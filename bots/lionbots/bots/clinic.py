"""Clinic outreach monitor: is the Lion Elite Wellness clinic campaign healthy?

Read-only by construction. It reads the public /health/outreach endpoint and,
when Supabase credentials are present, counts rows in the outreach tables.
It never sends, never queues, never edits a prospect, and never prints
recipients or message bodies. Sending belongs to the Node pipeline on Render.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .. import sources
from ..bot import Bot, blocked, done, skill

NY = ZoneInfo("America/New_York")
QUEUE_STATUSES = ("pending", "processing", "sent", "failed", "uncertain", "skipped")


def explain_health(report: dict) -> dict:
    """Turn the /health/outreach JSON into a verdict and plain-English lines."""
    status = str(report.get("status", "unknown")).lower()
    reasons = list(report.get("reasons") or [])
    lines = []
    sent = report.get("acceptedToday")
    if sent is None:
        sent = report.get("sendsToday")
    cap = report.get("dailySendCap")
    if sent is not None and cap:
        lines.append(f"{sent} of {cap} clinic e-mails accepted today (New York day).")
    if report.get("lastRunAt"):
        lines.append(f"Last outreach run: {report['lastRunAt']}.")
    win = report.get("window") or {}
    if isinstance(win, dict) and "open" in win:
        lines.append("Sending window is open." if win["open"] else "Sending window is closed right now.")
    for r in reasons:
        lines.append(f"Issue: {r}")
    err = report.get("lastError")
    if isinstance(err, dict) and err.get("message"):
        lines.append(f"Last error ({err.get('source')}, {err.get('at')}): {err['message']}")
    verdict = {"healthy": "ok", "degraded": "watch", "failing": "act", "unknown": "check"}.get(status, "check")
    return {"status": status, "verdict": verdict, "summary": lines or [f"Status: {status}"]}


def ny_day_start_utc(now: datetime | None = None) -> str:
    now = (now or datetime.now(timezone.utc)).astimezone(NY)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.astimezone(timezone.utc).isoformat(timespec="seconds")


class ClinicBot(Bot):
    name = "clinic"
    description = "Clinic outreach monitor (read-only): campaign health, queue counts, discovery supply. Never sends."
    keywords = {
        "clinic.health": ["clinic health", "outreach health", "is outreach working", "outreach status", "clinic status"],
        "clinic.audit": ["clinic audit", "outreach audit", "queue counts", "how many clinics", "clinic leads"],
    }

    @skill("clinic.health")
    def health(self, task):
        """No secrets. Reads the live /health/outreach endpoint and explains it."""
        url = task.payload.get("url") or os.environ.get("OUTREACH_HEALTH_URL") or sources.OUTREACH_HEALTH_URL
        report = sources.get_json(url, timeout=int(task.payload.get("timeout", 90)), opener=self.context.get("opener"))
        if not isinstance(report, dict):
            return done({"status": "invalid-response", "verdict": "check", "source": url})
        out = explain_health(report)
        out.update(source=url, raw=report)
        return done(out)

    @skill("clinic.audit")
    def audit(self, task):
        """Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Counts prospects, queue by status, today's sends, runs."""
        env = self.context.get("env") or os.environ
        if not env.get("SUPABASE_URL") or not env.get("SUPABASE_SERVICE_ROLE_KEY"):
            return blocked("Supabase read credentials are not set", gate="SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        op = self.context.get("opener")

        def get(table, params=None, count=False):
            return sources.supabase_get(table, params, count=count, env=env, opener=op)

        day_start = ny_day_start_utc(self.context.get("now"))
        queue = {s: get("outreach_queue", {"select": "queue_id", "status": f"eq.{s}"}, count=True) for s in QUEUE_STATUSES}
        sent_today = get("outreach_queue", {"select": "queue_id", "status": "eq.sent", "updated_at": f"gte.{day_start}"}, count=True)
        week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(timespec="seconds")
        report = {
            "mode": "read_only",
            "prospects_total": get("prospects", {"select": "prospect_id"}, count=True),
            "prospects_new_7d": get("prospects", {"select": "prospect_id", "created_at": f"gte.{week_ago}"}, count=True),
            "suppressions": get("outreach_suppressions", {"select": "*"}, count=True),
            "queue_by_status": queue,
            "sent_today_ny": sent_today,
            "recent_runs": get("outreach_runs", {"select": "started_at,trigger,dry_run,status,qualified,sent,failed,skipped",
                                                  "order": "started_at.desc", "limit": "5"}),
            "recent_discovery": get("clinic_discovery_runs", {"select": "started_at,queried,found,with_email,stored",
                                                               "order": "started_at.desc", "limit": "3"}),
        }
        warnings = []
        if queue.get("uncertain"):
            warnings.append(f"{queue['uncertain']} uncertain send(s) held for review.")
        runs = report["recent_runs"] or []
        if not runs:
            warnings.append("No outreach runs recorded.")
        elif runs[0].get("status") == "error":
            warnings.append("Most recent outreach run ended in error.")
        if not report["prospects_new_7d"]:
            warnings.append("No new clinic prospects in 7 days: discovery may be stalled.")
        report["warnings"] = warnings
        return done(report)
