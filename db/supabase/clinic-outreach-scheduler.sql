-- Clinic outreach: the ONE authoritative send scheduler (Supabase pg_cron).
--
-- Why here: GitHub Actions fired the old every-10-minutes schedule only 1-3
-- times a day inside the window (29 scheduled runs in 11 days). pg_cron already
-- runs other jobs in this project every minute.
--
-- What it does: every 10 minutes from 13:00 to 20:59 UTC (covers 09:00-15:00
-- New York in EST and EDT) it records a heartbeat and POSTs
-- /run/clinic-outreach?async=1 to the Render service. The service decides
-- everything else: no sends outside OUTREACH_SEND_WINDOW, the daily cap, an
-- advisory lock (an overlapping tick skips), suppression re-checked per send.
--
-- Secret: generated INSIDE the database and kept in Supabase Vault. Only its
-- SHA-256 goes to scheduler_credentials, which the service (role lionos_app)
-- can read but not change. It never appears in code, Render config, logs or chat.
--
-- Run as the database admin role (postgres). Idempotent; to rotate, delete the
-- vault secret and re-run. Pause: POST /api/cron/outreach-pause, or
--   SELECT cron.unschedule('clinic-outreach-send');
-- Installed in production 2026-11-22 (cron job id 4).

CREATE TABLE IF NOT EXISTS public.scheduler_credentials (
  name TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.scheduler_heartbeats (
  id BIGSERIAL PRIMARY KEY,
  job TEXT NOT NULL,
  ticked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id BIGINT);
CREATE INDEX IF NOT EXISTS scheduler_heartbeats_job_idx ON public.scheduler_heartbeats (job, ticked_at DESC);
ALTER TABLE public.scheduler_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_heartbeats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_read ON public.scheduler_credentials;
CREATE POLICY app_read ON public.scheduler_credentials FOR SELECT TO lionos_app USING (true);
DROP POLICY IF EXISTS app_read ON public.scheduler_heartbeats;
CREATE POLICY app_read ON public.scheduler_heartbeats FOR SELECT TO lionos_app USING (true);
REVOKE ALL ON public.scheduler_credentials, public.scheduler_heartbeats FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.scheduler_credentials, public.scheduler_heartbeats TO lionos_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'clinic_outreach_scheduler_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'clinic_outreach_scheduler_secret',
      'x-outreach-secret used by pg_cron job clinic-outreach-send to call Render /run/clinic-outreach');
  END IF;
END $$;

INSERT INTO public.scheduler_credentials (name, sha256)
SELECT 'clinic-outreach-send', encode(extensions.digest(decrypted_secret, 'sha256'), 'hex')
FROM vault.decrypted_secrets WHERE name = 'clinic_outreach_scheduler_secret'
ON CONFLICT (name) DO UPDATE SET sha256 = EXCLUDED.sha256, updated_at = now();

SELECT cron.schedule(
  'clinic-outreach-send',
  '*/10 13-20 * * *',
  $job$
  INSERT INTO public.scheduler_heartbeats (job, request_id)
  SELECT 'clinic-outreach-send', net.http_post(
    url := 'https://lion-elite-os.onrender.com/run/clinic-outreach?async=1',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-outreach-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'clinic_outreach_scheduler_secret')),
    body := '{}'::jsonb,
    -- A sleeping free instance takes ~30-60 s to wake; the run itself is async.
    timeout_milliseconds := 90000);
  $job$
);
