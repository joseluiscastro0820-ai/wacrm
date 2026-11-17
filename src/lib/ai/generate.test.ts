import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      usage: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      usage: null,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      usage: null,
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      usage,
    })
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})

const TOOLS = [
  {
    name: 'add_tag',
    description: 'Add a tag',
    parameters: { type: 'object' as const, properties: { tag_id: { type: 'string', description: 'id' } }, required: ['tag_id'] },
  },
]

describe('generateReply — tool calling', () => {
  it('OpenAI: runs the requested tool, replays the result, and returns the final text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'call_1', function: { name: 'add_tag', arguments: '{"tag_id":"tag-1"}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          choices: [{ message: { content: 'Done, tagged you!' } }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const runTool = vi.fn().mockResolvedValue('tag added')
    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'tag me as interested' }],
      tools: TOOLS,
      runTool,
    })

    expect(runTool).toHaveBeenCalledWith('add_tag', { tag_id: 'tag-1' })
    expect(res).toEqual({
      text: 'Done, tagged you!',
      handoff: false,
      // Usage accumulates across both provider round-trips.
      usage: { promptTokens: 30, completionTokens: 9, totalTokens: 39 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // The second request replays the tool call + its result.
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolCallMsg = secondBody.messages.find((m: { tool_calls?: unknown }) => m.tool_calls)
    expect(toolCallMsg.tool_calls[0].function.name).toBe('add_tag')
    const toolResultMsg = secondBody.messages.find((m: { role: string }) => m.role === 'tool')
    expect(toolResultMsg.content).toBe('tag added')
  })

  it('Anthropic: pairs tool_use/tool_result correctly across the replay', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'add_tag', input: { tag_id: 'tag-1' } }],
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
      )
      .mockResolvedValueOnce(
        okResponse({ content: [{ type: 'text', text: 'All set.' }], usage: { input_tokens: 20, output_tokens: 4 } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const runTool = vi.fn().mockResolvedValue('tag added')
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'tag me' }],
      tools: TOOLS,
      runTool,
    })

    expect(res.text).toBe('All set.')
    expect(res.handoff).toBe(false)
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const assistantToolUse = secondBody.messages.find(
      (m: { role: string; content: unknown }) => m.role === 'assistant' && Array.isArray(m.content),
    )
    expect(assistantToolUse.content[0].type).toBe('tool_use')
    const userToolResult = secondBody.messages.at(-1)
    expect(userToolResult.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'tag added' })
  })

  it('hands off instead of looping forever once the step cap is hit', async () => {
    const alwaysWantsTool = okResponse({
      choices: [{ message: { content: null, tool_calls: [{ id: 'call_x', function: { name: 'add_tag', arguments: '{}' } }] } }],
    })
    const fetchMock = vi.fn().mockResolvedValue(alwaysWantsTool)
    vi.stubGlobal('fetch', fetchMock)

    const runTool = vi.fn().mockResolvedValue('ok')
    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOLS,
      runTool,
    })

    expect(res).toMatchObject({ text: '', handoff: true })
    // MAX_TOOL_STEPS = 3 → 4 provider calls total (steps 0..3), tool run 3 times.
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(runTool).toHaveBeenCalledTimes(3)
  })

  it('malformed tool arguments become {} rather than throwing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'add_tag', arguments: '{not json' } }] } }],
        }),
      )
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const runTool = vi.fn().mockResolvedValue('ok')
    await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOLS,
      runTool,
    })

    expect(runTool).toHaveBeenCalledWith('add_tag', {})
  })
})
