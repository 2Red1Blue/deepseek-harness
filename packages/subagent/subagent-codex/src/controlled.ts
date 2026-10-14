/** Closed-input Codex execution over the existing subprocess and JSON-RPC owners. */
import { createHash, randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentControlledInstructionSource, SubagentControlledReadSetBoundary,
  SubagentControlledReadSetFrame, SubagentControlledReadSetItem, SubagentControlledReadSetProof,
  SubagentControlledNativeInputMessage, SubagentQualifiedManagementInputHash, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { codexAppServerArgv } from './run.ts'
import type { CodexRunSpec } from './run.ts'

type Obj = Record<string, unknown>
const FEATURES = ['shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'browser_use',
  'browser_use_external', 'browser_use_full_cdp_access', 'browser_annotation_api', 'computer_use',
  'in_app_browser', 'in_app_local_automation', 'apps', 'plugins', 'plugin_sharing', 'remote_plugin',
  'skill_mcp_dependency_install', 'skill_search', 'memories', 'goals', 'multi_agent', 'multi_agent_v2',
  'image_generation', 'view_image', 'hooks', 'workspace_dependencies', 'tool_suggest',
  'tool_call_mcp_elicitation', 'sleep_tool', 'request_permissions_tool', 'stable_environment_tools',
  'code_mode_host', 'code_mode', 'code_mode_tool_search', 'realtime_conversation', 'in_app_chat',
  'in_app_voice', 'in_app_dictation', 'in_app_updates', 'current_time_reminder'] as const
const BASE = 'You are a bounded research worker. All research input is supplied in the sole user task. '
  + 'Do not read files, use tools, access networks, change settings, send messages or delegate. '
  + 'Administrative instructions are separate from research evidence. Return the requested task output.'
const DEVELOPER = 'Closed-input research: use only the complete supplied research material and recorded administrative '
  + 'instructions. No additional reading or tools are permitted. Do not claim to have read an external source.'
const MAX_BYTES = 16 * 1024 * 1024
const READONLY_NOTIFICATIONS = new Set(['account/rateLimits/updated', 'account/updated', 'configWarning',
  'remoteControl/status/changed', 'thread/started', 'thread/status/changed', 'thread/tokenUsage/updated',
  'warning', 'turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryPartAdded',
  'rawResponse/completed', 'rawResponseItem/completed'])

/**
 * Serialize JSON data with sorted object keys and preserved array order.
 * @param value JSON-compatible protocol data.
 * @returns The deterministic JSON used by input and observation digests.
 */
export function controlledCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(controlledCanonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Obj).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, val]) => `${JSON.stringify(key)}:${controlledCanonical(val)}`).join(',')}}`
  return JSON.stringify(value)
}
/**
 * Hash exact UTF-8 text or bytes without normalization.
 * @param value Observed bytes or their exact text representation.
 * @returns A prefixed SHA-256 digest.
 */
export function controlledHash(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
const semanticHash = (value: unknown): string => controlledHash(controlledCanonical(value))
const same = (a: unknown, b: unknown): boolean => controlledCanonical(a) === controlledCanonical(b)
/**
 * Identify a qualified native management template across explicit working directories.
 * @param role Observed native management role.
 * @param content Complete observed text blocks, in order.
 * @param cwd The exact directory replaced by the fixed qualification placeholder.
 * @returns The canonical role/content digest; all other bytes remain significant.
 */
export function controlledManagementTemplateHash(role: 'developer' | 'system', content: readonly Readonly<{ type: string; text: string }>[], cwd: string): string {
  return semanticHash({ role, content: content.map(block => ({ ...block, text: block.text.split(cwd).join('<CONTROLLED_CWD>') })) })
}
function qualifiedHashes(value: readonly SubagentQualifiedManagementInputHash[]): readonly SubagentQualifiedManagementInputHash[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 || value.some(row =>
    !same(Object.keys(row).sort(), ['role', 'templateHash']) || !['developer', 'system'].includes(row.role)
    || !/^sha256:[a-f0-9]{64}$/.test(row.templateHash))) throw new Error('Closed native boundary requires an exact qualified management input allowlist')
  const normalized = [...value].sort((a, b) => a.role.localeCompare(b.role) || a.templateHash.localeCompare(b.templateHash))
  if (new Set(normalized.map(row => `${row.role}:${row.templateHash}`)).size !== normalized.length) throw new Error('Native management input allowlist has duplicate entries')
  return normalized
}
const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Accept only the observed 0.162.1 environment envelope, bound to the exact execution cwd. */
function knownEnvironment(text: string, cwd: string): boolean {
  const path = regexEscape(cwd)
  return new RegExp('^<environment_context>\\n  <cwd>' + path + '</cwd>\\n  <shell>[A-Za-z0-9_./\\\\: -]+</shell>'
    + '\\n  <current_date>\\d{4}-\\d{2}-\\d{2}</current_date>\\n  <timezone>[A-Za-z0-9_/+:-]+</timezone>'
    + '\\n  <filesystem><workspace_roots><root>' + path + '</root></workspace_roots>'
    + '<permission_profile type="managed"><file_system type="restricted"><entry access="read">'
    + '<special>:root</special></entry></file_system></permission_profile></filesystem>\\n</environment_context>$').test(text)
}
function obj(value: unknown): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native boundary object')
  return value as Obj
}
function str(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid native boundary identity')
  return value
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid native boundary array')
  return value
}
function configView(result: unknown): Obj {
  const config = obj(obj(result).config)
  const features = obj(config.features)
  const mcp = obj(config.mcp_servers ?? {})
  return { features: Object.fromEntries(Object.entries(features).filter(([, value]) => typeof value === 'boolean')),
    mcpNames: Object.keys(mcp).sort(), webSearch: config.web_search, projectDocMaxBytes: config.project_doc_max_bytes }
}
function inventory(result: unknown): { name: string; toolNames: string[] }[] {
  const value = obj(result)
  if (value.nextCursor != null) throw new Error('Native MCP inventory is incomplete')
  return array(value.data).map(raw => {
    const row = obj(raw)
    return { name: str(row.name), toolNames: Object.keys(obj(row.tools ?? {})).sort() }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** Retains only frame and item fingerprints; no private reasoning text is persisted or returned. */
class Connection {
  readonly child: SubprocessHandle
  readonly rpc: JsonRpcLineTransport
  readonly frames: SubagentControlledReadSetFrame[] = []
  readonly started = new Map<string, string>()
  readonly completed = new Map<string, { meta: SubagentControlledReadSetItem; raw: Obj }>()
  readonly nativeInputs: Omit<SubagentControlledNativeInputMessage, 'kind'>[] = []
  readonly terminal = Promise.withResolvers<Obj>()
  readonly failure = Promise.withResolvers<never>()
  readonly methods = new Map<string | number, string>()
  threadId?: string
  turnId?: string
  advertisedResponseModel?: string
  malformed = 0
  failed = false
  private terminalObserved = false
  private bytes = 0
  private input = ''
  private outgoing = ''
  private decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  private closePromise?: Promise<void>

  static async create(spec: CodexRunSpec): Promise<Connection> {
    const args = codexAppServerArgv().slice(0, 2)
    for (const feature of FEATURES) args.push('-c', `features.${feature}=false`)
    args.push('-c', 'features.skip_host_skill_discovery=true', '-c', 'web_search="disabled"',
      '-c', 'tools.view_image=false', '-c', 'project_doc_max_bytes=0', '-c', 'mcp_servers={}', 'app-server', '--stdio')
    const child = spec.spawn({ argv: args, cwd: spec.cwd, env: spec.env, graceMs: spec.disposeGraceMs,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } })
    child.done.catch(() => {})
    try { return new Connection(spec, child) } catch (error) {
      child.stdin?.end()
      child.terminate()
      await child.waitForExit()
      await child.done.catch(() => {})
      throw error
    }
  }
  private constructor(readonly spec: CodexRunSpec, child: SubprocessHandle) {
    this.child = child
    if (this.child.stdout === undefined || this.child.stdin === undefined) throw new Error('Native boundary requires owned pipes')
    const outgoing = new PassThrough()
    outgoing.on('data', (chunk: Buffer) => {
      this.outgoing += chunk.toString('utf8')
      this.outgoing = this.lines(this.outgoing, 'to-native')
    })
    outgoing.pipe(this.child.stdin)
    this.child.stdout.on('data', (chunk: Buffer | string) => {
      try {
        this.input += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
        this.input = this.lines(this.input, 'from-native')
      } catch (error) { this.malformed += 1; this.fail(error) }
    })
    this.child.stderr?.resume()
    this.child.stderr?.on('error', () => {})
    this.child.stdin.on('error', error => this.fail(error))
    this.child.stdout.on('error', error => this.fail(error))
    this.rpc = new JsonRpcLineTransport(this.child.stdout, outgoing)
    this.rpc.onRequest(async () => { this.fail(new Error('Closed native execution received an extra tool or input request')); throw new Error('Closed input boundary rejects server requests') })
    this.rpc.onNotification((method, params) => {
      try { this.notification(method, params) } catch (error) { this.fail(error) }
    })
    this.failure.promise.catch(() => {})
    this.terminal.promise.catch(() => {})
    this.child.done.then(() => this.fail(new Error('Native owner exited before boundary closure')), error => this.fail(error)).catch(() => {})
    this.rpc.start()
  }
  private fail(error: unknown): void { this.failed = true; this.failure.reject(error instanceof Error ? error : new Error('Native boundary failed')) }
  private lines(buffer: string, direction: 'to-native' | 'from-native'): string {
    while (buffer.includes('\n')) {
      const offset = buffer.indexOf('\n'), raw = buffer.slice(0, offset)
      buffer = buffer.slice(offset + 1)
      if (!raw.trim()) continue
      try {
        const frame = obj(JSON.parse(raw))
        if (direction === 'to-native' && typeof frame.method === 'string' && (typeof frame.id === 'string' || typeof frame.id === 'number')) this.methods.set(frame.id, frame.method)
        const method = typeof frame.method === 'string' ? frame.method : this.methods.get(frame.id as string | number) ?? 'response'
        const body = controlledCanonical(frame)
        this.bytes += Buffer.byteLength(body)
        if (this.bytes > MAX_BYTES) throw new Error('Native boundary observation exceeded its byte bound')
        this.frames.push({ order: this.frames.length + 1, direction, method, payloadHash: controlledHash(body), byteLength: Buffer.byteLength(body) })
      } catch (error) { this.malformed += 1; this.fail(error) }
    }
    return buffer
  }
  async call(method: string, params: Obj, signal: AbortSignal): Promise<unknown> {
    return await Promise.race([this.rpc.request(method, params, signal), this.failure.promise])
  }
  private notification(method: string, params: Obj): void {
    if (!READONLY_NOTIFICATIONS.has(method)) throw new Error('Closed native execution received an unqualified notification')
    if (method === 'rawResponseItem/completed') {
      const item = obj(params.item), type = item.type
      if (type !== 'message' && type !== 'reasoning') throw new Error('Closed native execution observed an extra raw tool or input item')
      if (type === 'message' && item.role !== 'assistant') {
        if (!same(Object.keys(item).sort(), ['content', 'id', 'internal_chat_message_metadata_passthrough', 'role', 'type'])) throw new Error('Native input wrapper contains unknown fields')
        const metadata = obj(item.internal_chat_message_metadata_passthrough)
        if (!same(Object.keys(metadata).sort(), ['content_item_kinds', 'create_time', 'turn_id'])
          || typeof metadata.create_time !== 'number' || !Number.isFinite(metadata.create_time)
          || !/^[A-Za-z0-9_-]+$/.test(str(metadata.turn_id))) throw new Error('Native input protocol metadata is unqualified')
        const kinds = array(metadata.content_item_kinds).map(str)
        if (kinds.some(kind => !/^[A-Za-z0-9_.:-]+$/.test(kind))) throw new Error('Native input protocol metadata includes unqualified values')
        const role = str(item.role)
        if (!['developer', 'system', 'user'].includes(role)) throw new Error('Native input message role is unknown')
        const content = array(item.content).map(value => {
          const block = obj(value), kind = str(block.type)
          if (kind !== 'input_text' && kind !== 'text') throw new Error('Native input contains an unqualified nontext block')
          if (!same(Object.keys(block).sort(), ['text', 'type'])) throw new Error('Native input block has unqualified additional fields')
          return { type: kind as 'input_text' | 'text', text: str(block.text) }
        })
        const bytes = controlledCanonical(content)
        if (kinds.length !== content.length) throw new Error('Native input metadata does not bind every content block')
        this.nativeInputs.push({ ordinal: this.nativeInputs.length + 1, nativeMessageId: str(item.id), role: role as 'developer' | 'system' | 'user',
          content, contentHash: controlledHash(bytes), byteLength: Buffer.byteLength(bytes),
          nativeMetadata: { turn_id: str(metadata.turn_id), create_time: metadata.create_time, content_item_kinds: kinds }, nativeMessageHash: semanticHash(item) })
      }
    }
    if (method === 'rawResponse/completed') {
      const output = params.response === undefined ? undefined : obj(params.response).output
      const advertised = params.response === undefined ? params.model : obj(params.response).model
      if (advertised !== undefined) {
        if (str(advertised) !== this.spec.model) throw new Error('Native response advertised a different model')
        this.advertisedResponseModel = str(advertised)
      }
      if (output !== undefined && array(output).some(value => !['message', 'reasoning'].includes(String(obj(value).type)))) {
        throw new Error('Closed native response contains an unqualified tool or compaction item')
      }
    }
    if (method === 'error') throw new Error('Native execution reported an error')
    if (method === 'turn/started' && params.threadId === this.threadId) {
      const id = str(obj(params.turn).id)
      if (this.terminalObserved || (this.turnId !== undefined && this.turnId !== id)) throw new Error('Native boundary observed an extra turn')
      this.turnId = id
    }
    if (!['item/started', 'item/completed', 'turn/completed'].includes(method)) return
    if (params.threadId !== this.threadId) throw new Error('Native boundary observed a foreign thread')
    if (this.terminalObserved) throw new Error('Native item arrived after terminal closure')
    if (method === 'turn/completed') {
      const turn = obj(params.turn)
      if (this.turnId !== undefined && turn.id !== this.turnId) throw new Error('Native boundary observed a foreign turn')
      this.turnId = str(turn.id)
      this.terminalObserved = true
      this.terminal.resolve(turn)
      return
    }
    if (this.turnId !== undefined && params.turnId !== this.turnId) throw new Error('Native item belongs to a foreign turn')
    this.turnId = str(params.turnId)
    const item = obj(params.item), id = str(item.id), type = str(item.type)
    if (!['userMessage', 'agentMessage', 'reasoning'].includes(type)) throw new Error('Closed native execution observed an extra tool, read or unknown item')
    if (method === 'item/started') {
      if (this.started.has(id)) throw new Error('Native item started twice')
      this.started.set(id, type)
    } else {
      if (this.completed.has(id) || this.started.get(id) !== type) throw new Error('Native item completion has no exact start')
      const body = controlledCanonical(item)
      this.completed.set(id, { meta: { id, type: type as SubagentControlledReadSetItem['type'], contentHash: controlledHash(body), byteLength: Buffer.byteLength(body) }, raw: type === 'reasoning' ? { id, type } : item })
    }
  }
  async close(): Promise<void> {
    return await (this.closePromise ??= (async () => {
      this.rpc.close()
      this.child.stdin?.end()
      this.child.terminate()
      await this.child.waitForExit()
      await this.child.done.catch(() => {})
    })())
  }
  assertFrameBoundary(): void {
    const remaining = this.input + this.decoder.decode()
    if (remaining.length !== 0 || this.outgoing.length !== 0) throw new Error('Native stream contains an incomplete protocol frame')
  }
}

async function sources(connection: Connection, paths: unknown): Promise<SubagentControlledInstructionSource[]> {
  if (connection.spec.readInstructionSource === undefined) throw new Error('Native instruction byte observation is unavailable')
  const result: SubagentControlledInstructionSource[] = []
  for (const value of array(paths)) {
    const path = str(value), bytes = await connection.spec.readInstructionSource(path)
    if (bytes.byteLength > MAX_BYTES) throw new Error('Native instruction source exceeds its observation bound')
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    result.push({ path, contentHash: controlledHash(bytes), byteLength: bytes.byteLength, content })
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

async function prepare(connection: Connection, signal: AbortSignal, approved: readonly SubagentQualifiedManagementInputHash[]): Promise<SubagentControlledReadSetBoundary> {
  const management = qualifiedHashes(approved)
  const spec = connection.spec
  if (!spec.model || !spec.providerName || !spec.cwd) throw new Error('Closed native execution requires an explicit model, provider and cwd')
  const initialized = obj(await connection.call('initialize', { clientInfo: { name: 'dsh-subagent-codex-controlled', version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false } }, signal))
  if (!/\/0\.162\.1(?:\s|$)/.test(String(initialized.userAgent))) throw new Error('Closed native boundary requires Codex 0.162.1')
  connection.rpc.notify('initialized', {})
  const before = configView(await connection.call('config/read', { cwd: spec.cwd, includeLayers: false }, signal))
  const features = obj(before.features)
  if (FEATURES.some(name => features[name] !== false) || features.skip_host_skill_discovery !== true
    || before.webSearch !== 'disabled' || before.projectDocMaxBytes !== 0) throw new Error('Native effective input policy did not match its required overrides')
  const names = array(before.mcpNames).map(str)
  const started = obj(await connection.call('thread/start', { cwd: spec.cwd, model: spec.model, allowProviderModelFallback: false,
    ephemeral: true, experimentalRawEvents: true, dynamicTools: [], approvalPolicy: 'never', sandbox: 'read-only',
    baseInstructions: BASE, developerInstructions: DEVELOPER,
    config: Object.fromEntries(names.map(name => [`mcp_servers.${name}.enabled`, false])) }, signal))
  connection.threadId = str(obj(started.thread).id)
  if (started.model !== spec.model || obj(started.sandbox).type !== 'readOnly' || obj(started.sandbox).networkAccess !== false) throw new Error('Native boundary model or permissions changed')
  const instructionSources = await sources(connection, started.instructionSources)
  const tools = inventory(await connection.call('mcpServerStatus/list', { threadId: connection.threadId, detail: 'toolsAndAuthOnly', limit: 100 }, signal))
  if (tools.some(server => server.toolNames.length > 0)) throw new Error('Native thread contains an external MCP tool')
  const after = configView(await connection.call('config/read', { cwd: spec.cwd, includeLayers: false }, signal))
  if (!same(before, after)) throw new Error('Native configuration changed during thread preparation')
  const policy: SubagentControlledReadSetBoundary['policy'] = { cwd: spec.cwd, approvalPolicy: 'never', sandbox: 'read-only', networkAccess: false,
    webSearch: 'disabled', projectDocMaxBytes: 0, userConfigIgnored: false, features: features as Record<string, boolean>,
    mcpDisabledNames: names, mcpToolInventory: tools, baseInstructions: BASE, developerInstructions: DEVELOPER, qualifiedManagementInputHashes: management }
  const basis = { version: 1 as const, mode: 'closed-input' as const, provider: spec.providerName, model: spec.model,
    runtimeVersion: '0.162.1' as const, policy, instructionSources }
  return { ...basis, boundaryRef: semanticHash(basis) }
}

/**
 * Inspect an actual ephemeral native thread without starting a model turn.
 * @param spec Configured model and owned subprocess/filesystem services.
 * @param signal Cancellation of inspection and its unpublished child.
 * @param approved Exact deployment-qualified management templates.
 * @returns Observed configuration, instruction sources and input-policy digest after cleanup.
 */
export async function inspectCodexControlledBoundary(spec: CodexRunSpec, signal: AbortSignal, approved: readonly SubagentQualifiedManagementInputHash[]): Promise<SubagentControlledReadSetBoundary> {
  signal.throwIfAborted()
  const connection = await Connection.create(spec)
  try { return await prepare(connection, signal, approved) } finally { await connection.close() }
}

/**
 * Publish one native execution only after its input policy matches prior inspection.
 * @param request Sole text task, explicit cwd, cancellation and qualified input digests.
 * @param spec Configured model and owned subprocess/filesystem services.
 * @returns A disposable execution; only complete observation returns a sealed proof.
 */
export async function startControlledCodexRun(request: SubagentStartRequest, spec: CodexRunSpec): Promise<SubagentRun> {
  request.signal.throwIfAborted()
  const control = request.controlledReadSet
  if (control?.mode !== 'closed-input' || !same(Object.keys(control).sort(), ['expectedBoundaryRef', 'expectedInputHash', 'mode', 'qualifiedManagementInputHashes'])
    || !/^sha256:[a-f0-9]{64}$/.test(control.expectedBoundaryRef) || !/^sha256:[a-f0-9]{64}$/.test(control.expectedInputHash)
    || request.cwd !== spec.cwd || request.prompt.length !== 1 || request.prompt[0]?.type !== 'text') throw new Error('Closed native execution requires one exact text prompt and explicit cwd')
  const prompt = request.prompt[0].text
  const inputHash = controlledHash(JSON.stringify([{ type: 'text', text: prompt }]))
  if (inputHash !== control.expectedInputHash) throw new Error('Closed native execution input hash changed')
  const connection = await Connection.create(spec), childId = SessionId(randomUUID())
  let boundary: SubagentControlledReadSetBoundary
  try {
    boundary = await prepare(connection, request.signal, control.qualifiedManagementInputHashes)
    if (boundary.boundaryRef !== control.expectedBoundaryRef) throw new Error('Closed native boundary changed since preflight')
  } catch (error) { await connection.close(); throw error }
  let outcomeSettled = false, ownedCancelled = false
  const dispose = async (): Promise<void> => {
    if (!outcomeSettled) ownedCancelled = true
    await connection.close()
  }
  const abort = (): void => { void dispose().catch(() => {}) }
  request.signal.addEventListener('abort', abort, { once: true })
  const result = (async (): Promise<SubagentResult> => {
    let stage = 'turn-start'
    try {
      const begun = obj(await connection.call('turn/start', { threadId: connection.threadId, model: spec.model,
        input: [{ type: 'text', text: prompt, text_elements: [] }], approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false } }, request.signal))
      const turnId = str(obj(begun.turn).id)
      if (connection.turnId !== undefined && connection.turnId !== turnId) throw new Error('Native accepted a different turn')
      connection.turnId = turnId
      stage = 'native-terminal-item-stream'
      const turn = await Promise.race([connection.terminal.promise, connection.failure.promise])
      if (turn.status !== 'completed' || turn.id !== turnId) throw new Error('Native turn did not complete normally')
      const ended = [...connection.completed.values()]
      if (connection.started.size !== ended.length || ended.filter(value => value.meta.type === 'userMessage').length !== 1) throw new Error('Native item stream did not close')
      const user = ended.find(value => value.meta.type === 'userMessage')!.raw
      const content = array(user.content)
      if (content.length !== 1 || obj(content[0]).type !== 'text' || obj(content[0]).text !== prompt) throw new Error('Native accepted input differs from the sole Host prompt')
      const terminalItems = array(turn.items)
      if (terminalItems.some(value => { const item = obj(value); return !ended.some(candidate => candidate.meta.id === item.id && candidate.meta.contentHash === semanticHash(item)) })) throw new Error('Native terminal summary changed a completed item')
      stage = 'final-policy-check'
      const config = configView(await connection.call('config/read', { cwd: spec.cwd, includeLayers: false }, request.signal))
      const tools = inventory(await connection.call('mcpServerStatus/list', { threadId: connection.threadId, detail: 'toolsAndAuthOnly', limit: 100 }, request.signal))
      const again = await Promise.race([sources(connection, boundary.instructionSources.map(value => value.path)), connection.failure.promise])
      if (!same(config.features, boundary.policy.features) || !same(config.mcpNames, boundary.policy.mcpDisabledNames)
        || config.webSearch !== 'disabled' || config.projectDocMaxBytes !== 0 || !same(tools, boundary.policy.mcpToolInventory)
        || !same(again, boundary.instructionSources) || connection.malformed !== 0 || connection.failed
        || connection.started.size !== ended.length || connection.completed.size !== ended.length) throw new Error('Native boundary changed or lost observation during its turn')
      if (turn.itemsView !== 'summary' && turn.itemsView !== 'full') throw new Error('Native terminal snapshot view is unknown')
      if (turn.itemsView === 'full' && (terminalItems.length !== ended.length
        || new Set(terminalItems.map(value => obj(value).id)).size !== ended.length)) throw new Error('Native full terminal snapshot lost completed items')
      connection.assertFrameBoundary()
      const nativeInputMessages: SubagentControlledNativeInputMessage[] = connection.nativeInputs.map(value => {
        if (value.role === 'user' && value.content.length === 1 && value.content[0]?.text === prompt) return { ...value, kind: 'research' }
        if (value.role === 'user' && !value.content.every(block => knownEnvironment(block.text, spec.cwd)
          || boundary.instructionSources.some(source => block.text === `# AGENTS.md instructions\n\n<INSTRUCTIONS>\n${source.content.trim()}\n</INSTRUCTIONS>`))) {
          throw new Error('Native user input has no verified administrative source or environment envelope')
        }
        if (value.role === 'developer' || value.role === 'system') {
          const managementTemplateHash = controlledManagementTemplateHash(value.role, value.content, spec.cwd)
          if (!boundary.policy.qualifiedManagementInputHashes.some(row => row.role === value.role && row.templateHash === managementTemplateHash)) {
            throw new Error('Native management input template has not been qualified')
          }
          return { ...value, kind: 'administrative', administrativeKind: 'native-management', managementTemplateHash }
        }
        return { ...value, kind: 'administrative', administrativeKind: 'verified-instruction-sources-and-environment' }
      })
      if (nativeInputMessages.filter(value => value.kind === 'research').length !== 1) throw new Error('Native raw input stream does not bind the sole research prompt')
      const items = ended.map(value => value.meta)
      const frames = [...connection.frames]
      const proof: SubagentControlledReadSetProof = { version: 1, mode: 'closed-input', boundaryRef: boundary.boundaryRef,
        provider: boundary.provider, model: boundary.model, runtimeVersion: '0.162.1', childId, cwd: spec.cwd,
        modelEvidence: 'native-thread-accepted', qualifiedManagementInputHashes: boundary.policy.qualifiedManagementInputHashes,
        ...connection.advertisedResponseModel === undefined ? {} : { advertisedResponseModel: connection.advertisedResponseModel },
        threadId: connection.threadId!, turnId, inputHash, promptContentHash: controlledHash(prompt),
        instructionSources: boundary.instructionSources, nativeInputMessages, items, startedItemIds: [...connection.started.keys()],
        completedItemIds: items.map(value => value.id), terminalItemIds: terminalItems.map(value => str(obj(value).id)),
        terminalItemsView: turn.itemsView, itemSetHash: semanticHash(items),
        ownerFrames: frames, ownerStreamHash: semanticHash(frames), seal: { method: 'native-terminal-item-stream', turnStatus: 'completed',
          inputItemCount: 1, toolItemCount: 0, unknownItemCount: 0, malformedFrameCount: 0, configurationStable: true,
          instructionSourcesStable: true, mcpInventoryEmpty: true, inputMatch: true, itemsMatch: true } }
      stage = 'final-output'
      const answer = ended.filter(value => value.meta.type === 'agentMessage').findLast(value => value.raw.phase === 'final_answer')
        ?? ended.filter(value => value.meta.type === 'agentMessage').at(-1)
      if (answer === undefined) throw new Error('Native closed turn returned no final answer')
      return { output: [{ type: 'text', text: str(answer.raw.text) }], stopReason: 'completed', controlledReadSet: proof }
    } catch {
      const cancelled = ownedCancelled || request.signal.aborted
      const category = cancelled ? 'cancelled' : connection.failed ? 'observation-or-transport' : 'boundary-validation'
      return { output: [], stopReason: cancelled ? 'aborted' : 'error', diagnostic: `Controlled native read-set boundary could not be sealed (stage=${stage}; category=${category})` }
    } finally { outcomeSettled = true; request.signal.removeEventListener('abort', abort) }
  })()
  result.catch(() => {})
  return { id: childId, result, dispose }
}
