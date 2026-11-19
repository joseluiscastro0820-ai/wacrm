-- ============================================================
-- 045_device_push_tokens.sql
--
-- "Fase 2" of Jose's companion-app request: the Android shell
-- (Capacitor, wrapping the live PWA — see capacitor.config.ts)
-- registers its FCM token here so the server can push real native
-- notifications instead of relying on the admin opening the app or
-- reading a WhatsApp alert (migration 042).
--
-- One row per installed device, not per user: a user can have
-- several devices, and FCM occasionally reissues a token for the
-- SAME install (app reinstall, data clear, token rotation) — so
-- registration is an upsert keyed on the token itself
-- (`device_push_tokens_token_key`), not on user_id. When that
-- happens the old row's user_id/account_id get overwritten in
-- place, which is correct even across a logout/login on the same
-- device.
--
-- No DROP POLICY IF EXISTS lines — this table has never existed
-- before, so there is nothing to drop, and including them has
-- reliably hung Supabase's "destructive statement" confirmation in
-- this project (see 043's history).
-- ============================================================

CREATE TABLE IF NOT EXISTS device_push_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios', 'web')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS idx_device_push_tokens_account ON device_push_tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user ON device_push_tokens(user_id);

ALTER TABLE device_push_tokens ENABLE ROW LEVEL SECURITY;

-- Clients only ever manage their own device's row (register on
-- login/app start, nothing to read back beyond that). Sending a
-- push reads across users/accounts from the server via the
-- service-role client, which bypasses RLS entirely — see
-- src/lib/push/send-push.ts.
CREATE POLICY device_push_tokens_select ON device_push_tokens FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY device_push_tokens_insert ON device_push_tokens FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY device_push_tokens_update ON device_push_tokens FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY device_push_tokens_delete ON device_push_tokens FOR DELETE
  USING (auth.uid() = user_id);
