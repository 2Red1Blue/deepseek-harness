import { createHash } from 'node:crypto'
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_ROOT_NAME = '@deepseek-ai/dsh-root'
const EXPECTED_PNPM_VERSION = '11.28.5'
const EXTERNAL_INSTALL_SCRIPT = 'node --experimental-strip-types scripts/install-external-dependencies.ts'

const REPAIRED_WORKSPACES = [
  {
    path: 'packages/subagent/subagent-claude-code',
    name: '@deepseek-ai/dsh-subagent-claude-code',
    dependency: '@anthropic-ai/claude-agent-sdk',
    version: '0.3.263',
  },
  {
    path: 'packages/subagent/subagent-codex',
    name: '@deepseek-ai/dsh-subagent-codex',
    dependency: '@openai/codex',
    version: '0.153.4',
  },
  {
    path: 'packages/skill/skill-office',
    name: '@deepseek-ai/dsh-skill-office',
    dependency: '@deepseek-ai/libreoffice-kit',
    version: '^0.1.5',
  },
] as const

const LOCKED_OPTIONAL_PAYLOADS = [
  {
    lockKey: '@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.263',
    packageDirectory: '@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.263/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64',
    name: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
    version: '0.3.263',
    executableFiles: ['claude'],
  },
  {
    lockKey: '@openai/codex@0.153.4-darwin-arm64',
    packageDirectory: '@openai+codex@0.153.4-darwin-arm64/node_modules/@openai/codex',
    name: '@openai/codex',
    version: '0.153.4-darwin-arm64',
    executableFiles: [
      'vendor/aarch64-apple-darwin/bin/codex',
      'vendor/aarch64-apple-darwin/bin/codex-code-mode-host',
      'vendor/aarch64-apple-darwin/codex-path/rg',
      'vendor/aarch64-apple-darwin/codex-resources/zsh/bin/zsh',
    ],
  },
  {
    lockKey: '@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.5',
    packageDirectory: '@deepseek-ai+libreoffice-kit-darwin-arm64@0.1.5/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64',
    name: '@deepseek-ai/libreoffice-kit-darwin-arm64',
    version: '0.1.5',
    executableFiles: [
      'bin/libreoffice-kit',
      'program/LibreOfficeDev.app/Contents/Resources/senddoc',
      'program/LibreOfficeDev.app/Contents/Resources/unoinfo',
    ],
  },
] as const

const RUNNER_PATH_VARIABLES = [
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'npm_config_cache',
  'npm_config_devdir',
  'PNPM_HOME',
] as const

type JsonObject = Record<string, unknown>
type ExternalSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>

/** Paths and command derived from a validated external-build binding. */
export interface ExternalInstallPlan {
  sourceRoot: string
  outputRoot: string
  buildRoot: string
  stageRoot: string
  storeDirectory: string
  nodeExecutable: string
  pnpmCli: string
  arguments: string[]
  environment: NodeJS.ProcessEnv
  metadataDigests: Record<string, string>
  lockedPackageIntegrity: Record<string, string>
}

/** Dependencies that make external install planning deterministic in focused specs. */
export interface ExternalInstallOptions {
  sourceRoot?: string
  workingDirectory?: string
  environment?: NodeJS.ProcessEnv
  executablePath?: string
  deviceOf?: (path: string) => string | number
  spawn?: ExternalSpawn
  platform?: string
  architecture?: string
}

function fail(message: string): never {
  throw new Error(`external dependency repair refused: ${message}`)
}

function readJson(path: string): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read JSON manifest ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`manifest is not a JSON object: ${path}`)
  }
  return value as JsonObject
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function requireWithin(parent: string, child: string, label: string): void {
  if (!within(parent, child)) fail(`${label} escapes its allowed directory: ${child}`)
}

function sameIdentity(left: JsonObject, right: JsonObject, fields: readonly string[], label: string): void {
  for (const field of fields) {
    if (left[field] !== right[field]) {
      fail(`${label} has different ${field} metadata in source and external stage`)
    }
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => stableValue(item))
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
    return Object.fromEntries(entries)
  }
  return value
}

