"""Lion Elite Beauty shapewear launch.

Nothing about the line (SKUs, sizes, price, inventory, launch date) exists in
the repo yet, so every skill takes those as inputs and lists what is missing
instead of filling gaps with plausible numbers.
"""

from __future__ import annotations

import re
from datetime import date, timedelta

from .. import llm
from ..bot import Bot, done, failed, skill
from ..drafts import gated_draft

# Garment claims the FTC and platforms treat as weight-loss/medical claims.
CLAIM_RULES = [
    (re.compile(r"\b(lose|drop|melt|burn)\w*\s+(\d+\s*)?(inch|inches|pounds|lbs|fat|weight)\b", re.I),
     "weight/fat-loss claim: a garment shapes, it does not remove fat"),
    (re.compile(r"\bpermanent(ly)?\b", re.I), "permanence claim"),
    (re.compile(r"\b(medical[- ]grade|doctor[- ]recommended|clinically (proven|tested)|fda)\b", re.I),
     "medical/clinical claim needs documented substantiation"),
    (re.compile(r"\b(waist train\w*|detox|sweat (out|away)|cellulite)\b", re.I), "unsubstantiated body claim"),
    (re.compile(r"\b(guarantee\w*|instant(ly)? (results|slim))\b", re.I), "results guarantee"),
    (re.compile(r"\b(post[- ]?(op|surgery|surgical)|lipo|bbl)\b", re.I),
     "post-surgical use: medical positioning, needs owner + legal sign-off"),
]
REQUIRED_FACTS = ["launch_date", "skus", "sizes", "price", "inventory_units", "fabric", "return_policy"]

PHASES = [
    (-28, "Lock facts: SKUs, size chart, fabric, price, return policy, photography."),
    (-21, "Waitlist page live; capture e-mail and (separately, with explicit consent) SMS."),
    (-21, "Seed product to creators for honest try-on content; disclose gifting (#gifted/#ad)."),
    (-14, "Teaser content: fabric close-ups, fit on a range of real bodies, size guide explainer."),
    (-7, "Waitlist reminder; publish size guide and fit FAQ."),
    (-2, "QA: checkout, inventory sync, size-exchange flow, shipping times."),
    (0, "Launch: waitlist early access first, then public."),
    (3, "Ask first buyers for fit reviews; log every size exchange by size."),
    (7, "Read sell-through and returns by size; reorder or fix the size chart before scaling ads."),
]


def claim_issues(text: str) -> list[dict]:
    return [{"match": m.group(0), "issue": why} for rx, why in CLAIM_RULES for m in rx.finditer(text)]


class ShapewearBot(Bot):
    name = "shapewear"
    description = "Lion Elite Beauty shapewear launch: plan, unit economics, size-chart QA, claim-safe copy drafts."
    keywords = {
        "shapewear.launch_plan": ["shapewear", "shape wear", "launch plan", "beauty launch"],
        "shapewear.economics": ["shapewear margin", "shapewear economics", "sell-through"],
        "shapewear.size_chart": ["size chart", "size guide", "sizing"],
        "shapewear.copy": ["shapewear copy", "shapewear description", "launch copy"],
    }

    @skill("shapewear.launch_plan")
    def launch_plan(self, task):
        """payload: launch_date, skus, sizes, price, inventory_units, fabric, return_policy."""
        p = task.payload
        missing = [f for f in REQUIRED_FACTS if not p.get(f)]
        launch = date.fromisoformat(p["launch_date"]) if p.get("launch_date") else None
        timeline = [{"date": (launch + timedelta(days=d)).isoformat() if launch else f"T{d:+d}", "step": s}
                    for d, s in PHASES]
        return done({"launch_date": p.get("launch_date"), "timeline": timeline, "missing_facts": missing,
                     "note": "Fill missing_facts before any copy or ads go out." if missing else None})

    @skill("shapewear.economics")
    def economics(self, task):
        """payload: price, unit_cost, shipping_per_order, payment_fee_pct (default 3), return_rate_pct, cac, inventory_units."""
        p = task.payload
        try:
            price, cost = float(p["price"]), float(p["unit_cost"])
            return_pct = float(p["return_rate_pct"])
        except (KeyError, TypeError, ValueError):
            return failed("price, unit_cost and return_rate_pct are required (shapewear return rates vary "
                          "widely by fit; use your own or a supplier's figure, not a guess)")
        ship = float(p.get("shipping_per_order", 0))
        fee = price * float(p.get("payment_fee_pct", 3)) / 100
        cac = float(p.get("cac", 0))
        kept = 1 - return_pct / 100
        # Returned units: refund the price, eat the outbound shipping and fee.
        contribution = kept * (price - cost) - ship - fee - cac
        out = {"contribution_per_order": round(contribution, 2),
               "contribution_margin_pct": round(contribution / price * 100, 1),
               "breakeven_cac": round(kept * (price - cost) - ship - fee, 2),
               "assumes": "returned units restocked at full value; no reverse-shipping cost included"}
        if p.get("inventory_units"):
            units = int(p["inventory_units"])
            out["inventory_cost"] = round(units * cost, 2)
            out["revenue_if_sold_through"] = round(units * price * kept, 2)
        return done(out)

    @skill("shapewear.size_chart")
    def size_chart(self, task):
        """payload: chart [{size, waist_min, waist_max, hip_min, hip_max}] in one unit. Finds gaps and overlaps."""
        chart = task.payload.get("chart")
        if not isinstance(chart, list) or not chart:
            return failed("payload.chart must be a non-empty list")
        issues = []
        for dim in ("waist", "hip"):
            rows = [r for r in chart if r.get(f"{dim}_min") is not None and r.get(f"{dim}_max") is not None]
            for r in rows:
                if r[f"{dim}_min"] >= r[f"{dim}_max"]:
                    issues.append(f"{r['size']}: {dim} min is not below max")
            for a, b in zip(rows, rows[1:]):
                gap = b[f"{dim}_min"] - a[f"{dim}_max"]
                if gap > 0.5:
                    issues.append(f"{dim} gap of {gap:g} between {a['size']} and {b['size']}: those customers have no size")
                elif gap < -0.5:
                    issues.append(f"{dim} overlap of {-gap:g} between {a['size']} and {b['size']}: say which to pick")
        return done({"sizes": [r.get("size") for r in chart], "issues": issues, "ok": not issues})

    @skill("shapewear.copy")
    def copy(self, task):
        """payload: product, facts (fabric, compression level, sizes, care). Draft + claim and compliance checks."""
        product = task.payload.get("product") or task.payload.get("request")
        if not product:
            return failed("payload.product is required")
        prompt = (
            f"Write a premium Lion Elite Beauty product description and 3 launch-post captions for: {product}.\n"
            f"Facts (use only these; [NEEDS: ...] otherwise): {task.payload.get('facts', {})}\n"
            "Positioning: premium, confident, for women who train and want structure under their clothes. "
            "Describe how it fits, feels, and smooths/supports. Never claim inch or fat loss, waist training, "
            "permanent results, medical or post-surgical use, or guarantees. No invented reviews or numbers."
        )
        text = llm.ask(prompt)["text"].strip()
        draft = gated_draft(text, "coaching")
        issues = claim_issues(text)
        draft["claim_issues"] = issues
        if issues:
            draft["customer_ready"] = False
            draft["note"] = "INTERNAL ONLY: remove the flagged claims first."
        return done(draft)
