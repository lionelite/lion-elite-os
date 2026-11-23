#!/usr/bin/env python3
"""Read-only clinic outreach audit bot. Python 3.10+, standard library only.

Never sends email, modifies leads, or logs credentials.
Uses the existing Supabase REST API and service key supplied at runtime.
"""
import collections
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TABLES = ("prospects", "outreach_queue", "outreach_runs", "outreach_suppressions")
VALID_STATUSES = ("pending", "queued", "sent", "failed", "skipped")

def fetch(table, params=None, count=False):
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    query = urllib.parse.urlencode(params or {})
    url = f"{base}/rest/v1/{table}" + (f"?{query}" if query else "")
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if count:
        headers["Prefer"] = "count=exact"
    request = urllib.request.Request(url, headers=headers, method="HEAD" if count else "GET")
    with urllib.request.urlopen(request, timeout=20) as response:
        if count:
            return int(response.headers.get("Content-Range", "0-0/0").rsplit("/", 1)[1])
        return json.loads(response.read().decode("utf-8"))

def audit():
    now = dt.datetime.now(dt.timezone.utc)
    today = now.date().isoformat()
    report = {"generated_utc": now.isoformat(), "mode": "read_only",
              "table_counts": {t: fetch(t, {"select": "*"}, True) for t in TABLES}}
    rows = fetch("outreach_queue", {"select": "status", "limit": "1000"})
    report["queue_status_sample"] = dict(collections.Counter(r["status"] for r in rows))
    report["queue_sample_size"] = len(rows)
    daily = fetch("daily_usage", {"select": "channel,sent_count", "usage_day": f"eq.{today}"})
    report["today_usage_utc_date"] = today
    report["today_recorded_sends"] = sum(int(r["sent_count"]) for r in daily if r["channel"] == "email")
    runs = fetch("outreach_runs", {"select": "run_date,status,dry_run,sent,failed,started_at",
                                    "order": "started_at.desc", "limit": "5"})
    report["recent_runs"] = runs
    report["warnings"] = []
    if not runs:
        report["warnings"].append("No outreach run records")
    elif runs[0]["run_date"] != today:
        report["warnings"].append("No run on current UTC calendar date; compare with America/New_York time")
    if report["queue_status_sample"].get("pending", 0) > 0:
        report["warnings"].append("Pending outreach queue exists; check worker, provider credentials and send controls")
    return report

def main():
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 2
    try:
        print(json.dumps(audit(), indent=2))
        return 0
    except (urllib.error.URLError, ValueError, KeyError) as exc:
        print(f"Audit failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