function stableJson(value: unknown): string | undefined {
  return JSON.stringify(stableValue(value))
}

function validateRootManifest(sourceRoot: string, stageRoot: string): void {
  const source = readJson(join(sourceRoot, 'package.json'))
  const staged = readJson(join(stageRoot, 'package.json'))
  const identityFields = ['name', 'version', 'packageManager', 'private'] as const
  sameIdentity(source, staged, identityFields, 'root package.json')
  if (source.name !== EXPECTED_ROOT_NAME) fail(`unexpected source package identity: ${String(source.name)}`)
  if (source.packageManager !== `pnpm@${EXPECTED_PNPM_VERSION}`) {
    fail(`source packageManager must pin pnpm@${EXPECTED_PNPM_VERSION}`)
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'workspaces',
    'engines',
  ]) {
    if (stableJson(source[field]) !== stableJson(staged[field])) {
      fail(`root package.json has different install metadata in ${field}`)
    }
  }

  const sourceScripts = source.scripts
  const stagedScripts = staged.scripts
  if (
    typeof sourceScripts !== 'object' || sourceScripts === null || Array.isArray(sourceScripts)
    || typeof stagedScripts !== 'object' || stagedScripts === null || Array.isArray(stagedScripts)
  ) fail('root package.json has no scripts object')
  const sourceScriptMap = sourceScripts as Record<string, unknown>
  const stagedScriptMap = stagedScripts as Record<string, unknown>
  if (sourceScriptMap['install:external'] !== EXTERNAL_INSTALL_SCRIPT) {
    fail(`root package.json must declare ${EXTERNAL_INSTALL_SCRIPT}`)
  }
  if (stagedScriptMap['install:external'] !== undefined && stagedScriptMap['install:external'] !== EXTERNAL_INSTALL_SCRIPT) {
    fail('external stage declares a different install:external command')
  }
  const comparableSourceScripts = { ...sourceScriptMap }
  const comparableStagedScripts = { ...stagedScriptMap }
  delete comparableSourceScripts['docs:check']
  delete comparableStagedScripts['docs:check']
  delete comparableSourceScripts['install:external']
  delete comparableStagedScripts['install:external']
  if (stableJson(comparableSourceScripts) !== stableJson(comparableStagedScripts)) {
    fail('root package.json has different lifecycle or build scripts in source and external stage')
  }
}

function validateWorkspaceManifests(sourceRoot: string, stageRoot: string): void {
  for (const workspace of REPAIRED_WORKSPACES) {
    const sourceManifestPath = join(sourceRoot, workspace.path, 'package.json')
    const stageManifestPath = join(stageRoot, workspace.path, 'package.json')
    if (sha256(sourceManifestPath) !== sha256(stageManifestPath)) {
      fail(`${workspace.path}/package.json differs between source and external stage`)
    }
    const manifest = readJson(sourceManifestPath)
    if (manifest.name !== workspace.name) {
      fail(`${workspace.path} is not ${workspace.name}`)
    }
    const dependencies = manifest.dependencies
    if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
      fail(`${workspace.path} has no dependencies object`)
    }
    if ((dependencies as Record<string, unknown>)[workspace.dependency] !== workspace.version) {
      fail(`${workspace.name} must pin ${workspace.dependency}@${workspace.version}`)
    }
  }
}

