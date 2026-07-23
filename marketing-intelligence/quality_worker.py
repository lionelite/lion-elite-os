import json
import os
import re
import time
from urllib import request

API_KEY = os.getenv("OPENAI_API_KEY", "")
MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6-terra")
THRESHOLD = int(os.getenv("QUALITY_THRESHOLD", "92"))
MAX_REVISIONS = int(os.getenv("MAX_REVISIONS", "8"))
QUEUE_FILE = os.getenv("MARKETING_QUEUE_FILE", "/data/marketing_queue.json")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "60"))

GATES = [
    "product_accuracy",
    "visual_quality",
    "hook",
    "copy",
    "brand",
    "compliance",
    "conversion",
    "platform",
    "audience_fit",
    "impulse_conversion",
]

WEAK_HEADLINE_PATTERNS = [
    r"^\s*[A-Z0-9+\- /]+\|\s*PEPTIDE INFO SERIES\s*$",
    r"^\s*PEPTIDE INFO SERIES\s*$",
    r"^\s*PRODUCT SPOTLIGHT\s*$",
]

GENERIC_AI_PHRASES = {
    "unlock your potential",
    "take your journey to the next level",
    "elevate your wellness",
    "game changer",
    "revolutionary solution",
    "transform your life today",
}


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


def normalized(value):
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def hard_product_check(asset):
    if asset.get("brand") != "Lion Elite Wellness" or not asset.get("product_name"):
        return []
    failures = []
    product = normalized(asset.get("product_name"))
    vial = normalized(asset.get("vial_product_name"))
    headline = normalized(asset.get("headline"))
    caption = normalized(asset.get("caption"))

    if not vial or product != vial:
        failures.append("Exact Lion Elite vial does not match the product.")
    if product not in headline:
        failures.append("Headline does not match the product.")
    if product not in caption:
        failures.append("Caption does not match the product.")

    expected = normalized(asset.get("expected_quantity"))
    actual = normalized(asset.get("vial_quantity"))
    if expected and actual and expected != actual:
        failures.append("Vial quantity does not match the approved product quantity.")
    return failures


def deterministic_marketing_checks(asset):
    failures = []
    headline = str(asset.get("headline", "")).strip()
    caption = str(asset.get("caption", "")).strip()
    brand = asset.get("brand", "")

    if len(headline) < 8:
        failures.append("Headline is too weak or too short to stop the scroll.")
    if any(re.match(pattern, headline, flags=re.I) for pattern in WEAK_HEADLINE_PATTERNS):
        failures.append("Headline uses the retired textbook-style Peptide Info Series format.")

    lower_copy = normalized(headline + " " + caption)
    used_generic = sorted(p for p in GENERIC_AI_PHRASES if p in lower_copy)
    if used_generic:
        failures.append("Generic AI marketing language detected: " + ", ".join(used_generic))

    if not asset.get("cta"):
        failures.append("No explicit CTA is defined.")

    if brand == "Lion Elite Wellness":
        banned = ["dose", "dosage", "inject", "take this", "treatment for", "cures", "heals you"]
        if any(term in lower_copy for term in banned):
            failures.append("Lion Elite Wellness copy contains human-use, dosing, or medical-claim language.")
    elif brand in {"Lion Elite Beauty", "AlexTheLionLifts"}:
        if not any(term in lower_copy for term in ["coach", "client", "transformation", "consult", "dm", "apply", "book", "start"]):
            failures.append("Coaching-brand copy lacks a clear human transformation or client-acquisition angle.")

    return failures


