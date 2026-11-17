import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicResponse {
  content?: { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]
  usage?: { input_tokens?: number; output_tokens?: number }
  stop_reason?: string
}

/** Anthropic's `tools` envelope: flat, with `input_schema`. */
function toAnthropicTools(tools: ProviderArgs['tools']) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
}

/**
 * Replay prior tool rounds as Anthropic expects them: an assistant
 * message whose content holds one `tool_use` block per call, followed
 * by a user message whose content holds the matching `tool_result`
 * blocks — Anthropic requires that pairing, not separate per-call
 * messages.
 */
function toAnthropicToolMessages(toolTurns: ProviderArgs['toolTurns']): ChatMessageLike[] {
  const out: ChatMessageLike[] = []
  for (const round of toolTurns ?? []) {
    out.push({
      role: 'assistant',
      content: round.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments })),
    })
    out.push({
      role: 'user',
      content: round.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.result })),
    })
  }
  return out
}

type ChatMessageLike = { role: 'user' | 'assistant'; content: string | Record<string, unknown>[] }

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, toolTurns } = args

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [...normalizeForAnthropic(messages), ...toAnthropicToolMessages(toolTurns)],
        ...(toAnthropicTools(tools) ? { tools: toAnthropicTools(tools) } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  })

  const toolUseBlocks = (data?.content ?? []).filter((b) => b.type === 'tool_use')
  if (toolUseBlocks.length > 0) {
    const toolCalls = toolUseBlocks.map((b) => ({
      id: b.id ?? '',
      name: b.name ?? '',
      arguments: b.input ?? {},
    }))
    return { text: '', usage, toolCalls }
  }

  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  return { text, usage }
}
