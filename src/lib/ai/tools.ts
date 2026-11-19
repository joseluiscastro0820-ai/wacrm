// ============================================================
// Tool catalog for the AI auto-reply agent.
//
// Wraps the same tenant-scoped writes automations already trust
// (addContactTagIfAbsent, the tag_added fan-out, the allow-listed
// contact fields) so the model can act on a conversation — tag the
// contact, fix a typo'd name, record their company — instead of only
// producing text.
//
// First pass (still true for create_deal/send_webhook) was
// deliberately narrow: contact-level writes only (add_tag, remove_tag,
// update_contact_field). NOT included, and why:
//   - create_deal: touches money (deal value). Wants its own
//     validation + a real pipeline/stage picker before a model can
//     reach it.
//   - send_webhook: an external destination driven by model output is
//     a prompt-injection/exfiltration risk even behind the existing
//     SSRF guard (isDeliverableUrl only blocks internal targets, not a
//     customer talking the model into POSTing transcript data to an
//     attacker's own public URL). Needs a "pick a pre-registered
//     webhook" redesign.
//   - assign_conversation: the existing [[HANDOFF]] sentinel in
//     generate.ts / defaults.ts already owns handing a thread to a
//     human for the GENERAL case. A second, competing handoff path
//     risks a race between the two rather than adding anything.
//
// lookup_order / cancel_order / request_return (added 2026-11-19) are
// the one exception, deliberately: Jose asked for the AI to resolve an
// order cancellation or a return request itself instead of always
// escalating. The evaluator-optimizer guardrail (evaluate.ts) already
// in place is what makes trusting the model with "touches a live
// order" acceptable now — each handler still re-checks ownership
// itself (account_id + contact_id) since these run on the
// service-role client (RLS does not apply), exactly like
// update_contact_field already does for custom fields.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { getTagChainDepth, MAX_TAG_CHAIN_DEPTH } from '@/lib/contacts/tag-chain'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { sendAdminAlert } from '@/lib/whatsapp/send-admin-alert'
import { sendAccountPush } from '@/lib/push/send-push'
import { createPendingReturn } from '@/lib/returns/create-pending-return'
import type { ToolDefinition } from './types'

export interface ToolContext {
  accountId: string
  contactId: string
  conversationId: string
}

const BUILTIN_CONTACT_FIELDS = new Set(['name', 'email', 'company'])

/**
 * Builds this account's tool catalog, with enums filled from its real
 * tags / custom fields — the model is only ever offered ids that
 * genuinely exist, never free text it could hallucinate a UUID into.
 * Returns `[]` for an account with no tags configured yet (contact
 * fields are still offered — every account has those three columns).
 */
