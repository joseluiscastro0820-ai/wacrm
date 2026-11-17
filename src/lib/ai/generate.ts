import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
  type ToolDefinition,
  type ToolRound,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'
import { generateGemini } from './providers/gemini'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Tool catalog to offer the model. Omitted = no tool calling, the
   *  exact behaviour this feature had before tools existed. */
  tools?: ToolDefinition[]
  /** Runs one tool call and returns its result as text. Required when
   *  `tools` is set. */
  runTool?: (name: string, args: Record<string, unknown>) => Promise<string>
}

/** Bound on how many tool round-trips one `generateReply` call will
 *  make before giving up and handing off, so a model that keeps asking
 *  for tools (or a tool that keeps failing) can't loop forever on the
 *  caller's own provider key. */
const MAX_TOOL_STEPS = 3

function sumUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

async function callProvider(
  provider: AiConfig['provider'],
  providerArgs: {
    apiKey: string
    model: string
    systemPrompt: string
    messages: ChatMessage[]
    timeoutMs: number
    tools?: ToolDefinition[]
    toolTurns?: ToolRound[]
  },
) {
  switch (provider) {
    case 'openai':
      return generateOpenAi(providerArgs)
    case 'anthropic':
      return generateAnthropic(providerArgs)
    case 'gemini':
      return generateGemini(providerArgs)
    default:
      throw new AiError(`Unsupported AI provider: ${provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter; when `tools` is given and the model
 * asks to use one, runs it via `runTool` and loops back with the result
 * (capped at `MAX_TOOL_STEPS`) before parsing the final text for the
 * handoff sentinel. Throws `AiError` on any provider/network failure —
 * a tool itself failing does NOT throw, it becomes a result the model
 * sees (same contract as a failed automation step).
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, tools, runTool } = args
  const timeoutMs = aiRequestTimeoutMs()
  const toolTurns: ToolRound[] = []
  let usage: AiUsage | null = null

  for (let step = 0; ; step++) {
    const result = await callProvider(config.provider, {
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      messages,
      timeoutMs,
      tools,
      toolTurns,
    })
    usage = sumUsage(usage, result.usage)

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return parseGeneration(result.text, usage)
    }

    // The model wants a tool. Without a way to run one (shouldn't
    // happen — we only pass `tools` together with `runTool` — but a
    // stale call site is cheap to guard) or past the step cap, stop
    // guessing and hand off rather than silently dropping the request.
    if (!runTool || step >= MAX_TOOL_STEPS) {
      return { text: '', handoff: true, usage }
    }

    const results = await Promise.all(
      result.toolCalls.map(async (call) => ({
        id: call.id,
        name: call.name,
        result: await runTool(call.name, call.arguments),
      })),
    )
    toolTurns.push({ calls: result.toolCalls, results })
  }
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}
