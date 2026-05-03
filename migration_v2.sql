-- LeadPilot — Migration v2
-- Run this in Supabase SQL Editor after migration.sql

-- ── Histórico de mensagens por conversa ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL CHECK (role IN ('lead', 'ai', 'owner', 'system')),
  body            TEXT        NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_id
  ON conversation_messages (conversation_id, created_at);

-- ── Notas manuais e stage closed ─────────────────────────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- 'closed' stage: lead expressou desinteresse — sem mais follow-up

-- ── RLS para conversation_messages ───────────────────────────────────────────
ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "service_role_full_access_messages"
  ON conversation_messages FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY IF NOT EXISTS "contractor_own_messages"
  ON conversation_messages FOR SELECT
  USING (
    conversation_id IN (
      SELECT id FROM conversations
      WHERE client_id IN (SELECT id FROM clients WHERE user_id = auth.uid())
    )
  );