function expandWorkspacePattern(sourceRoot: string, pattern: string): string[] {
  const components = pattern.split('/')
  if (pattern === '' || isAbsolute(pattern) || components.some(component => component === '' || component === '.' || component === '..')) {
    fail(`pnpm workspace pattern is not project-relative: ${pattern}`)
  }

  let candidates = [sourceRoot]
  for (const component of components) {
    if (component !== '*' && component.includes('*')) {
      fail(`pnpm workspace pattern uses an unsupported wildcard: ${pattern}`)
    }
    const next: string[] = []
    for (const candidate of candidates) {
      if (component === '*') {
        let entries
        try {
          entries = readdirSync(candidate, { withFileTypes: true })
        } catch {
          fail(`cannot read pnpm workspace directory: ${candidate}`)
        }
        for (const entry of entries) {
          if (entry.isDirectory()) next.push(join(candidate, entry.name))
        }
      } else {
        const path = join(candidate, component)
        try {
          if (statSync(path).isDirectory()) next.push(path)
        } catch {
          // A literal workspace directory may not exist in every checkout.
        }
      }
    }
    candidates = next
  }
  return candidates.filter((path) => {
    try {
      return statSync(join(path, 'package.json')).isFile()
    } catch {
      return false
    }
  })
}

function workspacePackageRoots(sourceRoot: string, stageRoot: string): Map<string, string> {
  const workspaceFile = readFileSync(join(sourceRoot, 'pnpm-workspace.yaml'), 'utf8')
  const patterns: string[] = []
  let inPackages = false
  for (const line of workspaceFile.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!inPackages) {
      if (/^packages:\s*(?:#.*)?$/.test(trimmed)) inPackages = true
      continue
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (!/^\s/.test(line)) break
    const match = line.match(/^\s*-\s*(?:"([^"]+)"|'([^']+)'|([^#]+?))\s*(?:#.*)?$/)
    if (!match) fail(`unsupported pnpm workspace package entry: ${trimmed}`)
    const pattern = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (pattern.startsWith('!')) fail(`pnpm workspace exclusions need an installer update: ${pattern}`)
    patterns.push(pattern)
  }
  if (patterns.length === 0) fail('pnpm-workspace.yaml declares no package paths')

  const roots = new Map<string, string>()
  const sourcePackages = new Set([sourceRoot])
  for (const pattern of patterns) {
    for (const path of expandWorkspacePattern(sourceRoot, pattern)) {
      sourcePackages.add(realpathSync(path))
    }
  }
  for (const sourcePackage of sourcePackages) {
    requireWithin(sourceRoot, sourcePackage, 'source workspace package')
    const packagePath = relative(sourceRoot, sourcePackage)
    const stagePackagePath = packagePath === '' ? stageRoot : join(stageRoot, packagePath)
    let stagePackage: string
    try {
      stagePackage = realpathSync(stagePackagePath)
    } catch {
      fail(`external stage workspace is missing: ${packagePath || '.'}`)
    }
    requireWithin(stageRoot, stagePackage, 'external stage workspace')
    const sourceManifest = readJson(join(sourcePackage, 'package.json'))
    const stageManifest = readJson(join(stagePackage, 'package.json'))
    if (sourceManifest.name !== stageManifest.name || sourceManifest.version !== stageManifest.version) {
      fail(`external stage workspace identity differs from source: ${packagePath || '.'}`)
    }
    roots.set(stagePackage, sourcePackage)
  }
  return roots
}

/** Repoint workspace dependency links from the metadata stage to internal source. */
function rewireWorkspaceLinks(
  sourceRoot: string,
  stageRoot: string,
  externalDevice: string | number,
  deviceOf: (path: string) => string | number,
): number {
  const roots = workspacePackageRoots(sourceRoot, stageRoot)
  const moduleDirectories = new Set([join(stageRoot, 'node_modules')])
  for (const stagePackage of roots.keys()) moduleDirectories.add(join(stagePackage, 'node_modules'))

  let rewired = 0
  const scannedDirectories = new Set<string>()
  for (const moduleDirectory of moduleDirectories) {
    let root: string
    try {
      root = realpathSync(moduleDirectory)
    } catch {
      continue
    }
    if (scannedDirectories.has(root)) continue
    scannedDirectories.add(root)
    requireWithin(stageRoot, root, 'workspace node_modules directory')
    if (deviceOf(root) !== externalDevice) fail(`workspace node_modules is not external: ${root}`)

    const pending = [root]
    while (pending.length > 0) {
      const directory = pending.pop()
      if (directory === undefined) continue
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        fail(`cannot scan workspace node_modules directory: ${directory}`)
      }
      for (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) {
          let target: string
          try {
            target = realpathSync(path)
          } catch {
            continue
          }
          const sourcePackage = roots.get(target)
          if (sourcePackage === undefined || target === sourcePackage) continue
          unlinkSync(path)
          symlinkSync(sourcePackage, path, 'dir')
          if (realpathSync(path) !== sourcePackage) fail(`workspace link still resolves to stage: ${path}`)
          rewired++
        } else if (entry.isDirectory()) {
          pending.push(path)
        }
      }
    }
  }
  return rewired
}

