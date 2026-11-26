"""Shared shape for anything a bot writes that a person might later publish."""

from __future__ import annotations

from . import node_bridge


def gated_draft(text: str, mode: str, require_disclaimer: bool = False) -> dict:
    """Run a draft through the repo's validator and label it honestly.

    `customer_ready` is True only when the validator ran and approved. A draft
    the validator could not check is not "probably fine"; it is unchecked.
    """
    try:
        verdict = node_bridge.compliance(text, mode, require_disclaimer)
    except node_bridge.NodeUnavailable as exc:
        return {"draft": text, "customer_ready": False, "compliance": None,
                "note": f"Not checked: {exc}. Run compliance.check before using it."}
    return {
        "draft": text,
        "customer_ready": bool(verdict["approved"]),
        "compliance": verdict,
        "note": None if verdict["approved"] else "INTERNAL ONLY: fix the blockers before this is used anywhere.",
        "sent": False,
    }
