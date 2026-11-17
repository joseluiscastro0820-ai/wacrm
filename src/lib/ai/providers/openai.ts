import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface OpenAiResponse {
  choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/** OpenAI's `tools` envelope: `{type:'function', function:{...}}`. */
function toOpenAiTools(tools: ProviderArgs['tools']) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/**
 * Replay prior tool rounds as OpenAI expects them: the assistant turn
 * that requested the call(s), immediately followed by one `tool` role
 * message per call carrying its result.
 */
function toOpenAiToolMessages(toolTurns: ProviderArgs['toolTurns']) {
  const out: Record<string, unknown>[] = []
  for (const round of toolTurns ?? []) {
    out.push({
      role: 'assistant',
      content: null,
      tool_calls: round.calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    })
    for (const r of round.results) {
      out.push({ role: 'tool', tool_call_id: r.id, content: r.result })
    }
  }
  return out
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`) — or, when the model asked to use a tool instead
 * of answering, the requested tool call(s) with no text.
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, toolTurns } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
          ...toOpenAiToolMessages(toolTurns),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        ...(toOpenAiTools(tools) ? { tools: toOpenAiTools(tools) } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })

  const rawToolCalls = data?.choices?.[0]?.message?.tool_calls
  if (rawToolCalls && rawToolCalls.length > 0) {
    const toolCalls = rawToolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseToolArguments(tc.function.arguments),
    }))
    return { text: '', usage, toolCalls }
  }

  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    })
  }
  return { text, usage }
}

/** The model's own JSON — malformed arguments become `{}` rather than
 *  throwing, so one bad tool call fails that tool, not the whole reply. */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
