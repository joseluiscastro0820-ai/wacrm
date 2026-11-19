import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { sendAccountPush } from '@/lib/push/send-push'
import { formatCurrency } from '@/lib/currency'
import { ensureOrderCode } from '@/lib/deals/order-code'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { supabaseAdmin } from '@/lib/flows/admin-client'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * POST /api/push/notify-deal-won
 *
 * Fired (fire-and-forget, from deal-form.tsx's handleStatusChange)
 * right after a deal's status is set to "won" client-side. A
 * separate tiny route rather than folding this into the status
 * update itself: that update already works directly against
 * Supabase from the client (same as every other deal mutation in
 * this app), and the push side effect needs server-only code
 * (sendAccountPush → firebase-admin + the service-role client) that
 * can't run in a "use client" component. This route re-derives the
 * deal's own account_id from the DB (never trusts a client-supplied
 * one) so a stranger can't use it to push into someone else's
 * account.
 *
 * One of the three Acciones-page events Jose picked for native push
 * (the other two — AI handoff, new return — already fire from
 * server code paths and call sendAccountPush directly).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`push-deal-won:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const dealId = typeof body.dealId === 'string' ? body.dealId.trim() : ''
    if (!dealId) return bad('dealId is required')

    // RLS already scopes this to the caller's own account, but the
    // explicit .eq keeps the intent obvious and costs nothing.
    const { data: deal, error } = await supabase
      .from('deals')
      .select('id, title, value, currency, status, conversation_id, contact:contacts(name, phone)')
      .eq('id', dealId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (error || !deal || deal.status !== 'won') {
      // Not an error worth surfacing to the UI — the status update
      // itself already succeeded and is the thing that matters; this
      // is best-effort just like sendAdminAlert.
      return NextResponse.json({ ok: true })
    }

    const contact = Array.isArray(deal.contact) ? deal.contact[0] : deal.contact
    const who = contact?.name?.trim() || contact?.phone || 'un cliente'

    void sendAccountPush(accountId, {
      title: 'Pedido listo para despachar',
      body: `"${deal.title}" (${formatCurrency(deal.value, deal.currency)}) — ${who}. Márcalo en Acciones.`,
      path: '/actions',
    })

    // Assigns the order its receipt code (idempotent — a deal moved
    // won → lost → won again keeps the same one) and sends it to the
    // customer, so the AI's order tools (lookup_order/cancel_order/
    // request_return — see src/lib/ai/tools.ts) have something to ask
    // for later. Best-effort: never lets a WhatsApp hiccup affect the
    // push notification above, which already succeeded.
    const admin = supabaseAdmin()
    const orderCode = await ensureOrderCode(admin, deal.id)
    if (orderCode && deal.conversation_id) {
      await sendMessageToConversation(admin, accountId, {
        conversationId: deal.conversation_id,
        messageType: 'text',
        contentText: `✅ Tu pedido fue confirmado. Código: ${orderCode} — guárdalo, lo necesitarás si deseas cancelarlo o solicitar una devolución más adelante.`,
      }).catch((err) =>
        console.error('[push/notify-deal-won] order-code message failed:', err),
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
