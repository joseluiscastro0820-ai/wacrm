import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import { mergeConsecutive, normalizeUsage, toNetworkError, type ProviderArgs } from './shared'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: { code?: number; message?: string; status?: string }
}

/**
 * Gemini uses `user`/`model` roles (not `assistant`) and takes the
 * system prompt as a separate top-level field rather than a message.
 */
function toGeminiContents(messages: ChatMessage[]) {
  return mergeConsecutive(messages).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

/**
 * Call Google's Gemini API (`generateContent`) with the caller's own
 * free-tier-eligible API key. Unlike OpenAI/Anthropic, Gemini reports
 * an invalid key as HTTP 400 with a `status`/`message` in the body
 * rather than a plain 401/403 — detect that explicitly so the settings
 * "Test key" button surfaces "invalid key" instead of a generic error.
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(
      `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: toGeminiContents(messages),
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as GeminiResponse | null
    const status = body?.error?.status
    const detail = body?.error?.message ?? ''
    const looksLikeBadKey =
      status === 'UNAUTHENTICATED' ||
      status === 'PERMISSION_DENIED' ||
      /api key not valid|api_key_invalid/i.test(detail)
    const code = looksLikeBadKey
      ? 'invalid_key'
      : status === 'RESOURCE_EXHAUSTED'
        ? 'rate_limited'
        : 'provider_error'
    const base =
      code === 'invalid_key'
        ? 'Gemini rejected the API key'
        : code === 'rate_limited'
          ? 'Gemini rate limit reached'
          : `Gemini API error (${res.status})`
    throw new AiError(detail ? `${base}: ${detail}` : base, {
      code,
      // Surface an auth failure as 401 so the settings "Test key" button
      // can show "invalid key"; everything else is an upstream 502.
      status: code === 'invalid_key' ? 401 : 502,
    })
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })
  return { text, usage }
}
