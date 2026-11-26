"""python -m lionbots <command>

  roster                         every bot, its skills, and its last heartbeat
  ask "<anything>"               route free text to a bot, queue it, run it now
  submit <skill> [json payload]  queue a specific skill
  run                            drain the queue once
  serve [--workers N]            stay up and work tasks as they arrive
  list [--status S]              recent tasks
  show <task id>                 one task with its full result
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import threading

from . import router, runner
from .community import Community
from .store import TaskStore


def _print(obj) -> None:
    print(json.dumps(obj, indent=2, default=str))


def _summary(task) -> str:
    detail = task.error or ""
    return f"{task.id}  {task.status:<11} {task.skill:<34} {detail[:80]}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="lionbots", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", help="task board path (default bots/.state/lionbots.db or $LIONBOTS_DB)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("roster")
    a = sub.add_parser("ask"); a.add_argument("text"); a.add_argument("--queue-only", action="store_true")
    a.add_argument("--no-llm", action="store_true", help="keyword routing only; no Claude call to fill fields")
    s = sub.add_parser("submit"); s.add_argument("skill"); s.add_argument("payload", nargs="?", default="{}")
    s.add_argument("--queue-only", action="store_true")
    sub.add_parser("run")
    sv = sub.add_parser("serve"); sv.add_argument("--workers", type=int, default=4); sv.add_argument("--poll", type=float, default=2.0)
    ls = sub.add_parser("list"); ls.add_argument("--status"); ls.add_argument("--limit", type=int, default=25)
    sh = sub.add_parser("show"); sh.add_argument("id")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)
    community = Community(TaskStore(args.db))

    if args.cmd == "roster":
        for b in community.roster():
            print(f"\n{b['bot']}  [{b['state']}]\n  {b['description']}")
            for skill_name, doc in b["skills"].items():
                print(f"    {skill_name:<36} {doc}")
        return 0

    if args.cmd in ("ask", "submit"):
        if args.cmd == "ask":
            skill_name, payload, why = router.route(community, args.text, use_llm=not args.no_llm)
            print(f"routed to {skill_name} ({why})", file=sys.stderr)
            task = community.submit(skill_name, payload, request_text=args.text)
        else:
            try:
                payload = json.loads(args.payload)
            except json.JSONDecodeError as exc:
                print(f"payload is not JSON: {exc}", file=sys.stderr)
                return 2
            task = community.submit(args.skill, payload)
        if task.status == "queued" and not args.queue_only:
            claimed = community.store.claim([task.skill], community.owner[task.skill])
            task = runner.run_task(community, claimed) if claimed else community.store.get(task.id)
        _print(task.to_dict())
        return 0 if task.status in ("done", "queued") else 1

    if args.cmd == "run":
        for t in runner.run_once(community):
            print(_summary(t))
        _print(community.store.counts())
        return 0

    if args.cmd == "serve":
        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())
        runner.serve(community, workers=args.workers, poll_seconds=args.poll, stop=stop)
        return 0

    if args.cmd == "list":
        for t in community.store.list(args.status, args.limit):
            print(_summary(t))
        return 0

    if args.cmd == "show":
        task = community.store.get(args.id)
        if not task:
            print("no such task", file=sys.stderr)
            return 1
        _print(task.to_dict())
        return 0
    return 2
