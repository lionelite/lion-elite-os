"""The community: which bots exist, what each one owns, and how work reaches them."""

from __future__ import annotations

import importlib
import pkgutil
import re
from typing import Any

from . import guardrails
from .bot import Bot
from .store import TaskStore
from .task import NEEDS_HUMAN, REFUSED, Task

SKILL_NAME = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")


class RegistryError(Exception):
    pass


def discover() -> list[type[Bot]]:
    """Every Bot subclass defined in lionbots/bots/*.py."""
    from . import bots as pkg

    found: list[type[Bot]] = []
    for mod in pkgutil.iter_modules(pkg.__path__):
        module = importlib.import_module(f"{pkg.__name__}.{mod.name}")
        for obj in vars(module).values():
            if isinstance(obj, type) and issubclass(obj, Bot) and obj is not Bot and obj.__module__ == module.__name__:
                found.append(obj)
    return sorted(found, key=lambda b: b.name)


class Community:
    def __init__(self, store: TaskStore, bot_classes: list[type[Bot]] | None = None,
                 context: dict[str, Any] | None = None):
        self.store = store
        self.bots: dict[str, Bot] = {}
        self.owner: dict[str, str] = {}  # skill -> bot name
        ctx = dict(context or {})
        ctx.setdefault("community", self)
        for cls in bot_classes if bot_classes is not None else discover():
            self.register(cls(ctx))

    def register(self, bot: Bot) -> None:
        if not bot.name or not bot.description:
            raise RegistryError(f"{type(bot).__name__} needs a name and description")
        if bot.name in self.bots:
            raise RegistryError(f"duplicate bot name {bot.name}")
        skills = bot.skills()
        if not skills:
            raise RegistryError(f"{bot.name} declares no skills")
        for s in skills:
            if not SKILL_NAME.match(s):
                raise RegistryError(f"{bot.name}: skill {s!r} must look like 'area.verb'")
            if s in self.owner:
                raise RegistryError(f"skill {s} claimed by both {self.owner[s]} and {bot.name}")
            reason = guardrails.check(s.replace(".", " ")) or guardrails.check(s)
            if reason:
                raise RegistryError(f"{bot.name}: skill {s} is refused by guardrails: {reason}")
            self.owner[s] = bot.name
        self.bots[bot.name] = bot

    def roster(self) -> list[dict[str, Any]]:
        states = self.store.bot_states()
        return [
            {
                "bot": b.name,
                "description": b.description,
                "skills": b.skill_docs(),
                "state": states.get(b.name, {}).get("state", "never run"),
                "last_seen": states.get(b.name, {}).get("last_seen"),
            }
            for b in self.bots.values()
        ]

    def submit(self, skill: str, payload: dict[str, Any] | None = None, *, request_text: str = "",
               requested_by: str = "owner", parent_id: str | None = None) -> Task:
        """Queue work. Refused work and unowned work are recorded, never silently dropped."""
        payload = dict(payload or {})
        reason = guardrails.check(skill) or guardrails.check(request_text)
        if reason:
            return self.store.add(skill, payload, status=REFUSED, error=reason,
                                  requested_by=requested_by, parent_id=parent_id)
        if skill not in self.owner:
            return self.store.add(skill, payload, status=NEEDS_HUMAN,
                                  error=f"No bot owns skill {skill!r}. Known skills: {', '.join(sorted(self.owner))}",
                                  requested_by=requested_by, parent_id=parent_id)
        return self.store.add(skill, payload, requested_by=requested_by, parent_id=parent_id)
