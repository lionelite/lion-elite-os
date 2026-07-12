CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS re_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text,
  source_name text NOT NULL,
  source_url text,
  address text NOT NULL,
  city text,
  state text DEFAULT 'FL',
  postal_code text,
  county text,
  property_type text,
  legal_unit_count integer,
  advertised_unit_count integer,
  asking_price numeric(14,2),
  estimated_market_value numeric(14,2),
  estimated_after_repair_value numeric(14,2),
  estimated_repairs numeric(14,2) DEFAULT 0,
  monthly_gross_rent numeric(14,2) DEFAULT 0,
  annual_operating_expenses numeric(14,2) DEFAULT 0,
  annual_debt_service numeric(14,2) DEFAULT 0,
  owner_name text,
  owner_mailing_address text,
  owner_occupied boolean,
  years_owned numeric(8,2),
  estimated_equity_pct numeric(7,4),
  foreclosure_signal boolean DEFAULT false,
  tax_delinquent_signal boolean DEFAULT false,
  code_violation_signal boolean DEFAULT false,
  probate_signal boolean DEFAULT false,
  vacant_signal boolean DEFAULT false,
  absentee_owner_signal boolean DEFAULT false,
  status text NOT NULL DEFAULT 'new',
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_name, external_id)
);

CREATE TABLE IF NOT EXISTS re_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES re_properties(id) ON DELETE CASCADE,
  category text NOT NULL,
  fact_name text NOT NULL,
  fact_value jsonb NOT NULL,
  source_url text,
  source_agency text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  confidence numeric(5,2) CHECK (confidence BETWEEN 0 AND 100),
  verified_by text,
  notes text
);

CREATE TABLE IF NOT EXISTS re_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES re_properties(id) ON DELETE CASCADE,
  score numeric(6,2) NOT NULL,
  recommendation text NOT NULL,
  economics jsonb NOT NULL,
  dimensions jsonb NOT NULL,
  deal_killers jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_critical_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS re_due_diligence_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES re_properties(id) ON DELETE CASCADE,
  task_key text NOT NULL,
  task_name text NOT NULL,
  responsible_role text NOT NULL,
  vendor_name text,
  status text NOT NULL DEFAULT 'not_started',
  due_date date,
  cost_estimate numeric(12,2),
  result_summary text,
  document_url text,
  completed_at timestamptz,
  UNIQUE(property_id, task_key)
);

CREATE INDEX IF NOT EXISTS re_properties_location_idx ON re_properties(county, city, postal_code);
CREATE INDEX IF NOT EXISTS re_properties_distress_idx ON re_properties(foreclosure_signal, tax_delinquent_signal, code_violation_signal, probate_signal, vacant_signal);
CREATE INDEX IF NOT EXISTS re_evidence_property_idx ON re_evidence(property_id, category);
CREATE INDEX IF NOT EXISTS re_analyses_property_created_idx ON re_analyses(property_id, created_at DESC);
