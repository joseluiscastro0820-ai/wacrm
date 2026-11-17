// ============================================================
// Evaluator-optimizer guardrail for the AI auto-reply agent.
//
// One extra, cheap LLM call right before a reply is sent: does the
// draft follow the business's own instructions, does it actually
// answer what the customer asked, and does it state a specific fact
// that isn't backed by the conversation or the knowledge base? A
// failing draft is never sent — the caller treats it exactly like the
// model's own [[HANDOFF]] path and escalates to a human instead.
//
// Deliberately reuses `generateReply` (same provider dispatch, same
// account's own API key/model — no new per-provider code, no new
// "which cheap model" config surface) rather than adding a second
// code path. The eval call passes no `tools`, so it's just a single
// text round-trip through whichever provider the account already
// uses.
//
// Fails CLOSED: any problem on our side — a provider error, a
// response that isn't the JSON verdict we asked for — is treated as
// a failed evaluation (handoff), the same "when in doubt, don't
// guess" rule already applied to the main reply. `evaluateReply`
// itself NEVER throws, matching the never-throws contract the rest of
// this module's helpers (`executeAiTool`, `logAiUsage`) already use,
// so a guardrail bug can only make auto-reply hand off more often,
// never crash the dispatch or silently drop the customer's message.
// ============================================================

import { generateReply } from './generate'
import type { AiConfig, AiUsage, ChatMessage } from './types'

export interface EvaluationResult {
  ok: boolean
  /** Short, human-readable reason the draft failed — present only
   *  when `ok` is false and a reason was available. Surfaced in the
   *  handoff note so whoever picks up the thread knows why the bot
   *  bailed on a reply it had already drafted. */
  reason?: string
}

/** How many of the most recent messages the evaluator sees. Kept well
 *  below the main generation's context window — the evaluator only
 *  needs enough to judge "does this answer the question", not the
 *  whole thread. */
const EVAL_CONTEXT_MESSAGE_LIMIT = 10

const EVAL_SYSTEM_PROMPT = [
  "You are a quality reviewer checking one automated customer-service reply before it is sent on WhatsApp, with no human reviewing it first.",
  "You will be shown the business's own instructions, the knowledge-base excerpts available (if any), the recent conversation, and the draft reply the bot wants to send.",
  'Fail the draft (ok: false) if ANY of the following is true: it contradicts or ignores the business\'s stated instructions; it does not actually address what the customer last asked; it states a specific fact — a price, an order status, availability, a policy detail, a promise — that is not supported by the conversation or the knowledge-base excerpts; it is rude, inappropriate, or something the business clearly would not want sent.',
  'Otherwise pass it (ok: true). Give the benefit of the doubt on tone and phrasing — only fail for the substantive problems above.',
  'Respond with ONLY a JSON object and nothing else, no markdown fences, no commentary: {"ok": true} or {"ok": false, "reason": "<one short sentence, in the same language as the draft, explaining what is wrong>"}.',
].join(' ')

function buildEvalPrompt(args: {
  businessPrompt: string | null
  knowledge?: string[]
  messages: ChatMessage[]
  draftReply: string
}): string {
  const { businessPrompt, knowledge, messages, draftReply } = args

  const transcript = messages
    .slice(-EVAL_CONTEXT_MESSAGE_LIMIT)
    .map((m) => `${m.role === 'user' ? 'customer' : 'business'}: ${m.content}`)
    .join('\n')

  const knowledgeBlock =
    knowledge && knowledge.length > 0
      ? knowledge.map((k, i) => `[${i + 1}] ${k}`).join('\n\n')
      : '(none)'

  return [
    `Business instructions:\n${businessPrompt && businessPrompt.trim() ? businessPrompt.trim() : '(none provided)'}`,
    `Knowledge base excerpts:\n${knowledgeBlock}`,
    `Recent conversation:\n${transcript || '(no prior messages)'}`,
    `Draft reply the bot wants to send:\n"${draftReply}"`,
    'Evaluate this draft per your instructions and respond with the JSON verdict only.',
  ].join('\n\n')
}

/**
 * Pulls `{"ok": ...}` out of the model's response. Tolerant of a
 * stray markdown fence or a sentence around the JSON (models don't
 * always follow "only JSON" perfectly) — takes the first `{...}`
 * block it finds. Any shape that isn't a clean `{ok: boolean, ...}`
 * is treated as a failed evaluation rather than guessed at.
 */
function parseEvaluation(raw: string): EvaluationResult {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return { ok: false, reason: 'quality check returned no verdict' }

  try {
    const parsed = JSON.parse(match[0]) as { ok?: unknown; reason?: unknown }
    if (parsed.ok === true) return { ok: true }
    if (parsed.ok === false) {
      const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
      return reason ? { ok: false, reason } : { ok: false }
    }
    return { ok: false, reason: 'quality check returned an unexpected verdict' }
  } catch {
    return { ok: false, reason: 'quality check returned malformed output' }
  }
}

/**
 * Runs the pre-send guardrail on a draft reply the main generation
 * already produced. Returns the verdict plus this call's own token
 * usage (the caller logs it — see the `mode` note at the call site).
 *
 * Never throws: a provider error, timeout, or anything else that goes
 * wrong while checking the draft is reported as a failed evaluation
 * (`ok: false`) so the caller hands off rather than sending an
 * unreviewed reply or crashing the dispatch.
 */
export async function evaluateReply(args: {
  config: AiConfig
  businessPrompt: string | null
  knowledge?: string[]
  messages: ChatMessage[]
  draftReply: string
}): Promise<{ result: EvaluationResult; usage: AiUsage | null }> {
  const { config, businessPrompt, knowledge, messages, draftReply } = args
  const prompt = buildEvalPrompt({ businessPrompt, knowledge, messages, draftReply })

  try {
    const res = await generateReply({
      config,
      systemPrompt: EVAL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    })
    return { result: parseEvaluation(res.text), usage: res.usage }
  } catch (err) {
    console.warn('[ai auto-reply] guardrail check failed, handing off rather than sending unchecked:', err)
    return { result: { ok: false, reason: 'quality check failed to run' }, usage: null }
  }
}
