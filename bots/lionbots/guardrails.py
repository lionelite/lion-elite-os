"""Work the bots must refuse, mirroring the hard limits in CLAUDE.md.

Checked at submission, before a task is stored, and again at registration so
no bot can even declare a skill in these families. Refusing here is the point:
a bot community "ready for any task" is exactly the thing that will one day be
asked to send, post, or spend, and the answer has to come from code, not from
whoever wrote the next bot.
"""

from __future__ import annotations

import re

# (pattern over skill names and free text, reason shown to the requester,
#  whether asking for a *draft* of that thing is fine)
REFUSED_PATTERNS: list[tuple[re.Pattern[str], str, bool]] = [
    (re.compile(r"\b(send|blast)\w*\b.*\b(e-?mail|sms|texts?|messages?|dms?)\b|\b(e-?mail|sms|dm)\.send\b", re.I),
     "Sending e-mail/SMS/DMs is done only by the governed outreach pipeline (docs/automated-outreach.md), not by bots.", True),
    (re.compile(r"\b(text|sms|message|blast|dm)\w*\s+(all|every|each|our|my|the)\b.{0,30}\b(customers?|clients?|leads?|list|contacts?|subscribers?|prospects?|clinics?)\b", re.I),
     "Bulk messaging goes only through the governed, consent-gated outreach and SMS pipelines.", True),
    (re.compile(r"\b(post|publish|tweet|reply|like|follow)\w*\b.*\b(instagram|facebook|twitter|x\.com|bluesky|linkedin|tiktok|social)\b|\bsocial\.(post|publish|reply)\b", re.I),
     "Social posting/replies go only through the SOCIAL_PUBLISH_ENABLED pipeline; engagement with other people's posts is prohibited.", True),
    (re.compile(r"\b(buy|purchase|pay for|make a payment|charge (the|a|my|our) card|upgrade (the |our )?(plan|tier|billing)|add (a )?payment method|(raise|increase) (the )?(ad )?(spend|budget|cap))\b", re.I),
     "Purchases, payments, plan upgrades and spend increases need explicit owner authorization.", False),
    (re.compile(r"\b(enable|flip|turn on|set)\b.*\b(OUTREACH_SEND_ENABLED|SMS_SEND_ENABLED|SOCIAL_PUBLISH_ENABLED|BLUESKY_OUTREACH_ENABLED|send switch|kill switch)\b", re.I),
     "Send switches and the kill switch belong to the owner.", False),
    (re.compile(r"\b(force[- ]push|merge (in)?to main|disable branch protection|delete (the )?(prod|production) |drop table|truncate)\b", re.I),
     "History rewrites, protected-branch merges and production data deletion are hard limits.", False),
    (re.compile(r"\b(print|show|reveal|dump|echo)\b.*\b(api[_ ]?key|token|secret|password|credential)s?\b", re.I),
     "Secrets are never printed or exposed.", False),
]


def check(text: str) -> str | None:
    """Return a refusal reason, or None when the work is allowed."""
    text = text or ""
    drafting = bool(re.search(r"\bdraft", text, re.I))
    for pattern, reason, draft_ok in REFUSED_PATTERNS:
        if pattern.search(text) and not (draft_ok and drafting):
            return reason
    return None
