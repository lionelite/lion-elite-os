import threading
import time
import unittest

from helpers import community, run

from lionbots import guardrails, router, runner
from lionbots.bot import Bot, BotError, done, skill
from lionbots.community import RegistryError, discover
from lionbots.llm import LLMUnavailable
from lionbots.sources import SourceUnavailable


class Flaky(Bot):
    name = "flaky"
    description = "fails once, then works"
    calls = 0

    @skill("flaky.go")
    def go(self, task):
        type(self).calls += 1
        if type(self).calls == 1:
            raise BotError("transient")
        return done({"calls": type(self).calls}, follow_ups=[{"skill": "flaky.child", "payload": {"n": 1}}])

    @skill("flaky.child")
    def child(self, task):
        return done(task.payload)

    @skill("flaky.crash")
    def crash(self, task):
        raise KeyError("boom")

    @skill("flaky.offline")
    def offline(self, task):
        raise SourceUnavailable("example.org", "proxy 403")

    @skill("flaky.nollm")
    def nollm(self, task):
        raise LLMUnavailable("no key", "ANTHROPIC_API_KEY")


class RegistryTests(unittest.TestCase):
    def test_every_shipped_bot_registers(self):
        c = community()
        names = set(c.bots)
        for expected in {"memecoin", "fba", "research_peptides", "clinical_peptides", "brand_alex",
                         "buildpipeline", "shapewear", "claude", "finance", "repo", "compliance", "ops", "triage"}:
            self.assertIn(expected, names)
        self.assertEqual(len(c.owner), sum(len(b.skills()) for b in c.bots.values()))

    def test_bot_cannot_declare_a_send_skill(self):
        class Sender(Bot):
            name, description = "sender", "x"

            @skill("email.send")
            def s(self, task):
                return done()

        with self.assertRaisesRegex(RegistryError, "guardrails"):
            community([Sender])

    def test_duplicate_skill_rejected(self):
        class A(Bot):
            name, description = "a", "x"

            @skill("x.do")
            def d(self, t):
                return done()

        class B(A):
            name = "b"

        with self.assertRaisesRegex(RegistryError, "claimed by both"):
            community([A, B])

    def test_keywords_only_name_owned_skills(self):
        for cls in discover():
            for s in (cls.keywords or {}):
                self.assertIn(s, cls.skills(), f"{cls.name} keyword entry for unknown skill {s}")


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        Flaky.calls = 0
        self.c = community([Flaky])

    def test_refused_and_unowned_are_recorded_not_dropped(self):
        t = self.c.submit("flaky.go", {}, request_text="send an email to all clients")
        self.assertEqual(t.status, "refused")
        t = self.c.submit("nobody.owns", {})
        self.assertEqual(t.status, "needs_human")
        self.assertIn("flaky.go", t.error)
        self.assertEqual(self.c.store.counts(), {"refused": 1, "needs_human": 1})

    def test_retry_then_follow_up(self):
        self.c.submit("flaky.go", {})
        finished = runner.run_once(self.c)
        statuses = {t.skill: t.status for t in finished}
        self.assertEqual(statuses, {"flaky.go": "done", "flaky.child": "done"})
        parent = [t for t in finished if t.skill == "flaky.go"][-1]
        self.assertEqual(len([t for t in finished if t.skill == "flaky.go"]), 1)
        self.assertEqual(parent.attempts, 2)
        child = [t for t in finished if t.skill == "flaky.child"][0]
        self.assertEqual(child.parent_id, parent.id)
        self.assertEqual(child.requested_by, "flaky")

    def test_crash_is_failed_not_fatal(self):
        t = run(self.c, "flaky.crash")
        self.assertEqual(t.status, "failed")
        self.assertIn("KeyError", t.error)

    def test_outside_dependencies_block_with_the_gate(self):
        t = run(self.c, "flaky.offline")
        self.assertEqual(t.status, "blocked")
        self.assertIn("example.org", t.error)
        t = run(self.c, "flaky.nollm")
        self.assertEqual(t.status, "blocked")
        self.assertIn("ANTHROPIC_API_KEY", t.error)

    def test_claim_is_exclusive_across_threads(self):
        for _ in range(40):
            self.c.submit("flaky.child", {})
        got, lock = [], threading.Lock()

        def worker():
            while True:
                t = self.c.store.claim(["flaky.child"], "flaky")
                if not t:
                    return
                with lock:
                    got.append(t.id)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        [th.start() for th in threads]
        [th.join() for th in threads]
        self.assertEqual(len(got), 40)
        self.assertEqual(len(set(got)), 40)

    def test_serve_picks_up_work_and_stops(self):
        stop = threading.Event()
        th = threading.Thread(target=runner.serve, args=(self.c,), kwargs={"workers": 2, "poll_seconds": 0.05, "stop": stop})
        th.start()
        task = self.c.submit("flaky.child", {"x": 1})
        deadline = time.time() + 5
        while self.c.store.get(task.id).status != "done" and time.time() < deadline:
            time.sleep(0.05)
        stop.set()
        th.join(5)
        self.assertEqual(self.c.store.get(task.id).status, "done")
        self.assertEqual(self.c.store.bot_states()["flaky"]["state"], "stopped")


class GuardrailTests(unittest.TestCase):
    def test_refuses(self):
        for text in ["send an email to every clinic", "text all customers", "post this on instagram",
                     "buy 2 SOL of BONK", "set OUTREACH_SEND_ENABLED to true", "print the api key",
                     "force-push main", "upgrade our plan", "email.send", "reply to them on bluesky"]:
            self.assertIsNotNone(guardrails.check(text), text)

    def test_allows(self):
        for text in ["draft an email to send to clinics", "analyze last month's ad spend",
                     "write captions for alexthelionlifts", "screen this token", "what does BPC-157 research show",
                     "plan the shapewear launch"]:
            self.assertIsNone(guardrails.check(text), text)


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.c = community()

    def route(self, text):
        return router.route(self.c, text, use_llm=False)[0]

    def test_specific_phrase_wins(self):
        self.assertEqual(self.route("check the shapewear size chart"), "shapewear.size_chart")
        self.assertEqual(self.route("fba profit on a $30 item"), "fba.profit")
        self.assertEqual(self.route("evidence brief on semaglutide"), "clinical_peptides.evidence_brief")
        self.assertEqual(self.route("content plan for alexthelionlifts"), "brand_alex.week_plan")
        self.assertEqual(self.route("buildpipeline vsl script for roofers"), "buildpipeline.funnel_copy")

    def test_unplaced_goes_to_general_bot(self):
        skill_name, payload, _ = router.route(self.c, "write me a haiku about lifting", use_llm=False)
        self.assertEqual(skill_name, "claude.ask")
        self.assertEqual(payload["prompt"], "write me a haiku about lifting")


if __name__ == "__main__":
    unittest.main()
