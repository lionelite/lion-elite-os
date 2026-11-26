"""Amazon FBA: unit economics, product screening, listing drafts."""

from __future__ import annotations

import re

from .. import llm
from ..bot import Bot, done, failed, skill

RESTRICTED = re.compile(
    r"\b(peptide|bpc|tb-?500|semaglutide|tirzepatide|sarm|research chemical|injectable|cbd|kratom|"
    r"supplement|vape|knife|weapon|pesticide|lithium battery|aerosol)\w*", re.I)


def num(p, key, default=None, required=False):
    v = p.get(key, default)
    if v is None:
        if required:
            raise ValueError(key)
        return None
    return float(v)


def profit(p: dict) -> dict:
    price = num(p, "price", required=True)
    landed = num(p, "landed_cost", required=True)  # unit cost + freight/duty to Amazon
    fba_fee = num(p, "fba_fee", required=True)  # from Amazon's fee preview / revenue calculator
    referral_pct = num(p, "referral_fee_pct", 15)
    storage = num(p, "storage_per_unit", 0)
    ppc = num(p, "ppc_per_unit", 0)
    return_pct = num(p, "return_rate_pct", 0)
    other = num(p, "other_per_unit", 0)
    referral = price * referral_pct / 100
    returns = price * return_pct / 100  # simple: lost revenue on returned units
    before_ads = price - landed - fba_fee - referral - storage - returns - other
    net = before_ads - ppc
    out = {
        "price": price,
        "fees": {"referral": round(referral, 2), "fba": fba_fee, "storage": storage,
                 "returns_allowance": round(returns, 2), "ppc": ppc, "other": other},
        "net_profit_per_unit": round(net, 2),
        "margin_pct": round(net / price * 100, 1) if price else None,
        "roi_pct": round(net / landed * 100, 1) if landed else None,
        "breakeven_acos_pct": round(before_ads / price * 100, 1) if price else None,
    }
    units = p.get("units_per_month")
    if units:
        out["monthly_net_profit"] = round(net * float(units), 2)
    out["verdict"] = ("losing money per unit" if net <= 0 else
                      "thin (<15% margin)" if out["margin_pct"] < 15 else
                      "workable" if out["margin_pct"] < 25 else "strong")
    return out


class FbaBot(Bot):
    name = "fba"
    description = "Amazon FBA unit economics, product-idea screening and listing drafts."
    keywords = {
        "fba.profit": ["fba", "amazon", "acos", "referral fee", "unit economics"],
        "fba.screen": ["product idea", "product research", "should i sell"],
        "fba.listing_draft": ["listing", "bullet points", "amazon title"],
    }

    @skill("fba.profit")
    def profit_skill(self, task):
        """payload: price, landed_cost, fba_fee (required); referral_fee_pct, ppc_per_unit, return_rate_pct, units_per_month."""
        try:
            return done(profit(task.payload))
        except ValueError as exc:
            return failed(f"payload.{exc} is required (no FBA fee is guessed: take it from Amazon's revenue calculator)")

    @skill("fba.screen")
    def screen(self, task):
        """payload: name, price, est_monthly_sales, top_competitor_reviews, weight_lb, seasonal, hazmat, brand_gated, landed_cost, fba_fee."""
        p = task.payload
        name = p.get("name") or p.get("request") or ""
        reasons, flags, score = [], [], 0
        if RESTRICTED.search(name):
            flags.append("Likely restricted or prohibited on Amazon (category approval, or banned outright for "
                         "research chemicals/injectables). Do not source inventory before checking Seller Central.")
        price = p.get("price")
        if price is not None:
            if 20 <= float(price) <= 70:
                score += 2; reasons.append("price in the $20-70 impulse/margin band")
            else:
                reasons.append("price outside $20-70: fees bite below, conversion drops above")
        sales = p.get("est_monthly_sales")
        if sales is not None:
            if float(sales) >= 300:
                score += 2; reasons.append("demand: 300+ sales/month")
            else:
                reasons.append("demand under 300 sales/month")
        reviews = p.get("top_competitor_reviews")
        if reviews is not None:
            if float(reviews) < 500:
                score += 2; reasons.append("top competitors under 500 reviews: room to rank")
            else:
                reasons.append("entrenched competitors (500+ reviews)")
        weight = p.get("weight_lb")
        if weight is not None:
            if float(weight) <= 2:
                score += 1; reasons.append("light (<=2 lb): lower FBA fee tier")
            else:
                reasons.append("heavy: higher fees")
        for key, msg in (("seasonal", "seasonal demand"), ("hazmat", "hazmat review required"),
                         ("brand_gated", "brand/category gated"), ("fragile", "fragile: damage returns")):
            if p.get(key):
                flags.append(msg)
        economics = None
        if all(p.get(k) is not None for k in ("price", "landed_cost", "fba_fee")):
            economics = profit(p)
            if economics["margin_pct"] >= 25:
                score += 2
            reasons.append(f"net margin {economics['margin_pct']}%")
        missing = [k for k in ("price", "est_monthly_sales", "top_competitor_reviews", "landed_cost", "fba_fee")
                   if p.get(k) is None]
        verdict = "stop" if flags and RESTRICTED.search(name) else (
            "promising" if score >= 7 and not flags else "maybe" if score >= 4 else "weak")
        return done({"name": name, "score": score, "max_score": 9, "verdict": verdict,
                     "reasons": reasons, "flags": flags, "missing": missing, "economics": economics})

    @skill("fba.listing_draft")
    def listing(self, task):
        """payload: product, features (list), audience, keywords (list). Returns title, 5 bullets, description."""
        p = task.payload
        product = p.get("product") or p.get("request")
        if not product:
            return failed("payload.product is required")
        if RESTRICTED.search(product):
            return failed("This product looks restricted on Amazon; confirm category approval before drafting a listing.")
        schema = {"type": "object", "additionalProperties": False,
                  "required": ["title", "bullets", "description", "backend_keywords"],
                  "properties": {"title": {"type": "string"},
                                 "bullets": {"type": "array", "items": {"type": "string"}},
                                 "description": {"type": "string"},
                                 "backend_keywords": {"type": "string"}}}
        prompt = (
            f"Write an Amazon listing for: {product}\nFeatures: {p.get('features', [])}\n"
            f"Audience: {p.get('audience', 'unspecified')}\nTarget keywords: {p.get('keywords', [])}\n"
            "Rules: title under 200 characters, exactly 5 bullets each under 250 characters, no medical or "
            "health claims, no 'best'/'#1' superlatives, no competitor brand names, no pricing or shipping promises, "
            "backend_keywords under 249 bytes without repeating title words. Use [NEEDS: ...] for any fact not given."
        )
        out = llm.ask(prompt, schema=schema)["json"]
        issues = []
        if len(out["title"]) > 200:
            issues.append("title over 200 characters")
        if len(out["bullets"]) != 5:
            issues.append(f"{len(out['bullets'])} bullets, Amazon shows 5")
        issues += [f"bullet {i + 1} over 250 characters" for i, b in enumerate(out["bullets"]) if len(b) > 250]
        if len(out["backend_keywords"].encode()) > 249:
            issues.append("backend keywords over 249 bytes")
        return done({**out, "issues": issues, "published": False})