function validateMetadataHashes(sourceRoot: string, stageRoot: string): void {
  for (const filename of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    if (sha256(join(sourceRoot, filename)) !== sha256(join(stageRoot, filename))) {
      fail(`${filename} differs between source and external stage`)
    }
  }
}

function readLockedIntegrity(lockfilePath: string, lockKey: string): string {
  const lockfile = readFileSync(lockfilePath, 'utf8')
  const packagesStart = lockfile.indexOf('\npackages:\n')
  const snapshotsStart = lockfile.indexOf('\nsnapshots:\n', packagesStart)
  if (packagesStart < 0 || snapshotsStart < 0) fail(`pnpm lockfile has no packages section: ${lockfilePath}`)
  const packageLines = lockfile.slice(packagesStart, snapshotsStart).split('\n')
  const headerIndex = packageLines.indexOf(`  '${lockKey}':`)
  if (headerIndex < 0) fail(`pnpm lockfile has no package entry for ${lockKey}`)
  const entryLines: string[] = []
  for (const line of packageLines.slice(headerIndex + 1)) {
    if (line.startsWith('  ') && !line.startsWith('    ') && line.trim() !== '') break
    entryLines.push(line)
  }
  const resolutionLine = entryLines.find(line => line.startsWith('    resolution:'))
  const integrity = resolutionLine?.match(/\bintegrity:\s*(sha512-[A-Za-z0-9+/]+={0,2})/)?.[1]
  if (!integrity || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    fail(`pnpm lockfile has no valid SHA-512 integrity for ${lockKey}`)
  }
  return integrity
}

function captureMetadataDigests(sourceRoot: string, stageRoot: string, outputRoot: string): Record<string, string> {
  const files: Record<string, string> = {
    'source/package.json': join(sourceRoot, 'package.json'),
    'stage/package.json': join(stageRoot, 'package.json'),
    'source/pnpm-lock.yaml': join(sourceRoot, 'pnpm-lock.yaml'),
    'source/pnpm-workspace.yaml': join(sourceRoot, 'pnpm-workspace.yaml'),
    'stage/pnpm-lock.yaml': join(stageRoot, 'pnpm-lock.yaml'),
    'stage/pnpm-workspace.yaml': join(stageRoot, 'pnpm-workspace.yaml'),
    'bindings.json': join(outputRoot, 'bindings.json'),
  }
  for (const workspace of REPAIRED_WORKSPACES) {
    files[`source/${workspace.path}/package.json`] = join(sourceRoot, workspace.path, 'package.json')
    files[`stage/${workspace.path}/package.json`] = join(stageRoot, workspace.path, 'package.json')
  }
  return Object.fromEntries(Object.entries(files).map(([name, path]) => [name, sha256(path)]))
}

function captureLockedPackageIntegrity(lockfilePath: string): Record<string, string> {
  return Object.fromEntries(LOCKED_OPTIONAL_PAYLOADS.map(payload => [
    payload.lockKey,
    readLockedIntegrity(lockfilePath, payload.lockKey),
  ]))
}