def evaluate(asset, revision):
    system = """Act as Lion Elite Marketing Intelligence final QA and conversion director. Evaluate the FINISHED marketing asset strictly. Required gates: product_accuracy, visual_quality, hook, copy, brand, compliance, conversion, platform, audience_fit, impulse_conversion.

Brand strategy:
- Lion Elite Wellness = research education, mechanisms, receptor/pathway curiosity, premium scientific positioning. No dosing, treatment, human-use instructions, or unsupported medical claims.
- Lion Elite Beauty = coaching, transformations, accountability, beauty/wellness, and client outcomes without medical promises.
- AlexTheLionLifts = lifestyle, credibility, training, transformation, coaching, personal-training-business growth.

Creative standard:
- Never approve generic textbook cards when a stronger visual story is possible.
- Product name, exact approved vial, quantity, headline and caption must agree.
- Reject cartoonish, cheap, malformed, unreadable, mismatched, obvious low-quality AI visuals.
- Hook must create curiosity, tension, aspiration, identity, contrast, myth, mechanism, problem awareness, or an immediate reason to keep reading.
- One primary idea per creative.
- Copy should move Hook -> Value/Curiosity -> Proof/Mechanism -> Brand Positioning -> CTA.
- Impulse conversion means low-friction next action, clear value, strong visual desire, social proof or credibility where truthful, and appropriate urgency without deception.
- Audience fit means the creative clearly speaks to the intended person and their desired outcome.

Score 0-100: accuracy 15, visual 15, hook 15, brand 10, educational/value 10, conversion 15, compliance 10, platform 5, audience fit 3, impulse conversion 2. Return JSON keys: score, gates, failures, revision_instructions, strongest_element, weakest_element, predicted_action."""
    result = openai_json(system, {"asset": asset, "revision": revision})
    gates = {g: bool(result.get("gates", {}).get(g, False)) for g in GATES}
    failures = list(result.get("failures", []))

    hard_failures = hard_product_check(asset)
    deterministic_failures = deterministic_marketing_checks(asset)

    if hard_failures:
        gates["product_accuracy"] = False
    if deterministic_failures:
        if any("Headline" in f or "textbook" in f for f in deterministic_failures):
            gates["hook"] = False
        if any("CTA" in f or "conversion" in f.lower() for f in deterministic_failures):
            gates["conversion"] = False
            gates["impulse_conversion"] = False
        if any("human-use" in f or "medical-claim" in f for f in deterministic_failures):
            gates["compliance"] = False
        if any("Coaching-brand" in f for f in deterministic_failures):
            gates["audience_fit"] = False

    failures = hard_failures + deterministic_failures + failures
    score = max(0, min(100, int(result.get("score", 0))))

    return {
        "score": score,
        "gates": gates,
        "failures": list(dict.fromkeys(failures)),
        "revision_instructions": list(result.get("revision_instructions", [])),
        "strongest_element": result.get("strongest_element", ""),
        "weakest_element": result.get("weakest_element", ""),
        "predicted_action": result.get("predicted_action", ""),
        "publish_ready": score >= THRESHOLD and all(gates.values()),
    }


def refine(asset, qa):
    system = """Act as Lion Elite's senior performance creative director. Fix ONLY what failed while preserving what already works. Make the next version materially stronger, not merely different.

Rules:
- Preserve factual accuracy and exact approved product identity.
- Never invent a vial, label, quantity, testimonial, result, scientific fact, or medical claim.
- Replace weak textbook headlines with curiosity-driven or outcome-driven hooks.
- Strengthen the first-frame visual concept before adding more copy.
- Reduce cognitive load. One primary idea per asset.
- Improve conversion with a low-friction CTA and obvious value exchange.
- For coaching brands, make the desired transformation and identity vivid.
- For Lion Elite Wellness, stay research/education focused and science-forward.
- Favor realistic premium nature/science/luxury imagery over generic AI graphics when consistent with the asset brief.
- Preserve any supplied approved_asset_url exactly.

Return the COMPLETE revised asset as JSON using the same keys, plus revision_reason and creative_hypothesis."""
    revised = openai_json(system, {"asset": asset, "qa": qa})
    for key in [
        "brand",
        "product_name",
        "expected_quantity",
        "approved_asset_url",
        "platform",
        "campaign_id",
        "audience",
    ]:
        if key in asset:
            revised[key] = asset[key]
    return revised


def process(asset):
    current = dict(asset)
    history = []
    best = {"score": -1, "asset": current, "qa": None}

    for revision in range(MAX_REVISIONS + 1):
        qa = evaluate(current, revision)
        history.append({"revision": revision, "qa": qa})

        if qa["score"] > best["score"]:
            best = {"score": qa["score"], "asset": dict(current), "qa": qa}

        if qa["publish_ready"]:
            return {
                "status": "approved",
                "asset": current,
                "qa": qa,
                "revision_count": revision,
                "history": history,
                "best_score": best["score"],
            }

        if revision == MAX_REVISIONS:
            return {
                "status": "blocked",
                "asset": best["asset"],
                "qa": best["qa"],
                "revision_count": revision,
                "history": history,
                "best_score": best["score"],
                "block_reason": "Maximum revisions reached without passing every mandatory gate.",
            }

        current = refine(current, qa)

    return {"status": "blocked", "asset": best["asset"], "history": history, "best_score": best["score"]}


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
