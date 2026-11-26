import io
import json
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lionbots.community import Community  # noqa: E402
from lionbots.store import TaskStore  # noqa: E402

needs_node = unittest.skipUnless(shutil.which("node"), "node not installed")


def community(bot_classes=None):
    return Community(TaskStore(":memory:"), bot_classes)


def run(c, skill, payload=None):
    from lionbots import runner

    task = c.submit(skill, payload or {})
    if task.status != "queued":
        return task
    return runner.run_task(c, c.store.claim([skill], c.owner[skill]))


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_opener(routes):
    """routes: list of (substring of url, json-able body). First match wins."""
    calls = []

    def opener(req, timeout=None):
        calls.append(req.full_url)
        for needle, body in routes:
            if needle in req.full_url:
                return FakeResponse(json.dumps(body).encode())
        raise AssertionError(f"unexpected url {req.full_url}")

    opener.calls = calls
    return opener
