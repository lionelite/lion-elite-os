from __future__ import annotations

import json
import os
import hashlib
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(os.getenv("TAX_DATA_DIR", "/var/data/tax-intelligence"))
INBOX = DATA_DIR / "inbox.jsonl"
LEDGER = DATA_DIR / "evidence_ledger.jsonl"
AUDIT = DATA_DIR / "audit_log.jsonl"
EXCEPTIONS = DATA_DIR / "exceptions.jsonl"

ENTITIES = {"lion_elite_wellness", "lion_elite_beauty", "personal", "needs_review"}

REQUIRED_BASE = ["transaction_date", "vendor", "amount", "entity"]
SPECIAL = {
    "vehicle": ["business_purpose", "business_use_pct", "allocation_method"],
    "travel": ["business_purpose", "destination", "travel_start", "travel_end"],
    "meal": ["business_purpose", "business_relationship"],
    "gift": ["business_purpose", "recipient", "business_relationship"],
    "asset": ["acquisition_date", "business_use_pct"],
}


def now():
    return datetime.now(timezone.utc).isoformat()


def append(path: Path, obj: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, sort_keys=True) + "\n")


def fingerprint(tx: dict) -> str:
    core = "|".join(str(tx.get(k, "")).strip().lower() for k in
                    ["entity", "transaction_date", "vendor", "amount", "payment_account"])
    return hashlib.sha256(core.encode()).hexdigest()


def classify(tx: dict) -> dict:
    tx = dict(tx)
    tx["transaction_id"] = tx.get("transaction_id") or fingerprint(tx)[:20]
    tx["captured_at"] = tx.get("captured_at") or now()
    tx["entity"] = str(tx.get("entity", "needs_review")).lower()
    if tx["entity"] not in ENTITIES:
        tx["entity"] = "needs_review"

    missing = [k for k in REQUIRED_BASE if tx.get(k) in (None, "")]
    category = str(tx.get("category", "needs_review")).lower()
    for field in SPECIAL.get(category, []):
        if tx.get(field) in (None, ""):
            missing.append(field)

    # Documentary support is expected for a tax-ready packet.
    if not tx.get("receipt_ref") and not tx.get("invoice_ref"):
        missing.append("receipt_or_invoice")
    if not tx.get("proof_of_payment_ref"):
        missing.append("proof_of_payment")

    if tx["entity"] == "personal":
        status = "PERSONAL"
    elif tx["entity"] == "needs_review" or category == "needs_review":
        status = "NEEDS_REVIEW"
    elif missing:
        status = "EVIDENCE_MISSING"
    elif tx.get("tax_treatment_uncertain"):
        status = "CPA_REVIEW"
    else:
        status = "SUBSTANTIATED"

    tx["missing_evidence"] = sorted(set(missing))
    tx["substantiation_status"] = status
    tx["tax_ready"] = status == "SUBSTANTIATED" and not tx.get("tax_treatment_uncertain", False)
    return tx


def process(tx: dict):
    result = classify(tx)
    append(LEDGER, result)
    append(AUDIT, {
        "timestamp": now(),
        "transaction_id": result["transaction_id"],
        "action": "classify_and_substantiate",
        "status": result["substantiation_status"],
        "missing_evidence": result["missing_evidence"],
    })
    if result["substantiation_status"] in {"EVIDENCE_MISSING", "NEEDS_REVIEW", "CPA_REVIEW"}:
        append(EXCEPTIONS, result)
    return result


def run_once():
    if not INBOX.exists():
        return 0
    lines = INBOX.read_text(encoding="utf-8").splitlines()
    if not lines:
        return 0
    for line in lines:
        if line.strip():
            process(json.loads(line))
    INBOX.write_text("", encoding="utf-8")
    return len(lines)


if __name__ == "__main__":
    import time
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    interval = int(os.getenv("TAX_POLL_SECONDS", "300"))
    while True:
        run_once()
        time.sleep(interval)
