from __future__ import annotations

from typing import Any, Callable

from .task import BLOCKED, DONE, FAILED, NEEDS_HUMAN, Outcome, Task


def done(result: Any = None, follow_ups: list[dict[str, Any]] | None = None) -> Outcome:
    return Outcome(DONE, result=result, follow_ups=follow_ups or [])


def blocked(reason: str, gate: str | None = None) -> Outcome:
    """The bot cannot proceed without something only a human can provide."""
    msg = f"{reason} (gate: {gate})" if gate else reason
    return Outcome(BLOCKED, error=msg)


def needs_human(reason: str) -> Outcome:
    return Outcome(NEEDS_HUMAN, error=reason)


def failed(reason: str) -> Outcome:
    return Outcome(FAILED, error=reason)


class BotError(Exception):
    """Raise for a retryable failure; the runner retries up to max_attempts."""


class Bot:
    """Base class. Subclass, set `name`/`description`, and decorate handlers with @skill.

    Bots are discovered automatically from `lionbots/bots/*.py`, so adding a
    new capability is one file.
    """

    name: str = ""
    description: str = ""
    # Words the free-text router uses to pick this bot's skills.
    keywords: dict[str, list[str]] = {}

    def __init__(self, context: dict[str, Any] | None = None):
        self.context = context or {}

    @classmethod
    def skills(cls) -> dict[str, Callable[["Bot", Task], Outcome]]:
        out = {}
        for attr in dir(cls):
            fn = getattr(cls, attr)
            skill_name = getattr(fn, "_lionbots_skill", None)
            if skill_name:
                out[skill_name] = fn
        return out

    @classmethod
    def skill_docs(cls) -> dict[str, str]:
        return {name: (fn.__doc__ or "").strip().splitlines()[0] if fn.__doc__ else "" for name, fn in cls.skills().items()}

    def handle(self, task: Task) -> Outcome:
        fn = self.skills().get(task.skill)
        if fn is None:
            return needs_human(f"{self.name} has no handler for {task.skill}")
        return fn(self, task)


def skill(name: str):
    def wrap(fn):
        fn._lionbots_skill = name
        return fn

    return wrap
