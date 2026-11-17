import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { loadAiConfig, loadEmbeddingsKey } from './config'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
  embeddings_provider: 'openai',
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
    expect(config!.embeddingsProvider).toBe('openai')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })

  it('threads embeddings_provider=gemini through to the config', async () => {
    const config = await loadAiConfig(
      dbReturning({ ...ROW, embeddings_provider: 'gemini' }),
      'acct',
      { requireActive: false },
    )
    expect(config!.embeddingsProvider).toBe('gemini')
  })

  it('defaults embeddings_provider to openai for a pre-migration row (null)', async () => {
    const config = await loadAiConfig(
      dbReturning({ ...ROW, embeddings_provider: null }),
      'acct',
      { requireActive: false },
    )
    expect(config!.embeddingsProvider).toBe('openai')
  })
})

describe('loadEmbeddingsKey', () => {
  it('returns the decrypted key and provider when both are set', async () => {
    const result = await loadEmbeddingsKey(
      dbReturning({ embeddings_api_key: 'enc-emb', embeddings_provider: 'gemini' }),
      'acct',
    )
    expect(result).toEqual({ key: 'plain:enc-emb', provider: 'gemini', corrupt: false })
  })

  it('defaults provider to openai when there is no key at all', async () => {
    const result = await loadEmbeddingsKey(
      dbReturning({ embeddings_api_key: null, embeddings_provider: null }),
      'acct',
    )
    expect(result).toEqual({ key: null, provider: 'openai', corrupt: false })
  })

})
