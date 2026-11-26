"""Keeps the community at the ready: claims queued tasks and runs them."""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from .bot import BotError
from .community import Community
from .llm import LLMRefused, LLMUnavailable
from .node_bridge import NodeUnavailable
from .sources import SourceUnavailable
from .task import BLOCKED, DONE, FAILED, NEEDS_HUMAN, QUEUED, Task

log = logging.getLogger("lionbots")


def run_task(community: Community, task: Task) -> Task:
    bot = community.bots[community.owner[task.skill]]
    community.store.heartbeat(bot.name, f"working on {task.id}")
    try:
        outcome = bot.handle(task)
    except BotError as exc:
        if task.attempts < task.max_attempts:
            log.warning("task %s attempt %s failed, requeueing: %s", task.id, task.attempts, exc)
            community.store.heartbeat(bot.name, "idle")
            return community.store.finish(task.id, QUEUED, error=str(exc))
        outcome_status, result, error = FAILED, None, str(exc)
    # Outside dependencies a bot cannot fix by retrying: say exactly what is missing.
    except LLMUnavailable as exc:
        outcome_status, result, error = BLOCKED, None, f"{exc.reason} (gate: {exc.gate})"
    except SourceUnavailable as exc:
        outcome_status, result, error = BLOCKED, None, (
            f"cannot reach {exc.host} from this machine ({exc.detail}); run where that host is allowed (gate: network)")
    except NodeUnavailable as exc:
        outcome_status, result, error = BLOCKED, None, f"{exc} (gate: node on PATH)"
    except LLMRefused as exc:
        outcome_status, result, error = NEEDS_HUMAN, None, f"Claude declined: {exc}"
    except Exception as exc:  # a bug in a bot must not take down the runner
        log.exception("task %s crashed in %s", task.id, bot.name)
        outcome_status, result, error = FAILED, None, f"{type(exc).__name__}: {exc}"
    else:
        outcome_status, result, error = outcome.status, outcome.result, outcome.error
        if outcome.status == DONE:
            for f in outcome.follow_ups:
                community.submit(f["skill"], f.get("payload"), requested_by=bot.name, parent_id=task.id)
    community.store.heartbeat(bot.name, "idle")
    return community.store.finish(task.id, outcome_status, result=result, error=error)


def run_once(community: Community) -> list[Task]:
    """Drain the queue in this thread. Returns finished tasks."""
    finished = []
    while True:
        progressed = False
        for bot in community.bots.values():
            task = community.store.claim(bot.skills().keys(), bot.name)
            if task:
                progressed = True
                result = run_task(community, task)
                if result.status != QUEUED:  # a retry is not a finish
                    finished.append(result)
        if not progressed:
            return finished


def serve(community: Community, workers: int = 4, poll_seconds: float = 2.0,
          stop: threading.Event | None = None, stale_after_seconds: int = 900) -> None:
    """Run until stopped: one claim loop per bot, a shared pool for the work."""
    stop = stop or threading.Event()
    for bot in community.bots.values():
        community.store.heartbeat(bot.name, "ready")
    log.info("community ready: %d bots, %d skills, %d workers",
             len(community.bots), len(community.owner), workers)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        in_flight: set = set()
        while not stop.is_set():
            cutoff = (datetime.now(timezone.utc) - timedelta(seconds=stale_after_seconds)).isoformat(timespec="seconds")
            community.store.requeue_stale(cutoff)
            in_flight = {f for f in in_flight if not f.done()}
            claimed = False
            for bot in community.bots.values():
                if len(in_flight) >= workers:
                    break
                task = community.store.claim(bot.skills().keys(), bot.name)
                if task:
                    claimed = True
                    in_flight.add(pool.submit(run_task, community, task))
            if not claimed:
                stop.wait(poll_seconds)
    for bot in community.bots.values():
        community.store.heartbeat(bot.name, "stopped")
