// ============================================================
// Tool catalog for the AI auto-reply agent.
//
// Wraps the same tenant-scoped writes automations already trust
// (addContactTagIfAbsent, the tag_added fan-out, the allow-listed
// contact fields) so the model can act on a conversation — tag the
// contact, fix a typo'd name, record their company — instead of only
// producing text.
//
// Scope for this first pass is deliberately narrow: contact-level
// writes only (add_tag, remove_tag, update_contact_field). NOT
// included yet, and why:
//   - create_deal: touches money (deal value). Wants its own
//     validation + a real pipeline/stage picker before a model can
//     reach it.
//   - send_webhook: an external destination driven by model output is
//     a prompt-injection/exfiltration risk even behind the existing
//     SSRF guard (isDeliverableUrl only blocks internal targets, not a
//     customer talking the model into POSTing transcript data to an
//     attacker's own public URL). Needs the evaluator-optimizer
//     guardrail first, or a "pick a pre-registered webhook" redesign.
//   - assign_conversation: the existing [[HANDOFF]] sentinel in
//     generate.ts / defaults.ts already owns handing a thread to a
//     human. A second, competing handoff path risks a race between
//     the two rather than adding anything.
// All three are tracked as the next step in the "Agentes de IA: qué
// sirve y qué integrar en Agent Free" doc (fase 2 — after the
// evaluator-optimizer guardrail lands).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { getTagChainDepth, MAX_TAG_CHAIN_DEPTH } from '@/lib/contacts/tag-chain'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
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
