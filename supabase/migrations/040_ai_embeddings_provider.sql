-- ============================================================
-- 040_ai_embeddings_provider.sql — alternate embeddings provider
--
-- Follow-up to 030_ai_knowledge.sql. Until now the knowledge base's
-- semantic search was hardcoded to OpenAI-compatible embeddings, so an
-- account whose main chat provider is Anthropic (which has no
-- embeddings API) or who simply doesn't have an OpenAI key was stuck
-- with lexical (full-text) search only.
--
-- This adds `embeddings_provider`, independent of the account's main
-- chat `provider` column: an account can run its chat on Anthropic (or
-- OpenAI, or Gemini) while using a *separate* Gemini key just for
-- embeddings, so semantic search works without an OpenAI key at all.
-- `embeddings_api_key` keeps its existing meaning — "the key to use
-- for whichever provider `embeddings_provider` names" — no column
-- rename needed.
--
-- The embedding dimension stays 1536 regardless of provider (Gemini's
-- `gemini-embedding-001` is explicitly requested at 1536 dims — see
-- src/lib/ai/embeddings.ts), so the existing `vector(1536)` column on
-- ai_knowledge_chunks needs no change.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS embeddings_provider text NOT NULL DEFAULT 'openai';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_configs_embeddings_provider_check'
      AND conrelid = 'ai_configs'::regclass
  ) THEN
    ALTER TABLE ai_configs
      ADD CONSTRAINT ai_configs_embeddings_provider_check
      CHECK (embeddings_provider IN ('openai', 'gemini'));
  END IF;
END $$;
