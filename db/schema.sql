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
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS google_connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'gmail',
  account_email TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  encrypted_access_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  gmail_history_id TEXT,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, account_email)
);

CREATE TABLE IF NOT EXISTS gmail_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES google_connections(connection_id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT,
  internet_message_id TEXT,
  in_reply_to TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_email TEXT,
  recipient_email TEXT,
  subject TEXT,
  snippet TEXT,
  prospect_id UUID REFERENCES prospects(prospect_id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(connection_id, gmail_message_id)
);
CREATE INDEX IF NOT EXISTS gmail_messages_thread_idx ON gmail_messages(gmail_thread_id);
CREATE INDEX IF NOT EXISTS gmail_messages_prospect_idx ON gmail_messages(prospect_id, received_at DESC);
