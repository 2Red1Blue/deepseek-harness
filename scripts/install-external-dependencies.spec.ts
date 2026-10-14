import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'
import {
  inspectExternalInstallPlan,
  installExternalDependencies,
} from './install-external-dependencies.ts'

const workspaceManifests = [
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
    version: '0.162.1',
  },
  {
    path: 'packages/skill/skill-office',
    name: '@deepseek-ai/dsh-skill-office',
    dependency: '@deepseek-ai/libreoffice-kit',
    version: '^0.1.5',
  },
] as const

const optionalPayloads = [
  {
    lockKey: '@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.263',
    directory: '@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.263/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64',
    name: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
    version: '0.3.263',
    files: ['claude'],
  },
  {
    lockKey: '@openai/codex@0.162.1-darwin-arm64',
    directory: '@openai+codex@0.162.1-darwin-arm64/node_modules/@openai/codex',
    name: '@openai/codex',
    version: '0.162.1-darwin-arm64',
    files: [
      'vendor/aarch64-apple-darwin/bin/codex',
      'vendor/aarch64-apple-darwin/bin/codex-code-mode-host',
      'vendor/aarch64-apple-darwin/codex-path/rg',
      'vendor/aarch64-apple-darwin/codex-resources/zsh/bin/zsh',
    ],
  },
  {
    lockKey: '@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.5',
    directory: '@deepseek-ai+libreoffice-kit-darwin-arm64@0.1.5/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64',
    name: '@deepseek-ai/libreoffice-kit-darwin-arm64',
    version: '0.1.5',
    files: [
      'bin/libreoffice-kit',
      'program/LibreOfficeDev.app/Contents/Resources/senddoc',
      'program/LibreOfficeDev.app/Contents/Resources/unoinfo',
    ],
  },
] as const

const fixtures: string[] = []

interface Fixture {
  container: string
  sourceRoot: string
  outputRoot: string
  buildRoot: string
  stageRoot: string
  environment: NodeJS.ProcessEnv
  deviceOf: (path: string) => string | number
  nodeExecutable: string
  pnpmCli: string
}

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function lockfileWithOptionalPayloads(): string {
  const packages = optionalPayloads.map((payload) => {
    const integrity = createHash('sha512').update(payload.lockKey).digest('base64')
    return `  '${payload.lockKey}':\n    resolution: {integrity: sha512-${integrity}}\n`
  }).join('\n')
  return `lockfileVersion: '9.0'\n\npackages:\n${packages}\nsnapshots:\n  {}\n`
}

function installPayloads(fixture: Fixture, options: { wrongVersion?: string; nonExecutableFile?: string } = {}): void {
  for (const payload of optionalPayloads) {
    const packageRoot = join(fixture.stageRoot, 'node_modules', '.pnpm', payload.directory)
    const version = options.wrongVersion ?? payload.version
    write(join(packageRoot, 'package.json'), `${JSON.stringify({ name: payload.name, version })}\n`)
    for (const file of payload.files) {
      const mode = file === options.nonExecutableFile ? 0o644 : 0o755
      const path = join(packageRoot, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'fixture executable\n', { mode })
    }
  }
}