function validateOptionalPayloads(
  stageRoot: string,
  externalDevice: string | number,
  deviceOf: (path: string) => string | number,
): void {
  let virtualStore: string
  try {
    virtualStore = realpathSync(join(stageRoot, 'node_modules', '.pnpm'))
  } catch {
    fail('external pnpm virtual store is missing')
  }
  for (const payload of LOCKED_OPTIONAL_PAYLOADS) {
    const packageRoot = join(virtualStore, payload.packageDirectory)
    let actualPackageRoot: string
    try {
      actualPackageRoot = realpathSync(packageRoot)
    } catch {
      fail(`locked optional package payload is missing: ${payload.lockKey}`)
    }
    requireWithin(virtualStore, actualPackageRoot, `package payload ${payload.lockKey}`)
    if (deviceOf(actualPackageRoot) !== externalDevice) {
      fail(`package payload is not on the external build device: ${payload.lockKey}`)
    }
    if (!statSync(actualPackageRoot).isDirectory()) fail(`package payload is not a directory: ${payload.lockKey}`)

    const manifestPath = join(actualPackageRoot, 'package.json')
    const manifest = readJson(manifestPath)
    if (manifest.name !== payload.name || manifest.version !== payload.version) {
      fail(`installed ${payload.lockKey} has the wrong package name or version`)
    }
    for (const relativeExecutable of payload.executableFiles) {
      const executablePath = join(actualPackageRoot, relativeExecutable)
      requireWithin(actualPackageRoot, resolve(executablePath), `package executable ${relativeExecutable}`)
      let executableStat
      try {
        executableStat = statSync(executablePath)
      } catch {
        fail(`required executable is missing from ${payload.lockKey}: ${relativeExecutable}`)
      }
      if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) {
        fail(`required executable is not executable in ${payload.lockKey}: ${relativeExecutable}`)
      }
      const realExecutable = realpathSync(executablePath)
      requireWithin(actualPackageRoot, realExecutable, `package executable ${relativeExecutable}`)
      if (deviceOf(realExecutable) !== externalDevice) {
        fail(`required executable is not on the external build device: ${relativeExecutable}`)
      }
    }
  }
}

