import json
import os
import time
from urllib import request

API_KEY = os.getenv("OPENAI_API_KEY", "")
MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6-terra")
THRESHOLD = int(os.getenv("QUALITY_THRESHOLD", "90"))
MAX_REVISIONS = int(os.getenv("MAX_REVISIONS", "6"))
QUEUE_FILE = os.getenv("MARKETING_QUEUE_FILE", "/data/marketing_queue.json")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "60"))

GATES = ["product_accuracy", "visual_quality", "hook", "copy", "brand", "compliance", "conversion", "platform"]


def openai_json(instructions, payload):
    if not API_KEY:
        raise RuntimeError("OPENAI_API_KEY is missing")
    body = json.dumps({
        "model": MODEL,
        "reasoning": {"effort": "medium"},
        "instructions": instructions,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "Return JSON only.\n" + json.dumps(payload)}]}],
        "text": {"format": {"type": "json_object"}},
    }).encode()
    req = request.Request(
        "https://api.openai.com/v1/responses",
        data=body,
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode())
    text = data.get("output_text", "")
    if not text:
        text = "".join(
            c.get("text", "")
            for item in data.get("output", [])
            for c in item.get("content", [])
            if c.get("type") in {"output_text", "text"}
        )
    return json.loads(text)


def hard_product_check(asset):
    if asset.get("brand") != "Lion Elite Wellness" or not asset.get("product_name"):
        return []
    failures = []
    product = str(asset.get("product_name", "")).strip().lower()
    vial = str(asset.get("vial_product_name", "")).strip().lower()
    if not vial or product != vial:
        failures.append("Exact Lion Elite vial does not match the product.")
    if product not in str(asset.get("headline", "")).lower():
        failures.append("Headline does not match the product.")
    if product not in str(asset.get("caption", "")).lower():
        failures.append("Caption does not match the product.")
    expected = str(asset.get("expected_quantity", "")).lower().strip()
    actual = str(asset.get("vial_quantity", "")).lower().strip()
    if expected and actual and expected != actual:
        failures.append("Vial quantity does not match the approved product quantity.")
    return failures


def evaluate(asset, revision):
    system = """Act as Lion Elite Marketing Intelligence final QA. Evaluate the finished marketing asset strictly. Required gates are product_accuracy, visual_quality, hook, copy, brand, compliance, conversion, platform. Lion Elite Wellness is research education only: no dosing, treatment, human-use instructions, or unsupported medical claims. Product name, exact approved vial, quantity, headline and caption must agree. Reject cartoonish, cheap, malformed, unreadable, off-brand or obvious low-quality AI visuals when realism is intended. Score 0-100: accuracy 20, visual 20, hook 15, brand 10, educational value 10, conversion 10, compliance 10, platform 5. Return JSON keys: score, gates, failures, revision_instructions."""
    result = openai_json(system, {"asset": asset, "revision": revision})
    gates = {g: bool(result.get("gates", {}).get(g, False)) for g in GATES}
    failures = list(result.get("failures", []))
    hard_failures = hard_product_check(asset)
    if hard_failures:
        gates["product_accuracy"] = False
        failures = hard_failures + failures
    score = max(0, min(100, int(result.get("score", 0))))
    return {
        "score": score,
        "gates": gates,
        "failures": failures,
        "revision_instructions": list(result.get("revision_instructions", [])),
        "publish_ready": score >= THRESHOLD and all(gates.values()),
    }


def refine(asset, qa):
    system = """Act as Lion Elite senior creative director. Fix the failed QA checkpoints with targeted revisions. Preserve accurate information and approved product identity. Never invent a vial, label, quantity, testimonial or medical claim. For Lion Elite Wellness keep content research/education focused. Return the complete revised asset as JSON using the same keys."""
    revised = openai_json(system, {"asset": asset, "qa": qa})
    for key in ["brand", "product_name", "expected_quantity", "approved_asset_url"]:
        if key in asset:
            revised[key] = asset[key]
    return revised


def process(asset):
    current = dict(asset)
    history = []
    for revision in range(MAX_REVISIONS + 1):
        qa = evaluate(current, revision)
        history.append({"revision": revision, "qa": qa})
        if qa["publish_ready"]:
            return {"status": "approved", "asset": current, "qa": qa, "revision_count": revision, "history": history}
        if revision == MAX_REVISIONS:
            return {"status": "blocked", "asset": current, "qa": qa, "revision_count": revision, "history": history}
        current = refine(current, qa)
    return {"status": "blocked", "asset": current, "history": history}


def run_once():
    if not os.path.exists(QUEUE_FILE):
        return
    with open(QUEUE_FILE, "r", encoding="utf-8") as f:
        queue = json.load(f)
    changed = False
    for item in queue:
        if item.get("status", "pending") != "pending":
            continue
        item["result"] = process(item)
        item["status"] = item["result"]["status"]
        changed = True
    if changed:
        os.makedirs(os.path.dirname(QUEUE_FILE), exist_ok=True)
        with open(QUEUE_FILE + ".tmp", "w", encoding="utf-8") as f:
            json.dump(queue, f, indent=2)
        os.replace(QUEUE_FILE + ".tmp", QUEUE_FILE)


def main():
    while True:
        run_once()
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
