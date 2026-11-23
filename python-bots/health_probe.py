#!/usr/bin/env python3
"""Zero-secret, read-only health probe for the canonical clinic outreach sender."""
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.getenv("OUTREACH_HEALTH_URL", "https://lion-elite-os.onrender.com/health/outreach")
def main():
    try:
        req = urllib.request.Request(URL, headers={"Accept": "application/json", "User-Agent": "LionEliteClinicMonitor/1.0"})
        with urllib.request.urlopen(req, timeout=90) as resp:
            report = json.load(resp)
    except (urllib.error.URLError, ValueError, TimeoutError) as error:
        print(json.dumps({"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                          "status": "unreachable", "error_type": type(error).__name__}))
        return 1
    if not isinstance(report, dict):
        print('{"status":"invalid-response"}')
        return 1
    print(json.dumps({"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                      "source": URL, "health": report}, indent=2))
    state = str(report.get("status", report.get("health", "unknown"))).lower()
    return 1 if state in ("failing", "unhealthy", "error") else 0

if __name__ == "__main__":
    sys.exit(main())
