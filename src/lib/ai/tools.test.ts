import { describe, it, expect, vi, beforeEach } from 'vitest'

// Isolate tools.ts from tag-write.ts / automations/engine.ts internals —
// both have their own test coverage; here we only check that tools.ts
// calls them with the right arguments and handles their result.
const h = vi.hoisted(() => ({
  addContactTagIfAbsent: vi.fn(),
  runAutomationsForTrigger: vi.fn(),
}))
vi.mock('@/lib/contacts/tag-write', () => ({
  addContactTagIfAbsent: h.addContactTagIfAbsent,
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))

import { buildAiTools, executeAiTool } from './tools'

const CTX = { accountId: 'acct-1', contactId: 'contact-1', conversationId: 'conv-1' }

/** Minimal chainable Supabase-query-builder stand-in. Each call records
 *  itself and resolves `result` once the chain is awaited. */
function makeChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  chain.select = self
  chain.eq = self
  chain.order = () => Promise.resolve(result)
  chain.maybeSingle = () => Promise.resolve(result)
  chain.delete = self
  chain.update = self
  chain.upsert = () => Promise.resolve(result)
  return chain
}

function mockDb(byTable: Record<string, { data: unknown; error: unknown }>) {
  const calls: { table: string }[] = []
  return {
    calls,
    from: (table: string) => {
      calls.push({ table })
      return makeChain(byTable[table] ?? { data: null, error: null })
    },
  }
}

beforeEach(() => {
  h.addContactTagIfAbsent.mockReset()
  h.runAutomationsForTrigger.mockReset()
})

describe('buildAiTools', () => {
  it('offers add_tag/remove_tag with the account\'s real tag ids in the enum', async () => {
    const db = mockDb({
      tags: { data: [{ id: 'tag-1', name: 'VIP' }, { id: 'tag-2', name: 'Lead' }], error: null },
      custom_fields: { data: [], error: null },
    }) as never

    const tools = await buildAiTools(db, 'acct-1')

    const addTag = tools.find((t) => t.name === 'add_tag')
    expect(addTag).toBeTruthy()
    expect(addTag!.parameters.properties.tag_id.enum).toEqual(['tag-1', 'tag-2'])
    expect(addTag!.description).toContain('VIP')
    expect(tools.find((t) => t.name === 'remove_tag')).toBeTruthy()
  })

  it('omits add_tag/remove_tag when the account has no tags', async () => {
    const db = mockDb({
      tags: { data: [], error: null },
      custom_fields: { data: [], error: null },
    }) as never

    const tools = await buildAiTools(db, 'acct-1')

    expect(tools.find((t) => t.name === 'add_tag')).toBeUndefined()
    // update_contact_field is always offered — every account has the
    // three built-in columns.
    expect(tools.find((t) => t.name === 'update_contact_field')).toBeTruthy()
  })

  it('includes custom fields in update_contact_field, namespaced as custom:<id>', async () => {
    const db = mockDb({
      tags: { data: [], error: null },
      custom_fields: { data: [{ id: 'cf-1', field_name: 'Budget' }], error: null },
    }) as never

    const tools = await buildAiTools(db, 'acct-1')
    const field = tools.find((t) => t.name === 'update_contact_field')!
    expect(field.parameters.properties.field.enum).toContain('custom:cf-1')
    expect(field.description).toContain('Budget')
  })
})

describe('executeAiTool', () => {
  it('add_tag: adds the tag and fans out tag_added when newly added', async () => {
    h.addContactTagIfAbsent.mockResolvedValue(true)
    const db = mockDb({}) as never

    const result = await executeAiTool(db, 'add_tag', { tag_id: 'tag-1' }, CTX)

    expect(result).toBe('tag added')
    expect(h.addContactTagIfAbsent).toHaveBeenCalledWith(db, {
      accountId: 'acct-1',
      contactId: 'contact-1',
      tagId: 'tag-1',
    })
    expect(h.runAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', triggerType: 'tag_added', contactId: 'contact-1' }),
    )
  })

  it('add_tag: does not fan out tag_added when the tag was already present', async () => {
    h.addContactTagIfAbsent.mockResolvedValue(false)
    const db = mockDb({}) as never

    const result = await executeAiTool(db, 'add_tag', { tag_id: 'tag-1' }, CTX)

    expect(result).toBe('the contact already had that tag')
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('update_contact_field: refuses a field outside the allow-list', async () => {
    const db = mockDb({}) as never
    const result = await executeAiTool(
      db,
      'update_contact_field',
      { field: 'id', value: 'drop me' },
      CTX,
    )
    expect(result).toContain('not writable')
  })

  it('update_contact_field: writes an allowed built-in field, scoped to the account', async () => {
    const dbObj = mockDb({})
    const result = await executeAiTool(
      dbObj as never,
      'update_contact_field',
      { field: 'company', value: 'Acme' },
      CTX,
    )
    expect(result).toBe('company updated')
    expect(dbObj.calls.some((c) => c.table === 'contacts')).toBe(true)
  })

  it('update_contact_field: refuses a custom field id from another account', async () => {
    const db = mockDb({ custom_fields: { data: null, error: null } }) as never
    const result = await executeAiTool(
      db,
      'update_contact_field',
      { field: 'custom:not-mine', value: 'x' },
      CTX,
    )
    expect(result).toContain('not writable')
  })

  it('never throws on a DB error — returns it as a result string', async () => {
    h.addContactTagIfAbsent.mockRejectedValue(new Error('db unreachable'))
    const db = mockDb({}) as never
    const result = await executeAiTool(db, 'add_tag', { tag_id: 'tag-1' }, CTX)
    expect(result).toContain('tool failed')
  })

  it('reports an unknown tool name instead of throwing', async () => {
    const db = mockDb({}) as never
    const result = await executeAiTool(db, 'delete_everything', {}, CTX)
    expect(result).toBe('unknown tool: delete_everything')
  })
})
