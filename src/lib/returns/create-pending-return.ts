import type { SupabaseClient } from '@supabase/supabase-js'
import { sendAdminAlert } from '@/lib/whatsapp/send-admin-alert'
import { sendAccountPush } from '@/lib/push/send-push'

export interface PendingReturnItem {
  /** deal_items.id — the row being returned. */
  id: string
  deal_id: string
  product_id: string | null
  product_name: string
  quantity: number
}

/**
 * Files a new pending return. Shared by the two ways one can start:
 * a customer tapping the "¿qué deseas devolver?" interactive list an
 * agent sends from ContactSidebar (see the WhatsApp webhook route),
 * and the AI's own `request_return` tool (src/lib/ai/tools.ts), used
 * when a customer asks for one directly in chat — now that an order
 * code (migration 046) lets the AI identify the exact item without
 * guessing.
 *
 * Only FILES the return — approving or rejecting it is always a
 * human's job from Acciones/Devoluciones, never automatic. That's
 * Jose's own call (2026-11-19): the AI gets to resolve a cancellation
 * on its own, but not a return of something already delivered.
 *
 * Never throws: both admin-notification calls are best-effort (see
 * their own docs), and the insert's own failure is left for the
 * caller to handle/log in whatever way fits its context (the two
 * call sites already differ on what they tell the customer when
 * something goes wrong upstream of this).
 */
export async function createPendingReturn(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    item: PendingReturnItem
    /** Why the customer wants to return it, in their own words — left
     *  null for the interactive-list path, which doesn't ask. */
    customerNote?: string | null
  },
): Promise<{ error: string | null }> {
  const { accountId, conversationId, contactId, item, customerNote } = args

  const { error } = await db.from('returns').insert({
    account_id: accountId,
    conversation_id: conversationId,
    contact_id: contactId,
    deal_id: item.deal_id,
    deal_item_id: item.id,
    product_id: item.product_id,
    product_name: item.product_name,
    quantity: item.quantity,
    status: 'pending',
    customer_note: customerNote || null,
  })
  if (error) return { error: error.message }

  // Unlike a conversation handoff, a pending return creates no in-app
  // notification at all beyond these two — see migration 042's ops
  // notes. Both are best-effort / never throw.
  void sendAdminAlert(
    accountId,
    `Nueva devolución pendiente: ${item.quantity}x "${item.product_name}".`,
  )
  void sendAccountPush(accountId, {
    title: 'Nueva devolución pendiente',
    body: `${item.quantity}x "${item.product_name}"`,
    path: '/actions',
  })

  return { error: null }
}
