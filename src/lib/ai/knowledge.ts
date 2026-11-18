import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

interface MatchRow {
  id: string
  content: string
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk. Runs under whatever client the
 * caller passes (service-role for ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey' | 'embeddingsProvider'>,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  // Replace, don't append — re-ingest must be idempotent.
  const { error: delErr } = await db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', documentId)
  if (delErr) throw delErr

  if (chunks.length === 0) return

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsProvider, config.embeddingsApiKey, chunks, 'document')
    } catch (err) {
      embedError = err
    }
  }

  const rows = chunks.map((content, i) => ({
    document_id: documentId,
    account_id: accountId,
    chunk_index: i,
    content,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }))

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
  if (insErr) throw insErr

  if (embedError) throw embedError
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks), then topped up with lexical full-text
 * matches to fill `k`. Lexical-only when there's no key. Best-effort:
 * any failure (no KB, embedding error, RPC error) degrades to fewer or
 * zero results and never throws into the draft / auto-reply path.
 */

/**
 * Grounding text for the two pricing questions that used to always
 * require a human (migration 043 — "Fase 0" of reducing how often
 * Jose gets paged): delivery fee to a specific city/zone, and
 * quantity/wholesale discounts. Returned as extra `knowledge` entries
 * so the model can quote them directly via the same
 * "never invent prices" system-prompt rule that already governs
 * knowledge-base excerpts — this is just another trusted source, not
 * a tool call, so it carries zero write risk.
 *
 * Deliberately separate from retrieveKnowledge(): that function's
 * early-out ("no ai_knowledge_chunks rows → skip everything") has
 * nothing to do with whether this account has configured zones or
 * discounts, and a query-relevance check doesn't apply here — this is
 * small, static reference data the model should always see in full,
 * not something to search. Best-effort like its sibling: any DB
 * hiccup degrades to an empty list rather than failing the reply.
 */
export async function buildPricingKnowledge(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  try {
    const [{ data: zones }, { data: discounts }] = await Promise.all([
      db
        .from('delivery_zones')
        .select('label, fee')
        .eq('account_id', accountId)
        .order('label'),
      db
        .from('volume_discounts')
        .select('min_quantity, discount_percent')
        .eq('account_id', accountId)
        .order('min_quantity'),
    ])

    const entries: string[] = []
    if (zones && zones.length > 0) {
      entries.push(
        'Delivery fees by city/zone — quote the exact number when a customer asks about delivery to one of these places. ' +
          "If their city isn't listed here, do NOT guess a fee — say you'll check and a human will confirm it:\n" +
          zones.map((z: { label: string; fee: number }) => `- ${z.label}: ${z.fee}`).join('\n'),
      )
    }
    if (discounts && discounts.length > 0) {
      entries.push(
        'Volume/wholesale discounts — mention and apply these exactly when a customer asks about buying in bulk or a quantity that qualifies:\n' +
          discounts
            .map((d: { min_quantity: number; discount_percent: number }) => `- ${d.min_quantity}+ units: ${d.discount_percent}% off`)
            .join('\n'),
      )
    }
    return entries
  } catch (err) {
    console.error('[ai] buildPricingKnowledge failed:', err)
    return []
  }
}

export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey' | 'embeddingsProvider'>,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two RPCs
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return []
  } catch {
    return []
  }

  const picked = new Map<string, string>() // id → content, preserves order

  // Semantic path.
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(
        config.embeddingsProvider,
        config.embeddingsApiKey,
        [query],
        'query',
      )
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data as MatchRow[]) picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: query,
        p_match_count: k,
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (picked.size >= k) break
          if (!picked.has(row.id)) picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}