function validateBindings(sourceRoot: string, deviceOf: (path: string) => string | number): {
  outputRoot: string
  buildRoot: string
  stageRoot: string
} {
  const sourceNodeModules = join(sourceRoot, 'node_modules')
  let sourceNodeModulesStat: ReturnType<typeof lstatSync>
  try {
    sourceNodeModulesStat = lstatSync(sourceNodeModules)
  } catch {
    fail(`source node_modules binding is missing: ${sourceNodeModules}`)
  }
  if (!sourceNodeModulesStat.isSymbolicLink()) {
    fail(`source node_modules must remain a symlink: ${sourceNodeModules}`)
  }

  let stagedNodeModules: string
  try {
    stagedNodeModules = realpathSync(sourceNodeModules)
  } catch {
    fail(`source node_modules symlink has no external target: ${sourceNodeModules}`)
  }
  const stageRoot = dirname(stagedNodeModules)
  const outputRoot = dirname(stageRoot)
  const buildRoot = dirname(dirname(outputRoot))
  const expectedNodeModules = realpathSync(join(outputRoot, 'install-stage', 'node_modules'))
  if (stageRoot !== join(outputRoot, 'install-stage') || stagedNodeModules !== expectedNodeModules) {
    fail(`source node_modules does not resolve to the runner's install-stage: ${stagedNodeModules}`)
  }

  const sourceDevice = deviceOf(sourceRoot)
  const externalDevice = deviceOf(outputRoot)
  if (sourceDevice === externalDevice) fail('source and external build stage are on the same device')
  if (deviceOf(stageRoot) !== externalDevice) fail('install-stage is not on the bound external device')

  const bindingsPath = join(outputRoot, 'bindings.json')
  let bindingsStat: ReturnType<typeof lstatSync>
  try {
    bindingsStat = lstatSync(bindingsPath)
  } catch {
    fail(`external bindings manifest is missing: ${bindingsPath}`)
  }
  if (!bindingsStat.isFile() || bindingsStat.isSymbolicLink() || deviceOf(bindingsPath) !== externalDevice) {
    fail('bindings.json must be a regular file on the external build device')
  }
  const bindings = readJson(bindingsPath)
  if (bindings.schema !== 'ecosystem-build-bindings.v1' || bindings.source !== sourceRoot) {
    fail('external bindings do not identify this source worktree')
  }
  const artifacts = bindings.artifacts
  if (typeof artifacts !== 'object' || artifacts === null || Array.isArray(artifacts)) {
    fail('external bindings have no artifact map')
  }
  const artifactMap = artifacts as Record<string, unknown>
  if (typeof artifactMap.node_modules !== 'string') {
    fail('root node_modules binding does not point to its resolved external stage')
  }
  let boundRootNodeModules: string
  try {
    boundRootNodeModules = realpathSync(artifactMap.node_modules)
  } catch {
    fail('root node_modules binding has no external target')
  }
  if (boundRootNodeModules !== stagedNodeModules) {
    fail('root node_modules binding does not point to its resolved external stage')
  }

  for (const [sourceRelative, targetValue] of Object.entries(artifactMap)) {
    if (typeof targetValue !== 'string' || !isAbsolute(targetValue)) {
      fail(`binding target must be absolute: ${sourceRelative}`)
    }
    const components = sourceRelative.split(/[\\/]/)
    if (sourceRelative === '' || isAbsolute(sourceRelative) || components.some(part => part === '' || part === '.' || part === '..')) {
      fail(`binding source must be a normalized project-relative path: ${sourceRelative}`)
    }
    const sourcePath = join(sourceRoot, ...components)
    let sourceStat
    try {
      sourceStat = lstatSync(sourcePath)
    } catch {
      fail(`bound source path is missing: ${sourceRelative}`)
    }
    if (!sourceStat.isSymbolicLink()) fail(`bound source path is not a symlink: ${sourceRelative}`)

    let actualTarget: string
    try {
      actualTarget = realpathSync(sourcePath)
    } catch {
      fail(`bound source symlink has no target: ${sourceRelative}`)
    }
    let expectedTarget: string
    try {
      expectedTarget = realpathSync(targetValue)
    } catch {
      fail(`bound external target is missing: ${targetValue}`)
    }
    requireWithin(outputRoot, expectedTarget, `binding ${sourceRelative}`)
    if (actualTarget !== expectedTarget) fail(`bound source symlink changed: ${sourceRelative}`)
    if (deviceOf(expectedTarget) !== externalDevice) {
      fail(`bound output is not on the external build device: ${sourceRelative}`)
    }
  }

  for (const workspace of REPAIRED_WORKSPACES) {
    const key = `${workspace.path}/node_modules`
    if (typeof artifactMap[key] !== 'string') fail(`missing external workspace dependency binding: ${key}`)
  }
  return { outputRoot, buildRoot, stageRoot }
}

function externalRunnerPath(
  name: string,
  environment: NodeJS.ProcessEnv,
  buildRoot: string,
  outputRoot: string,
  device: string | number,
  deviceOf: (path: string) => string | number,
): string {
  const rawPath = environment[name]
  if (!rawPath || !isAbsolute(rawPath)) fail(`external build runner did not provide absolute ${name}`)
  let path: string
  try {
    path = realpathSync(rawPath)
  } catch {
    fail(`${name} does not resolve to a prepared runner directory: ${rawPath}`)
  }
  const allowedRoot = name === 'TMPDIR' ? outputRoot : buildRoot
  requireWithin(allowedRoot, path, `${name} runner path`)
  if (deviceOf(path) !== device) fail(`${name} is not on the external build device`)
  return path
}

