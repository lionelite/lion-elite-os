from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

QUEUED = "queued"
RUNNING = "running"
DONE = "done"
FAILED = "failed"
# A bot reached a gate it may not open (missing credential, human decision).
BLOCKED = "blocked"
# Nobody owns this kind of work yet; a human has to route or build a bot.
NEEDS_HUMAN = "needs_human"
# Refused by guardrails at submission time; never stored as runnable work.
REFUSED = "refused"

TERMINAL = {DONE, FAILED, BLOCKED, NEEDS_HUMAN, REFUSED}
STATUSES = {QUEUED, RUNNING} | TERMINAL


@dataclass
class Task:
    id: str
    skill: str
    payload: dict[str, Any] = field(default_factory=dict)
    status: str = QUEUED
    bot: str | None = None
    result: Any = None
    error: str | None = None
    attempts: int = 0
    max_attempts: int = 2
    requested_by: str = "owner"
    parent_id: str | None = None
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


@dataclass
class Outcome:
    """What a bot hands back. Use the helpers in bot.py rather than building one."""

    status: str
    result: Any = None
    error: str | None = None
    follow_ups: list[dict[str, Any]] = field(default_factory=list)
