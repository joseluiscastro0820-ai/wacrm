import type { SupabaseClient } from '@supabase/supabase-js'

type DB = SupabaseClient

// Bounded like the usage route's own `ai_usage_log` query (see
// src/app/api/ai/usage/route.ts) — an active account's bot-touched
// conversation volume sits comfortably under these caps; `truncated`
// tells the UI when it doesn't, so the stat reads as "partial" rather
// than silently wrong.
const MAX_CONVERSATIONS = 500
const MAX_MESSAGES = 5_000

export interface QualityMetrics {
  resolvedWithoutHumanPct: number | null
  resolvedWithoutHumanSamples: number
  avgFirstResponseMinutes: number | null
  avgFirstResponseSamples: number
  truncated: boolean
}

interface ConversationRow {
  id: string
  ai_autoreply_disabled: boolean
}

interface MessageRow {
  conversation_id: string
  sender_type: string
  ai_generated: boolean
  created_at: string
}

/**
 * Two quality signals for the AI usage dashboard, both computed over
 * conversations the bot actually touched (`ai_reply_count > 0`) with
 * activity since `since`:
 *
 *  - resolvedWithoutHumanPct — % of those conversations the bot is
 *    still handling solo, i.e. `ai_autoreply_disabled` is false. That
 *    flag flips true on a model-signaled handoff OR someone manually
 *    turning the bot off for that one thread (see migration 029), so
 *    "false" is as close as stored state gets to "the bot resolved
 *    this without a human stepping in."
 *  - avgFirstResponseMinutes — average time from a conversation's
 *    first customer message to the first `ai_generated` reply, one
 *    sample per conversation. Mirrors the pairing algorithm in
 *    lib/dashboard/queries.ts#loadResponseTime, but paired against
 *    the bot's own replies specifically rather than any outbound
 *    message, and capped at one sample per conversation (we only care
 *    about the bot's first touch, not every reply pair in the thread).
 */
export async function loadQualityMetrics(
  db: DB,
  accountId: string,
  since: Date,
): Promise<QualityMetrics> {
  const { data: convData, error: convErr } = await db
    .from('conversations')
    .select('id, ai_autoreply_disabled')
    .eq('account_id', accountId)
    .gt('ai_reply_count', 0)
    .gte('last_message_at', since.toISOString())
    .limit(MAX_CONVERSATIONS + 1)
  if (convErr) throw convErr

  const allConvs = (convData ?? []) as ConversationRow[]
  const convTruncated = allConvs.length > MAX_CONVERSATIONS
  const convs = convTruncated ? allConvs.slice(0, MAX_CONVERSATIONS) : allConvs

  const resolvedWithoutHumanSamples = convs.length
  const resolvedWithoutHumanPct =
    resolvedWithoutHumanSamples === 0
      ? null
      : (convs.filter((c) => !c.ai_autoreply_disabled).length /
          resolvedWithoutHumanSamples) *
        100

  if (convs.length === 0) {
    return {
      resolvedWithoutHumanPct,
      resolvedWithoutHumanSamples,
      avgFirstResponseMinutes: null,
      avgFirstResponseSamples: 0,
      truncated: convTruncated,
    }
  }

  const convIds = convs.map((c) => c.id)
  const { data: msgData, error: msgErr } = await db
    .from('messages')
    .select('conversation_id, sender_type, ai_generated, created_at')
    .in('conversation_id', convIds)
    .order('conversation_id', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(MAX_MESSAGES + 1)
  if (msgErr) throw msgErr

  const allMsgs = (msgData ?? []) as MessageRow[]
  const msgTruncated = allMsgs.length > MAX_MESSAGES
  const msgs = msgTruncated ? allMsgs.slice(0, MAX_MESSAGES) : allMsgs

  // Walk once, grouped by conversation (rows are ordered
  // conversation_id then created_at): track the first unanswered
  // customer message, and as soon as an ai_generated reply follows it,
  // record the gap and stop looking at that conversation — one sample
  // per thread, same discipline as loadResponseTime's "a single
  // customer message can only count once."
  let currentConv = ''
  let pendingCustomer: Date | null = null
  let resolved = false
  const samplesMin: number[] = []
  for (const row of msgs) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id
      pendingCustomer = null
      resolved = false
    }
    if (resolved) continue
    const ts = new Date(row.created_at)
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts
    } else if (row.ai_generated && pendingCustomer) {
      const diffMin = (ts.getTime() - pendingCustomer.getTime()) / 60_000
      if (diffMin >= 0) samplesMin.push(diffMin)
      resolved = true
    }
  }

  const avgFirstResponseMinutes =
    samplesMin.length === 0
      ? null
      : samplesMin.reduce((a, b) => a + b, 0) / samplesMin.length

  return {
    resolvedWithoutHumanPct,
    resolvedWithoutHumanSamples,
    avgFirstResponseMinutes,
    avgFirstResponseSamples: samplesMin.length,
    truncated: convTruncated || msgTruncated,
  }
}
