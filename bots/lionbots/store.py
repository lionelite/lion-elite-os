"""Durable task board on SQLite (stdlib, no server to run).

Claiming is a single UPDATE ... WHERE status='queued' so two runner threads
or processes can never pick up the same task.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .task import QUEUED, RUNNING, STATUSES, TERMINAL, Task

DEFAULT_DB = Path(__file__).resolve().parent.parent / ".state" / "lionbots.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  skill TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  bot TEXT,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  requested_by TEXT NOT NULL DEFAULT 'owner',
  parent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, created_at);
CREATE TABLE IF NOT EXISTS bots (
  name TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL,
  state TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class TaskStore:
    def __init__(self, path: str | os.PathLike | None = None):
        self.path = str(path or os.getenv("LIONBOTS_DB") or DEFAULT_DB)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        if self.path != ":memory:":
            self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.executescript(SCHEMA)

    def _row(self, row: sqlite3.Row | None) -> Task | None:
        if row is None:
            return None
        d = dict(row)
        d["payload"] = json.loads(d["payload"])
        d["result"] = json.loads(d["result"]) if d["result"] is not None else None
        return Task(**d)

    def add(self, skill: str, payload: dict[str, Any] | None = None, *, status: str = QUEUED,
            requested_by: str = "owner", parent_id: str | None = None, max_attempts: int = 2,
            error: str | None = None) -> Task:
        if status not in STATUSES:
            raise ValueError(f"unknown status {status}")
        ts = now()
        task_id = uuid.uuid4().hex[:12]
        with self._lock:
            self._conn.execute(
                "INSERT INTO tasks (id, skill, payload, status, error, max_attempts, requested_by, parent_id, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (task_id, skill, json.dumps(payload or {}), status, error, max_attempts, requested_by, parent_id, ts, ts),
            )
        return self.get(task_id)

    def get(self, task_id: str) -> Task | None:
        with self._lock:
            return self._row(self._conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone())

    def list(self, status: str | None = None, limit: int = 50) -> list[Task]:
        q, args = "SELECT * FROM tasks", []
        if status:
            q += " WHERE status = ?"
            args.append(status)
        q += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            return [self._row(r) for r in self._conn.execute(q, args).fetchall()]

    def claim(self, skills: Iterable[str], bot: str) -> Task | None:
        """Atomically move the oldest queued task for these skills to running."""
        skills = list(skills)
        if not skills:
            return None
        marks = ",".join("?" * len(skills))
        with self._lock:
            row = self._conn.execute(
                f"UPDATE tasks SET status = ?, bot = ?, attempts = attempts + 1, updated_at = ?"
                f" WHERE id = (SELECT id FROM tasks WHERE status = ? AND skill IN ({marks})"
                f" ORDER BY created_at, rowid LIMIT 1) AND status = ? RETURNING *",
                (RUNNING, bot, now(), QUEUED, *skills, QUEUED),
            ).fetchone()
            return self._row(row)

    def finish(self, task_id: str, status: str, result: Any = None, error: str | None = None) -> Task:
        if status not in TERMINAL and status != QUEUED:
            raise ValueError(f"cannot finish with status {status}")
        with self._lock:
            self._conn.execute(
                "UPDATE tasks SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?",
                (status, json.dumps(result, default=str) if result is not None else None, error, now(), task_id),
            )
        return self.get(task_id)

    def requeue_stale(self, older_than_iso: str) -> int:
        """Return tasks stuck in `running` (a crashed runner) to the queue."""
        with self._lock:
            cur = self._conn.execute(
                "UPDATE tasks SET status = ?, updated_at = ? WHERE status = ? AND updated_at < ? AND attempts < max_attempts",
                (QUEUED, now(), RUNNING, older_than_iso),
            )
            return cur.rowcount

    def counts(self) -> dict[str, int]:
        with self._lock:
            rows = self._conn.execute("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").fetchall()
        return {r["status"]: r["n"] for r in rows}

    def heartbeat(self, bot: str, state: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO bots (name, last_seen, state) VALUES (?,?,?)"
                " ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen, state = excluded.state",
                (bot, now(), state),
            )

    def bot_states(self) -> dict[str, dict[str, str]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM bots").fetchall()
        return {r["name"]: {"last_seen": r["last_seen"], "state": r["state"]} for r in rows}
