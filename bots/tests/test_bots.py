import unittest
from datetime import date

from helpers import community, fake_opener, needs_node, run

from lionbots import llm, sources
from lionbots.bots import brand_alex, memecoin, shapewear


class OfflineBots(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = community()

    def test_fba_profit(self):
        t = run(self.c, "fba.profit", {"price": 40, "landed_cost": 8, "fba_fee": 6, "ppc_per_unit": 4,
                                       "referral_fee_pct": 15, "units_per_month": 100})
        r = t.result
        self.assertEqual(r["net_profit_per_unit"], 16.0)  # 40 - 8 - 6 - 6 - 4
        self.assertEqual(r["breakeven_acos_pct"], 50.0)  # 20 / 40
        self.assertEqual(r["monthly_net_profit"], 1600.0)

    def test_fba_profit_never_guesses_the_fee(self):
        t = run(self.c, "fba.profit", {"price": 40, "landed_cost": 8})
        self.assertEqual(t.status, "failed")
        self.assertIn("fba_fee", t.error)

    def test_fba_screen_stops_restricted_products(self):
        t = run(self.c, "fba.screen", {"name": "Semaglutide research kit", "price": 50})
        self.assertEqual(t.result["verdict"], "stop")

    def test_memecoin_hard_flags_and_unknowns(self):
        s = memecoin.screen({"honeypot": True, "liquidity_usd": 50000})
        self.assertEqual(s["verdict"], "avoid")
        s = memecoin.screen({"liquidity_usd": 50000})
        self.assertEqual(s["verdict"], "unverified - high risk")
        self.assertIn("honeypot", s["unknown"])

    def test_memecoin_size_caps_allocation_whatever_the_stop(self):
        t = run(self.c, "memecoin.size", {"bankroll": 10000, "entry": 1, "stop": 0.9, "risk_pct": 50, "max_alloc_pct": 50})
        self.assertLessEqual(t.result["allocation_usd"], 1000)  # max_alloc capped at 10%
        self.assertEqual(t.result["risk_pct"], 5.0)

    def test_shapewear_size_chart_and_claims(self):
        t = run(self.c, "shapewear.size_chart", {"chart": [
            {"size": "S", "waist_min": 24, "waist_max": 27}, {"size": "M", "waist_min": 27, "waist_max": 30}]})
        self.assertTrue(t.result["ok"])
        self.assertTrue(shapewear.claim_issues("Lose 3 inches instantly with medical-grade compression"))
        self.assertFalse(shapewear.claim_issues("Smooths and supports under fitted clothes"))

    def test_shapewear_plan_lists_missing_facts(self):
        t = run(self.c, "shapewear.launch_plan", {"launch_date": "2027-01-15"})
        self.assertIn("price", t.result["missing_facts"])
        self.assertEqual(t.result["timeline"][-1]["date"], "2027-01-22")

    def test_alex_week_plan_is_mostly_not_a_pitch(self):
        plan = brand_alex.week_plan(date(2026, 11, 23))
        self.assertEqual(len(plan), 7)
        self.assertEqual(sum(1 for d in plan if d["cta"].startswith("Coaching")), 2)
        self.assertEqual(len({d["pillar"] for d in plan}), 7)

    def test_finance_bot_uses_the_real_engine(self):
        t = run(self.c, "finance.analyze_property", {"case": {
            "name": "t", "purchase_price": 300000, "units": 2, "annual_rent": 30000, "annual_operating_expenses": 10000,
            "annual_debt_service": 22000, "annual_interest": 18000, "cash_invested": 80000,
            "closing_costs_capitalized": 5000, "land_value": 60000}})
        self.assertEqual(t.status, "done")
        self.assertEqual(t.result["investment_metrics"]["cash_flow_before_tax"], -2000)
        self.assertNotEqual(t.result["decision"], "BUY")

    def test_repo_bot_keeps_private_paths_private(self):
        for path in (".env", "agency/ledgers/x.json", "../../etc/passwd", ".git/config"):
            t = run(self.c, "repo.read", {"path": path})
            self.assertEqual(t.status, "failed", path)
        t = run(self.c, "repo.script", {"script": "db:migrate"})
        self.assertEqual(t.status, "failed")

    @needs_node
    def test_ruo_copy_check_uses_repo_validator(self):
        bad = run(self.c, "research_peptides.copy_check", {"text": "Inject 5mg daily for healing."}).result
        self.assertFalse(bad["customer_ready"])
        good = run(self.c, "research_peptides.copy_check", {
            "text": "Lyophilized research peptide, HPLC-verified. For laboratory research purposes only."}).result
        self.assertTrue(good["customer_ready"], good)

    @needs_node
    def test_buildpipeline_uses_live_funnel_rules(self):
        t = run(self.c, "buildpipeline.validate_funnel", {"config": {"headline": "h", "ctaLabel": "Apply",
                                                                     "calendarUrl": "https://calendly.com/"},
                                                          "status": "published"})
        self.assertEqual(t.result["code"], "CALENDAR_REQUIRED")
        t = run(self.c, "buildpipeline.validate_funnel", {"config": {"headline": "h", "ctaLabel": "Apply",
                                                                     "calendarUrl": "https://calendly.com/x/intro"},
                                                          "status": "published"})
        self.assertTrue(t.result["valid"])


class NetworkedSources(unittest.TestCase):
    def test_pubmed_parsing(self):
        opener = fake_opener([
            ("esearch", {"esearchresult": {"idlist": ["111"]}}),
            ("esummary", {"result": {"111": {"title": "A trial", "fulljournalname": "J", "pubdate": "2024 Jan",
                                             "pubtype": ["Randomized Controlled Trial"]}}}),
        ])
        out = sources.pubmed_search("x", clinical_only=True, opener=opener)
        self.assertEqual(out[0]["pmid"], "111")
        self.assertEqual(out[0]["year"], "2024")
        self.assertIn("randomized+controlled+trial", opener.calls[0].lower())

    def test_trials_parsing(self):
        body = {"studies": [{"hasResults": True, "protocolSection": {
            "identificationModule": {"nctId": "NCT1", "briefTitle": "T"},
            "statusModule": {"overallStatus": "COMPLETED"},
            "designModule": {"phases": ["PHASE3"], "enrollmentInfo": {"count": 300}},
            "sponsorCollaboratorsModule": {"leadSponsor": {"name": "S"}}}}]}
        out = sources.trials_search("x", opener=fake_opener([("clinicaltrials", body)]))
        self.assertEqual(out[0]["nct_id"], "NCT1")
        self.assertEqual(out[0]["phases"], ["PHASE3"])

    def test_dex_sorted_by_liquidity(self):
        body = {"pairs": [{"baseToken": {"symbol": "A"}, "liquidity": {"usd": 10}},
                          {"baseToken": {"symbol": "B"}, "liquidity": {"usd": 900}}]}
        out = sources.dex_search("x", opener=fake_opener([("dexscreener", body)]))
        self.assertEqual([p["symbol"] for p in out], ["B", "A"])

    def test_unreachable_host_is_reported_not_empty(self):
        import urllib.error

        def opener(req, timeout=None):
            raise urllib.error.URLError("Tunnel connection failed: 403")

        with self.assertRaises(sources.SourceUnavailable) as ctx:
            sources.pubmed_search("x", opener=opener)
        self.assertEqual(ctx.exception.host, "eutils.ncbi.nlm.nih.gov")


class ClaudeBackedBots(unittest.TestCase):
    """Without credentials they block and name the gate; with a fake client they gate drafts."""

    def tearDown(self):
        llm._client = None

    def test_blocks_without_client(self):
        def unavailable():
            raise llm.LLMUnavailable("the anthropic package is not installed", "pip install -r bots/requirements.txt")

        orig = llm._get_client
        llm._get_client = unavailable
        try:
            t = run(community(), "claude.ask", {"prompt": "hi"})
        finally:
            llm._get_client = orig
        self.assertEqual(t.status, "blocked")
        self.assertIn("pip install", t.error)

    @needs_node
    def test_shapewear_copy_flags_claims_even_if_model_writes_them(self):
        orig = llm.ask
        llm.ask = lambda *a, **k: {"text": "Lose 2 inches in a day. Guaranteed."}
        try:
            t = run(community(), "shapewear.copy", {"product": "sculpt bodysuit"})
        finally:
            llm.ask = orig
        self.assertFalse(t.result["customer_ready"])
        self.assertTrue(t.result["claim_issues"])


if __name__ == "__main__":
    unittest.main()


class EvidenceBriefSources(unittest.TestCase):
    def test_supplied_sources_are_not_refetched(self):
        orig_ask, orig_trials, orig_pub = llm.ask, sources.trials_search, sources.pubmed_search
        sources.trials_search = sources.pubmed_search = lambda *a, **k: self.fail("should not fetch")
        llm.ask = lambda *a, **k: {"text": "brief citing NCT1"}
        try:
            t = run(community(), "clinical_peptides.evidence_brief",
                    {"compound": "x", "trials": [{"nct_id": "NCT1"}], "articles": []})
        finally:
            llm.ask, sources.trials_search, sources.pubmed_search = orig_ask, orig_trials, orig_pub
        self.assertEqual(t.status, "done")
        self.assertTrue(t.result["internal_only"])
