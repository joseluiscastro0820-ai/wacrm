import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig, EmbeddingsProvider } from './types'

interface AiConfigRow {
  provider: 'openai' | 'anthropic'
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
  embeddings_provider: string | null
}

const CONFIG_COLUMNS =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key, embeddings_provider'

/** Narrow a DB value (should always be 'openai'|'gemini' per the
 *  CHECK constraint in migration 040, but a pre-040 row — or a direct
 *  DB edit — could still have it null) down to a safe default. */
function normalizeEmbeddingsProvider(raw: string | null): EmbeddingsProvider {
  return raw === 'gemini' ? 'gemini' : 'openai'
}

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
    embeddingsProvider: normalizeEmbeddingsProvider(row.embeddings_provider),
  }
}

/**
 * Load + decrypt just the embeddings key (and which provider it's
 * for), independent of `is_active`. Used by the knowledge-base ingest
 * routes so the KB gets embedded (and semantic search works) whenever
 * an embeddings key is present, even if the assistant's master switch
 * is currently off.
 *
 * Returns `{ key, provider, corrupt }`: `key` is null when there's no
 * key OR it can't be decrypted; `corrupt` distinguishes those cases so
 * callers can warn ("a key is set but unusable") rather than silently
 * indexing lexical-only and reporting success. `provider` defaults to
 * 'openai' even when `key` is null, so callers never have to null-check
 * it separately.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string,
): Promise<{ key: string | null; provider: EmbeddingsProvider; corrupt: boolean }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key, embeddings_provider')
    .eq('account_id', accountId)
    .maybeSingle()
  const provider = normalizeEmbeddingsProvider(
    (data as { embeddings_provider?: string | null } | null)?.embeddings_provider ?? null,
  )
  if (error || !data?.embeddings_api_key) return { key: null, provider, corrupt: false }
  try {
    return { key: decrypt(data.embeddings_api_key), provider, corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, provider, corrupt: true }
  }
}
