import { AiError, type EmbeddingsProvider } from './types'
import { aiRequestTimeoutMs } from './defaults'
import { providerHttpError, toNetworkError } from './providers/shared'

// ============================================================
// Embeddings — OpenAI, or Gemini as an alternative.
//
// Used for the knowledge base's optional semantic-search path: embed
// each chunk at ingest, and embed the query at retrieval. Anthropic has
// no embeddings endpoint, so an Anthropic-main-chat account (or any
// account without an OpenAI key) needs a different provider for this
// one piece — `embeddings_provider` on `ai_configs` (migration 040)
// picks which, independent of the account's main chat provider.
//
// Both providers are requested at 1536 dimensions, matching the
// `vector(1536)` column from migration 030 — switching provider never
// requires a column change, only a re-index (existing chunks embedded
// by the other provider live in a different vector space and should
// be refreshed via Settings → AI Assistant → Reindex).
//
// Gemini path is UNTESTED against a live key (same caveat as the
// Gemini tool-calling adapter) — written from Google's current REST
// docs as of Nov 2026; `gemini-embedding-001` was picked over the
// newer `gemini-embedding-2` specifically because its request shape,
// task-type field, and per-text batching are unambiguously documented,
// where gemini-embedding-2's were not at the time this was written.
// ============================================================

/** Which side of a retrieval pair a text is: affects how Gemini is
 *  asked to optimize the embedding (OpenAI has no such knob — the
 *  OpenAI path ignores this). Ingest uses 'document', a live query
 *  uses 'query'. */
export type EmbeddingTaskType = 'document' | 'query'

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'

const GEMINI_EMBEDDINGS_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents'
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'

/** Shared target dimensionality for both providers — matches the
 *  `vector(1536)` column; keep in sync with migration 030 if that
 *  ever changes. */
export const EMBEDDING_DIMENSIONS = 1536

// Keep batches modest so a big re-index stays under request-size
// limits and partial failures are cheap. Neither provider's docs state
// a hard batch cap at the time of writing; 96 is OpenAI's own
// embeddings example size and is reused for Gemini too.
const BATCH_SIZE = 96

interface OpenAiEmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[]
}

interface GeminiBatchEmbedResponse {
  embeddings?: { values?: number[] }[]
}

/** Format a vector for a pgvector column / RPC param: `[0.1,0.2,...]`.
 *  PostgREST casts this text literal to `vector`; a raw JS array does
 *  not cast reliably. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/** L2-normalize a vector in place semantics (returns a new array).
 *  Google's docs: `gemini-embedding-001` auto-normalizes only its
 *  native 3072-dim output — requesting a truncated size (we request
 *  1536) means the caller must normalize. A zero vector (shouldn't
 *  happen for real text) is returned unchanged rather than divided by
 *  zero. */
function l2Normalize(vec: number[]): number[] {
  let sumSq = 0
  for (const v of vec) sumSq += v * v
  const norm = Math.sqrt(sumSq)
  if (!Number.isFinite(norm) || norm === 0) return vec
  return vec.map((v) => v / norm)
}

/**
 * Embed a list of strings, preserving input order. Batched; throws
 * `AiError` on provider/network failure so callers can decide whether
 * to degrade (retrieval) or surface (ingest). `taskType` only affects
 * the Gemini path (optimizes the embedding for a document being
 * indexed vs. a query being matched against it); ignored by OpenAI.
 */
export async function embedTexts(
  provider: EmbeddingsProvider,
  apiKey: string,
  inputs: string[],
  taskType: EmbeddingTaskType = 'document',
): Promise<number[][]> {
  if (inputs.length === 0) return []
  return provider === 'gemini'
    ? embedTextsGemini(apiKey, inputs, taskType)
    : embedTextsOpenAi(apiKey, inputs)
}

async function embedTextsOpenAi(
  apiKey: string,
  inputs: string[],
): Promise<number[][]> {
  const timeoutMs = aiRequestTimeoutMs()
  const out: number[][] = []

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)

    let res: Response
    try {
      res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: OPENAI_EMBEDDING_MODEL, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }

    if (!res.ok) {
      throw await providerHttpError('OpenAI embeddings', res)
    }

    const data = (await res.json().catch(() => null)) as OpenAiEmbeddingResponse | null
    const rows = data?.data
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Embeddings response was malformed.', {
        code: 'embeddings_malformed',
      })
    }

    // Sort by index so order matches the input batch regardless of how
    // the provider returns them. Require a real numeric index — defaulting
    // a missing one to 0 would silently misalign chunks with their
    // vectors (chunk N gets chunk M's embedding), so fail loud instead.
    if (rows.some((r) => typeof r.index !== 'number')) {
      throw new AiError('Embeddings response was missing result indices.', {
        code: 'embeddings_malformed',
      })
    }
    const ordered = [...rows].sort((a, b) => a.index! - b.index!)
    for (const r of ordered) {
      if (!Array.isArray(r.embedding)) {
        throw new AiError('Embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        })
      }
      out.push(r.embedding)
    }
  }

  return out
}

async function embedTextsGemini(
  apiKey: string,
  inputs: string[],
  taskType: EmbeddingTaskType,
): Promise<number[][]> {
  const timeoutMs = aiRequestTimeoutMs()
  const out: number[][] = []
  const geminiTaskType = taskType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT'

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)

    let res: Response
    try {
      res = await fetch(GEMINI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${GEMINI_EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            taskType: geminiTaskType,
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }

    if (!res.ok) {
      throw await providerHttpError('Gemini embeddings', res)
    }

    const data = (await res.json().catch(() => null)) as GeminiBatchEmbedResponse | null
    const rows = data?.embeddings
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Embeddings response was malformed.', {
        code: 'embeddings_malformed',
      })
    }

    // batchEmbedContents has no per-item index (unlike OpenAI) — the
    // API contract is that `embeddings[]` comes back in request order,
    // so unlike the OpenAI path there is nothing to sort by. The length
    // check above is the only integrity check available.
    for (const r of rows) {
      if (!Array.isArray(r.values)) {
        throw new AiError('Embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        })
      }
      // Requesting a truncated (non-3072) size means the vector isn't
      // auto-normalized by the API — normalize here. Harmless for the
      // cosine-distance RPC either way (cosine similarity is already
      // scale-invariant), but matches Google's own guidance and keeps
      // vectors consistent for anything that assumes unit length later.
      out.push(l2Normalize(r.values))
    }
  }

  return out
}