export async function buildAiTools(db: SupabaseClient, accountId: string): Promise<ToolDefinition[]> {
  const [{ data: tags }, { data: fields }] = await Promise.all([
    db.from('tags').select('id, name').eq('account_id', accountId).order('name'),
    db.from('custom_fields').select('id, field_name').eq('account_id', accountId).order('field_name'),
  ])

  const tagList = (tags ?? []) as { id: string; name: string }[]
  const fieldList = (fields ?? []) as { id: string; field_name: string }[]
  const tools: ToolDefinition[] = []

  if (tagList.length > 0) {
    const tagHelp = tagList.map((t) => `${t.id} = "${t.name}"`).join('; ')
    const tagIdParam = {
      type: 'string',
      description: 'The exact id of one of the available tags, never a made-up one.',
      enum: tagList.map((t) => t.id),
    }
    tools.push({
      name: 'add_tag',
      description: `Add a tag to the current contact, to categorize them (e.g. "interested", "VIP", "needs follow-up") based on what they said. Available tags (id = name): ${tagHelp}`,
      parameters: { type: 'object', properties: { tag_id: tagIdParam }, required: ['tag_id'] },
    })
    tools.push({
      name: 'remove_tag',
      description: `Remove a tag from the current contact, if it no longer applies. Available tags (id = name): ${tagHelp}`,
      parameters: { type: 'object', properties: { tag_id: tagIdParam }, required: ['tag_id'] },
    })
  }

  const fieldHelp = [
    ...Array.from(BUILTIN_CONTACT_FIELDS, (f) => `${f} = ${f}`),
    ...fieldList.map((f) => `custom:${f.id} = "${f.field_name}"`),
  ].join('; ')
  tools.push({
    name: 'update_contact_field',
    description: `Update a fact about the contact when the customer states it in the conversation (their name, email, company, or a custom field). Available fields (value for "field" = what it stores): ${fieldHelp}`,
    parameters: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          description: 'One of the available fields, EXACTLY as it appears left of "=" above.',
          enum: [...BUILTIN_CONTACT_FIELDS, ...fieldList.map((f) => `custom:${f.id}`)],
        },
        value: { type: 'string', description: 'The new value, as the customer stated it.' },
      },
      required: ['field', 'value'],
    },
  })

  // Always offered — every account has deals/orders, unlike tags
  // (which need at least one configured). See this file's header note
  // on why these three are the one exception to the "no money-moving
  // tools" rule.
  tools.push(
    {
      name: 'lookup_order',
      description:
        'Look up one of the CURRENT contact\'s own orders by its code (format "AF-0001", given to the customer by WhatsApp when their order was confirmed). Use this before cancel_order or request_return, to see the order\'s items/status and get the right item id. If the code does not match one of THIS contact\'s own orders you get "not found" — even if the code is real but belongs to someone else. Never guess or make up a code.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The order code the customer gave you, e.g. "AF-0001".' },
        },
        required: ['code'],
      },
    },
    {
      name: 'cancel_order',
      description:
        'Cancel one of the CURRENT contact\'s own orders — only works if it has not shipped yet. ALWAYS try once to understand why and offer to help or keep the sale before calling this; only call it once the customer still wants to cancel after that. This resolves it yourself — do not also hand off to a human for this.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The order code, e.g. "AF-0001".' },
          reason: { type: 'string', description: "Why the customer wants to cancel, in their own words." },
        },
        required: ['code', 'reason'],
      },
    },
    {
      name: 'request_return',
      description:
        'File a return for ONE item from one of the CURRENT contact\'s own orders (call lookup_order first to see the order\'s items and get the right item_id). This does NOT approve the return — it only files it for a human to review — so tell the customer an agent will check it soon, never that it is already approved or refunded.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: "The deal item's id, exactly as lookup_order returned it." },
          reason: { type: 'string', description: 'Why the customer wants to return it, in their own words.' },
        },
        required: ['item_id', 'reason'],
      },
    },
  )

  return tools
}

