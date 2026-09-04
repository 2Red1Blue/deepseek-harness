import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceAnalyzer, WorkspaceCaches } from '../src/analyzer.ts'
import type { WorkspaceAnalyzerOptions } from '../src/analyzer.ts'
import { FaceModelEmitter } from '../src/emitter.ts'
import type { WorkspaceTypertGeneratorOptions } from '../src/index.ts'
import type { TypertFace } from '../src/model.ts'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'

const fixtureRoot = resolve(import.meta.dirname, 'fixtures/remote-model')
const repositoryRoot = resolve(import.meta.dirname, '../../../..')
const temporaryRoots: string[] = []
const temporaryLinks: string[] = []

interface RuntimeSchema {
  parse(value: unknown): unknown
}

interface RemoteModule {
  readonly TYPERT_REMOTE: {
    readonly descriptors: readonly {
      readonly id: string
      readonly parameters: readonly { readonly codec: { readonly mode: string; readonly schema: RuntimeSchema } }[]
      readonly result: { readonly schema: RuntimeSchema }
    }[]
  }
}

afterEach(() => {
  for (const link of temporaryLinks.splice(0)) unlinkSync(link)
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('explicit Typert package containers', { timeout: 30_000 }, () => {
  it('admits only direct references in default or explicit canonical containers', () => {
    const root = workspace()
    const local = schemaPackage(root, 'packages/local', '@fixture/local')
    const sibling = schemaPackage(root, '../sibling/packages/extra', '@fixture/extra')
    const prefix = schemaPackage(root, '../sibling/packages-other/excluded', '@fixture/prefix')
    schemaPackage(root, '../sibling/packages/unreferenced', '@fixture/unreferenced')
    aggregate(root, 'tsconfig.host.json', [local, sibling, prefix])
    const caches = new WorkspaceCaches()
    const discover = (additionalPackageRoots?: readonly string[]) => new WorkspaceAnalyzer({
      root,
      caches,
      ...(additionalPackageRoots === undefined ? {} : { additionalPackageRoots }),
    }).discoverPackages()

    expect(discover().map(item => item.package)).toEqual(['@fixture/local'])
    expect(discover(['../sibling/packages']).map(item => item.package)).toEqual(['@fixture/extra', '@fixture/local'])
    expect(discover().map(item => item.package)).toEqual(['@fixture/local'])
    expect(caches.registrations.size).toBe(2)

    const alias = directoryLink(join(root, '../sibling/packages'), join(root, 'sibling-alias'))
    expect(discover([alias, '../sibling/packages', alias])).toEqual(discover(['../sibling/packages']))
    expect(caches.registrations.size).toBe(2)
    expect(discover(['../sibling/packages-other', alias])).toEqual(discover([alias, '../sibling/packages-other']))
    expect(caches.registrations.size).toBe(3)
    const selected = new WorkspaceTypertGenerator(root, { additionalPackageRoots: [alias] })
      .generate(['@fixture/extra'], ['host'])
    expect(selected.map(item => [item.package, item.packageRoot])).toEqual([
      ['@fixture/extra', '../sibling/packages/extra'],
    ])
  })

  it.each(['packages', '../sibling/packages'])('excludes symlink escapes from %s', (container) => {
    const root = workspace()
    const escaped = schemaPackage(root, '../outside/escaped', '@fixture/escaped')
    mkdirSync(resolve(root, container), { recursive: true })
    const link = directoryLink(escaped, resolve(root, container, 'escape'))
    aggregate(root, 'tsconfig.host.json', [link])

    expect(new WorkspaceAnalyzer({ root, additionalPackageRoots: [container] }).discoverPackages()).toEqual([])
  })

  it('rejects globally conflicting identities before selecting packages or faces', () => {
    const root = workspace()
    const selected = schemaPackage(root, 'packages/selected', '@fixture/selected')
    const first = schemaPackage(root, 'packages/first', '@fixture/duplicate', 'client')
    const second = schemaPackage(root, '../sibling/packages/second', '@fixture/duplicate', 'client')
    aggregate(root, 'tsconfig.host.json', [selected])
    aggregate(root, 'tsconfig.client.json', [second, first])
    aggregate(root, 'reversed.client.json', [first, second])
    const options = { additionalPackageRoots: ['../sibling/packages'] }
    const diagnostic = `typert(client): package @fixture/duplicate has conflicting roots: ${JSON.stringify([first, second].sort())}`

    expect(() => new WorkspaceTypertGenerator(root, options).generate(['@fixture/selected'], ['host']))
      .toThrow(diagnostic)
    expect(() => new WorkspaceAnalyzer({ root, ...options, clientConfig: 'reversed.client.json' }).discoverPackages())
      .toThrow(diagnostic)
  })

  it('deduplicates the same physical package and keeps Host and Client identities independent', () => {
    const root = workspace()
    const host = schemaPackage(root, 'packages/host', '@fixture/shared')
    const client = schemaPackage(root, '../sibling/packages/client', '@fixture/shared', 'client')
    const alias = directoryLink(host, join(root, 'packages/alias'))
    aggregate(root, 'tsconfig.host.json', [host, alias, host])
    aggregate(root, 'tsconfig.client.json', [client])

    const artifacts = new WorkspaceTypertGenerator(root, { additionalPackageRoots: ['../sibling/packages'] })
      .generate(['@fixture/shared'])
    expect(artifacts.map(item => [item.face, item.packageRoot])).toEqual([
      ['host', 'packages/host'],
      ['client', '../sibling/packages/client'],
    ])
  })

  it('isolates inventories by both aggregate paths and reuses canonical root/config identities', () => {
    const root = workspace()
    const first = schemaPackage(root, 'packages/first', '@fixture/first')
    const second = schemaPackage(root, 'packages/second', '@fixture/second')
    aggregate(root, 'first.json', [first])
    aggregate(root, 'second.json', [second])
    const caches = new WorkspaceCaches()
    const discover = (options: WorkspaceAnalyzerOptions) => new WorkspaceAnalyzer({ ...options, caches }).discoverPackages()

    expect(discover({ root, hostConfig: 'first.json' }).map(item => item.package)).toEqual(['@fixture/first'])
    expect(discover({ root, hostConfig: 'second.json' }).map(item => item.package)).toEqual(['@fixture/second'])
    expect(discover({ root, hostConfig: 'first.json', clientConfig: 'second.json' })).toMatchObject([
      { package: '@fixture/first', faces: ['host'] },
      { package: '@fixture/second', faces: ['client'] },
    ])
    expect(caches.registrations.size).toBe(3)
    const alias = directoryLink(root, join(root, '../product-alias'))
    expect(discover({ root: alias, hostConfig: resolve(alias, 'first.json') })).toEqual(
      discover({ root, hostConfig: 'first.json' }),
    )
    expect(caches.registrations.size).toBe(3)
  })

  it.each(['host', 'client'] as const)('isolates %s compiler hosts across custom aggregate options', async (face) => {
    const root = workspace()
    const target = schemaPackage(root, 'packages/cache', '@fixture/cache', face)
    write(join(target, 'src/index.ts'), `import type { Choice } from '#choice'
/** @typert schema */
export interface Value { readonly value: Choice }
`)
    write(join(target, 'src/string.ts'), 'export type Choice = string\n')
    write(join(target, 'src/number.ts'), 'export type Choice = number\n')
    const stringPaths = { '#choice': [join(target, 'src/string.ts')] }
    const numberPaths = { '#choice': [join(target, 'src/number.ts')] }
    json(join(target, 'tsconfig.json'), {
      extends: '../../tsconfig.base.json',
      compilerOptions: { paths: stringPaths },
      include: ['src'],
    })
    aggregate(root, 'string.json', [target], stringPaths)
    aggregate(root, 'number.json', [target], numberPaths)
    const caches = new WorkspaceCaches()
    for (const [config, accepted, rejected] of [
      ['string.json', 'text', 1],
      ['number.json', 1, 'text'],
      ['string.json', 'text', 1],
    ] as const) {
      const model = new WorkspaceAnalyzer({
        root,
        caches,
        faces: [face],
        ...(face === 'host' ? { hostConfig: config } : { clientConfig: config }),
      }).analyze()
      const generatedFace = model.faces[0]
      if (generatedFace === undefined) throw new Error('Missing cache fixture face')
      const artifact = new FaceModelEmitter(generatedFace).emit('@fixture/cache')
      const generated = await execute(artifact.js) as { readonly Value: RuntimeSchema }
      expect(generated.Value.parse({ value: accepted })).toEqual({ value: accepted })
      expect(() => generated.Value.parse({ value: rejected })).toThrow()
      const configPath = join(root, config)
      const compilerOptions = caches.config(configPath).parsed.options
      const host = caches.programHost(face, compilerOptions, configPath)
      const resolved = ts.resolveModuleName(
        '#choice', join(target, 'src/index.ts'), compilerOptions, host, host.getModuleResolutionCache?.(),
      )
      const expectedSource = config === 'string.json' ? 'src/string.ts' : 'src/number.ts'
      expect(resolved.resolvedModule?.resolvedFileName.replaceAll('\\', '/'))
        .toBe(join(target, expectedSource).replaceAll('\\', '/'))
    }
    expect(caches.registrations.size).toBe(2)
  })

  it('forwards custom aggregates and sibling roots through discovery and generation with real protocol sources', async () => {
    const { root, options } = remoteWorkspace()
    const generator = new WorkspaceTypertGenerator(root, options)
    expect(generator.discover()).toEqual([
      { package: '@deepseek-ai/dsh-typert-protocol', root: '../sibling/packages/typert/protocol', faces: ['host'] },
      { package: '@fixture/client', root: '../sibling/packages/client', faces: ['client'] },
      { package: '@fixture/remote', root: 'packages/remote', faces: ['host'] },
    ])
    const artifacts = generator.generate(['@fixture/remote', '@fixture/client'])
    expect(artifacts.map(item => [item.package, item.face])).toEqual([
      ['@fixture/remote', 'host'],
      ['@fixture/client', 'client'],
    ])
    const [artifact] = generator.generate(['@fixture/remote'], ['host'])
    if (artifact?.remote === undefined) throw new Error('Missing sibling Remote artifact')
    const generated = await execute(artifact.remote.js) as RemoteModule
    expect(generated.TYPERT_REMOTE.descriptors.map(item => item.id)).toEqual([
      '@fixture/remote#goals/create', '@fixture/remote#goals/rename', '@fixture/remote#goals/watch',
    ])
    const create = generated.TYPERT_REMOTE.descriptors[0]
    expect(create).toMatchObject({
      scope: { context: 'agent', wire: 'agentId' },
      cancellation: { parameter: 'signal' },
      parameters: [{ wire: 'agentId' }, { wire: 'request', codec: { mode: 'strict' } }],
    })
    const request = create?.parameters[1]?.codec.schema
    expect(request?.parse({ title: 'ship' })).toEqual({ title: 'ship' })
    expect(() => request?.parse({ title: 1 })).toThrow()
    expect(request?.parse({ title: 'ship', extra: true })).toEqual({ title: 'ship' })
    expect(create?.result.schema.parse({ ref: 'goal-1' })).toEqual({ ref: 'goal-1' })
    expect(() => create?.result.schema.parse({ ref: 1 })).toThrow()
    expect(artifact.remote.dts).toContain("'agent:goals/create'")
    expect(JSON.parse(artifact.remote.dtsMap)).toMatchObject({ sources: ['../src/index.ts'] })
    expect(JSON.stringify(artifacts)).not.toContain('aggregates')
  })

  it.each([
    ['MissingRequest', /TypeScript TS2304: Cannot find name 'MissingRequest'/],
    ['unknown', /Remote boundary contains unconstrained unknown data/],
  ])('rejects invalid request field type %s with diagnostics enabled', (type, diagnostic) => {
    const { root, options } = remoteWorkspace()
    const path = join(root, 'packages/remote/src/types.ts')
    write(path, readFileSync(path, 'utf8').replace('readonly title: string', `readonly title: ${type}`))

    expect(() => new WorkspaceTypertGenerator(root, options).generate(['@fixture/remote'], ['host']))
      .toThrow(diagnostic)
  })

  it('preserves generation of the official Remote fixture with default options', async () => {
    const root = workspace()
    cpSync(fixtureRoot, root, { recursive: true })
    const defaults = new WorkspaceTypertGenerator(root).generate()
    expect(new WorkspaceTypertGenerator(root, { additionalPackageRoots: [] }).generate()).toEqual(defaults)
    expect(defaults).toHaveLength(1)
    const [artifact] = defaults
    expect(artifact).toMatchObject({ package: '@fixture/remote', face: 'host', packageRoot: 'packages/remote' })
    if (artifact?.remote === undefined) throw new Error('Missing official Remote artifact')
    const generated = await execute(artifact.remote.js) as RemoteModule
    expect(generated.TYPERT_REMOTE.descriptors.map(item => item.id)).toEqual([
      '@fixture/remote#goals/create', '@fixture/remote#goals/rename', '@fixture/remote#goals/watch',
    ])
  })
})

function workspace(): string {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-typert-external-')))
  temporaryRoots.push(temporary)
  const root = join(temporary, 'product')
  json(join(root, 'package.json'), { private: true, type: 'module' })
  json(join(root, 'tsconfig.base.json'), {
    compilerOptions: {
      target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
      noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: [],
    },
  })
  return root
}

function schemaPackage(root: string, path: string, name: string, face: TypertFace = 'host'): string {
  const target = resolve(root, path)
  json(join(target, 'package.json'), {
    name,
    type: 'module',
    exports: {
      '.': './src/index.ts',
      [face === 'host' ? './typert' : './client/typert']: {
        types: `./lib/typert.${face}.d.ts`, default: `./lib/typert.${face}.js`,
      },
    },
    files: [`lib/typert.${face}.js`, `lib/typert.${face}.d.ts`],
  })
  json(join(target, 'tsconfig.json'), {
    extends: join(root, 'tsconfig.base.json'),
    compilerOptions: { rootDir: 'src' },
    include: ['src'],
  })
  write(join(target, 'src/index.ts'), '/** @typert schema */\nexport interface Value { readonly value: string }\n')
  return target
}

function aggregate(root: string, path: string, packages: readonly string[], paths: Record<string, string[]> = {}): void {
  json(resolve(root, path), {
    extends: join(root, 'tsconfig.base.json'),
    compilerOptions: { paths },
    files: [],
    references: packages.map(target => ({ path: target })),
  })
}

function remoteWorkspace(): {
  readonly root: string
  readonly options: WorkspaceTypertGeneratorOptions
} {
  const root = workspace()
  cpSync(fixtureRoot, root, { recursive: true })
  const protocol = resolve(root, '../sibling/packages/typert/protocol')
  cpSync(join(repositoryRoot, 'packages/typert/protocol/src'), join(protocol, 'src'), { recursive: true })
  cpSync(join(repositoryRoot, 'packages/typert/protocol/package.json'), join(protocol, 'package.json'))
  json(join(protocol, 'tsconfig.json'), { extends: join(root, 'tsconfig.base.json'), include: ['src'] })
  const client = schemaPackage(root, '../sibling/packages/client', '@fixture/client', 'client')
  const paths = {
    '@deepseek-ai/dsh-typert-protocol': [join(protocol, 'src/index.ts')],
    '@deepseek-ai/cordis': [join(repositoryRoot, 'vendor/cordis/src/index.ts')],
    '@deepseek-ai/cosmokit': [join(repositoryRoot, 'vendor/cosmokit/src/index.ts')],
    '@fixture/domain': [join(root, 'packages/domain/src/index.ts')],
    '@fixture/domain/*': [join(root, 'packages/domain/src/*')],
    '@fixture/remote/*': [join(root, 'packages/remote/src/*')],
  }
  const basePath = join(root, 'tsconfig.base.json')
  const base = JSON.parse(readFileSync(basePath, 'utf8')) as { compilerOptions: object }
  json(basePath, { compilerOptions: { ...base.compilerOptions, paths, types: [] } })
  const sourcePath = join(root, 'packages/remote/src/index.ts')
  write(sourcePath, readFileSync(sourcePath, 'utf8')
    .replace('TypertRemoteService, Remote', 'bindTypertRemote, Remote')
    .replace("export class GoalService extends TypertRemoteService {\n  constructor() {\n    super(undefined, 'goals')\n  }",
      "export class GoalService {\n  readonly typertRemote = bindTypertRemote(this, 'goals')"))
  aggregate(root, 'tsconfig.host.json', [])
  const hostConfig = '../aggregates/host.json'
  const clientConfig = '../aggregates/client.json'
  aggregate(root, hostConfig, [join(root, 'packages/domain'), join(root, 'packages/remote'), protocol], paths)
  aggregate(root, clientConfig, [client], paths)
  return { root, options: { hostConfig, clientConfig, additionalPackageRoots: ['../sibling/packages'] } }
}

function directoryLink(target: string, path: string): string {
  symlinkSync(target, path, 'junction')
  temporaryLinks.push(path)
  return path
}

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
}

function json(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function execute(source: string): Promise<unknown> {
  const executable = source.replace("from 'zod'", `from ${JSON.stringify(import.meta.resolve('zod'))}`)
  return import(`data:text/javascript,${encodeURIComponent(executable)}`)
}
