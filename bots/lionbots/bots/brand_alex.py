"""AlexTheLionLifts personal-brand content. Drafts only.

Positioning comes from knowledge/brands.md and ai-agents/marketing-agent.md:
founder authority, training, discipline, athletic development, consistency,
leadership, recovery, lifestyle. Not every post is a pitch.

@alexthelionlifts is not one of the accounts the social publish pipeline
posts to, so nothing here publishes. The owner posts.
"""

from __future__ import annotations

from datetime import date, timedelta

from .. import llm
from ..bot import Bot, done, failed, skill
from ..drafts import gated_draft

HANDLE = "@alexthelionlifts"
PILLARS = ["training", "discipline", "athletic development", "consistency", "leadership", "recovery", "lifestyle"]
FORMATS = ["reel", "carousel", "reel", "story series", "reel", "carousel", "talking-head reel"]
ANGLES = {
    "training": "a lift, session or programming principle from this week",
    "discipline": "a choice made when motivation was low",
    "athletic development": "a movement or athletic quality being built, and why",
    "consistency": "what showing up looked like over a long stretch",
    "leadership": "a lesson from building and running the businesses",
    "recovery": "sleep, deloads, or managing a hard week",
    "lifestyle": "a real day: training around work",
}
# Roughly one post in five carries a direct coaching CTA.
CTA_DAYS = {2, 6}
SOFT_CTA = "Coaching applications are open: link in bio."


def week_plan(start: date) -> list[dict]:
    offset = start.toordinal() % len(PILLARS)
    out = []
    for i in range(7):
        pillar = PILLARS[(offset + i) % len(PILLARS)]
        out.append({
            "date": (start + timedelta(days=i)).isoformat(),
            "pillar": pillar,
            "format": FORMATS[i],
            "angle": ANGLES[pillar],
            "cta": SOFT_CTA if i in CTA_DAYS else "none: build trust, no pitch",
            "needs_from_owner": "real footage or a real story for this angle",
        })
    return out


class AlexBrandBot(Bot):
    name = "brand_alex"
    description = f"{HANDLE} personal brand: weekly content plans, hooks and captions (drafts, never posted)."
    keywords = {
        "brand_alex.week_plan": ["alexthelionlifts", "content calendar", "content plan", "personal brand"],
        "brand_alex.captions": ["caption", "hooks", "reel hook", "instagram caption"],
    }

    @skill("brand_alex.week_plan")
    def week(self, task):
        """payload: start (YYYY-MM-DD, default today). Seven days across the brand pillars."""
        start = date.fromisoformat(task.payload["start"]) if task.payload.get("start") else date.today()
        return done({"handle": HANDLE, "plan": week_plan(start), "published": False})

    @skill("brand_alex.captions")
    def captions(self, task):
        """payload: topic (what actually happened), pillar, count (default 3), cta (bool)."""
        p = task.payload
        topic = p.get("topic") or p.get("request")
        if not topic:
            return failed("payload.topic is required: the real moment or lesson the post is about")
        count = max(1, min(int(p.get("count", 3)), 6))
        schema = {"type": "object", "additionalProperties": False, "required": ["options"],
                  "properties": {"options": {"type": "array", "items": {
                      "type": "object", "additionalProperties": False, "required": ["hook", "caption"],
                      "properties": {"hook": {"type": "string"}, "caption": {"type": "string"}}}}}}
        prompt = (
            f"Write {count} Instagram post options for {HANDLE}, a founder who lifts and coaches. "
            f"Pillar: {p.get('pillar', 'any')}. What actually happened: {topic}\n"
            "Voice: direct, disciplined, confident, earned; first person; no hype, no emojis walls, no hashtag "
            "spam (max 3). Each option: a hook under 12 words for the first frame, and a caption under 120 words. "
            f"{'End with: ' + SOFT_CTA if p.get('cta') else 'No sales pitch.'} "
            "Do not invent numbers, PRs, client results or quotes; use [NEEDS: ...] for any you would want. "
            "No peptide, drug or supplement dosing, no body-transformation promises."
        )
        options = llm.ask(prompt, schema=schema)["json"]["options"]
        return done({"handle": HANDLE, "options": [
            {"hook": o["hook"], **gated_draft(o["hook"] + "\n\n" + o["caption"], "coaching")} for o in options]})

    @skill("brand_alex.check")
    def check(self, task):
        """payload: text. Coaching-mode compliance check."""
        if not task.payload.get("text"):
            return failed("payload.text is required")
        return done(gated_draft(task.payload["text"], "coaching"))
