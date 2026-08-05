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
