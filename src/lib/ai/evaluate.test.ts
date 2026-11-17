import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { evaluateReply } from './evaluate'
import type { AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: 'Be concise. Never discuss competitors.',
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    embeddingsProvider: 'openai',
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

function chatCompletion(content: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return okResponse({ choices: [{ message: { content } }], usage })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('evaluateReply', () => {
  it('passes a clean JSON {"ok": true} verdict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatCompletion('{"ok": true}')))

    const { result } = await evaluateReply({
      config: config(),
      businessPrompt: 'Be concise.',
      knowledge: ['Returns accepted within 30 days.'],
      messages: [{ role: 'user', content: 'what is your return policy?' }],
      draftReply: 'We accept returns within 30 days.',
    })

    expect(result).toEqual({ ok: true })
  })

  it('fails closed with the given reason on {"ok": false, "reason": ...}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        chatCompletion('{"ok": false, "reason": "invents a price not in the knowledge base"}'),
      ),
    )

    const { result } = await evaluateReply({
      config: config(),
      businessPrompt: null,
      messages: [{ role: 'user', content: 'how much does it cost?' }],
      draftReply: 'It costs $49.',
    })

    expect(result).toEqual({ ok: false, reason: 'invents a price not in the knowledge base' })
  })

  it('tolerates a markdown-fenced or chatty response around the JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        chatCompletion('Sure, here is my verdict:\n```json\n{"ok": false, "reason": "off topic"}\n```'),
      ),
    )

    const { result } = await evaluateReply({
      config: config(),
      businessPrompt: null,
      messages: [{ role: 'user', content: 'hi' }],
      draftReply: 'unrelated reply',
    })

    expect(result).toEqual({ ok: false, reason: 'off topic' })
  })

  it('fails closed when the response has no JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatCompletion('looks fine to me')))

    const { result } = await evaluateReply({
      config: config(),
      businessPrompt: null,
      messages: [{ role: 'user', content: 'hi' }],
      draftReply: 'hello',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('fails closed when "ok" is missing or not a boolean', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatCompletion('{"verdict": "fine"}')))

    const { result } = await evaluateReply({
      config: config(),
      businessPrompt: null,
      messages: [{ role: 'user', content: 'hi' }],
      draftReply: 'hello',
    })

    expect(result.ok).toBe(false)
  })

  it('never throws — a provider error (e.g. invalid key) becomes a failed evaluation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse(401, { error: { message: 'bad key' } })))

    const { result, usage } = await evaluateReply({
      config: config(),
      businessPrompt: null,
      messages: [{ role: 'user', content: 'hi' }],
      draftReply: 'hello',
    })

    expect(result.ok).toBe(false)
    expect(usage).toBeNull()
  })

  it('returns the eval call\'s own usage for separate cost accounting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        chatCompletion('{"ok": true}', { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126 }),
      ),
    )

    const { usage } = await evaluateReply({
      config: config(),
      businessPrompt: null,
      messages: [{ role: 'user', content: 'hi' }],
      draftReply: 'hello',
    })

    expect(usage).toEqual({ promptTokens: 120, completionTokens: 6, totalTokens: 126 })
  })

  it('includes the business prompt, knowledge, and draft reply in the request sent to the provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatCompletion('{"ok": true}'))
    vi.stubGlobal('fetch', fetchMock)

    await evaluateReply({
      config: config(),
      businessPrompt: 'Never discuss competitors.',
      knowledge: ['Shipping takes 3-5 days.'],
      messages: [{ role: 'user', content: 'when will it arrive?' }],
      draftReply: 'It should arrive in 3-5 days.',
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const userContent = body.messages.find((m: { role: string }) => m.role === 'user').content as string
    expect(userContent).toContain('Never discuss competitors.')
    expect(userContent).toContain('Shipping takes 3-5 days.')
    expect(userContent).toContain('It should arrive in 3-5 days.')
    expect(userContent).toContain('when will it arrive?')
  })
})
