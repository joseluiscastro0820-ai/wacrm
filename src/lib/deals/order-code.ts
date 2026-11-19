import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Idempotently assigns this deal a short, customer-facing order code
 * ("AF-0001") the first time it's called for a given deal — a second
 * call for the same deal just returns the existing code (see
 * `assign_order_code`, migration 046, which does the actual
 * read-or-assign atomically to avoid a race between two concurrent
 * callers).
 *
 * Called once, right when a deal is marked "won" (see
 * /api/push/notify-deal-won/route.ts), and sent to the customer over
 * WhatsApp there. This code is the ONLY identifier the AI's order
 * tools (lookup_order, cancel_order, request_return — see
 * src/lib/ai/tools.ts) accept from a customer, specifically so the AI
 * never has to guess which of a contact's orders they mean.
 *
 * Returns null on any failure (RPC error, deal not found) — best
 * effort, same as the rest of this notification pipeline: a missing
 * code just means this deal doesn't get the WhatsApp receipt text,
 * never a reason to fail the push notification it rides along with.
 */
export async function ensureOrderCode(
  db: SupabaseClient,
  dealId: string,
): Promise<string | null> {
  const { data, error } = await db.rpc('assign_order_code', { p_deal_id: dealId })
  if (error) {
    console.error('[order-code] assign_order_code failed:', error)
    return null
  }
  return (data as string | null) ?? null
}
