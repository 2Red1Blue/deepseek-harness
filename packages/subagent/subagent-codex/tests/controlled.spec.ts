import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { inspectCodexControlledBoundary, controlledHash, controlledCanonical, controlledManagementTemplateHash } from '../src/controlled.ts'
import { startCodexRun, type CodexRunSpec } from '../src/run.ts'

type Obj = Record<string, unknown>
const cwd = '/audit-empty'
const prompt = 'The complete public research material is in this sole prompt.'
const parent = {} as Agent
const approved = [{ role: 'developer' as const, templateHash: controlledManagementTemplateHash('developer',
  [{ type: 'input_text', text: 'known native administrative text' }], cwd) }]
function fixture(options: { tool?: boolean; unknown?: boolean; trailing?: boolean; utf8?: boolean;
  view?: string; extraUser?: boolean; extraBlock?: boolean; missingPipe?: boolean; setupThrow?: boolean;
  holdTurn?: boolean; wrongVersion?: boolean; sourceChanges?: boolean; unapprovedManagement?: boolean;
  failedTerminal?: boolean; inputMismatch?: boolean; unclosedItem?: boolean; changedSummary?: boolean } = {}) {
  const calls: string[] = [], handles: SubprocessHandle[] = []
  let sourceReads = 0, spawned = 0
  const metadata = (count: number) => ({ turn_id: 'turn-1', create_time: 1, content_item_kinds: Array(count).fill('text') })
  const spec: CodexRunSpec = { cwd, providerName: 'native-luna', model: 'gpt-6-luna', permissionMode: 'never', env: {}, disposeGraceMs: 1,
    readInstructionSource: async () => {
      sourceReads += 1
      return Buffer.from(options.sourceChanges && sourceReads >= 3 ? 'changed administration' : 'known administration')
    },
    spawn: (input: SubprocessSpawnSpec) => {
      spawned += 1
      const from = new PassThrough(), to = new PassThrough(), stderr = new PassThrough()
      const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
      const terminate = vi.fn(() => done.resolve({ exitCode: 0, signal: null }))
      const handle: SubprocessHandle = { stdin: to, stdout: options.missingPipe ? undefined : from, stderr,
        control: undefined, collected: {}, done: done.promise, terminate, waitForExit: vi.fn(async () => { await done.promise; return true }) }
      handles.push(handle)
      if (options.setupThrow) vi.spyOn(from, 'on').mockImplementation(() => { throw new Error('setup failed') })
      const features: Obj = {}
      input.argv.forEach((arg, index) => { if (arg === '-c' && input.argv[index + 1]?.startsWith('features.')) {
        const [key, value] = input.argv[index + 1]!.slice(9).split('='); features[key!] = value === 'true'
      } })
      let buffer = ''
      const send = (value: Obj) => from.write(JSON.stringify(value) + '\n')
      const notify = (method: string, params: Obj) => send({ method, params })
      to.on('data', data => {
        buffer += data.toString()
        while (buffer.includes('\n')) {
          const offset = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, offset)) as Obj
          buffer = buffer.slice(offset + 1)
          const method = String(message.method); calls.push(method)
          if (message.id === undefined) continue
          const params = message.params as Obj
          const reply = (result: Obj) => send({ id: message.id, result })
          if (method === 'initialize') reply({ userAgent: `codex_cli_rs/${options.wrongVersion ? '0.162.10' : '0.162.1'} test` })
          else if (method === 'config/read') reply({ config: { features, mcp_servers: { fixture: { enabled: true } }, web_search: 'disabled', project_doc_max_bytes: 0 } })
          else if (method === 'thread/start') reply({ thread: { id: `thread-${spawned}`, ephemeral: true }, model: 'gpt-6-luna',
            sandbox: { type: 'readOnly', networkAccess: false }, instructionSources: ['/known/AGENTS.md'] })
          else if (method === 'mcpServerStatus/list') reply({ data: [{ name: 'fixture', tools: {} }], nextCursor: null })
          else if (method === 'turn/start') {
            const threadId = params.threadId
            reply({ turn: { id: 'turn-1' } })
            notify('turn/started', { threadId, turn: { id: 'turn-1' } })
            if (options.holdTurn) continue
            const item = (value: Obj) => { notify('item/started', { threadId, turnId: 'turn-1', item: value }); notify('item/completed', { threadId, turnId: 'turn-1', item: value }) }
            item({ id: 'u', type: 'userMessage', content: [{ type: 'text', text: options.inputMismatch ? 'PRIVATE_OTHER_PROMPT' : prompt }] })
            if (options.unclosedItem) notify('item/started', { threadId, turnId: 'turn-1', item: { id: 'unclosed', type: 'reasoning' } })
            const raw = (id: string, role: string, texts: string[]) => notify('rawResponseItem/completed', { threadId, turnId: 'turn-1',
              item: { type: 'message', id, role, content: texts.map(text => ({ type: 'input_text', text, ...(options.extraBlock ? { annotations: [] } : {}) })),
                internal_chat_message_metadata_passthrough: metadata(texts.length) } })
            raw('native-admin', 'developer', [options.unapprovedManagement ? 'unknown administrative reading context' : 'known native administrative text'])
            if (options.extraUser) raw('unrecorded-user', 'user', ['unrecorded file or memory context'])
            raw('native-task', 'user', [prompt])
            if (options.tool) item({ id: 'tool', type: 'commandExecution', command: 'cat unexpected', status: 'completed' })
            if (options.unknown) notify('item/newInput', { threadId, turnId: 'turn-1', input: 'unknown' })
            item({ id: 'r', type: 'reasoning', summary: ['PRIVATE_REASONING_MUST_NOT_PERSIST'] })
            const answer = { id: 'a', type: 'agentMessage', phase: 'final_answer', text: 'public result' }
            item(answer)
            notify('rawResponse/completed', { threadId, turnId: 'turn-1', responseId: 'response-1', usage: {} })
            notify('turn/completed', { threadId, turn: { id: 'turn-1', status: options.failedTerminal ? 'failed' : 'completed',
              ...(options.failedTerminal ? { error: { message: 'PRIVATE_NATIVE_ERROR_WITH_SECRET', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } } } : {}),
              itemsView: options.view ?? 'summary', items: [options.changedSummary ? { ...answer, text: 'PRIVATE_DISPLAY_SUMMARY' } : answer] } })
          }
          if (method === 'mcpServerStatus/list' && calls.filter(value => value === 'turn/start').length > 0) {
            if (options.trailing) from.write('{"unfinished":')
            if (options.utf8) from.write(Buffer.from([0xc3]))
          }
        }
      })
      return handle
    } }
  return { spec, calls, handles }
}
async function open(test: ReturnType<typeof fixture>) {
  const boundary = await inspectCodexControlledBoundary(test.spec, new AbortController().signal, approved)
  return await startCodexRun({ parent, cwd, prompt: [{ type: 'text', text: prompt }], signal: new AbortController().signal,
    controlledReadSet: { mode: 'closed-input', expectedBoundaryRef: boundary.boundaryRef,
      expectedInputHash: controlledHash(JSON.stringify([{ type: 'text', text: prompt }])), qualifiedManagementInputHashes: approved } }, test.spec)
}

