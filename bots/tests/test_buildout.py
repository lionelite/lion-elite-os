import json
import tempfile
import unittest
from pathlib import Path

from helpers import FakeResponse, community, run

from lionbots import sources
from lionbots.bots import clinic, copytrade
from lionbots.bots.copytrade import parse_swap

W = "Trader1111111111111111111111111111111111111"
MINT = "Meme111111111111111111111111111111111111111"


def tx(sol_delta_lamports, token_pre, token_post, sig="sig", err=None, fee=5000):
    pre = 10 * 10**9
    return {"blockTime": 1764000000, "transaction": {"signatures": [sig], "message": {"accountKeys": [{"pubkey": W}]}},
            "meta": {"err": err, "fee": fee, "preBalances": [pre], "postBalances": [pre + sol_delta_lamports - fee],
                     "preTokenBalances": [{"owner": W, "mint": MINT, "uiTokenAmount": {"uiAmount": token_pre}}] if token_pre else [],
                     "postTokenBalances": [{"owner": W, "mint": MINT, "uiTokenAmount": {"uiAmount": token_post}}] if token_post else []}}


class ParseSwap(unittest.TestCase):
    def test_buy(self):
        ev = parse_swap(tx(-1 * 10**9, None, 1000), W)
        self.assertEqual(ev["side"], "buy")
        self.assertAlmostEqual(ev["sol_amount"], 1.0)
        self.assertAlmostEqual(ev["price_sol"], 0.001)

    def test_partial_sell(self):
        ev = parse_swap(tx(2 * 10**9, 1000, 250), W)
        self.assertEqual(ev["side"], "sell")
        self.assertAlmostEqual(ev["sold_fraction"], 0.75)

    def test_failed_and_transfers_ignored(self):
        self.assertIsNone(parse_swap(tx(-10**9, None, 1000, err={"x": 1}), W))
        self.assertIsNone(parse_swap(tx(0, None, 1000), W))  # airdrop / transfer in


class FakeChain:
    """Routes Solana RPC POSTs and DexScreener GETs."""

    def __init__(self, price=0.2, liq=50_000):
        self.sigs, self.txs, self.price, self.liq = [], {}, price, liq

    def add(self, sig, t):
        self.sigs.insert(0, {"signature": sig, "err": None})
        self.txs[sig] = t

    def __call__(self, req, timeout=None):
        url = req.full_url
        if "dexscreener" in url:
            pairs = [{"baseToken": {"address": sources.WSOL, "symbol": "SOL"}, "priceUsd": "200", "liquidity": {"usd": 9e9}},
                     {"baseToken": {"address": MINT, "symbol": "MEME"}, "priceUsd": str(self.price), "liquidity": {"usd": self.liq}}]
            return FakeResponse(json.dumps(pairs).encode())
        body = json.loads(req.data)
        if body["method"] == "getSignaturesForAddress":
            opts = body["params"][1]
            out = []
            for s in self.sigs:
                if s["signature"] == opts.get("until"):
                    break
                out.append(s)
            return FakeResponse(json.dumps({"result": out[: opts["limit"]]}).encode())
        return FakeResponse(json.dumps({"result": self.txs[body["params"][0]]}).encode())