function makeFixture(): Fixture {
  const container = mkdtempSync(join(tmpdir(), 'dsh-external-dependencies-'))
  fixtures.push(container)
  const sourceRoot = join(container, 'source')
  const buildRoot = join(container, 'agent-ecosystem-build')
  const outputRoot = join(buildRoot, 'projects', 'fixture-project')
  const stageRoot = join(outputRoot, 'install-stage')
  const externalToolBin = join(buildRoot, 'toolchains', 'pnpm-runtime', 'node_modules', '.bin')
  const externalPnpmRoot = join(buildRoot, 'toolchains', 'pnpm-global', '.tools', 'pnpm', '11.28.5', 'node_modules', 'pnpm')
  const pnpmCli = join(externalPnpmRoot, 'bin', 'pnpm.mjs')
  const nodeExecutable = join(buildRoot, 'toolchains', 'node24-runtime', 'bin', 'node')
  const artifacts: Record<string, string> = {}

  const rootManifest = {
    name: '@deepseek-ai/dsh-root',
    version: '0.2.1-alpha.1',
    private: true,
    packageManager: 'pnpm@11.28.5',
    dependencies: { fixture: '1.0.0' },
    devDependencies: { fixtureTool: '2.0.0' },
    optionalDependencies: { fixtureOptional: '3.0.0' },
    peerDependencies: { fixturePeer: '4.0.0' },
    workspaces: ['packages/*/*'],
    engines: { node: '>=22' },
    scripts: {
      'docs:check': 'source docs check',
      'install:external': 'node --experimental-strip-types scripts/install-external-dependencies.ts',
    },
  }
  const stagedRootManifest = {
    ...rootManifest,
    scripts: { 'docs:check': 'staged docs check' },
  }
  write(join(sourceRoot, 'package.json'), `${JSON.stringify(rootManifest)}\n`)
  write(join(stageRoot, 'package.json'), `${JSON.stringify(stagedRootManifest)}\n`)
  const lockfile = lockfileWithOptionalPayloads()
  write(join(sourceRoot, 'pnpm-lock.yaml'), lockfile)
  write(join(stageRoot, 'pnpm-lock.yaml'), lockfile)
  write(join(sourceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*/*\n')
  write(join(stageRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*/*\n')

  for (const workspace of workspaceManifests) {
    const manifest = {
      name: workspace.name,
      version: rootManifest.version,
      dependencies: { [workspace.dependency]: workspace.version },
    }
    const sourcePackage = join(sourceRoot, workspace.path)
    const stagedPackage = join(stageRoot, workspace.path)
    write(join(sourcePackage, 'package.json'), `${JSON.stringify(manifest)}\n`)
    write(join(stagedPackage, 'package.json'), `${JSON.stringify(manifest)}\n`)

    const stagedModules = join(stagedPackage, 'node_modules')
    mkdirSync(stagedModules, { recursive: true })
    const sourceModules = join(sourcePackage, 'node_modules')
    symlinkSync(stagedModules, sourceModules, process.platform === 'win32' ? 'junction' : 'dir')
    artifacts[`${workspace.path}/node_modules`] = stagedModules
  }

  const stagedRootModules = join(stageRoot, 'node_modules')
  mkdirSync(stagedRootModules, { recursive: true })
  symlinkSync(stagedRootModules, join(sourceRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  artifacts.node_modules = stagedRootModules

  for (const path of [
    join(buildRoot, 'cache', 'xdg'),
    join(buildRoot, 'state', 'xdg'),
    join(buildRoot, 'cache', 'npm'),
    join(buildRoot, 'cache', 'node-gyp'),
    join(buildRoot, 'cache', 'pnpm', 'store', 'v11'),
    join(buildRoot, 'toolchains', 'pnpm-global'),
    join(outputRoot, 'tmp'),
    externalToolBin,
    join(externalPnpmRoot, 'bin'),
    dirname(nodeExecutable),
  ]) mkdirSync(path, { recursive: true })
  write(join(externalPnpmRoot, 'package.json'), `${JSON.stringify({ name: 'pnpm', version: '11.28.5' })}\n`)
  write(pnpmCli, '#!/usr/bin/env node\n')
  write(join(externalToolBin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), '# untrusted PATH pnpm\n')
  write(nodeExecutable, '# node fixture\n')

  write(join(outputRoot, 'bindings.json'), `${JSON.stringify({
    schema: 'ecosystem-build-bindings.v1',
    source: realpathSync(sourceRoot),
    artifacts,
  })}\n`)

  const deviceOf = (path: string): string | number => {
    const resolved = realpathSync(path)
    const relativePath = relative(realpathSync(sourceRoot), resolved)
    return resolved === realpathSync(sourceRoot) || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
      ? 'internal-device'
      : 'external-device'
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${externalToolBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    XDG_CACHE_HOME: join(buildRoot, 'cache', 'xdg'),
    XDG_STATE_HOME: join(buildRoot, 'state', 'xdg'),
    npm_config_cache: join(buildRoot, 'cache', 'npm'),
    npm_config_devdir: join(buildRoot, 'cache', 'node-gyp'),
    npm_config_optional: 'false',
    pnpm_config_optional: 'false',
    npm_config_offline: 'true',
    pnpm_config_offline: 'true',
    npm_config_force: 'true',
    pnpm_config_force: 'true',
    PNPM_HOME: join(buildRoot, 'toolchains', 'pnpm-global'),
    TMPDIR: join(outputRoot, 'tmp'),
    npm_config_user_agent: 'pnpm/11.28.5 npm/? node/v24.0.0 darwin arm64',
  }

  return { container, sourceRoot, outputRoot, buildRoot, stageRoot, environment, deviceOf, nodeExecutable, pnpmCli }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeFixtureSafely(fixture)
})

describe.skipIf(process.platform === 'win32')('external optional dependency repair', () => {
  it('derives the bound external stage and plans a full frozen workspace install', () => {
    const fixture = makeFixture()
    const plan = inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })

    expect(plan.stageRoot).toBe(realpathSync(fixture.stageRoot))
    expect(plan.storeDirectory).toBe(realpathSync(join(fixture.buildRoot, 'cache', 'pnpm', 'store', 'v11')))
    expect(plan.arguments).toEqual([
      'install',
      '--frozen-lockfile',
      '--reporter=ndjson',
    ])
    expect(plan.pnpmCli).toBe(realpathSync(fixture.pnpmCli))
    expect(plan.environment.npm_config_store_dir).toBe(plan.storeDirectory)
    expect(plan.environment.pnpm_config_store_dir).toBe(plan.storeDirectory)
    expect(plan.environment.npm_config_optional).toBe('true')
    expect(plan.environment.pnpm_config_optional).toBe('true')
    expect(plan.environment.npm_config_offline).toBe('false')
    expect(plan.environment.pnpm_config_offline).toBe('false')
    expect(plan.environment.npm_config_force).toBe('false')
    expect(plan.environment.pnpm_config_force).toBe('false')
    expect(plan.environment.TMP).toBe(realpathSync(fixture.environment.TMPDIR!))
    expect(plan.environment.TEMP).toBe(realpathSync(fixture.environment.TMPDIR!))
    expect(Object.keys(plan.lockedPackageIntegrity)).toHaveLength(optionalPayloads.length)
    expect(Object.values(plan.lockedPackageIntegrity).every(value => value.startsWith('sha512-'))).toBe(true)
  })

  it('invokes pnpm shell-free in the external stage and revalidates bindings after success', () => {
    const fixture = makeFixture()
    const calls: Array<{ executable: string; args: string[]; options: object }> = []
    const rootWorkspaceLink = join(fixture.stageRoot, 'node_modules', '@deepseek-ai', 'dsh-subagent-claude-code')
    const packageWorkspaceLink = join(
      fixture.stageRoot,
      workspaceManifests[0].path,
      'node_modules',
      '@deepseek-ai',
      'dsh-subagent-codex',
    )
    const spawn = (
      executable: string,
      args: readonly string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ): SpawnSyncReturns<string> => {
      calls.push({ executable, args: [...args], options })
      installPayloads(fixture)
      mkdirSync(dirname(rootWorkspaceLink), { recursive: true })
      symlinkSync(join(fixture.stageRoot, workspaceManifests[0].path), rootWorkspaceLink, 'dir')
      mkdirSync(dirname(packageWorkspaceLink), { recursive: true })
      symlinkSync(join(fixture.stageRoot, workspaceManifests[1].path), packageWorkspaceLink, 'dir')
      return { status: 0, signal: null, output: [], pid: 1, stdout: '', stderr: '' }
    }

    expect(installExternalDependencies({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
      spawn,
    })).toBe(0)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.executable).toBe(realpathSync(fixture.nodeExecutable))
    expect(calls[0]?.args[0]).toBe(realpathSync(fixture.pnpmCli))
    expect(calls[0]?.args).toContain('--frozen-lockfile')
    expect(calls[0]?.args).toContain('--reporter=ndjson')
    expect(calls[0]?.args).not.toContain('--filter')
    expect(calls[0]?.args).not.toContain('--force')
    expect(calls[0]?.options).toMatchObject({ cwd: realpathSync(fixture.stageRoot), shell: false, stdio: 'inherit' })
    expect(lstatSync(join(fixture.sourceRoot, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(realpathSync(rootWorkspaceLink)).toBe(realpathSync(join(fixture.sourceRoot, workspaceManifests[0].path)))
    expect(realpathSync(packageWorkspaceLink)).toBe(realpathSync(join(fixture.sourceRoot, workspaceManifests[1].path)))
  })

  it('does not let an earlier PATH pnpm override the pinned external CLI', () => {
    const fixture = makeFixture()
    const maliciousBin = join(fixture.sourceRoot, 'malicious-bin')
    mkdirSync(maliciousBin)
    write(join(maliciousBin, 'pnpm'), '#!/bin/sh\nexit 99\n')
    fixture.environment.PATH = `${maliciousBin}:${fixture.environment.PATH}`

    const plan = inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })

    expect(plan.pnpmCli).toBe(realpathSync(fixture.pnpmCli))
    expect(plan.pnpmCli).not.toBe(realpathSync(join(maliciousBin, 'pnpm')))
  })

  it('refuses an external pnpm package with the wrong version', () => {
    const fixture = makeFixture()
    write(
      join(dirname(dirname(fixture.pnpmCli)), 'package.json'),
      `${JSON.stringify({ name: 'pnpm', version: '10.30.3' })}\n`,
    )

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('external pnpm package must be pnpm@11.28.5')
  })

  it('rejects pnpm exit zero when a locked optional payload is still absent', () => {
    const fixture = makeFixture()
    const spawn = vi.fn(() => {
      mkdirSync(join(fixture.stageRoot, 'node_modules', '.pnpm'), { recursive: true })
      return { error: undefined, status: 0, signal: null, output: [], pid: 1, stdout: '', stderr: '' }
    })

    expect(() => installExternalDependencies({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
      spawn: spawn as never,
    })).toThrow('locked optional package payload is missing')
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('rejects a postflight payload with the wrong locked version', () => {
    const fixture = makeFixture()
    const spawn = vi.fn(() => {
      installPayloads(fixture, { wrongVersion: '0.0.0' })
      return { error: undefined, status: 0, signal: null, output: [], pid: 1, stdout: '', stderr: '' }
    })

    expect(() => installExternalDependencies({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
      spawn: spawn as never,
    })).toThrow('has the wrong package name or version')
  })

  it('rejects a postflight payload with a non-executable required binary', () => {
    const fixture = makeFixture()
    const missingMode = 'vendor/aarch64-apple-darwin/bin/codex-code-mode-host'
    const spawn = vi.fn(() => {
      installPayloads(fixture, { nonExecutableFile: missingMode })
      return { error: undefined, status: 0, signal: null, output: [], pid: 1, stdout: '', stderr: '' }
    })

    expect(() => installExternalDependencies({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
      spawn: spawn as never,
    })).toThrow('required executable is not executable')
  })

  it('rejects a locked optional package whose real path escapes the pnpm virtual store', () => {
    const fixture = makeFixture()
    const payload = optionalPayloads[0]
    const packageRoot = join(fixture.stageRoot, 'node_modules', '.pnpm', payload.directory)
    const escapedPackage = join(fixture.buildRoot, 'escaped-optional-package')
    const spawn = vi.fn(() => {
      installPayloads(fixture)
      write(join(escapedPackage, 'package.json'), `${JSON.stringify({ name: payload.name, version: payload.version })}\n`)
      writeFileSync(join(escapedPackage, 'claude'), 'fixture executable\n', { mode: 0o755 })
      rmSync(packageRoot, { recursive: true, force: true })
      symlinkSync(escapedPackage, packageRoot, 'dir')
      return { error: undefined, status: 0, signal: null, output: [], pid: 1, stdout: '', stderr: '' }
    })

    expect(() => installExternalDependencies({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
      spawn: spawn as never,
    })).toThrow('package payload @anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.263 escapes its allowed directory')
  })

  it('rejects a required executable whose real path escapes its package root', () => {
    const fixture = makeFixture()
    const claudeRoot = join(fixture.stageRoot, 'node_modules', '.pnpm', optionalPayloads[0].directory)
    const escapedExecutable = join(fixture.buildRoot, 'escaped-claude')
    const spawn = vi.fn(() => {
      installPayloads(fixture)
      writeFileSync(escapedExecutable, 'fixture executable\n', { mode: 0o755 })
      rmSync(join(claudeRoot, 'claude'))
      symlinkSync(escapedExecutable, join(claudeRoot, 'claude'))
      return { error: undefined, status: 0, signal: null, output: [], pid: 1, stdout: '', stderr: '' }
    })

    expect(() => installExternalDependencies({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
      spawn: spawn as never,
    })).toThrow('package executable claude escapes its allowed directory')
  })

  it('rejects source metadata mutation during pnpm even when its manifest identity remains valid', () => {
    const fixture = makeFixture()
    const spawn = vi.fn(() => {
      const packagePath = join(fixture.sourceRoot, 'package.json')
      const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
      manifest.description = 'changed during install'
      write(packagePath, `${JSON.stringify(manifest)}\n`)
      installPayloads(fixture)
      return { error: undefined, status: 0, signal: null, output: [], pid: 1, stdout: '', stderr: '' }
    })

    expect(() => installExternalDependencies({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
      spawn: spawn as never,
    })).toThrow('source/package.json changed while pnpm was running')
  })

  it('refuses a copied source node_modules directory before launching pnpm', () => {
    const fixture = makeFixture()
    rmSync(join(fixture.sourceRoot, 'node_modules'))
    mkdirSync(join(fixture.sourceRoot, 'node_modules'))
    const spawn = vi.fn()

    expect(() => installExternalDependencies({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
      spawn: spawn as never,
    })).toThrow('source node_modules must remain a symlink')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses an external binding that escapes the runner project output', () => {
    const fixture = makeFixture()
    const escapedTarget = join(fixture.container, 'escaped-node-modules')
    mkdirSync(escapedTarget)
    const bindingsPath = join(fixture.outputRoot, 'bindings.json')
    const bindings = JSON.parse(readFileSync(bindingsPath, 'utf8')) as { artifacts: Record<string, string> }
    bindings.artifacts[`${workspaceManifests[0].path}/node_modules`] = escapedTarget
    write(bindingsPath, `${JSON.stringify(bindings)}\n`)

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('escapes its allowed directory')
  })

  it('refuses a bindings manifest that names another source checkout', () => {
    const fixture = makeFixture()
    const bindingsPath = join(fixture.outputRoot, 'bindings.json')
    const bindings = JSON.parse(readFileSync(bindingsPath, 'utf8')) as { source: string }
    bindings.source = join(fixture.container, 'different-source')
    write(bindingsPath, `${JSON.stringify(bindings)}\n`)

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('external bindings do not identify this source worktree')
  })

  it('refuses source/stage lockfile or workspace metadata drift', () => {
    const fixture = makeFixture()
    write(join(fixture.stageRoot, 'pnpm-lock.yaml'), 'lockfileVersion: changed\n')

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('pnpm-lock.yaml differs between source and external stage')
  })

  it('refuses an optional payload lock entry without a valid SHA-512 integrity', () => {
    const fixture = makeFixture()
    const lockPath = join(fixture.sourceRoot, 'pnpm-lock.yaml')
    const invalid = readFileSync(lockPath, 'utf8').replace(/integrity: sha512-[A-Za-z0-9+/]+={0,2}/, 'integrity: sha512-short')
    write(lockPath, invalid)
    write(join(fixture.stageRoot, 'pnpm-lock.yaml'), invalid)

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('pnpm lockfile has no valid SHA-512 integrity')
  })

  it('refuses a root install metadata mismatch while allowing the known docs script drift', () => {
    const fixture = makeFixture()
    const stageManifestPath = join(fixture.stageRoot, 'package.json')
    const staged = JSON.parse(readFileSync(stageManifestPath, 'utf8')) as Record<string, unknown>
    staged.devDependencies = { fixtureTool: 'different' }
    write(stageManifestPath, `${JSON.stringify(staged)}\n`)

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('root package.json has different install metadata in devDependencies')
  })

  it('refuses workspace metadata drift between source and external stage', () => {
    const fixture = makeFixture()
    write(join(fixture.stageRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/changed/*\n')

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('pnpm-workspace.yaml differs between source and external stage')
  })

  it('refuses a selected workspace with the wrong manifest identity', () => {
    const fixture = makeFixture()
    const path = join(fixture.sourceRoot, workspaceManifests[1].path, 'package.json')
    const changed = JSON.parse(readFileSync(path, 'utf8')) as { name: string; dependencies: Record<string, string> }
    changed.name = '@deepseek-ai/dsh-wrong-package'
    write(path, `${JSON.stringify(changed)}\n`)
    write(join(fixture.stageRoot, workspaceManifests[1].path, 'package.json'), `${JSON.stringify(changed)}\n`)

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('packages/subagent/subagent-codex is not @deepseek-ai/dsh-subagent-codex')
  })

  it('refuses a selected workspace whose dependency pin changed', () => {
    const fixture = makeFixture()
    const path = join(fixture.sourceRoot, workspaceManifests[1].path, 'package.json')
    const changed = JSON.parse(readFileSync(path, 'utf8')) as { name: string; dependencies: Record<string, string> }
    changed.dependencies['@openai/codex'] = 'latest'
    write(path, `${JSON.stringify(changed)}\n`)
    write(join(fixture.stageRoot, workspaceManifests[1].path, 'package.json'), `${JSON.stringify(changed)}\n`)

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('@openai/codex@0.162.1')
  })

  it('refuses a cache path outside the external build runner tree', () => {
    const fixture = makeFixture()
    fixture.environment.npm_config_cache = join(fixture.sourceRoot, '.npm-cache')
    mkdirSync(fixture.environment.npm_config_cache)

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('npm_config_cache runner path escapes its allowed directory')
  })

  it('refuses to create or substitute a missing shared pnpm store', () => {
    const fixture = makeFixture()
    const store = join(fixture.buildRoot, 'cache', 'pnpm', 'store', 'v11')
    rmSync(store, { recursive: true })

    expect(() => inspectExternalInstallPlan({
      sourceRoot: fixture.sourceRoot,
      workingDirectory: fixture.sourceRoot,
      environment: fixture.environment,
      executablePath: fixture.nodeExecutable,
      deviceOf: fixture.deviceOf,
      platform: 'darwin',
      architecture: 'arm64',
    })).toThrow('shared pnpm v11 store must already exist')
    expect(lstatSync(store, { throwIfNoEntry: false })).toBeUndefined()
  })
})
