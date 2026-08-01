CREATE TABLE IF NOT EXISTS sales_reps (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rep_weekly_checkins (
  id UUID PRIMARY KEY,
  rep_id UUID NOT NULL REFERENCES sales_reps(id),
  week_start DATE NOT NULL,
  leads_contacted INTEGER NOT NULL DEFAULT 0 CHECK (leads_contacted >= 0),
  conversations_started INTEGER NOT NULL DEFAULT 0 CHECK (conversations_started >= 0),
  followups_completed INTEGER NOT NULL DEFAULT 0 CHECK (followups_completed >= 0),
  consultations_booked INTEGER NOT NULL DEFAULT 0 CHECK (consultations_booked >= 0),
  sales_closed INTEGER NOT NULL DEFAULT 0 CHECK (sales_closed >= 0),
  revenue_cents INTEGER NOT NULL DEFAULT 0 CHECK (revenue_cents >= 0),
  wins TEXT NOT NULL DEFAULT '',
  blockers TEXT NOT NULL DEFAULT '',
  support_needed TEXT NOT NULL DEFAULT '',
  next_week_commitment TEXT NOT NULL DEFAULT '',
  confidence_score INTEGER NOT NULL DEFAULT 5 CHECK (confidence_score BETWEEN 1 AND 10),
  performance_score INTEGER NOT NULL DEFAULT 0 CHECK (performance_score BETWEEN 0 AND 100),
  manager_status TEXT NOT NULL DEFAULT 'submitted' CHECK (manager_status IN ('submitted','reviewed','follow-up-required','complete')),
  manager_notes TEXT NOT NULL DEFAULT '',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE(rep_id, week_start)
);

CREATE INDEX IF NOT EXISTS rep_weekly_checkins_week_idx ON rep_weekly_checkins(week_start DESC);
CREATE INDEX IF NOT EXISTS rep_weekly_checkins_status_idx ON rep_weekly_checkins(manager_status);
