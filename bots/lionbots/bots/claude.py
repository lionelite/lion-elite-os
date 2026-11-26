from __future__ import annotations

from .. import llm
from ..bot import Bot, done, failed, skill

SYSTEM = (
    "You are a member of the Lion Elite bot community, an internal team working for the owner of "
    "Lion Elite Wellness (Research-Use-Only peptides), Lion Elite Beauty (premium coaching), "
    "BuildPipeline.online and the personal brand AlexTheLionLifts. Your output is an internal draft or "
    "analysis: nothing you write is sent or published by you. Never give human dosing, administration or "
    "treatment guidance for research peptides. Never invent testimonials, results, statistics or sources; "
    "where a fact is needed and not supplied, write [NEEDS: ...]."
)


class ClaudeBot(Bot):
    name = "claude"
    description = "General-purpose bot for anything no specialist owns: research, writing, analysis, planning."

    @skill("claude.ask")
    def ask(self, task):
        """payload: prompt, system (optional), effort (optional)."""
        prompt = task.payload.get("prompt") or task.payload.get("request")
        if not prompt:
            return failed("payload.prompt is required")
        system = SYSTEM + ("\n\n" + task.payload["system"] if task.payload.get("system") else "")
        out = llm.ask(prompt, system=system, effort=task.payload.get("effort"))
        out["sent"] = False
        return done(out)
