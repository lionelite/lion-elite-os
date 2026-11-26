"""BuildPipeline.online: VSL funnel copy, config validation, funnel reports.

Uses lib/platform/vsl-funnel.js so the bot applies the same rules the live
funnel API does (a published funnel needs a real scheduling page, etc.).
"""

from __future__ import annotations

from .. import llm, node_bridge
from ..bot import Bot, done, failed, skill

MODULE = "lib/platform/vsl-funnel.js"


def validate(config: dict, status: str = "draft") -> dict:
    res = node_bridge.call(MODULE, "normalizeFunnelConfig", config, {"status": status})
    if res["ok"]:
        return {"valid": True, "status": status, "config": res["value"]}
    return {"valid": False, "status": status, "error": res["error"], "code": res.get("code")}


class BuildPipelineBot(Bot):
    name = "buildpipeline"
    description = "BuildPipeline.online VSL funnels: draft copy + script, validate configs, report conversion."
    keywords = {
        "buildpipeline.funnel_copy": ["buildpipeline", "vsl", "funnel copy", "sales video", "vsl script"],
        "buildpipeline.validate_funnel": ["validate funnel", "funnel config", "publish funnel"],
        "buildpipeline.funnel_report": ["funnel report", "funnel conversion", "funnel stats"],
    }

    @skill("buildpipeline.validate_funnel")
    def validate_funnel(self, task):
        """payload: config, status ('draft' | 'published')."""
        config = task.payload.get("config")
        if not isinstance(config, dict):
            return failed("payload.config must be an object")
        return done(validate(config, task.payload.get("status", "draft")))

    @skill("buildpipeline.funnel_report")
    def funnel_report(self, task):
        """payload: events [{type, sessionId}]. Step-by-step conversion."""
        events = task.payload.get("events")
        if not isinstance(events, list):
            return failed("payload.events must be a list")
        res = node_bridge.call(MODULE, "funnelReport", events)
        return done(res["value"]) if res["ok"] else failed(res["error"])

    @skill("buildpipeline.funnel_copy")
    def funnel_copy(self, task):
        """payload: offer, audience, calendar_url (optional), proof (real items only). Config + VSL script."""
        p = task.payload
        offer = p.get("offer") or p.get("request")
        if not offer:
            return failed("payload.offer is required")
        schema = {"type": "object", "additionalProperties": False,
                  "required": ["headline", "subheadline", "ctaLabel", "qualificationQuestions", "vsl_script"],
                  "properties": {"headline": {"type": "string"}, "subheadline": {"type": "string"},
                                 "ctaLabel": {"type": "string"},
                                 "qualificationQuestions": {"type": "array", "items": {"type": "string"}},
                                 "vsl_script": {"type": "string"}}}
        prompt = (
            f"Draft a BuildPipeline video-sales-letter funnel. Offer: {offer}. "
            f"Audience: {p.get('audience', 'unspecified')}.\n"
            "Return: headline (under 90 chars), subheadline (under 160), ctaLabel (under 40, e.g. 'Apply for a "
            "call'), 3-5 qualificationQuestions that separate buyers from browsers, and a 3-5 minute vsl_script "
            "(hook, problem, mechanism, offer, who it is not for, call to action) with [B-ROLL] cues. "
            "Do not invent testimonials, client names, revenue figures or guarantees: write [NEEDS: real proof] "
            "where proof belongs."
        )
        draft = llm.ask(prompt, schema=schema, effort="high")["json"]
        config = {k: draft[k] for k in ("headline", "subheadline", "ctaLabel", "qualificationQuestions")}
        config["proof"] = [str(x) for x in p.get("proof", [])]
        if p.get("calendar_url"):
            config["calendarUrl"] = p["calendar_url"]
        return done({
            "config": config,
            "vsl_script": draft["vsl_script"],
            "draft_check": validate(config, "draft"),
            "publish_check": validate(config, "published"),
            "published": False,
        })
