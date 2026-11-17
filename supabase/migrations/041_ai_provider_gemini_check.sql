-- ============================================================
-- 041_ai_provider_gemini_check.sql — allow Gemini as a main provider
--
-- Bug fix, unrelated to the fase 3 embeddings-provider work (migration
-- 040): `ai_configs.provider` and `ai_usage_log.provider` have always
-- been CHECK-constrained to ('openai', 'anthropic') (migrations 029 /
-- 033), but `AiProvider` in src/lib/ai/types.ts has included 'gemini'
-- since the Gemini tool-calling adapter shipped, and the Settings UI
-- already lets an admin pick "Google Gemini" as the main chat
-- provider. Saving that choice has always failed at the DB layer —
-- `POST /api/ai/config` passes Postgres' 23514 check-violation straight
-- through as a generic 500, so the admin just sees "Failed to save AI
-- configuration" with no indication why.
--
-- This widens both CHECK constraints to match the application-layer
-- `AiProvider` type. No data backfill needed — no row could have ever
-- been written with provider='gemini' given the constraint being
-- fixed here.
--
-- Idempotent — safe to run multiple times (DROP IF EXISTS + recreate).
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));
