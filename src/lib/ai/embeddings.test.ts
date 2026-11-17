import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { embedTexts, toVectorLiteral } from './embeddings'
import { AiError } from './types'

function okOpenAiEmbeddings(count: number, shuffle = false): Response {
  const rows = Array.from({ length: count }, (_, i) => ({
    embedding: [i, i + 0.5],
    index: i,
  }))
  if (shuffle) rows.reverse()
  return { ok: true, status: 200, json: async () => ({ data: rows }) } as unknown as Response
}

function okGeminiEmbeddings(vectors: number[][]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ embeddings: vectors.map((values) => ({ values })) }),
  } as unknown as Response
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => vi.unstubAllGlobals())

describe('toVectorLiteral', () => {
  it('formats a pgvector literal', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]')
  })
})

describe('embedTexts — OpenAI', () => {
  it('returns [] and makes no request for empty input', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await embedTexts('openai', 'sk-x', [])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('embeds a single batch and sends the key', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length
      return okOpenAiEmbeddings(n)
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await embedTexts('openai', 'sk-x', ['a', 'b', 'c'])
    expect(out).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(
      (opts as unknown as { headers: Record<string, string> }).headers.Authorization,
    ).toBe('Bearer sk-x')
  })

  it('splits large inputs into multiple batches', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length
      return okOpenAiEmbeddings(n)
    })
    vi.stubGlobal('fetch', fetchMock)

    const inputs = Array.from({ length: 100 }, (_, i) => `t${i}`)
    const out = await embedTexts('openai', 'sk-x', inputs)
    expect(out).toHaveLength(100)
    expect(fetchMock).toHaveBeenCalledTimes(2) // 96 + 4
  })

  it('reorders by index when the provider returns them shuffled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts: { body: string }) => {
        const n = JSON.parse(opts.body).input.length
        return okOpenAiEmbeddings(n, true)
      }),
    )
    const out = await embedTexts('openai', 'sk-x', ['a', 'b', 'c'])
    expect(out[0]).toEqual([0, 0.5]) // index 0 first despite shuffle
    expect(out[2]).toEqual([2, 2.5])
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'bad key' } }),
      } as unknown as Response),
    )
    await expect(embedTexts('openai', 'sk-x', ['a'])).rejects.toMatchObject({
      code: 'invalid_key',
    })
  })

  it('throws when the provider omits result indices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.1] }, { embedding: [0.2] }] }),
      } as unknown as Response),
    )
    await expect(embedTexts('openai', 'sk-x', ['a', 'b'])).rejects.toBeInstanceOf(AiError)
  })

  it('throws on a malformed response (count mismatch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as unknown as Response),
    )
    await expect(embedTexts('openai', 'sk-x', ['a', 'b'])).rejects.toBeInstanceOf(AiError)
  })
})

describe('embedTexts — Gemini', () => {
  it('returns [] and makes no request for empty input', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await embedTexts('gemini', 'AIza-x', [])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls batchEmbedContents with the key header and preserves order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okGeminiEmbeddings([
        [3, 4], // norm 5 → [0.6, 0.8]
        [0, 5], // norm 5 → [0, 1]
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await embedTexts('gemini', 'AIza-x', ['a', 'b'])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual([0.6, 0.8])
    expect(out[1]).toEqual([0, 1])

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('batchEmbedContents')
    expect(url).toContain('gemini-embedding-001')
    const headers = (opts as unknown as { headers: Record<string, string> }).headers
    expect(headers['x-goog-api-key']).toBe('AIza-x')
  })

  it('requests outputDimensionality=1536 and the right taskType per call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okGeminiEmbeddings([[1, 0]]))
    vi.stubGlobal('fetch', fetchMock)

    await embedTexts('gemini', 'AIza-x', ['doc chunk'], 'document')
    let body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.requests[0].outputDimensionality).toBe(1536)
    expect(body.requests[0].taskType).toBe('RETRIEVAL_DOCUMENT')
    expect(body.requests[0].content.parts[0].text).toBe('doc chunk')

    await embedTexts('gemini', 'AIza-x', ['a query'], 'query')
    body = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(body.requests[0].taskType).toBe('RETRIEVAL_QUERY')
  })

  it('defaults to the document task type when none is passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okGeminiEmbeddings([[1, 0]]))
    vi.stubGlobal('fetch', fetchMock)
    await embedTexts('gemini', 'AIza-x', ['x'])
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.requests[0].taskType).toBe('RETRIEVAL_DOCUMENT')
  })

  it('splits large inputs into multiple batches', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).requests.length
      return okGeminiEmbeddings(Array.from({ length: n }, () => [1, 0]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const inputs = Array.from({ length: 100 }, (_, i) => `t${i}`)
    const out = await embedTexts('gemini', 'AIza-x', inputs)
    expect(out).toHaveLength(100)
    expect(fetchMock).toHaveBeenCalledTimes(2) // 96 + 4
  })

  it('maps a 403 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'API key not valid' } }),
      } as unknown as Response),
    )
    await expect(embedTexts('gemini', 'AIza-x', ['a'])).rejects.toMatchObject({
      code: 'invalid_key',
    })
  })

  it('throws on a malformed response (count mismatch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ embeddings: [] }),
      } as unknown as Response),
    )
    await expect(embedTexts('gemini', 'AIza-x', ['a', 'b'])).rejects.toBeInstanceOf(AiError)
  })

  it('throws when a row is missing its vector', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ embeddings: [{}] }),
      } as unknown as Response),
    )
    await expect(embedTexts('gemini', 'AIza-x', ['a'])).rejects.toBeInstanceOf(AiError)
  })

  it('leaves a zero vector unchanged instead of dividing by zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okGeminiEmbeddings([[0, 0, 0]])))
    const out = await embedTexts('gemini', 'AIza-x', ['x'])
    expect(out[0]).toEqual([0, 0, 0])
  })
})
