-- Clinic outreach: the ONE authoritative send scheduler (Supabase pg_cron).
--
-- Why here: GitHub Actions fired the old every-10-minutes schedule only 2-3
-- times a day (29 scheduled runs in 11 days), so a day got one or two sending
-- runs. pg_cron already runs other jobs in this project every minute.
--
-- What it does: every 10 minutes from 13:00 to 20:59 UTC (covers 09:00-15:00
-- New York in both EST and EDT) it POSTs /run/clinic-outreach?async=1 to the
-- Render service. The service decides everything else: it refuses to send
-- outside OUTREACH_SEND_WINDOW, enforces the daily cap, takes an advisory lock
-- (an overlapping tick skips), and re-checks suppression before each send.
--
-- The scheduler secret is generated INSIDE the database and kept in Supabase
-- Vault. Only its SHA-256 is written to app_settings, which the service compares
-- against. The secret never appears in code, Render config, logs or chat.
--
-- Idempotent: safe to run again. Rotate: delete the vault secret and re-run.
-- Pause sending: POST /api/cron/outreach-pause (app_settings.outreach_paused),
-- or unschedule:  SELECT cron.unschedule('clinic-outreach-send');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'clinic_outreach_scheduler_secret') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'clinic_outreach_scheduler_secret',
      'x-outreach-secret used by pg_cron job clinic-outreach-send to call Render /run/clinic-outreach');
  END IF;
END $$;

INSERT INTO app_settings (key, value, updated_by)
SELECT 'scheduler_secret_sha256', to_jsonb(encode(extensions.digest(decrypted_secret, 'sha256'), 'hex')), 'clinic-outreach-scheduler.sql'
FROM vault.decrypted_secrets WHERE name = 'clinic_outreach_scheduler_secret'
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();

SELECT cron.schedule(
  'clinic-outreach-send',
  '*/10 13-20 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://lion-elite-os.onrender.com/run/clinic-outreach?async=1',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-outreach-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'clinic_outreach_scheduler_secret')),
    body := '{}'::jsonb,
    -- A sleeping free instance takes ~30-60 s to wake; the run itself is async.
    timeout_milliseconds := 90000);
  $job$
);
