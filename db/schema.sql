CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS prospects (
  prospect_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint TEXT NOT NULL UNIQUE,
  business JSONB NOT NULL DEFAULT '{}'::jsonb,
  contact JSONB,
  campaign_id TEXT,
  owner_id TEXT,
  stage TEXT NOT NULL DEFAULT 'discovered',
  status TEXT NOT NULL DEFAULT 'active',
  score NUMERIC(6,2),
  enrichment JSONB,
  personalization JSONB,
  validation JSONB,
  next_action TEXT,
  next_action_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prospects_stage_idx ON prospects(stage);
CREATE INDEX IF NOT EXISTS prospects_campaign_idx ON prospects(campaign_id);
CREATE INDEX IF NOT EXISTS prospects_status_idx ON prospects(status);

CREATE TABLE IF NOT EXISTS outreach_queue (
  queue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(prospect_id) ON DELETE CASCADE,
  campaign_id TEXT,
  channel TEXT NOT NULL DEFAULT 'email',
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  message_version TEXT,
  validation_run_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep existing deployments compatible when this idempotent schema is rerun.
ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS outreach_queue_status_schedule_idx ON outreach_queue(status, scheduled_at);

CREATE TABLE IF NOT EXISTS prospect_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID REFERENCES prospects(prospect_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prospect_events_timeline_idx ON prospect_events(prospect_id, created_at);

CREATE TABLE IF NOT EXISTS daily_usage (
  usage_day DATE NOT NULL,
  channel TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  PRIMARY KEY (usage_day, channel)
);

CREATE TABLE IF NOT EXISTS coaching_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  customer_id TEXT,
  customer_email TEXT,
  status TEXT NOT NULL,
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency TEXT,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  onboarding_status TEXT NOT NULL DEFAULT 'pending',
  next_action TEXT,
  last_event_id TEXT NOT NULL,
  last_event_created_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_subscriptions_status_idx ON coaching_subscriptions(status);
CREATE INDEX IF NOT EXISTS coaching_subscriptions_next_action_idx ON coaching_subscriptions(next_action);

CREATE TABLE IF NOT EXISTS subscription_events (
  event_id TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES coaching_subscriptions(subscription_id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency TEXT,
  status TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_events_subscription_idx ON subscription_events(subscription_id, occurred_at);

-- Lion Elite Coaching PWA ----------------------------------------------------
-- The coaching portal is intentionally isolated from prospect/outreach data.
-- It stores only the information needed to deliver coaching and maintains an
-- append-only audit trail for sensitive plan changes and client access.

CREATE TABLE IF NOT EXISTS coaching_clients (
  client_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id TEXT REFERENCES coaching_subscriptions(subscription_id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS coaching_clients_email_unique_idx ON coaching_clients(lower(email));
CREATE INDEX IF NOT EXISTS coaching_clients_status_idx ON coaching_clients(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS coaching_invites (
  invite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES coaching_clients(client_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT 'coach',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_invites_client_idx ON coaching_invites(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coaching_sessions (
  session_token_hash TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('coach', 'client')),
  client_id UUID REFERENCES coaching_clients(client_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((actor_type = 'client' AND client_id IS NOT NULL) OR actor_type = 'coach')
);
CREATE INDEX IF NOT EXISTS coaching_sessions_expiry_idx ON coaching_sessions(expires_at);

CREATE TABLE IF NOT EXISTS coaching_exercises (
  exercise_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  muscle_group TEXT NOT NULL DEFAULT 'full body',
  equipment TEXT NOT NULL DEFAULT 'other',
  instructions TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL,
  video_kind TEXT NOT NULL DEFAULT 'link' CHECK (video_kind IN ('youtube', 'vimeo', 'video', 'link')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_exercises_active_idx ON coaching_exercises(active, muscle_group, name);

CREATE TABLE IF NOT EXISTS coaching_workout_plans (
  plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES coaching_clients(client_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'assisted')),
  start_date DATE,
  end_date DATE,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_workout_plans_client_idx ON coaching_workout_plans(client_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS coaching_workout_days (
  workout_day_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES coaching_workout_plans(plan_id) ON DELETE CASCADE,
  day_index INTEGER NOT NULL CHECK (day_index BETWEEN 1 AND 14),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  UNIQUE (plan_id, day_index)
);

CREATE TABLE IF NOT EXISTS coaching_workout_exercises (
  workout_exercise_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workout_day_id UUID NOT NULL REFERENCES coaching_workout_days(workout_day_id) ON DELETE CASCADE,
  exercise_id UUID REFERENCES coaching_exercises(exercise_id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL,
  video_kind TEXT NOT NULL DEFAULT 'link' CHECK (video_kind IN ('youtube', 'vimeo', 'video', 'link')),
  sets JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_workout_exercises_day_idx ON coaching_workout_exercises(workout_day_id, sort_order);

CREATE TABLE IF NOT EXISTS coaching_workout_logs (
  workout_log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES coaching_clients(client_id) ON DELETE CASCADE,
  workout_day_id UUID NOT NULL REFERENCES coaching_workout_days(workout_day_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'skipped')),
  performance JSONB NOT NULL DEFAULT '[]'::jsonb,
  effort INTEGER CHECK (effort IS NULL OR effort BETWEEN 1 AND 10),
  feedback TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_workout_logs_client_idx ON coaching_workout_logs(client_id, started_at DESC);

CREATE TABLE IF NOT EXISTS coaching_nutrition_plans (
  nutrition_plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES coaching_clients(client_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  calorie_target INTEGER CHECK (calorie_target IS NULL OR calorie_target BETWEEN 500 AND 10000),
  protein_grams INTEGER CHECK (protein_grams IS NULL OR protein_grams BETWEEN 0 AND 1000),
  carbohydrate_grams INTEGER CHECK (carbohydrate_grams IS NULL OR carbohydrate_grams BETWEEN 0 AND 1500),
  fat_grams INTEGER CHECK (fat_grams IS NULL OR fat_grams BETWEEN 0 AND 500),
  guidance TEXT NOT NULL DEFAULT '',
  meals JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_nutrition_plans_client_idx ON coaching_nutrition_plans(client_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS coaching_supplement_plans (
  supplement_plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES coaching_clients(client_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_supplement_plans_client_idx ON coaching_supplement_plans(client_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS coaching_peptide_protocols (
  protocol_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES coaching_clients(client_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  clinician_name TEXT NOT NULL DEFAULT '',
  clinician_confirmed BOOLEAN NOT NULL DEFAULT false,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'published' OR clinician_confirmed = true)
);
CREATE INDEX IF NOT EXISTS coaching_peptide_protocols_client_idx ON coaching_peptide_protocols(client_id, status, updated_at DESC);

-- Clinician credential behind a peptide protocol.
--
-- clinician_confirmed above is a boolean: it records that someone ticked a box,
-- not who, under what licence, whether it was current, or that the client
-- consented. These columns are the evidence that tick stands on. Validated by
-- lib/credentials/validate.js and enforced at publish time.
--
-- All nullable, and the constraint is added NOT VALID on purpose: protocols
-- published before this existed are not retroactively invalidated, but no new
-- publish can happen without the credential. Archiving an old row still works,
-- because archived rows do not have to satisfy it.
ALTER TABLE coaching_peptide_protocols ADD COLUMN IF NOT EXISTS clinician_license_type TEXT;
ALTER TABLE coaching_peptide_protocols ADD COLUMN IF NOT EXISTS clinician_license_number TEXT;
ALTER TABLE coaching_peptide_protocols ADD COLUMN IF NOT EXISTS clinician_license_state TEXT;
ALTER TABLE coaching_peptide_protocols ADD COLUMN IF NOT EXISTS clinician_npi TEXT;
ALTER TABLE coaching_peptide_protocols ADD COLUMN IF NOT EXISTS clinician_license_expires_at DATE;
ALTER TABLE coaching_peptide_protocols ADD COLUMN IF NOT EXISTS clinician_verified_at TIMESTAMPTZ;
ALTER TABLE coaching_peptide_protocols ADD COLUMN IF NOT EXISTS clinician_verified_by TEXT;
ALTER TABLE coaching_peptide_protocols ADD COLUMN IF NOT EXISTS consent_obtained_at TIMESTAMPTZ;
ALTER TABLE coaching_peptide_protocols ADD COLUMN IF NOT EXISTS consent_document_id TEXT;

DO $$ BEGIN
  ALTER TABLE coaching_peptide_protocols
    ADD CONSTRAINT coaching_peptide_protocols_credential_chk
    CHECK (
      status <> 'published' OR (
        coalesce(clinician_license_type, '') <> ''
        AND coalesce(clinician_license_number, '') <> ''
        AND coalesce(clinician_license_state, '') <> ''
        AND clinician_verified_at IS NOT NULL
        AND consent_obtained_at IS NOT NULL
      )
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS coaching_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES coaching_clients(client_id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('coach', 'client', 'system')),
  sender_name TEXT NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_messages_client_idx ON coaching_messages(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coaching_checkins (
  checkin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES coaching_clients(client_id) ON DELETE CASCADE,
  weight_lbs NUMERIC(6,2) CHECK (weight_lbs IS NULL OR weight_lbs BETWEEN 50 AND 1000),
  sleep_hours NUMERIC(4,2) CHECK (sleep_hours IS NULL OR sleep_hours BETWEEN 0 AND 24),
  energy INTEGER CHECK (energy IS NULL OR energy BETWEEN 1 AND 10),
  adherence INTEGER CHECK (adherence IS NULL OR adherence BETWEEN 1 AND 10),
  soreness INTEGER CHECK (soreness IS NULL OR soreness BETWEEN 1 AND 10),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_checkins_client_idx ON coaching_checkins(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coaching_push_subscriptions (
  push_subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('coach', 'client')),
  client_id UUID REFERENCES coaching_clients(client_id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((actor_type = 'client' AND client_id IS NOT NULL) OR actor_type = 'coach')
);
CREATE INDEX IF NOT EXISTS coaching_push_subscriptions_recipient_idx ON coaching_push_subscriptions(actor_type, client_id);

CREATE TABLE IF NOT EXISTS coaching_audit_events (
  audit_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES coaching_clients(client_id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('coach', 'client', 'system')),
  event_type TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_audit_events_client_idx ON coaching_audit_events(client_id, created_at DESC);

-- Multi-coach support ---------------------------------------------------------
-- Before this, "coach" was a single shared access token with no identity:
-- every coach session could read every client. Each coach is now a row, and
-- client ownership is an explicit foreign key so access can be scoped.
--
-- role 'owner' sees every client and administers coaches (the business owner).
-- role 'coach' sees only clients whose coach_id is their own.
CREATE TABLE IF NOT EXISTS coaching_coaches (
  coach_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Only the SHA-256 hash is stored; the plaintext access token is shown once
  -- at creation/rotation and is unrecoverable afterwards.
  access_token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'coach' CHECK (role IN ('owner', 'coach')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS coaching_coaches_email_unique_idx ON coaching_coaches(lower(email));
CREATE INDEX IF NOT EXISTS coaching_coaches_role_idx ON coaching_coaches(role, status);

-- Client ownership. NULL means unassigned, which only an owner can see; the
-- owner-bootstrap claims those on first login so nothing is stranded.
ALTER TABLE coaching_clients ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES coaching_coaches(coach_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS coaching_clients_coach_idx ON coaching_clients(coach_id, status, updated_at DESC);

-- Sessions carry the acting coach so authorization never depends on a shared
-- secret alone.
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES coaching_coaches(coach_id) ON DELETE CASCADE;

-- Push subscriptions are per-coach; otherwise one coach's device receives
-- another coach's client message alerts.
ALTER TABLE coaching_push_subscriptions ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES coaching_coaches(coach_id) ON DELETE CASCADE;

-- Identity-less coach rows predate this migration and cannot be authorized.
-- Dropping them forces one re-login and one re-subscribe; both are cheap, and
-- the alternative is a session that no policy can scope. Client sessions are
-- untouched. Idempotent: after migration no coach row has a NULL coach_id.
DELETE FROM coaching_sessions WHERE actor_type = 'coach' AND coach_id IS NULL;
DELETE FROM coaching_push_subscriptions WHERE actor_type = 'coach' AND coach_id IS NULL;

DO $$ BEGIN
  ALTER TABLE coaching_sessions
    ADD CONSTRAINT coaching_sessions_coach_identity_chk
    CHECK (actor_type <> 'coach' OR coach_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Funnel events for the automated revenue engine (Issue #89, P1).
-- Append-only. event_key is the idempotency guard: webhook and worker retries
-- replay the same logical event, and double-counting revenue is worse than
-- dropping a duplicate. No PII by design — subject_id is opaque and
-- subject_hash is salted, so this table can be queried and exported freely.
CREATE TABLE IF NOT EXISTS funnel_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  brand TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  subject_id TEXT NOT NULL,
  subject_hash TEXT,
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS funnel_events_window_idx ON funnel_events(occurred_at);
CREATE INDEX IF NOT EXISTS funnel_events_brand_source_idx ON funnel_events(brand, source, occurred_at);
CREATE INDEX IF NOT EXISTS funnel_events_subject_idx ON funnel_events(subject_id, occurred_at);

-- Captured B2C leads -----------------------------------------------------------
-- Two lanes, one capture surface:
--   beauty-client   a consumer who wants coaching (Lion Elite Beauty)
--   coach-platform  a coach who wants somewhere to run their own clients
--
-- This exists because nothing in the codebase could write smsConsent. The SMS
-- pipeline reads it in three places and refuses to send without it, so the whole
-- channel was built, gated, and permanently inert: no record could ever be
-- eligible. Consent has to be captured from the person before any of it works.
--
-- The CHECK constraints are the point. Under TCPA, consent is not a flag you set
-- — it is evidence you must be able to produce: what the person was shown, when
-- they agreed, and from where. A row cannot claim consent without carrying it.
CREATE TABLE IF NOT EXISTS captured_leads (
  lead_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lane TEXT NOT NULL CHECK (lane IN ('beauty-client', 'coach-platform')),
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  phone TEXT,
  source TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'converted', 'archived')),

  email_marketing_consent BOOLEAN NOT NULL DEFAULT false,
  email_consent_at TIMESTAMPTZ,

  sms_marketing_consent BOOLEAN NOT NULL DEFAULT false,
  sms_consent_at TIMESTAMPTZ,
  -- The exact disclosure the person agreed to, stored verbatim. If the wording
  -- on the form changes, older rows still prove what THEY were shown.
  sms_consent_text TEXT,
  sms_consent_ip TEXT,
  sms_consent_user_agent TEXT,

  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Consent cannot be asserted without the evidence that backs it.
  CHECK (email_marketing_consent = false OR email_consent_at IS NOT NULL),
  CHECK (
    sms_marketing_consent = false OR (
      phone IS NOT NULL AND phone <> ''
      AND sms_consent_at IS NOT NULL
      AND sms_consent_text IS NOT NULL AND sms_consent_text <> ''
    )
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS captured_leads_email_lane_idx ON captured_leads(lower(email), lane);
CREATE INDEX IF NOT EXISTS captured_leads_lane_status_idx ON captured_leads(lane, status, created_at DESC);
CREATE INDEX IF NOT EXISTS captured_leads_sms_reachable_idx ON captured_leads(sms_marketing_consent, unsubscribed_at);

-- Quiet hours are enforced in the recipient's LOCAL time, and an unknown local
-- time fails closed (skipped as unknown_local_time). Without a timezone every
-- lead would therefore be permanently unsendable, so the opt-in page captures
-- the browser's IANA zone at the moment of consent.
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS timezone TEXT;
-- Per-campaign cooldown needs to know when we last texted them.
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS last_sms_sent_at TIMESTAMPTZ;
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS last_sms_campaign TEXT;