class CopyTrade(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.chain = FakeChain()
        self.c = community([copytrade.CopyTradeBot])
        bot = self.c.bots["copytrade"]
        bot.context.update(opener=self.chain, copytrade_state=str(Path(self.dir.name) / "s.json"))

    def tearDown(self):
        self.dir.cleanup()

    def test_needs_wallets_from_owner(self):
        t = run(self.c, "copytrade.watch", {"wallets": ""})
        self.assertEqual(t.status, "blocked")

    def test_follow_buy_then_sell_in_paper(self):
        p = {"wallets": [W]}
        self.chain.add("old", tx(-10**9, None, 1000))
        t = run(self.c, "copytrade.watch", p)  # first look: start from now, no copying history
        self.assertEqual(t.result["paper_fills"], [])
        # Trader buys 1 SOL for 1000 tokens: 0.001 SOL = $0.20/token
        self.chain.add("b1", tx(-10**9, None, 1000))
        t = run(self.c, "copytrade.watch", p)
        self.assertEqual(t.result["alerts"][0]["side"], "buy")
        fill = t.result["paper_fills"][0]
        self.assertEqual(fill["action"], "paper_buy")
        self.assertEqual(fill["usd"], 25.0)  # 10% of $250
        self.assertFalse(t.result["live_trading"])
        # Trader sells everything at 2x
        self.chain.add("s1", tx(2 * 10**9, 1000, None))
        t = run(self.c, "copytrade.watch", p)
        sell = t.result["paper_fills"][0]
        self.assertEqual(sell["action"], "paper_sell")
        self.assertGreater(sell["pnl_usd"], 20)  # ~2x minus slippage both sides and fees
        r = run(self.c, "copytrade.report", {"offline": True}).result
        self.assertEqual(r["closed_trades"], 1)
        self.assertEqual(r["win_rate_pct"], 100.0)

    def test_small_buys_and_thin_pools_are_not_copied(self):
        p = {"wallets": [W]}
        self.chain.add("old", tx(-10**9, None, 1))
        run(self.c, "copytrade.watch", p)
        self.chain.add("tiny", tx(-10**8, None, 100))  # 0.1 SOL < 0.5 minimum
        self.assertEqual(run(self.c, "copytrade.watch", p).result["alerts"], [])
        self.chain.liq = 2_000
        self.chain.add("thin", tx(-10**9, None, 1000))
        t = run(self.c, "copytrade.watch", p)
        self.assertEqual(t.result["paper_fills"][0]["action"], "skip")

    def test_stop_loss(self):
        p = {"wallets": [W]}
        self.chain.add("old", tx(-10**9, None, 1))
        run(self.c, "copytrade.watch", p)
        self.chain.add("b1", tx(-10**9, None, 1000))
        run(self.c, "copytrade.watch", p)
        self.chain.price = 0.05  # -75%
        t = run(self.c, "copytrade.watch", p)
        self.assertEqual(t.result["paper_fills"][0]["why"], "stop loss")

    def test_no_trading_skills_exist(self):
        skills = set(copytrade.CopyTradeBot.skills())
        self.assertEqual(skills, {"copytrade.watch", "copytrade.report", "copytrade.vet"})
        src = Path(copytrade.__file__).read_text()
        for word in ("sendTransaction", "private_key", "Keypair", "sign("):
            self.assertNotIn(word, src)


class Clinic(unittest.TestCase):
    def test_health_explained(self):
        c = community([clinic.ClinicBot])
        body = {"ok": True, "status": "degraded", "reasons": ["2 uncertain submission(s) held"], "acceptedToday": 40,
                "dailySendCap": 150, "window": {"open": True}, "lastRunAt": "2026-11-25T15:00:00Z", "lastError": None}
        c.bots["clinic"].context["opener"] = lambda req, timeout=None: FakeResponse(json.dumps(body).encode())
        t = run(c, "clinic.health")
        self.assertEqual(t.result["verdict"], "watch")
        self.assertIn("40 of 150 clinic e-mails accepted today (New York day).", t.result["summary"])

    def test_audit_needs_credentials(self):
        c = community([clinic.ClinicBot])
        c.bots["clinic"].context["env"] = {"X": "1"}
        self.assertEqual(run(c, "clinic.audit").status, "blocked")

    def test_audit_is_read_only(self):
        c = community([clinic.ClinicBot])
        methods = []

        class R(FakeResponse):
            headers = {"Content-Range": "0-0/7"}

        def opener(req, timeout=None):
            methods.append(req.get_method())
            return R(b"[]")

        c.bots["clinic"].context.update(env={"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"}, opener=opener)
        t = run(c, "clinic.audit")
        self.assertEqual(t.status, "done")
        self.assertEqual(t.result["prospects_total"], 7)
        self.assertEqual(set(methods), {"GET"})


if __name__ == "__main__":
    unittest.main()
