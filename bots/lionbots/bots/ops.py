from __future__ import annotations

from ..bot import Bot, done, needs_human, skill


class OpsBot(Bot):
    name = "ops"
    description = "Community health: who is ready, what is queued, what is stuck."
    keywords = {"ops.status": ["status", "health", "queue", "stuck", "who is ready", "bots"]}

    @skill("ops.status")
    def status(self, task):
        """Report task counts and every bot's last heartbeat."""
        community = self.context.get("community")
        if community is None:
            return done({"note": "no community in context"})
        return done({"tasks": community.store.counts(), "bots": community.roster()})

    @skill("ops.ping")
    def ping(self, task):
        """Round-trip check that the runner is picking up work."""
        return done({"pong": True, "echo": task.payload})


class TriageBot(Bot):
    name = "triage"
    description = "Holds requests no bot can place yet, so they are seen instead of lost."

    @skill("triage.unrouted")
    def unrouted(self, task):
        """Record an unplaceable request for a human to route or build a bot for."""
        return needs_human(
            "No bot owns this yet. Route it with `submit <skill>`, or add a bot under bots/lionbots/bots/."
        )