function resolvePnpmCli(buildRoot: string, device: string | number, deviceOf: (path: string) => string | number): string {
  const packagePath = join(
    buildRoot,
    'toolchains',
    'pnpm-global',
    '.tools',
    'pnpm',
    EXPECTED_PNPM_VERSION,
    'node_modules',
    'pnpm',
  )
  let packageRoot: string
  try {
    packageRoot = realpathSync(packagePath)
  } catch {
    fail(`external pnpm@${EXPECTED_PNPM_VERSION} package is missing: ${packagePath}`)
  }
  requireWithin(buildRoot, packageRoot, 'external pnpm package')
  if (deviceOf(packageRoot) !== device) fail('external pnpm package is not on the external build device')

  let manifestPath: string
  try {
    manifestPath = realpathSync(join(packageRoot, 'package.json'))
  } catch {
    fail('external pnpm package manifest is missing')
  }
  requireWithin(packageRoot, manifestPath, 'external pnpm package manifest')
  if (deviceOf(manifestPath) !== device) fail('external pnpm package manifest is not on the external build device')
  const manifest = readJson(manifestPath)
  if (manifest.name !== 'pnpm' || manifest.version !== EXPECTED_PNPM_VERSION) {
    fail(`external pnpm package must be pnpm@${EXPECTED_PNPM_VERSION}`)
  }

  const cliPath = join(packageRoot, 'bin', 'pnpm.mjs')
  let cli: string
  try {
    cli = realpathSync(cliPath)
  } catch {
    fail(`external pnpm CLI is missing: ${cliPath}`)
  }
  requireWithin(packageRoot, cli, 'external pnpm CLI')
  if (!statSync(cli).isFile() || deviceOf(cli) !== device) {
    fail('external pnpm CLI must be a file on the external build device')
  }
  return cli
}

function expectedUserAgent(environment: NodeJS.ProcessEnv): void {
  if (!environment.npm_config_user_agent?.startsWith(`pnpm/${EXPECTED_PNPM_VERSION} `)) {
    fail(`installer must run under the pinned pnpm@${EXPECTED_PNPM_VERSION}`)
  }
}

/**
 * Validate the external runner layout and prepare the bounded pnpm command.
 * @param options - Optional paths and process adapters used by focused specs.
 * @returns The validated stage, cache, and shell-free pnpm invocation.
 */
export function inspectExternalInstallPlan(options: ExternalInstallOptions = {}): ExternalInstallPlan {
  const sourceRoot = realpathSync(options.sourceRoot ?? dirname(dirname(fileURLToPath(import.meta.url))))
  const environment = { ...(options.environment ?? process.env) }
  const deviceOf = options.deviceOf ?? (path => statSync(path).dev)
  const workingDirectory = realpathSync(options.workingDirectory ?? process.cwd())
  if (workingDirectory !== sourceRoot) fail('run install:external from the source worktree root')
  if ((options.platform ?? process.platform) !== 'darwin' || (options.architecture ?? process.arch) !== 'arm64') {
    fail('this repair is limited to the macOS arm64 external build runner')
  }

  const { outputRoot, buildRoot, stageRoot } = validateBindings(sourceRoot, deviceOf)
  const externalDevice = deviceOf(outputRoot)
  validateMetadataHashes(sourceRoot, stageRoot)
  validateRootManifest(sourceRoot, stageRoot)
  validateWorkspaceManifests(sourceRoot, stageRoot)

  for (const name of RUNNER_PATH_VARIABLES) {
    externalRunnerPath(name, environment, buildRoot, outputRoot, externalDevice, deviceOf)
  }
  const temporaryDirectory = externalRunnerPath('TMPDIR', environment, buildRoot, outputRoot, externalDevice, deviceOf)
  environment.TMP = temporaryDirectory
  environment.TEMP = temporaryDirectory

  const nodeExecutable = realpathSync(options.executablePath ?? process.execPath)
  if (deviceOf(nodeExecutable) !== externalDevice) fail('Node.js runtime is not on the external build device')
  expectedUserAgent(environment)
  const pnpmCli = resolvePnpmCli(buildRoot, externalDevice, deviceOf)

  const configuredStore = join(buildRoot, 'cache', 'pnpm', 'store', 'v11')
  let configuredStoreStat: ReturnType<typeof lstatSync>
  try {
    configuredStoreStat = lstatSync(configuredStore)
  } catch {
    fail('shared pnpm v11 store must already exist on the external build device')
  }
  if (!configuredStoreStat.isDirectory() || configuredStoreStat.isSymbolicLink()) {
    fail('shared pnpm v11 store must be an existing external directory')
  }
  const storeDirectory = realpathSync(configuredStore)
  requireWithin(buildRoot, storeDirectory, 'shared pnpm store')
  if (!statSync(storeDirectory).isDirectory() || deviceOf(storeDirectory) !== externalDevice) {
    fail('shared pnpm v11 store must already exist on the external build device')
  }
  environment.npm_config_store_dir = storeDirectory
  environment.pnpm_config_store_dir = storeDirectory
  environment.npm_config_optional = 'true'
  environment.pnpm_config_optional = 'true'
  environment.npm_config_offline = 'false'
  environment.pnpm_config_offline = 'false'
  environment.npm_config_force = 'false'
  environment.pnpm_config_force = 'false'

  const arguments_ = ['install', '--frozen-lockfile', '--reporter=ndjson']

  return {
    sourceRoot,
    outputRoot,
    buildRoot,
    stageRoot,
    storeDirectory,
    nodeExecutable,
    pnpmCli,
    arguments: arguments_,
    environment,
    metadataDigests: captureMetadataDigests(sourceRoot, stageRoot, outputRoot),
    lockedPackageIntegrity: captureLockedPackageIntegrity(join(sourceRoot, 'pnpm-lock.yaml')),
  }
}

