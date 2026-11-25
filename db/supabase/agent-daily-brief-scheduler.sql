-- Daily agent brief: built every morning by Supabase pg_cron.
--
-- Same pattern as clinic-outreach-scheduler.sql, and for the same reason:
-- GitHub Actions drops scheduled runs, pg_cron does not.
--
-- What it does: at 11:17 UTC (06:17 New York in winter, 07:17 in summer) it
-- records a heartbeat and POSTs /run/agents/daily-brief?async=1 to the Render
-- service. The service reads the live numbers, builds the brief and stores it
-- in agent_briefs. .github/workflows/daily-agent-brief.yml then copies it into
-- the Obsidian vault (vault branch). Read-only toward the business: no sends.
--
-- Secret: generated INSIDE the database and kept in Supabase Vault. Only its
-- SHA-256 goes to scheduler_credentials under the name 'agent-daily-brief',
-- separate from the sender's credential, so neither job can act as the other.
--
-- Run as the database admin role (postgres). Idempotent. To stop it:
--   SELECT cron.unschedule('agent-daily-brief');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'agent_daily_brief_scheduler_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'agent_daily_brief_scheduler_secret',
      'x-outreach-secret used by pg_cron job agent-daily-brief to call Render /run/agents/daily-brief');
  END IF;
END $$;

INSERT INTO public.scheduler_credentials (name, sha256)
SELECT 'agent-daily-brief', encode(extensions.digest(decrypted_secret, 'sha256'), 'hex')
FROM vault.decrypted_secrets WHERE name = 'agent_daily_brief_scheduler_secret'
ON CONFLICT (name) DO UPDATE SET sha256 = EXCLUDED.sha256, updated_at = now();

SELECT cron.schedule(
  'agent-daily-brief',
  '17 11 * * *',
  $job$
  INSERT INTO public.scheduler_heartbeats (job, request_id)
  SELECT 'agent-daily-brief', net.http_post(
    url := 'https://lion-elite-os.onrender.com/run/agents/daily-brief?async=1',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-outreach-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'agent_daily_brief_scheduler_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000);
  $job$
);
