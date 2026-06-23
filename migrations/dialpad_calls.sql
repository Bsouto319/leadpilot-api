-- Migration: Dialpad integration for CP Cabinets
-- Run in: https://supabase.com/dashboard/project/pvphgusjofufwtyiyviu/editor

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS dialpad_alice_active          BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dialpad_number_id             TEXT,
  ADD COLUMN IF NOT EXISTS dialpad_webhook_id            TEXT,
  ADD COLUMN IF NOT EXISTS dialpad_twilio_forward_number TEXT;

CREATE TABLE IF NOT EXISTS dialpad_calls (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID        REFERENCES clients(id) ON DELETE CASCADE,
  dialpad_call_id  TEXT        UNIQUE,
  caller_number    TEXT,
  caller_name      TEXT,
  direction        TEXT        DEFAULT 'inbound',
  status           TEXT,
  duration_seconds INT         DEFAULT 0,
  recording_url    TEXT,
  started_at       TIMESTAMPTZ,
  answered_at      TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  handled_by       TEXT        DEFAULT 'secretary',
  lead_score       INT         DEFAULT 0,
  area             TEXT,
  ai_summary       TEXT,
  raw_payload      JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dialpad_calls_client_id  ON dialpad_calls(client_id);
CREATE INDEX IF NOT EXISTS idx_dialpad_calls_started_at ON dialpad_calls(client_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dialpad_calls_status     ON dialpad_calls(client_id, status);
