from __future__ import annotations

import json
import os
import time
from pathlib import Path

from property_acquisition_pipeline import AcquisitionCase, analyze

DATA_DIR = Path(os.getenv("TAX_DATA_DIR", "/var/data/tax-intelligence"))
PROPERTY_INBOX = DATA_DIR / "property_inbox.jsonl"
PROPERTY_RESULTS = DATA_DIR / "property_analysis.jsonl"
PROPERTY_EXCEPTIONS = DATA_DIR / "property_exceptions.jsonl"
POLL_SECONDS = int(os.getenv("PROPERTY_POLL_SECONDS", "300"))


def append(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, sort_keys=True) + "\n")


def process(payload: dict) -> dict:
    case = AcquisitionCase(**payload["case"])
    result = analyze(case, payload.get("provided_documents"))
    append(PROPERTY_RESULTS, result)
    if result["decision"] != "ACQUIRE_CANDIDATE" or result["risk_flags"]:
        append(PROPERTY_EXCEPTIONS, result)
    return result


def run_once() -> int:
    if not PROPERTY_INBOX.exists():
        return 0
    lines = PROPERTY_INBOX.read_text(encoding="utf-8").splitlines()
    if not lines:
        return 0
    processed = 0
    for line in lines:
        if line.strip():
            process(json.loads(line))
            processed += 1
    PROPERTY_INBOX.write_text("", encoding="utf-8")
    return processed


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    while True:
        run_once()
        time.sleep(POLL_SECONDS)
