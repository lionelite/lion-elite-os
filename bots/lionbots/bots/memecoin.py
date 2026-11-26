"""Meme-coin research: screening and position sizing. It never trades.

No wallet, no exchange keys, no orders. "Buy X" requests are refused by
guardrails; buying stays a human action.
"""

from __future__ import annotations

from .. import sources
from ..bot import Bot, done, failed, skill

# (field, test on the value, flag text) - any hard flag means avoid.
HARD = [
    ("honeypot", lambda v: v is True, "Honeypot detected: sells are blocked."),
    ("sell_tax_pct", lambda v: v is not None and v > 10, "Sell tax above 10%."),
    ("mint_authority_revoked", lambda v: v is False, "Mint authority not revoked: supply can be inflated."),
    ("freeze_authority_revoked", lambda v: v is False, "Freeze authority not revoked: your tokens can be frozen."),
    ("lp_locked", lambda v: v is False, "Liquidity not locked or burned: the pool can be pulled."),
    ("liquidity_usd", lambda v: v is not None and v < 10_000, "Liquidity under $10k: you may not be able to exit."),
]
SOFT = [
    ("top10_holder_pct", lambda v: v is not None and v > 30, "Top 10 wallets hold over 30% of supply."),
    ("dev_wallet_pct", lambda v: v is not None and v > 5, "Dev wallet holds over 5%."),
    ("age_hours", lambda v: v is not None and v < 24, "Under 24 hours old."),
    ("lp_lock_days", lambda v: v is not None and v < 30, "Liquidity lock under 30 days."),
    ("buy_tax_pct", lambda v: v is not None and v > 5, "Buy tax above 5%."),
    ("contract_verified", lambda v: v is False, "Contract source not verified."),
    ("socials", lambda v: v is False, "No website or socials."),
]
CRITICAL_UNKNOWNS = ["honeypot", "mint_authority_revoked", "lp_locked", "top10_holder_pct", "liquidity_usd"]


def screen(facts: dict) -> dict:
    hard = [msg for f, test, msg in HARD if f in facts and test(facts[f])]
    soft = [msg for f, test, msg in SOFT if f in facts and test(facts[f])]
    liq, mcap = facts.get("liquidity_usd"), facts.get("market_cap_usd")
    if liq and mcap and liq / mcap < 0.05:
        soft.append("Liquidity is under 5% of market cap: thin exit relative to valuation.")
    unknown = [f for f in CRITICAL_UNKNOWNS if facts.get(f) is None]
    if hard:
        verdict = "avoid"
    elif unknown or len(soft) >= 3:
        verdict = "unverified - high risk"
    else:
        verdict = "passed screen - still speculative"
    return {
        "verdict": verdict,
        "hard_flags": hard,
        "soft_flags": soft,
        "unknown": unknown,
        "note": "A screen can only fail a token, never clear it. No meme coin is safe; size for total loss.",
    }


class MemeCoinBot(Bot):
    name = "memecoin"
    description = "Meme-coin rug/risk screening, DexScreener lookups and loss-capped position sizing. Never trades."
    keywords = {
        "memecoin.lookup": ["meme coin", "memecoin", "token", "dexscreener", "ticker", "solana", "pump"],
        "memecoin.screen": ["rug", "honeypot", "screen token", "is it safe"],
        "memecoin.size": ["position size", "how much to put", "bankroll"],
    }

    @skill("memecoin.lookup")
    def lookup(self, task):
        """payload: query (symbol, name or address). Live pairs plus a partial screen."""
        q = task.payload.get("query") or task.payload.get("request")
        if not q:
            return failed("payload.query is required")
        pairs = sources.dex_search(q)[: int(task.payload.get("max", 5))]
        for p in pairs:
            p["screen"] = screen({k: p.get(k) for k in ("liquidity_usd", "market_cap_usd", "age_hours")})
        return done({"query": q, "pairs": pairs,
                     "note": "Holder concentration, mint/freeze authority, LP lock and honeypot status are not in "
                             "DexScreener data; check them (e.g. RugCheck, a block explorer) and pass them to memecoin.screen."})

    @skill("memecoin.screen")
    def screen_skill(self, task):
        """payload: facts {liquidity_usd, market_cap_usd, top10_holder_pct, lp_locked, mint_authority_revoked, ...}."""
        facts = task.payload.get("facts")
        if not isinstance(facts, dict):
            return failed("payload.facts must be an object")
        return done(screen(facts))

    @skill("memecoin.size")
    def size(self, task):
        """payload: bankroll, entry, stop (optional), risk_pct (default 1), max_alloc_pct (default 2)."""
        p = task.payload
        try:
            bankroll, entry = float(p["bankroll"]), float(p["entry"])
        except (KeyError, TypeError, ValueError):
            return failed("payload.bankroll and payload.entry are required numbers")
        risk_pct = min(float(p.get("risk_pct", 1)), 5.0)
        max_alloc_pct = min(float(p.get("max_alloc_pct", 2)), 10.0)
        cap_alloc = bankroll * max_alloc_pct / 100
        result = {"bankroll": bankroll, "entry": entry, "risk_pct": risk_pct, "max_alloc_pct": max_alloc_pct}
        stop = p.get("stop")
        if stop is not None and 0 < float(stop) < entry:
            risk_dollars = bankroll * risk_pct / 100
            by_stop = risk_dollars / ((entry - float(stop)) / entry)
            alloc = min(by_stop, cap_alloc)
            result.update(stop=float(stop), stop_based_allocation=round(by_stop, 2))
        else:
            alloc = cap_alloc
        result.update(
            allocation_usd=round(alloc, 2),
            units=round(alloc / entry, 6) if entry else None,
            worst_case_loss_usd=round(alloc, 2),
            note="Meme coins gap through stops and can go to zero, so the allocation is capped at max_alloc_pct "
                 "of bankroll regardless of the stop. Plan for losing the whole allocation.",
        )
        return done(result)
