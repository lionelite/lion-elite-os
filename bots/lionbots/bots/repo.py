from __future__ import annotations

import shutil
import subprocess

from ..bot import Bot, blocked, done, failed, skill
from ..paths import REPO_ROOT

# Read-only / generation-only scripts. Nothing here sends, publishes, deploys,
# migrates a database or writes a ledger.
ALLOWED_SCRIPTS = {
    "agents:roster", "agents:knowledge", "agents:recall", "agents:plan",
    "agency:plan", "agency:proposal", "agency:internal", "agency:tickets",
    "agency:scope", "agency:portfolio", "agency:bench",
    "real-estate:demo", "validate:render",
}
# Never readable through a bot, even inside the repo.
PRIVATE_PARTS = {".env", ".git", "node_modules", "agency/clients", "agency/ledgers", "agency/bench", ".state"}
MAX_READ_BYTES = 200_000


def _inside_repo(rel: str):
    path = (REPO_ROOT / rel).resolve()
    if REPO_ROOT not in path.parents and path != REPO_ROOT:
        raise ValueError("path escapes the repository")
    rel_posix = path.relative_to(REPO_ROOT).as_posix()
    for private in PRIVATE_PARTS:
        if rel_posix == private or rel_posix.startswith(private + "/") or f"/{private}/" in f"/{rel_posix}/" \
                or path.name.startswith(".env"):
            raise ValueError(f"{rel_posix} is private")
    return path


class RepoBot(Bot):
    name = "repo"
    description = "Reads and searches this repository and runs allowlisted read-only npm scripts."
    keywords = {
        "repo.search": ["find", "search", "where is", "grep", "which file"],
        "repo.read": ["read", "open file", "show file"],
        "repo.script": ["roster", "portfolio", "bench", "agency plan", "agents plan"],
    }

    @skill("repo.search")
    def search(self, task):
        """payload: pattern (regex), glob (optional), max (default 50)."""
        pattern = task.payload.get("pattern") or task.payload.get("request")
        if not pattern:
            return failed("payload.pattern is required")
        cmd = ["git", "-C", str(REPO_ROOT), "grep", "-n", "-I", "-E", "--max-count", "5", pattern]
        if task.payload.get("glob"):
            cmd += ["--", task.payload["glob"]]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if proc.returncode not in (0, 1):
            return failed(proc.stderr.strip()[:500])
        hits = [line for line in proc.stdout.splitlines()
                if not any(line.startswith(p + "/") for p in PRIVATE_PARTS)]
        limit = int(task.payload.get("max", 50))
        return done({"pattern": pattern, "total": len(hits), "hits": hits[:limit]})

    @skill("repo.read")
    def read(self, task):
        """payload: path (repo-relative), start/end lines (optional)."""
        rel = task.payload.get("path")
        if not rel:
            return failed("payload.path is required")
        try:
            path = _inside_repo(rel)
        except ValueError as exc:
            return failed(str(exc))
        if not path.is_file():
            return failed(f"{rel} is not a file")
        text = path.read_bytes()[:MAX_READ_BYTES].decode("utf-8", errors="replace")
        lines = text.splitlines()
        start = max(1, int(task.payload.get("start", 1)))
        end = int(task.payload.get("end", len(lines)))
        return done({"path": rel, "lines": f"{start}-{min(end, len(lines))}",
                     "text": "\n".join(lines[start - 1:end])})

    @skill("repo.script")
    def script(self, task):
        """payload: script (allowlisted npm script), args (list)."""
        name = task.payload.get("script")
        if name not in ALLOWED_SCRIPTS:
            return failed(f"script must be one of {sorted(ALLOWED_SCRIPTS)}")
        npm = shutil.which("npm")
        if not npm:
            return blocked("npm is not installed here", gate="node/npm on PATH")
        args = [str(a) for a in task.payload.get("args", [])]
        proc = subprocess.run([npm, "run", "--silent", name, *(["--", *args] if args else [])],
                              cwd=REPO_ROOT, capture_output=True, text=True, timeout=300)
        out = {"script": name, "exit_code": proc.returncode, "stdout": proc.stdout[-20000:],
               "stderr": proc.stderr[-4000:]}
        return done(out) if proc.returncode == 0 else failed(f"{name} exited {proc.returncode}: {proc.stderr[-500:]}")
