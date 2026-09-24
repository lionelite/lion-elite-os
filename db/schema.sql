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


-- LionOS GTM SaaS ------------------------------------------------------------
-- Multi-tenant platform foundation. Every customer-owned record is scoped by
-- workspace_id. Authentication/membership enforcement is layered above this
-- schema; database foreign keys ensure records cannot point at nonexistent
-- workspaces.

CREATE TABLE IF NOT EXISTS gtm_workspaces (
  workspace_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'solo' CHECK (plan IN ('solo','agency','enterprise')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gtm_workspace_profiles (
  workspace_id UUID PRIMARY KEY REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  website_url TEXT,
  company_description TEXT NOT NULL DEFAULT '',
  offer_name TEXT NOT NULL DEFAULT '',
  offer_description TEXT NOT NULL DEFAULT '',
  primary_goal TEXT NOT NULL DEFAULT 'book_meetings',
  target_geography TEXT NOT NULL DEFAULT '',
  icp JSONB NOT NULL DEFAULT '{}'::jsonb,
  exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
  messaging_angles JSONB NOT NULL DEFAULT '[]'::jsonb,
  onboarding_status TEXT NOT NULL DEFAULT 'draft' CHECK (onboarding_status IN ('draft','ready','approved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gtm_campaigns (
  campaign_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT 'book_meetings',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed','archived')),
  offer JSONB NOT NULL DEFAULT '{}'::jsonb,
  icp JSONB NOT NULL DEFAULT '{}'::jsonb,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
  channels JSONB NOT NULL DEFAULT '["email"]'::jsonb,
  sequence JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_event TEXT NOT NULL DEFAULT 'meeting_booked',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_campaigns_workspace_idx ON gtm_campaigns(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS gtm_agent_tasks (
  task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE SET NULL,
  agent_key TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','blocked','completed','failed','cancelled')),
  delegated_by TEXT,
  required_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation JSONB NOT NULL DEFAULT '{}'::jsonb,
  kpi TEXT,
  run_after TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_agent_tasks_workspace_idx ON gtm_agent_tasks(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS gtm_audit_events (
  audit_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','agent','system','integration')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_audit_events_workspace_idx ON gtm_audit_events(workspace_id, created_at DESC);


-- Prospects, evidence, intent and inbox ---------------------------------------
CREATE TABLE IF NOT EXISTS gtm_prospects (
  prospect_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE SET NULL,
  company_name TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered','qualified','queued','contacted','replied','meeting','opportunity','won','lost','suppressed')),
  fit_score INTEGER NOT NULL DEFAULT 0 CHECK (fit_score BETWEEN 0 AND 100),
  intent_heat INTEGER NOT NULL DEFAULT 1 CHECK (intent_heat BETWEEN 1 AND 5),
  confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  next_action TEXT,
  replied_at TIMESTAMPTZ,
  last_signal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_prospects_workspace_campaign_idx ON gtm_prospects(workspace_id, campaign_id, status);
CREATE INDEX IF NOT EXISTS gtm_prospects_queue_idx ON gtm_prospects(workspace_id, intent_heat, status);

CREATE TABLE IF NOT EXISTS gtm_evidence (
  evidence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  prospect_id UUID NOT NULL REFERENCES gtm_prospects(prospect_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS gtm_evidence_prospect_idx ON gtm_evidence(prospect_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS gtm_inbox_threads (
  thread_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  prospect_id UUID NOT NULL REFERENCES gtm_prospects(prospect_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','linkedin','other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','booked','closed')),
  classification TEXT,
  latest_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_inbox_workspace_idx ON gtm_inbox_threads(workspace_id, status, latest_message_at DESC);

ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS send_policy TEXT NOT NULL DEFAULT 'supervised' CHECK (send_policy IN ('supervised','autopilot'));
ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS intent_threshold INTEGER NOT NULL DEFAULT 4 CHECK (intent_threshold BETWEEN 1 AND 5);


CREATE TABLE IF NOT EXISTS gtm_inbox_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES gtm_inbox_threads(thread_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','draft')),
  sender TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','draft','approved','sent','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_inbox_messages_thread_idx ON gtm_inbox_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS gtm_meetings (
  meeting_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  prospect_id UUID NOT NULL REFERENCES gtm_prospects(prospect_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE SET NULL,
  thread_id UUID REFERENCES gtm_inbox_threads(thread_id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','booked','completed','cancelled','no_show')),
  booking_url TEXT,
  external_calendar_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_meetings_workspace_idx ON gtm_meetings(workspace_id, status, starts_at);

CREATE TABLE IF NOT EXISTS gtm_opportunities (
  opportunity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  prospect_id UUID NOT NULL REFERENCES gtm_prospects(prospect_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'replied' CHECK (stage IN ('replied','meeting','qualified','proposal','negotiation','won','lost')),
  value_cents INTEGER CHECK (value_cents IS NULL OR value_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  owner TEXT,
  next_action TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gtm_opportunities_prospect_unique_idx ON gtm_opportunities(workspace_id, prospect_id);
CREATE INDEX IF NOT EXISTS gtm_opportunities_workspace_stage_idx ON gtm_opportunities(workspace_id, stage, updated_at DESC);


CREATE TABLE IF NOT EXISTS gtm_integrations (
  integration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('gmail','google_calendar','calendly','crm','webhook')),
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected','error','reauth_required')),
  account_label TEXT,
  external_account_id TEXT,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, external_account_id)
);
CREATE INDEX IF NOT EXISTS gtm_integrations_workspace_idx ON gtm_integrations(workspace_id, provider, status);

CREATE TABLE IF NOT EXISTS gtm_integration_events (
  integration_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, external_event_id)
);
CREATE INDEX IF NOT EXISTS gtm_integration_events_unprocessed_idx ON gtm_integration_events(workspace_id, provider, processed_at);


-- GTM demand engine parity ----------------------------------------------------
CREATE TABLE IF NOT EXISTS gtm_agents (
  agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  agent_key TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, agent_key)
);
CREATE INDEX IF NOT EXISTS gtm_agents_workspace_idx ON gtm_agents(workspace_id, status);

CREATE TABLE IF NOT EXISTS gtm_source_runs (
  source_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  query JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  candidates_found INTEGER NOT NULL DEFAULT 0,
  candidates_accepted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_source_runs_workspace_idx ON gtm_source_runs(workspace_id, campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gtm_usage_ledger (
  usage_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  purse TEXT NOT NULL CHECK (purse IN ('data','action')),
  action_key TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits >= 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  provider_cost_cents INTEGER CHECK (provider_cost_cents IS NULL OR provider_cost_cents >= 0),
  idempotency_key TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS gtm_usage_ledger_workspace_idx ON gtm_usage_ledger(workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS gtm_usage_ledger_action_idx ON gtm_usage_ledger(workspace_id, action_key, occurred_at DESC);

CREATE TABLE IF NOT EXISTS gtm_delivery_jobs (
  delivery_job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','delivered','failed','dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, destination, idempotency_key)
);
CREATE INDEX IF NOT EXISTS gtm_delivery_jobs_ready_idx ON gtm_delivery_jobs(status, next_attempt_at);

ALTER TABLE gtm_workspaces ADD COLUMN IF NOT EXISTS data_credit_allowance INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE gtm_workspaces ADD COLUMN IF NOT EXISTS action_credit_allowance INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE gtm_workspaces ADD COLUMN IF NOT EXISTS overage_enabled BOOLEAN NOT NULL DEFAULT false;


-- Agency tenancy, membership and white-label ---------------------------------
CREATE TABLE IF NOT EXISTS gtm_users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gtm_users_email_unique_idx ON gtm_users(lower(email));

CREATE TABLE IF NOT EXISTS gtm_workspace_memberships (
  membership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES gtm_users(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','operator','member','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS gtm_workspace_memberships_user_idx ON gtm_workspace_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS gtm_workspace_memberships_workspace_idx ON gtm_workspace_memberships(workspace_id, status);

CREATE TABLE IF NOT EXISTS gtm_workspace_branding (
  workspace_id UUID PRIMARY KEY REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  brand_name TEXT NOT NULL DEFAULT '',
  logo_url TEXT,
  accent_color TEXT,
  support_email TEXT,
  postal_address TEXT,
  custom_domain TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gtm_workspace_limits (
  workspace_id UUID PRIMARY KEY REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  data_credit_cap INTEGER,
  action_credit_cap INTEGER,
  daily_send_cap INTEGER,
  daily_source_cap INTEGER,
  overage_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE gtm_prospects ADD COLUMN IF NOT EXISTS source_provider TEXT;
ALTER TABLE gtm_prospects ADD COLUMN IF NOT EXISTS source_external_id TEXT;
ALTER TABLE gtm_prospects ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS gtm_prospects_source_idx ON gtm_prospects(workspace_id, source_provider, source_external_id);


-- Sender infrastructure, ramp and immutable compliance gate -------------------
CREATE TABLE IF NOT EXISTS gtm_sending_domains (
  sending_domain_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','error','disabled')),
  provider TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, domain)
);

CREATE TABLE IF NOT EXISTS gtm_senders (
  sender_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  sending_domain_id UUID REFERENCES gtm_sending_domains(sending_domain_id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','linkedin','sms')),
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','warming','active','paused','error','disabled')),
  connected_at TIMESTAMPTZ,
  ramp_started_at TIMESTAMPTZ,
  daily_cap INTEGER NOT NULL DEFAULT 10 CHECK (daily_cap >= 0),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  send_window_start TIME NOT NULL DEFAULT '09:00',
  send_window_end TIME NOT NULL DEFAULT '17:00',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel, address)
);
CREATE INDEX IF NOT EXISTS gtm_senders_workspace_idx ON gtm_senders(workspace_id, channel, status);

CREATE TABLE IF NOT EXISTS gtm_send_attempts (
  send_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE SET NULL,
  prospect_id UUID REFERENCES gtm_prospects(prospect_id) ON DELETE SET NULL,
  sender_id UUID REFERENCES gtm_senders(sender_id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','linkedin','sms')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','blocked','approved','sent','failed','skipped')),
  scheduled_for TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  compliance_passed BOOLEAN NOT NULL DEFAULT false,
  compliance_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  block_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_send_attempts_sender_day_idx ON gtm_send_attempts(sender_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gtm_compliance_policies (
  compliance_policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  policy_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  severity TEXT NOT NULL DEFAULT 'block' CHECK (severity IN ('block','warn')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, policy_key)
);

CREATE TABLE IF NOT EXISTS gtm_csv_imports (
  csv_import_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE SET NULL,
  filename TEXT NOT NULL DEFAULT '',
  mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  skip_fit_gate BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','mapped','imported','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A send cannot be marked sent without a passing compliance snapshot.
DO $$ BEGIN
  ALTER TABLE gtm_send_attempts
    ADD CONSTRAINT gtm_send_attempts_compliance_sent_chk
    CHECK (status <> 'sent' OR compliance_passed = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- Production identity, OAuth secrets, sender provisioning and signal polling ---
CREATE TABLE IF NOT EXISTS gtm_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES gtm_users(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_sessions_user_idx ON gtm_sessions(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS gtm_oauth_credentials (
  oauth_credential_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_account_id TEXT,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, external_account_id)
);
CREATE INDEX IF NOT EXISTS gtm_oauth_credentials_workspace_idx ON gtm_oauth_credentials(workspace_id, provider);

CREATE TABLE IF NOT EXISTS gtm_sender_provisioning_requests (
  provisioning_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  domain TEXT NOT NULL,
  sender_local_part TEXT NOT NULL DEFAULT 'hello',
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','dns_pending','verifying','provisioned','failed','cancelled')),
  dns_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  external_domain_id TEXT,
  external_sender_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_sender_provisioning_workspace_idx ON gtm_sender_provisioning_requests(workspace_id, status);

CREATE TABLE IF NOT EXISTS gtm_signal_subscriptions (
  signal_subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (poll_interval_seconds >= 60),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error')),
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_signal_subscriptions_due_idx ON gtm_signal_subscriptions(status, next_poll_at);

CREATE TABLE IF NOT EXISTS gtm_signal_events (
  signal_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES gtm_prospects(prospect_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, external_event_id)
);
CREATE INDEX IF NOT EXISTS gtm_signal_events_prospect_idx ON gtm_signal_events(prospect_id, observed_at DESC);


-- OAuth consent state ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS gtm_oauth_states (
  oauth_state_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES gtm_users(user_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  redirect_uri TEXT NOT NULL,
  code_verifier_ciphertext TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_oauth_states_workspace_idx ON gtm_oauth_states(workspace_id, provider, expires_at DESC);


-- Runtime operations parity ---------------------------------------------------
CREATE TABLE IF NOT EXISTS gtm_usage_incidents (
  usage_incident_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  purse TEXT NOT NULL CHECK (purse IN ('data','action')),
  level TEXT NOT NULL CHECK (level IN ('warning','hard_stop','recovered')),
  percent_used INTEGER NOT NULL,
  balance_remaining INTEGER NOT NULL,
  period_key TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, purse, level, period_key)
);
CREATE INDEX IF NOT EXISTS gtm_usage_incidents_workspace_idx ON gtm_usage_incidents(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gtm_connector_health (
  connector_health_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  connection_key TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','connected','degraded','disconnected','error')),
  verified_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, connection_key)
);
CREATE INDEX IF NOT EXISTS gtm_connector_health_workspace_idx ON gtm_connector_health(workspace_id, status);

CREATE TABLE IF NOT EXISTS gtm_webhook_endpoints (
  webhook_endpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  signing_secret_ciphertext TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  event_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_delivery_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_webhook_endpoints_workspace_idx ON gtm_webhook_endpoints(workspace_id, enabled);


-- Scheduler, sender health, MCP boundary --------------------------------------
CREATE TABLE IF NOT EXISTS gtm_runtime_jobs (
  runtime_job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  job_key TEXT NOT NULL,
  cadence_seconds INTEGER,
  daily_time TIME,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error')),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, job_key)
);
CREATE INDEX IF NOT EXISTS gtm_runtime_jobs_due_idx ON gtm_runtime_jobs(status, next_run_at);

CREATE TABLE IF NOT EXISTS gtm_sender_health_checks (
  sender_health_check_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES gtm_senders(sender_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('healthy','degraded','blocked','error')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_sender_health_checks_idx ON gtm_sender_health_checks(sender_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS gtm_mcp_clients (
  mcp_client_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES gtm_users(user_id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- MCP OAuth grants and LinkedIn provider events --------------------------------
CREATE TABLE IF NOT EXISTS gtm_mcp_auth_codes (
  mcp_auth_code_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES gtm_mcp_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES gtm_users(user_id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gtm_mcp_access_tokens (
  mcp_access_token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES gtm_mcp_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES gtm_users(user_id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS gtm_linkedin_events (
  linkedin_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES gtm_prospects(prospect_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, external_event_id)
);
CREATE INDEX IF NOT EXISTS gtm_linkedin_events_unprocessed_idx ON gtm_linkedin_events(workspace_id, processed_at, created_at);

CREATE TABLE IF NOT EXISTS gtm_channel_action_requests (
  channel_action_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES gtm_campaigns(campaign_id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES gtm_prospects(prospect_id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('linkedin','email','sms')),
  action_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  compliance_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','blocked','processing','completed','failed')),
  provider TEXT,
  external_action_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_channel_actions_ready_idx ON gtm_channel_action_requests(channel,status,created_at);


CREATE UNIQUE INDEX IF NOT EXISTS gtm_runtime_jobs_global_key_unique
  ON gtm_runtime_jobs(job_key) WHERE workspace_id IS NULL;

CREATE TABLE IF NOT EXISTS gtm_linkedin_connections (
  linkedin_connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'configured_provider',
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','degraded','disconnected','error')),
  cursor TEXT,
  last_polled_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);


-- Operator control surface ----------------------------------------------------
CREATE TABLE IF NOT EXISTS gtm_templates (
  template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','linkedin','sms')),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_templates_workspace_idx ON gtm_templates(workspace_id, channel, updated_at DESC);

CREATE TABLE IF NOT EXISTS gtm_audiences (
  audience_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'dynamic',
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_size INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_audiences_workspace_idx ON gtm_audiences(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS gtm_sequences (
  sequence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  stop_on_reply BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_sequences_workspace_idx ON gtm_sequences(workspace_id, updated_at DESC);

ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS audience_id UUID REFERENCES gtm_audiences(audience_id) ON DELETE SET NULL;
ALTER TABLE gtm_campaigns ADD COLUMN IF NOT EXISTS sequence_id UUID REFERENCES gtm_sequences(sequence_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS gtm_agent_settings (
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  agent_key TEXT NOT NULL,
  display_label TEXT NOT NULL DEFAULT '',
  prompt_override TEXT NOT NULL DEFAULT '',
  model_tier TEXT NOT NULL DEFAULT 'standard' CHECK (model_tier IN ('economy','standard','premium')),
  cadence_seconds INTEGER,
  send_policy TEXT CHECK (send_policy IN ('supervised','autopilot')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_key)
);

CREATE TABLE IF NOT EXISTS gtm_agent_threads (
  agent_thread_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  user_id UUID REFERENCES gtm_users(user_id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Agent conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_agent_threads_workspace_idx ON gtm_agent_threads(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS gtm_agent_turns (
  agent_turn_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_thread_id UUID NOT NULL REFERENCES gtm_agent_threads(agent_thread_id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL DEFAULT '',
  tool_name TEXT,
  tool_payload JSONB,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('running','completed','errored')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_agent_turns_thread_idx ON gtm_agent_turns(agent_thread_id, created_at);


-- Commercial packaging, credit packs, agency reporting ------------------------
CREATE TABLE IF NOT EXISTS gtm_credit_packs (
  credit_pack_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_key TEXT NOT NULL UNIQUE,
  purse TEXT NOT NULL CHECK (purse IN ('data','action')),
  credits INTEGER NOT NULL CHECK (credits > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gtm_credit_pack_purchases (
  credit_pack_purchase_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  pack_key TEXT NOT NULL REFERENCES gtm_credit_packs(pack_key),
  purse TEXT NOT NULL CHECK (purse IN ('data','action')),
  credits INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_checkout_id TEXT,
  provider_payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded')),
  period_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS gtm_credit_pack_purchases_workspace_idx ON gtm_credit_pack_purchases(workspace_id, period_key, status);

CREATE TABLE IF NOT EXISTS gtm_onboarding_previews (
  onboarding_preview_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES gtm_workspaces(workspace_id) ON DELETE CASCADE,
  company JSONB NOT NULL DEFAULT '{}'::jsonb,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  preview JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO gtm_credit_packs (pack_key,purse,credits,price_cents)
VALUES
  ('data-3000','data',3000,3600),
  ('data-7500','data',7500,9000),
  ('data-15000','data',15000,18000),
  ('action-25000','action',25000,8800),
  ('action-60000','action',60000,21000),
  ('action-125000','action',125000,43800)
ON CONFLICT (pack_key) DO NOTHING;


-- Sellable LionOS subscriptions -----------------------------------------------
CREATE TABLE IF NOT EXISTS gtm_subscriptions (
  gtm_subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES gtm_workspaces(workspace_id) ON DELETE SET NULL,
  customer_email TEXT NOT NULL,
  plan_key TEXT NOT NULL CHECK (plan_key IN ('solo','agency')),
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_customer_id TEXT,
  provider_subscription_id TEXT UNIQUE,
  provider_checkout_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','past_due','cancelled','incomplete')),
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_subscriptions_email_idx ON gtm_subscriptions(lower(customer_email), status);

CREATE TABLE IF NOT EXISTS gtm_sales_leads (
  gtm_sales_lead_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  company_name TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL DEFAULT '',
  plan_interest TEXT CHECK (plan_interest IN ('solo','agency','enterprise')),
  source TEXT NOT NULL DEFAULT 'lionos_sales_site',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','checkout_started','paid','onboarding','active','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gtm_sales_leads_email_idx ON gtm_sales_leads(lower(email), created_at DESC);
