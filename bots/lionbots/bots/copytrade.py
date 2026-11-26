"""Copy-trade watcher for Solana meme-coin wallets: alerts plus PAPER trades only.

Plan (owner, Nov 2026): follow ~5 consistently profitable, non-leaderboard
Solana traders; alert on buys of at least 0.5 SOL and on their sells; mirror
them in a paper account with a $250 starting bankroll, balanced risk, and
measure whether copying would have made money before any real money is used.

What this bot can never do: it holds no private key, builds no transaction,
signs nothing and talks to no exchange or wallet. Live trading is not a
setting here; it would be a separate, owner-approved project.

Paper fills are deliberately pessimistic: we enter at the trader's own fill
price plus `slippage_pct` (we are always later than them) and exit at their
sell price minus `slippage_pct`, plus a flat fee per trade.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .. import sources
from ..bot import Bot, blocked, done, failed, skill
from ..paths import REPO_ROOT

LAMPORTS = 1_000_000_000
STABLES = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  # USDT
}

DEFAULTS = {
    "bankroll_usd": 250.0,
    "min_buy_sol": 0.5,           # trader buys smaller than this are ignored
    "alloc_pct": 10.0,            # paper allocation per copied buy, % of equity
    "max_positions": 5,
    "slippage_pct": 3.0,          # worse fill than the trader, each side
    "fee_usd": 0.05,              # flat network + priority fee per paper trade
    "stop_loss_pct": 50.0,        # meme coins: wide stop, checked at each poll
    "min_liquidity_usd": 10_000,  # skip copies into pools you could not exit
    "signatures_per_poll": 25,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --- transaction parsing ----------------------------------------------------------

def parse_swap(tx: dict, wallet: str) -> dict | None:
    """Classify one parsed transaction for `wallet` as a SOL-quoted buy or sell.

    Returns {side, mint, token_delta, sol_amount, price_sol, sold_fraction} or
    None for anything else (failed tx, transfers, stablecoin swaps, multi-token).
    """
    if not tx or (tx.get("meta") or {}).get("err") is not None:
        return None
    meta, msg = tx["meta"], (tx.get("transaction") or {}).get("message") or {}
    keys = [k.get("pubkey") if isinstance(k, dict) else k for k in msg.get("accountKeys") or []]
    if wallet not in keys:
        return None
    idx = keys.index(wallet)
    lamports = meta["postBalances"][idx] - meta["preBalances"][idx]
    if idx == 0:
        lamports += meta.get("fee", 0)  # trade size, not trade size plus network fee
    sol = lamports / LAMPORTS

    def balances(field):
        out = {}
        for b in meta.get(field) or []:
            if b.get("owner") == wallet:
                amt = (b.get("uiTokenAmount") or {}).get("uiAmount") or 0
                out[b["mint"]] = out.get(b["mint"], 0) + float(amt)
        return out

    pre, post = balances("preTokenBalances"), balances("postTokenBalances")
    deltas = {m: post.get(m, 0) - pre.get(m, 0) for m in set(pre) | set(post)}
    sol += deltas.pop(sources.WSOL, 0)  # wrapped SOL counts as SOL
    deltas = {m: d for m, d in deltas.items() if abs(d) > 1e-12}
    if len(deltas) != 1 or any(m in STABLES for m in deltas):
        return None
    mint, d = next(iter(deltas.items()))
    if d > 0 and sol < 0:
        side, sol_amount = "buy", -sol
    elif d < 0 and sol > 0:
        side, sol_amount = "sell", sol
    else:
        return None
    held_before = pre.get(mint, 0)
    return {
        "side": side,
        "mint": mint,
        "token_delta": d,
        "sol_amount": round(sol_amount, 9),
        "price_sol": sol_amount / abs(d),
        "sold_fraction": (min(1.0, -d / held_before) if held_before > 0 else 1.0) if side == "sell" else None,
        "signature": (tx.get("transaction") or {}).get("signatures", [None])[0],
        "block_time": tx.get("blockTime"),
    }


# --- paper ledger -----------------------------------------------------------------

def new_ledger(cfg: dict) -> dict:
    return {"started_at": now_iso(), "starting_bankroll_usd": cfg["bankroll_usd"], "cash_usd": cfg["bankroll_usd"],
            "wallets": {}, "positions": {}, "closed": [], "alerts": [], "skipped": []}


def equity(ledger: dict, prices: dict) -> float:
    total = ledger["cash_usd"]
    for mint, p in ledger["positions"].items():
        px = (prices.get(mint) or {}).get("price_usd")
        total += p["tokens"] * px if px is not None else p["cost_usd"]
    return total


def _keep(lst: list, item: dict, n: int = 300) -> None:
    lst.append(item)
    del lst[:-n]


def paper_buy(ledger, cfg, ev, wallet, sol_usd, prices) -> dict:
    mint = ev["mint"]
    info = prices.get(mint) or {}
    reason = None
    if mint in ledger["positions"]:
        reason = "already holding this token"
    elif len(ledger["positions"]) >= cfg["max_positions"]:
        reason = f"max {cfg['max_positions']} open positions"
    elif info.get("liquidity_usd") is not None and info["liquidity_usd"] < cfg["min_liquidity_usd"]:
        reason = f"liquidity ${info['liquidity_usd']:,.0f} under ${cfg['min_liquidity_usd']:,.0f}"
    alloc = min(equity(ledger, prices) * cfg["alloc_pct"] / 100, ledger["cash_usd"] - cfg["fee_usd"])
    if not reason and alloc < 1:
        reason = "no paper cash left"
    if reason:
        rec = {"at": now_iso(), "wallet": wallet, "mint": mint, "symbol": info.get("symbol"), "reason": reason}
        _keep(ledger["skipped"], rec)
        return {"action": "skip", **rec}
    entry_usd = ev["price_sol"] * sol_usd * (1 + cfg["slippage_pct"] / 100)
    tokens = alloc / entry_usd
    ledger["cash_usd"] -= alloc + cfg["fee_usd"]
    ledger["positions"][mint] = {"tokens": tokens, "cost_usd": alloc + cfg["fee_usd"], "entry_usd": entry_usd,
                                 "trader_entry_usd": ev["price_sol"] * sol_usd, "wallet": wallet,
                                 "symbol": info.get("symbol"), "opened_at": now_iso(), "signature": ev.get("signature")}
    return {"action": "paper_buy", "mint": mint, "symbol": info.get("symbol"), "usd": round(alloc, 2),
            "entry_usd": entry_usd, "wallet": wallet}


def _close(ledger, cfg, mint, fraction, exit_usd, why) -> dict:
    p = ledger["positions"][mint]
    tokens = p["tokens"] * fraction
    cost = p["cost_usd"] * fraction
    proceeds = tokens * exit_usd - cfg["fee_usd"]
    ledger["cash_usd"] += proceeds
    p["tokens"] -= tokens
    p["cost_usd"] -= cost
    rec = {"at": now_iso(), "mint": mint, "symbol": p.get("symbol"), "wallet": p["wallet"], "fraction": round(fraction, 4),
           "cost_usd": round(cost, 2), "proceeds_usd": round(proceeds, 2), "pnl_usd": round(proceeds - cost, 2),
           "pnl_pct": round((proceeds - cost) / cost * 100, 1) if cost else None, "why": why}
    _keep(ledger["closed"], rec, 1000)
    if p["tokens"] <= 1e-12 or fraction >= 0.999:
        del ledger["positions"][mint]
    return {"action": "paper_sell", **rec}


def paper_sell(ledger, cfg, ev, wallet, sol_usd) -> dict | None:
    p = ledger["positions"].get(ev["mint"])
    if not p or p["wallet"] != wallet:
        return None
    exit_usd = ev["price_sol"] * sol_usd * (1 - cfg["slippage_pct"] / 100)
    return _close(ledger, cfg, ev["mint"], ev["sold_fraction"] or 1.0, exit_usd, "trader sold")


def check_stops(ledger, cfg, prices) -> list[dict]:
    out = []
    for mint in list(ledger["positions"]):
        p = ledger["positions"][mint]
        px = (prices.get(mint) or {}).get("price_usd")
        if px is None:
            continue
        if p["tokens"] * px < p["cost_usd"] * (1 - cfg["stop_loss_pct"] / 100):
            out.append(_close(ledger, cfg, mint, 1.0, px * (1 - cfg["slippage_pct"] / 100), "stop loss"))
    return out


def summarize(ledger: dict, prices: dict) -> dict:
    eq = equity(ledger, prices)
    closed = [c for c in ledger["closed"] if c["fraction"] > 0]
    wins = [c for c in closed if c["pnl_usd"] > 0]
    by_wallet: dict[str, dict] = {}
    for c in closed:
        w = by_wallet.setdefault(c["wallet"], {"trades": 0, "wins": 0, "pnl_usd": 0.0})
        w["trades"] += 1
        w["wins"] += c["pnl_usd"] > 0
        w["pnl_usd"] = round(w["pnl_usd"] + c["pnl_usd"], 2)
    opens = []
    for mint, p in ledger["positions"].items():
        px = (prices.get(mint) or {}).get("price_usd")
        value = p["tokens"] * px if px is not None else None
        opens.append({"mint": mint, "symbol": p.get("symbol"), "wallet": p["wallet"], "cost_usd": round(p["cost_usd"], 2),
                      "value_usd": round(value, 2) if value is not None else None,
                      "unrealized_pct": round((value - p["cost_usd"]) / p["cost_usd"] * 100, 1) if value else None})
    start = ledger["starting_bankroll_usd"]
    return {
        "mode": "paper",
        "started_at": ledger["started_at"],
        "starting_bankroll_usd": start,
        "equity_usd": round(eq, 2),
        "return_pct": round((eq - start) / start * 100, 2),
        "cash_usd": round(ledger["cash_usd"], 2),
        "open_positions": opens,
        "closed_trades": len(closed),
        "win_rate_pct": round(len(wins) / len(closed) * 100, 1) if closed else None,
        "realized_pnl_usd": round(sum(c["pnl_usd"] for c in closed), 2),
        "by_wallet": by_wallet,
        "skipped_copies": len(ledger["skipped"]),
    }


# --- the bot ----------------------------------------------------------------------

def _wallets(payload: dict) -> list[str]:
    raw = payload.get("wallets") or os.environ.get("COPYTRADE_WALLETS", "")
    if isinstance(raw, str):
        raw = raw.replace("\n", ",").split(",")
    return [w.strip() for w in raw if w and w.strip()]


def _cfg(payload: dict) -> dict:
    cfg = dict(DEFAULTS)
    for k in DEFAULTS:
        env = os.environ.get(f"COPYTRADE_{k.upper()}")
        v = payload.get(k, env)
        if v not in (None, ""):
            cfg[k] = type(DEFAULTS[k])(v)
    return cfg


class CopyTradeBot(Bot):
    name = "copytrade"
    description = "Watches chosen Solana trader wallets; alerts on their buys/sells and mirrors them in a PAPER account. Never trades."
    keywords = {
        "copytrade.watch": ["copy trade", "copytrade", "watch wallets", "mirror", "trader wallets", "gmgn"],
        "copytrade.report": ["paper trading", "paper account", "copytrade report", "copy trade results", "paper pnl"],
        "copytrade.vet": ["vet wallet", "check trader", "is this trader good", "wallet history"],
    }

    # State is a small JSON file so it survives between scheduled runs (the
    # workflow caches it). Override with COPYTRADE_STATE.
    def _state_path(self) -> Path:
        return Path(self.context.get("copytrade_state") or os.environ.get("COPYTRADE_STATE")
                    or REPO_ROOT / "bots" / ".state" / "copytrade.json")

    def _load(self, cfg) -> dict:
        p = self._state_path()
        if p.exists():
            return json.loads(p.read_text())
        return new_ledger(cfg)

    def _save(self, ledger) -> None:
        p = self._state_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(ledger, indent=1))
        tmp.replace(p)

    def _rpc(self, method, params):
        return sources.solana_rpc(method, params, opener=self.context.get("opener"))

    def _sol_usd(self, payload) -> float | None:
        if payload.get("sol_usd"):
            return float(payload["sol_usd"])
        return (sources.dex_token_prices([sources.WSOL], opener=self.context.get("opener")).get(sources.WSOL) or {}).get("price_usd")

    def _new_swaps(self, wallet, last_sig, limit):
        opts = {"limit": limit}
        if last_sig:
            opts["until"] = last_sig
        sigs = self._rpc("getSignaturesForAddress", [wallet, opts]) or []
        swaps = []
        for s in reversed(sigs):  # oldest first, so sells follow their buys
            if s.get("err") is not None:
                continue
            tx = self._rpc("getTransaction", [s["signature"], {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}])
            ev = parse_swap(tx, wallet)
            if ev:
                ev["signature"] = ev.get("signature") or s["signature"]
                swaps.append(ev)
        return swaps, (sigs[0]["signature"] if sigs else last_sig)

    @skill("copytrade.watch")
    def watch(self, task):
        """One poll: new trades from COPYTRADE_WALLETS (or payload.wallets) -> alerts + paper fills."""
        wallets = _wallets(task.payload)
        if not wallets:
            return blocked("No trader wallets chosen yet", gate="owner sets COPYTRADE_WALLETS (up to 5 Solana addresses)")
        if len(wallets) > 10:
            return failed("Track at most 10 wallets; the plan is 5.")
        cfg = _cfg(task.payload)
        ledger = self._load(cfg)
        sol_usd = self._sol_usd(task.payload)
        if not sol_usd:
            return blocked("Could not price SOL in USD", gate="network: api.dexscreener.com")
        alerts, fills = [], []
        for w in wallets:
            st = ledger["wallets"].setdefault(w, {"last_sig": None, "added_at": now_iso()})
            first_look = st["last_sig"] is None
            swaps, newest = self._new_swaps(w, st["last_sig"], 1 if first_look else cfg["signatures_per_poll"])
            st["last_sig"] = newest
            if first_look:
                continue  # start from now; history is not something we could have copied
            for ev in swaps:
                if ev["side"] == "buy" and ev["sol_amount"] < cfg["min_buy_sol"]:
                    continue
                alert = {"at": now_iso(), "wallet": w, "side": ev["side"], "mint": ev["mint"],
                         "sol": round(ev["sol_amount"], 3), "usd": round(ev["sol_amount"] * sol_usd, 2),
                         "signature": ev["signature"],
                         "trader_time": datetime.fromtimestamp(ev["block_time"], timezone.utc).isoformat()
                         if ev.get("block_time") else None}
                alerts.append(alert)
                _keep(ledger["alerts"], alert)
                ev["_alert"] = alert
                st.setdefault("pending", []).append(ev)
        # Price everything we touch in one call, then fill.
        pending = [(w, ev) for w, st in ledger["wallets"].items() for ev in st.pop("pending", [])]
        mints = list(ledger["positions"]) + [ev["mint"] for _, ev in pending]
        prices = sources.dex_token_prices(mints, opener=self.context.get("opener")) if mints else {}
        for w, ev in pending:
            sym = (prices.get(ev["mint"]) or {}).get("symbol")
            ev["_alert"]["symbol"] = sym
            ev.pop("_alert")
            fill = paper_buy(ledger, cfg, ev, w, sol_usd, prices) if ev["side"] == "buy" else paper_sell(ledger, cfg, ev, w, sol_usd)
            if fill:
                fills.append(fill)
        fills += check_stops(ledger, cfg, prices)
        ledger["last_poll"] = now_iso()
        self._save(ledger)
        return done({"mode": "paper", "live_trading": False, "wallets": len(wallets), "sol_usd": sol_usd,
                     "alerts": alerts, "paper_fills": fills, "account": summarize(ledger, prices)})

    @skill("copytrade.report")
    def report(self, task):
        """Paper account: equity vs $250 start, open positions, win rate, P&L per trader."""
        cfg = _cfg(task.payload)
        ledger = self._load(cfg)
        prices = {}
        if ledger["positions"] and not task.payload.get("offline"):
            try:
                prices = sources.dex_token_prices(list(ledger["positions"]), opener=self.context.get("opener"))
            except sources.SourceUnavailable:
                prices = {}
        out = summarize(ledger, prices)
        out["recent_alerts"] = ledger["alerts"][-10:]
        out["recent_closed"] = ledger["closed"][-10:]
        out["priced_live"] = bool(prices)
        out["note"] = ("Paper results with pessimistic fills. Going live needs a separate owner decision; "
                       "this bot has no keys and cannot place trades.")
        return done(out)

    @skill("copytrade.vet")
    def vet(self, task):
        """payload: wallet, limit (default 100). Recent SOL-quoted swaps and round-trip P&L, to help pick traders."""
        wallet = (task.payload.get("wallet") or "").strip()
        if not wallet:
            return failed("payload.wallet is required")
        limit = min(int(task.payload.get("limit", 100)), 300)
        sigs = self._rpc("getSignaturesForAddress", [wallet, {"limit": limit}]) or []
        by_mint: dict[str, dict] = {}
        swaps = 0
        for s in reversed(sigs):
            if s.get("err") is not None:
                continue
            ev = parse_swap(self._rpc("getTransaction", [s["signature"], {"encoding": "jsonParsed",
                                                                         "maxSupportedTransactionVersion": 0}]), wallet)
            if not ev:
                continue
            swaps += 1
            m = by_mint.setdefault(ev["mint"], {"buys": 0, "sells": 0, "sol_in": 0.0, "sol_out": 0.0})
            m["buys" if ev["side"] == "buy" else "sells"] += 1
            m["sol_in" if ev["side"] == "buy" else "sol_out"] += ev["sol_amount"]
        round_trips = {k: v for k, v in by_mint.items() if v["buys"] and v["sells"]}
        pnl = [v["sol_out"] - v["sol_in"] for v in round_trips.values()]
        buys = [v["sol_in"] / v["buys"] for v in by_mint.values() if v["buys"]]
        return done({
            "wallet": wallet,
            "transactions_checked": len(sigs),
            "swaps": swaps,
            "tokens_traded": len(by_mint),
            "round_trips": len(round_trips),
            "round_trip_win_rate_pct": round(sum(p > 0 for p in pnl) / len(pnl) * 100, 1) if pnl else None,
            "round_trip_pnl_sol": round(sum(pnl), 3),
            "avg_buy_sol": round(sum(buys) / len(buys), 3) if buys else None,
            "note": "Small sample from recent history only; tokens still held are not counted as wins or losses.",
        })
