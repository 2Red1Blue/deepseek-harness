import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const streamSimple = vi.hoisted(() => vi.fn())

// A hand-declared route is built by `createProvider` over the protocol table in
// `src/provider.ts`, so the table's lazy api module is the SDK boundary this
// test can observe. A catalog route dispatches through pi-ai's own provider and
// would not see this mock.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

vi.mock('@earendil-works/pi-ai/api/anthropic-messages.lazy', () => ({
  anthropicMessagesApi: () => ({ stream: streamSimple, streamSimple }),
}))

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => { streamSimple.mockReset() })

/** A hand-declared OpenAI-compatible route with one fully described model. */
function gatewayAdapter(): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'local-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

async function drain(adapter: PiAiAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'local-gateway',
    model: 'local-model',
    messages: [],
  })) chunks.push(chunk)
  return chunks
}

describe('pi-ai SDK retry boundary', () => {
  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    const chunks = await drain(gatewayAdapter())

    expect(streamSimple).toHaveBeenCalledOnce()
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, apiKey: 'test-key' })
    // pi-ai reports a setup failure as a terminal in-stream error rather than
    // throwing, which the converter turns into the harness error finish.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'mock SDK boundary' } },
    })
  })

  it('dispatches a hand-declared route to the endpoint and model its configuration describes', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    expect(streamSimple.mock.calls[0]?.[0]).toMatchObject({
      id: 'local-model',
      provider: 'local-gateway',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 8192,
      maxTokens: 1024,
    })
  })
})


describe('explicit Anthropic thinking disabled SDK boundary', () => {
  function anthropicAdapter(profile: Partial<PiAiProviderProfile> = {}): {
    adapter: PiAiAdapter
    resolveApiKey: ReturnType<typeof vi.fn>
  } {
    const resolveApiKey = vi.fn(() => Promise.resolve('test-key'))
    const profiles = resolveProfiles({ 'local-gateway': {
      api: 'anthropic-messages', baseURL: 'http://127.0.0.1:9',
      models: [{ id: 'local-model', reasoningEfforts: false, contextWindow: 8192, maxTokens: 4096 }],
      ...profile,
    } })
    return { adapter: new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() }), resolveApiKey }
  }

  async function captureOptions(
    profile: Partial<PiAiProviderProfile>,
    overrides: Partial<GenerateOptions> = {},
  ): Promise<Record<string, unknown>> {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })
    const { adapter } = anthropicAdapter(profile)
    for await (const _chunk of adapter.stream({
      provider: 'local-gateway', model: 'local-model', messages: [], maxTokens: 4096, ...overrides,
    })) { /* Drain the SDK's terminal error without a network call. */ }
    expect(streamSimple).toHaveBeenCalledOnce()
    return streamSimple.mock.calls[0]?.[2] as Record<string, unknown>
  }

  it.each([undefined, false])('keeps legacy SDK options without a hook for flag %s', async (flag) => {
    const options = await captureOptions({ reasoning: 'off', ...flag === undefined ? {} : { anthropicThinkingDisabledWhenOff: flag } })
    expect(options).not.toHaveProperty('onPayload')
    expect(options).not.toHaveProperty('reasoning')
    expect(options).toMatchObject({ maxRetries: 0, maxTokens: 4096, apiKey: 'test-key' })
  })

  it('disables thinking on the SDK-owned payload without reading content or replacing output_config', async () => {
    const options = await captureOptions({ reasoning: 'off', anthropicThinkingDisabledWhenOff: true })
    expect(options).toMatchObject({ maxRetries: 0, maxTokens: 4096, apiKey: 'test-key' })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options).not.toHaveProperty('reasoning')
    expect(streamSimple.mock.calls[0]?.[0]).toMatchObject({ reasoning: false, api: 'anthropic-messages' })
    const hook = options.onPayload as (payload: unknown) => unknown
    const outputConfig = { effort: 'high', format: { type: 'json' } }
    const payload = { model: 'local-model', max_tokens: 4096,
      thinking: { type: 'adaptive' }, reasoning_effort: 'high', output_config: outputConfig }
    for (const key of ['messages', 'system', 'content', 'usage']) {
      Object.defineProperty(payload, key, { enumerable: true, get: () => { throw new Error('forbidden content read') } })
    }
    expect(hook(payload)).toBeUndefined()
    expect(payload.thinking).toEqual({ type: 'disabled' })
    expect(payload).not.toHaveProperty('reasoning_effort')
    expect(payload.output_config).toBe(outputConfig)
    expect(outputConfig).toEqual({ format: { type: 'json' } })
    expect(payload.model).toBe('local-model')
    expect(payload.max_tokens).toBe(4096)
  })

  it('accepts explicit request off when the profile has no default effort', async () => {
    const options = await captureOptions({ anthropicThinkingDisabledWhenOff: true }, { reasoningEffort: ReasoningEffortId('off') })
    expect(options.onPayload).toBeTypeOf('function')
  })

  it.each([undefined, 'high'] as const)('refuses missing or enabled effort %s before credentials and SDK', async (effort) => {
    const { adapter, resolveApiKey } = anthropicAdapter({ anthropicThinkingDisabledWhenOff: true,
      models: [{ id: 'local-model', reasoningEfforts: { off: null, high: 'high' } }] })
    const run = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'local-gateway', model: 'local-model', messages: [], ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
      })) { /* No dispatch is admitted. */ }
    }
    await expect(run()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(streamSimple).not.toHaveBeenCalled()
  })

  it('rejects malformed SDK payload metadata before mutating it', async () => {
    const options = await captureOptions({ reasoning: 'off', anthropicThinkingDisabledWhenOff: true })
    const hook = options.onPayload as (payload: unknown) => unknown
    for (const payload of [null, [], 'invalid', { output_config: null }, { output_config: [] }]) {
      expect(() => hook(payload)).toThrow(/must be an object/)
    }
    const payload = { thinking: { type: 'adaptive' }, output_config: null }
    expect(() => hook(payload)).toThrow()
    expect(payload.thinking).toEqual({ type: 'adaptive' })
    const minimal = { model: 'm', max_tokens: 2000 }
    hook(minimal)
    expect(minimal).toEqual({ model: 'm', max_tokens: 2000, thinking: { type: 'disabled' } })
  })
})