type ToolHandler = (
  db: SupabaseClient,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<string>

const handlers: Record<string, ToolHandler> = {
  add_tag: async (db, args, ctx) => {
    const tagId = typeof args.tag_id === 'string' ? args.tag_id : ''
    if (!tagId) return 'add_tag needs a tag_id'
    const added = await addContactTagIfAbsent(db, {
      accountId: ctx.accountId,
      contactId: ctx.contactId,
      tagId,
    })
    if (!added) return 'the contact already had that tag'

    // Mirror automations/engine.ts's tag_added fan-out, same depth
    // guard — a tool-driven tag starts the chain at depth 0.
    const depth = getTagChainDepth()
    if (depth < MAX_TAG_CHAIN_DEPTH) {
      await runAutomationsForTrigger({
        accountId: ctx.accountId,
        triggerType: 'tag_added',
        contactId: ctx.contactId,
        context: {
          conversation_id: ctx.conversationId,
          tag_id: tagId,
          vars: { _tag_chain_depth: depth + 1 },
        },
      })
    }
    return 'tag added'
  },

  remove_tag: async (db, args, ctx) => {
    const tagId = typeof args.tag_id === 'string' ? args.tag_id : ''
    if (!tagId) return 'remove_tag needs a tag_id'
    await db.from('contact_tags').delete().eq('contact_id', ctx.contactId).eq('tag_id', tagId)
    return 'tag removed'
  },

  update_contact_field: async (db, args, ctx) => {
    const field = typeof args.field === 'string' ? args.field : ''
    const value = typeof args.value === 'string' ? args.value : ''
    if (!field) return 'update_contact_field needs a field'

    if (field.startsWith('custom:')) {
      const customFieldId = field.slice('custom:'.length)
      if (!customFieldId) return `field ${field} is not writable`
      const { data: cf } = await db
        .from('custom_fields')
        .select('id')
        .eq('id', customFieldId)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (!cf) return `field ${field} is not writable`
      await db
        .from('contact_custom_values')
        .upsert(
          { contact_id: ctx.contactId, custom_field_id: customFieldId, value },
          { onConflict: 'contact_id,custom_field_id' },
        )
      return 'custom field updated'
    }

    if (!BUILTIN_CONTACT_FIELDS.has(field)) return `field ${field} is not writable`
    await db
      .from('contacts')
      .update({ [field]: value, updated_at: new Date().toISOString() })
      .eq('id', ctx.contactId)
      .eq('account_id', ctx.accountId)
    return `${field} updated`
  },

  lookup_order: async (db, args, ctx) => {
    const code = typeof args.code === 'string' ? args.code.trim().toUpperCase() : ''
    if (!code) return 'lookup_order needs a code'

    // Scoped to THIS contact — the ownership check that makes the
    // order code safe to hand a customer at all (see migration 046's
    // header note). Never relax this to "any contact on the account".
    const { data: deal } = await db
      .from('deals')
      .select('id, title, status, dispatched_at, deal_items(id, product_name, quantity)')
      .eq('order_code', code)
      .eq('account_id', ctx.accountId)
      .eq('contact_id', ctx.contactId)
      .maybeSingle()
    if (!deal) return `no order found with code ${code} for this contact`

    const items = (deal.deal_items ?? []) as { id: string; product_name: string; quantity: number }[]
    const itemsText =
      items.length > 0
        ? items.map((i) => `${i.id} = ${i.quantity}x "${i.product_name}"`).join('; ')
        : 'no items on file'
    const shipped = deal.dispatched_at ? 'already shipped' : 'not shipped yet'
    return `order ${code} "${deal.title}" — status: ${deal.status}, ${shipped}. Items (item_id = description): ${itemsText}`
  },

  cancel_order: async (db, args, ctx) => {
    const code = typeof args.code === 'string' ? args.code.trim().toUpperCase() : ''
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (!code || !reason) return 'cancel_order needs a code and a reason'

    const { data: deal } = await db
      .from('deals')
      .select('id, status, dispatched_at')
      .eq('order_code', code)
      .eq('account_id', ctx.accountId)
      .eq('contact_id', ctx.contactId)
      .maybeSingle()
    if (!deal) return `no order found with code ${code} for this contact`
    if (deal.dispatched_at) return 'cannot cancel — this order has already shipped'
    if (deal.status !== 'open') return `cannot cancel — this order is already "${deal.status}"`

    const { error } = await db
      .from('deals')
      .update({
        status: 'lost',
        cancelled_by: 'ai',
        cancellation_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', deal.id)
    if (error) return 'cancel_order failed — tell the customer a human will follow up'

    // Informational only — Jose explicitly asked for this NOT to wait
    // on him (2026-11-19): it's already resolved by the time he sees
    // either notification, whenever he next opens the app/WhatsApp.
    void sendAccountPush(ctx.accountId, {
      title: 'La IA canceló un pedido',
      body: `${code}: ${reason}`,
      path: '/pipelines',
    })
    void sendAdminAlert(ctx.accountId, `La IA canceló el pedido ${code}: ${reason}`)

    return `order ${code} cancelled`
  },

  request_return: async (db, args, ctx) => {
    const itemId = typeof args.item_id === 'string' ? args.item_id.trim() : ''
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (!itemId || !reason) return 'request_return needs an item_id and a reason'

    const { data: item } = await db
      .from('deal_items')
      .select('id, deal_id, product_id, product_name, quantity, deals!inner(account_id, contact_id)')
      .eq('id', itemId)
      .maybeSingle()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deal = item?.deals as any
    if (!item || !deal || deal.account_id !== ctx.accountId || deal.contact_id !== ctx.contactId) {
      return "that item does not belong to this contact's orders"
    }

    const { error } = await createPendingReturn(db, {
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      item: {
        id: item.id,
        deal_id: item.deal_id,
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: item.quantity,
      },
      customerNote: reason,
    })
    if (error) return 'request_return failed — tell the customer a human will follow up'

    return 'return filed, pending human review'
  },
}

/**
 * Run one tool call by name. Never throws — a failure (bad args, a DB
 * error) becomes a string result the model sees on its next turn, the
 * same contract automations/engine.ts uses for a failed step, so one
 * bad tool call degrades the reply rather than crashing the dispatch.
 */
export async function executeAiTool(
  db: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const handler = handlers[name]
  if (!handler) return `unknown tool: ${name}`
  try {
    return await handler(db, args, ctx)
  } catch (err) {
    return `tool failed: ${err instanceof Error ? err.message : String(err)}`
  }
}
