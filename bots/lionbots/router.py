"""Turn a free-text request into (skill, payload).

Keyword routing first because it is free, instant and explainable; longer
phrases win ties because they are more specific ("size chart" beats
"shapewear"). Anything it cannot place goes to `claude.ask` when that bot
exists, otherwise to triage. When Claude is reachable it also fills the chosen
skill's payload fields from the text; without it the payload is just the text
and the bot says which fields it needs.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .community import Community

FALLBACK_SKILL = "claude.ask"


def pick_skill(community: Community, text: str) -> tuple[str, str]:
    lowered = text.lower()
    best: tuple[int, str] | None = None
    for bot in community.bots.values():
        for skill_name, words in (bot.keywords or {}).items():
            if skill_name not in community.owner:
                continue
            score = sum(len(w) for w in words if re.search(rf"\b{re.escape(w.lower())}", lowered))
            if score and (best is None or score > best[0]):
                best = (score, skill_name)
    if best:
        return best[1], "keyword match"
    if FALLBACK_SKILL in community.owner:
        return FALLBACK_SKILL, "no keyword match; general-purpose bot"
    return "triage.unrouted", "no keyword match and no general-purpose bot"


def extract_payload(community: Community, skill_name: str, text: str) -> dict[str, Any] | None:
    """Ask Claude to fill the skill's documented fields. None when it can't."""
    from . import llm

    bot = community.bots[community.owner[skill_name]]
    doc = (bot.skills()[skill_name].__doc__ or "").strip()
    prompt = (
        f"Convert this request into the JSON payload for the skill `{skill_name}`.\n"
        f"Skill documentation: {doc}\nRequest: {text}\n"
        "Return only a JSON object. Include only fields the request actually states; omit the rest. "
        "Never invent numbers."
    )
    try:
        out = llm.ask(prompt, effort="low", max_tokens=2000)["text"].strip()
        out = re.sub(r"^```(?:json)?|```$", "", out).strip()
        payload = json.loads(out)
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def route(community: Community, text: str, *, use_llm: bool = True) -> tuple[str, dict[str, Any], str]:
    """Return (skill, payload, why)."""
    skill_name, why = pick_skill(community, text)
    if skill_name == FALLBACK_SKILL:
        return skill_name, {"prompt": text}, why
    payload = {"request": text}
    if use_llm and skill_name != "triage.unrouted":
        extracted = extract_payload(community, skill_name, text)
        if extracted:
            payload.update(extracted)
            why += "; fields extracted by Claude"
    return skill_name, payload, why