describe('native closed input owner boundary', () => {
  it('performs zero-turn inspection, seals exact input and never retains private reasoning', async () => {
    const test = fixture()
    const boundary = await inspectCodexControlledBoundary(test.spec, new AbortController().signal, approved)
    expect(test.calls).not.toContain('turn/start')
    expect(test.handles[0]!.terminate).toHaveBeenCalledTimes(1)
    const run = await startCodexRun({ parent, cwd, prompt: [{ type: 'text', text: prompt }], signal: new AbortController().signal,
      controlledReadSet: { mode: 'closed-input', expectedBoundaryRef: boundary.boundaryRef,
        expectedInputHash: controlledHash(JSON.stringify([{ type: 'text', text: prompt }])), qualifiedManagementInputHashes: approved } }, test.spec)
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.controlledReadSet?.childId).toBe(run.id)
    expect(result.controlledReadSet?.nativeInputMessages.filter(value => value.kind === 'research')).toHaveLength(1)
    expect(result.controlledReadSet?.ownerStreamHash).toBe(controlledHash(controlledCanonical(result.controlledReadSet!.ownerFrames)))
    expect(JSON.stringify(result.controlledReadSet)).not.toContain('PRIVATE_REASONING')
    await run.dispose(); await run.dispose()
    expect((await run.result).stopReason).toBe('completed')
    expect(test.handles[1]!.terminate).toHaveBeenCalledTimes(1)
  })
  it.each([{ missingPipe: true }, { setupThrow: true }])('awaits unpublished child cleanup on setup failure %j', async options => {
    const test = fixture(options)
    await expect(inspectCodexControlledBoundary(test.spec, new AbortController().signal, approved)).rejects.toThrow()
    expect(test.handles[0]!.terminate).toHaveBeenCalledTimes(1)
    expect(test.handles[0]!.waitForExit).toHaveBeenCalledTimes(1)
  })
  it.each([{ tool: true }, { unknown: true }, { trailing: true }, { utf8: true }, { view: 'unknown' },
    { view: 'full' }, { extraUser: true }, { extraBlock: true }, { sourceChanges: true }, { unapprovedManagement: true }])('refuses unsealed or unqualified native observations %j', async options => {
    const test = fixture(options), run = await open(test)
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.controlledReadSet).toBeUndefined()
    expect(result.diagnostic).toMatch(/stage=.+; category=/)
    await run.dispose()
    expect(test.handles.at(-1)!.terminate).toHaveBeenCalledTimes(1)
  })
  it('rejects an inexact runtime pin before a model turn', async () => {
    const test = fixture({ wrongVersion: true })
    await expect(inspectCodexControlledBoundary(test.spec, new AbortController().signal, approved)).rejects.toThrow('0.162.1')
    expect(test.calls).not.toContain('turn/start')
  })
  it('owns cancellation during a turn without requiring the original signal to abort', async () => {
    const test = fixture({ holdTurn: true }), run = await open(test)
    await run.dispose()
    expect(await run.result).toMatchObject({ stopReason: 'aborted' })
    expect((await run.result).controlledReadSet).toBeUndefined()
    expect(test.handles.at(-1)!.terminate).toHaveBeenCalledTimes(1)
  })
  it.each([
    [{ failedTerminal: true }, 'turn-status-not-completed'],
    [{ unclosedItem: true }, 'unclosed-items-or-user-count'],
    [{ inputMismatch: true }, 'sole-input-mismatch'],
    [{ changedSummary: true }, 'terminal-summary-item-mismatch'],
  ] as const)('reports a precise safe terminal violation %j', async (options, code) => {
    const test = fixture(options), run = await open(test), result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.controlledReadSet).toBeUndefined()
    expect(result.diagnostic).toContain(`violation=${code}`)
    expect(result.diagnostic).toContain('ownerStreamHash')
    expect(result.diagnostic).not.toMatch(/PRIVATE_NATIVE_ERROR|PRIVATE_OTHER_PROMPT|PRIVATE_DISPLAY_SUMMARY|PRIVATE_REASONING/)
    if ('failedTerminal' in options && options.failedTerminal) {
      expect(result.diagnostic).toContain('"codexErrorInfoType":"httpConnectionFailed"')
      expect(result.diagnostic).toContain('"httpStatus":429')
      expect(result.diagnostic).toContain('"terminalStatus":"failed"')
    }
    if ('changedSummary' in options && options.changedSummary) expect(result.diagnostic).toContain('completedMismatchBytes')
    await run.dispose()
  })
})
