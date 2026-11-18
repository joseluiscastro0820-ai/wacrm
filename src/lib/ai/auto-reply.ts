import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge, buildPricingKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { sendAdminAlert } from '@/lib/whatsapp/send-admin-alert'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { buildAiTools, executeAiTool } from './tools'
import { evaluateReply } from './evaluate'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { AiError, type GenerateResult } from './types'
import type { AiConfig, ChatMessage, ToolDefinition } from './types'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/** Error codes worth one quick retry — transient provider-side hiccups
 *  (Gemini's free tier in particular returns 503 "model overloaded"
 *  fairly often) rather than something a retry can't fix (bad key,
 *  empty response). */
const RETRYABLE_CODES = new Set(['provider_error', 'rate_limited', 'network', 'timeout'])
const RETRY_DELAY_MS = 1500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `generateReply`, retrying once after a short delay when the failure
 * looks transient (provider capacity/rate-limit/network blip) rather
 * than a hard failure (bad key, empty response) a retry can't fix.
 * Free-tier providers — Gemini especially — routinely return a 503
 * "currently experiencing high demand" that clears within a second or
 * two, and without this a customer's message would otherwise just go
 * unanswered with nothing surfaced anywhere.
 */
async function generateReplyWithRetry(args: {
  config: AiConfig
  systemPrompt: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  runTool?: (name: string, toolArgs: Record<string, unknown>) => Promise<string>
}): Promise<GenerateResult> {
  try {
    return await generateReply(args)
  } catch (err) {
    const retryable = err instanceof AiError && RETRYABLE_CODES.has(err.code)
    if (!retryable) throw err
    console.warn(
      `[ai auto-reply] transient provider error, retrying once: ${err.message}`,
    )
    await sleep(RETRY_DELAY_MS)
    // A retry re-runs any tool calls the model makes this time too.
    // That's safe here: add_tag/update_contact_field are idempotent
    // (addContactTagIfAbsent no-ops on a duplicate, a field update is
    // last-write-wins), so a tool re-run on retry can't double-apply.
    return await generateReply(args)
  }
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort),
    // plus the always-on pricing reference (delivery zones + volume
    // discounts, migration 043) so the two most common "needs a human"
    // questions can now be answered directly — see buildPricingKnowledge.
    const knowledge = [
      ...(await buildPricingKnowledge(db, accountId)),
      ...(await retrieveKnowledge(db, accountId, config, latestUserMessage(messages))),
    ]

    // Tool catalog for this account (tags + contact fields it actually
    // has). Best-effort: a lookup failure here just means no tools
    // this turn, never a reason to fail the whole reply.
    const tools = await buildAiTools(db, accountId).catch((err) => {
      console.warn('[ai auto-reply] buildAiTools failed, continuing without tools:', err)
      return [] as ToolDefinition[]
    })

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      hasTools: tools.length > 0,
    })

    const { text, handoff: modelHandoff, usage } = await generateReplyWithRetry({
      config,
      systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      runTool:
        tools.length > 0
          ? (name, toolArgs) =>
              executeAiTool(db, name, toolArgs, { accountId, contactId, conversationId })
          : undefined,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    let handoff = modelHandoff || !text
    let handoffNote: string | undefined

    // Guardrail (evaluator-optimizer): the model DID produce a candidate
    // reply, but before it goes out, one more cheap check — does it
    // follow the business's own instructions, does it answer what the
    // customer asked, does it state a fact the conversation/knowledge
    // base doesn't back up? A failure here hands off exactly like the
    // model's own [[HANDOFF]] path above, instead of sending a reply
    // nobody reviewed. Skipped when the model already declined — a
    // handoff it already chose doesn't need re-checking.
    if (!handoff) {
      const evaluation = await evaluateReply({
        config,
        businessPrompt: config.systemPrompt,
        knowledge,
        messages,
        draftReply: text,
      })
      // Logged under the same 'auto_reply' bucket as the generation it's
      // checking — `ai_usage_log.mode` is a DB CHECK constrained to
      // ('auto_reply', 'draft'), and this one extra, small call doesn't
      // warrant a migration for its own bucket. It does mean the eval
      // call's cost is folded into the main generation's number in
      // reporting, not broken out separately.
      void logAiUsage(db, {
        accountId,
        conversationId,
        mode: 'auto_reply',
        provider: config.provider,
        model: config.model,
        usage: evaluation.usage,
      })
      if (!evaluation.result.ok) {
        handoff = true
        handoffNote = evaluation.result.reason
      }
    }

    if (handoff) {
      // The model can't (or shouldn't) answer, or the guardrail above
      // rejected its draft — stop auto-replying on this thread and hand
      // it to a human. We (a) pause the bot here (sticky until
      // re-enabled), (b) route the conversation to the configured
      // handoff agent — null leaves it in the shared queue — and (c)
      // leave a short internal note so whoever picks it up has context.
      // Assigning fires the `on_conversation_assigned` trigger, which
      // notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
        note: handoffNote,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      // Best-effort WhatsApp ping to the admin's own number (migration
      // 042) — the in-app notification above only reaches someone with
      // the app open; this reaches them wherever they are. Never
      // awaited into the critical path mattering: sendAdminAlert
      // swallows its own errors (e.g. alert_phone not configured, or
      // the template not approved yet), so it can't turn this into a
      // failed handoff.
      void sendAdminAlert(
        accountId,
        `Un chat pasó a atención humana: la IA no pudo responder.${
          handoffNote ? ` (${handoffNote})` : ''
        }`,
      )
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
