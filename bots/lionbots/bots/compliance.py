from __future__ import annotations

from .. import node_bridge
from ..bot import Bot, done, failed, skill

MODES = {"research-only", "coaching"}


class ComplianceBot(Bot):
    name = "compliance"
    description = "Checks copy against the RUO / coaching rules in lib/social/social-compliance.js."
    keywords = {"compliance.check": ["compliance", "compliant", "ruo", "check this copy", "allowed to say"]}

    @skill("compliance.check")
    def check(self, task):
        """payload: text, mode ('research-only' | 'coaching'), require_disclaimer."""
        text = task.payload.get("text") or task.payload.get("request")
        mode = task.payload.get("mode", "research-only")
        if not text:
            return failed("payload.text is required")
        if mode not in MODES:
            return failed(f"mode must be one of {sorted(MODES)}")
        return done(node_bridge.compliance(text, mode, bool(task.payload.get("require_disclaimer", False))))
