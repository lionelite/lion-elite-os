# Python Clinic Bots (phase 1: read-only)

This folder introduces a Python monitoring bot to the existing Lion Elite OS architecture. It does not replace the existing Node outreach sender, bypass pre-send validation, or send emails. The purpose is to diagnose the bottleneck before introducing a competing queue or automated sender.

## Run

Python 3.10+; no external dependencies:

```sh
export SUPABASE_URL="https://<your-project>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<server-side-secret>"
python3 python-bots/clinic_audit.py
```

Store credentials only in GitHub Actions secrets or Render environment variables, **never in the repository**. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in a trusted server environment. Never use service-role credentials in a browser. No automatic scheduling is enabled in this PR.

## Components planned (reuse existing DB and systems)

1. Discovery agent: collect public business records with website and source link, respecting terms/rate limits.
2. Qualification agent: assess clinic fit and public contact data with source provenance.
3. CRM agent: deduplicate by existing `prospects.fingerprint`, preserve opt-outs and ownership.
4. Outreach agent: reuse existing Node validation and queue; draft by default, approval required before sending.
5. Monitor agent (implemented): report queue counts, daily usage, recent runs and warnings.

## Safety, reliability and release gates

- Avoid duplicate independent senders. The existing Node pipeline owns all email delivery.
- Require opt-out and suppression checks, human-reviewed templates, valid sending domain, and explicit enablement.
- Enforce sending caps in the existing sender rather than a parallel Python process.
- Run schema/RLS review before granting access to any new agent: several current public tables lack row-level security. Do not enable RLS abruptly without compatible policies; existing workflows could break.
- Verify row counts and accepted deliveries against provider logs before considering outreach operational.
- For production deployment, confirm the intended Render workspace and examine current service/env settings.

## Bot success criterion

`clinic_audit.py` exits zero, prints JSON from live Supabase tables, and makes **only read-only HTTP requests**.
