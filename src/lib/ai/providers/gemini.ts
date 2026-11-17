import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import { mergeConsecutive, normalizeUsage, toNetworkError, type ProviderArgs } from './shared'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: { code?: number; message?: string; status?: string }
}

/** Gemini's `tools` envelope: one entry with a `functionDeclarations`
 *  array (Gemini groups all functions under a single tool). */
function toGeminiTools(tools: ProviderArgs['tools']) {
  if (!tools || tools.length === 0) return undefined
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ]
}

/**
 * Replay prior tool rounds as Gemini expects them: a `model` turn
 * carrying the `functionCall` part(s), followed by a `function` turn
 * carrying the matching `functionResponse` part(s).
 *
 * NOTE: unlike the OpenAI/Anthropic shapes below (both exercised
 * against their public docs with high confidence), this one hasn't
 * been smoke-tested against a live Gemini key — verify the first real
 * tool-calling run against Gemini before relying on it in production.
 */
function toGeminiToolContents(toolTurns: ProviderArgs['toolTurns']) {
  const out: { role: string; parts: Record<string, unknown>[] }[] = []
  for (const round of toolTurns ?? []) {
    out.push({
      role: 'model',
      parts: round.calls.map((c) => ({ functionCall: { name: c.name, args: c.arguments } })),
    })
    out.push({
      role: 'function',
      parts: round.results.map((r) => ({
        functionResponse: { name: r.name, response: { result: r.result } },
      })),
    })
  }
  return out
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
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, toolTurns } = args

  let res: Response
  try {
    res = await fetch(
      `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [...toGeminiContents(messages), ...toGeminiToolContents(toolTurns)],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
          ...(toGeminiTools(tools) ? { tools: toGeminiTools(tools) } : {}),
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
  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })

  const parts = data?.candidates?.[0]?.content?.parts ?? []
  const callParts = parts.filter((p) => p.functionCall?.name)
  if (callParts.length > 0) {
    // Gemini doesn't hand back a call id — synthesize one scoped to this
    // response so the result can be matched back to it on replay.
    const toolCalls = callParts.map((p, i) => ({
      id: `call_${i}`,
      name: p.functionCall!.name!,
      arguments: p.functionCall!.args ?? {},
    }))
    return { text: '', usage, toolCalls }
  }

  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }
  return { text, usage }
}
