import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadQualityMetrics } from './quality-metrics'

interface Conv {
  id: string
  ai_autoreply_disabled: boolean
}
interface Msg {
  conversation_id: string
  sender_type: string
  ai_generated: boolean
  created_at: string
}

function makeDb(conversations: Conv[], messages: Msg[]) {
  const db = {
    from: (table: string) => {
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              gt: () => ({
                gte: () => ({
                  // The real query asks for MAX_CONVERSATIONS + 1 so it
                  // can detect truncation; the fake just mirrors that cap
                  // back via Postgres-style `limit` semantics.
                  limit: (n: number) =>
                    Promise.resolve({ data: conversations.slice(0, n), error: null }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'messages') {
        return {
          select: () => ({
            in: () => ({
              order: () => ({
                order: () => ({
                  limit: (n: number) =>
                    Promise.resolve({ data: messages.slice(0, n), error: null }),
                }),
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db as unknown as SupabaseClient
}

const SINCE = new Date('2026-10-01T00:00:00Z')

describe('loadQualityMetrics', () => {
  it('returns nulls when no conversation has a bot reply', async () => {
    const db = makeDb([], [])
    const result = await loadQualityMetrics(db, 'acct-1', SINCE)
    expect(result).toEqual({
      resolvedWithoutHumanPct: null,
      resolvedWithoutHumanSamples: 0,
      avgFirstResponseMinutes: null,
      avgFirstResponseSamples: 0,
      truncated: false,
    })
  })

  it('computes resolvedWithoutHumanPct from ai_autoreply_disabled', async () => {
    const convs: Conv[] = [
      { id: 'c1', ai_autoreply_disabled: false },
      { id: 'c2', ai_autoreply_disabled: false },
      { id: 'c3', ai_autoreply_disabled: true },
      { id: 'c4', ai_autoreply_disabled: false },
    ]
    const db = makeDb(convs, [])
    const result = await loadQualityMetrics(db, 'acct-1', SINCE)
    expect(result.resolvedWithoutHumanSamples).toBe(4)
    expect(result.resolvedWithoutHumanPct).toBe(75)
  })

  it('pairs first customer message to first ai_generated reply, one sample per conversation', async () => {
    const convs: Conv[] = [{ id: 'c1', ai_autoreply_disabled: false }]
    const msgs: Msg[] = [
      { conversation_id: 'c1', sender_type: 'customer', ai_generated: false, created_at: '2026-10-05T10:00:00Z' },
      // A human agent reply in between should NOT count as the bot's
      // first response.
      { conversation_id: 'c1', sender_type: 'agent', ai_generated: false, created_at: '2026-10-05T10:02:00Z' },
      { conversation_id: 'c1', sender_type: 'bot', ai_generated: true, created_at: '2026-10-05T10:05:00Z' },
      // A second customer message + bot reply in the same thread must
      // not add a second sample — only the first pairing counts.
      { conversation_id: 'c1', sender_type: 'customer', ai_generated: false, created_at: '2026-10-05T10:10:00Z' },
      { conversation_id: 'c1', sender_type: 'bot', ai_generated: true, created_at: '2026-10-05T10:20:00Z' },
    ]
    const db = makeDb(convs, msgs)
    const result = await loadQualityMetrics(db, 'acct-1', SINCE)
    expect(result.avgFirstResponseSamples).toBe(1)
    expect(result.avgFirstResponseMinutes).toBe(5)
  })

  it('averages across multiple conversations and ignores one with no bot reply yet', async () => {
    const convs: Conv[] = [
      { id: 'c1', ai_autoreply_disabled: false },
      { id: 'c2', ai_autoreply_disabled: false },
    ]
    const msgs: Msg[] = [
      { conversation_id: 'c1', sender_type: 'customer', ai_generated: false, created_at: '2026-10-05T10:00:00Z' },
      { conversation_id: 'c1', sender_type: 'bot', ai_generated: true, created_at: '2026-10-05T10:02:00Z' },
      // c2's bot hasn't replied yet — no sample from this conversation.
      { conversation_id: 'c2', sender_type: 'customer', ai_generated: false, created_at: '2026-10-06T09:00:00Z' },
    ]
    const db = makeDb(convs, msgs)
    const result = await loadQualityMetrics(db, 'acct-1', SINCE)
    expect(result.avgFirstResponseSamples).toBe(1)
    expect(result.avgFirstResponseMinutes).toBe(2)
  })

  it('is not truncated under the conversation cap', async () => {
    const convs: Conv[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      ai_autoreply_disabled: false,
    }))
    const db = makeDb(convs, [])
    const result = await loadQualityMetrics(db, 'acct-1', SINCE)
    expect(result.truncated).toBe(false)
    expect(result.resolvedWithoutHumanSamples).toBe(10)
  })

  it('flags truncated and caps the sample count when over the conversation limit (500)', async () => {
    const convs: Conv[] = Array.from({ length: 501 }, (_, i) => ({
      id: `c${i}`,
      ai_autoreply_disabled: false,
    }))
    const db = makeDb(convs, [])
    const result = await loadQualityMetrics(db, 'acct-1', SINCE)
    expect(result.truncated).toBe(true)
    expect(result.resolvedWithoutHumanSamples).toBe(500)
  })

  it('flags truncated when over the message limit (5000)', async () => {
    const convs: Conv[] = [{ id: 'c1', ai_autoreply_disabled: false }]
    // One customer message, then enough filler agent messages to push
    // the fetched row count past MAX_MESSAGES, then the bot's reply —
    // the reply itself gets cut off by the cap, so no sample forms,
    // but `truncated` must still be reported.
    const msgs: Msg[] = [
      { conversation_id: 'c1', sender_type: 'customer', ai_generated: false, created_at: '2026-10-05T10:00:00Z' },
      ...Array.from({ length: 5_000 }, (_, i) => ({
        conversation_id: 'c1',
        sender_type: 'agent',
        ai_generated: false,
        created_at: `2026-10-05T10:${String(1 + (i % 58)).padStart(2, '0')}:00Z`,
      })),
    ]
    const db = makeDb(convs, msgs)
    const result = await loadQualityMetrics(db, 'acct-1', SINCE)
    expect(result.truncated).toBe(true)
  })

  it('does not count a diffMin < 0 (clock skew) as a sample', async () => {
    const convs: Conv[] = [{ id: 'c1', ai_autoreply_disabled: false }]
    const msgs: Msg[] = [
      { conversation_id: 'c1', sender_type: 'customer', ai_generated: false, created_at: '2026-10-05T10:05:00Z' },
      { conversation_id: 'c1', sender_type: 'bot', ai_generated: true, created_at: '2026-10-05T10:00:00Z' },
    ]
    const db = makeDb(convs, msgs)
    const result = await loadQualityMetrics(db, 'acct-1', SINCE)
    // The pairing still resolves (so the conversation isn't counted
    // twice), but the negative gap is discarded rather than reported.
    expect(result.avgFirstResponseSamples).toBe(0)
    expect(result.avgFirstResponseMinutes).toBeNull()
  })
})