/**
 * Restore external workspace dependencies and verify the pinned optional payloads.
 * @param options - Optional paths and process adapters used by focused specs.
 * @returns Zero after pnpm succeeds and external bindings remain valid.
 */
export function installExternalDependencies(options: ExternalInstallOptions = {}): number {
  const plan = inspectExternalInstallPlan(options)
  const invoke: ExternalSpawn = options.spawn ?? spawnSync
  const result = invoke(plan.nodeExecutable, [plan.pnpmCli, ...plan.arguments], {
    cwd: plan.stageRoot,
    env: plan.environment,
    encoding: 'utf8',
    shell: false,
    stdio: 'inherit',
  })
  if (result.error) fail(`pnpm install could not start: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`pnpm install failed with ${result.signal ? `signal ${result.signal}` : `status ${String(result.status)}`}`)
  }

  const deviceOf = options.deviceOf ?? (path => statSync(path).dev)
  const rewiredLinks = rewireWorkspaceLinks(
    plan.sourceRoot,
    plan.stageRoot,
    deviceOf(plan.outputRoot),
    deviceOf,
  )
  if (rewiredLinks > 0) {
    console.log(`external dependency repair: rewired ${rewiredLinks} workspace links to internal source`)
  }

  const verification = inspectExternalInstallPlan({
    ...options,
    workingDirectory: plan.sourceRoot,
    environment: plan.environment,
  })
  if (verification.stageRoot !== plan.stageRoot || verification.storeDirectory !== plan.storeDirectory) {
    fail('external installation bindings changed while pnpm was running')
  }
  for (const [file, digest] of Object.entries(plan.metadataDigests)) {
    if (verification.metadataDigests[file] !== digest) fail(`${file} changed while pnpm was running`)
  }
  for (const [lockKey, integrity] of Object.entries(plan.lockedPackageIntegrity)) {
    if (verification.lockedPackageIntegrity[lockKey] !== integrity) {
      fail(`locked package integrity changed while pnpm was running: ${lockKey}`)
    }
  }
  validateOptionalPayloads(
    verification.stageRoot,
    deviceOf(verification.outputRoot),
    deviceOf,
  )
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = installExternalDependencies()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
