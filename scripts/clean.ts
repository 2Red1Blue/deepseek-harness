import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { repositoryConfigHost } from './ts-project.ts'

const knownOrphanEntries = new Set(['node_modules', 'lib', '.typecheck'])

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === 'string')
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function childDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => join(path, entry.name))
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

function repositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function parseConfig(configPath: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, repositoryConfigHost)
  if (!parsed) throw new Error(`clean: cannot parse TypeScript config ${configPath}`)
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  }
  return parsed
}

interface ExternalBuildBindings {
  schema: 'ecosystem-build-bindings.v1'
  source: string
  artifacts: Record<string, string>
}

function defaultBindingsPath(root: string): string {
  const volume = process.env.ECO_BUILD_VOLUME ?? '/Volumes/Mac Storage'
  const identity = `${basename(root)}-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`
  return join(volume, 'agent-ecosystem-build', 'projects', identity, 'bindings.json')
}

/** Clears repository build output and exact external bindings without removing their source links. */
export class RepositoryCleaner {
  private readonly root: string
  private readonly bindingsPath: string
  private readonly validatedExternalTargets = new Map<string, string>()

  constructor(root: string, bindingsPath?: string) {
    this.root = resolve(root)
    this.bindingsPath = bindingsPath ?? defaultBindingsPath(this.root)
  }

  /**
   * Clear generated build state and remove package directories containing only known residue.
   * Bound external output links remain in place so later builds keep writing to their targets.
   * @returns Repository-relative paths that were cleared or removed.
   */
  async clean(): Promise<string[]> {
    const targets = await this.plan()
    // Validate every symlink before clearing any output so an unsafe link prevents partial cleanup.
    for (const target of targets) {
      const externalTarget = await this.externalTargetFor(target)
      if (externalTarget !== undefined) this.validatedExternalTargets.set(target, externalTarget)
    }
    for (const target of targets) await this.removeTarget(target)
    return targets.map(target => repositoryPath(this.root, target))
  }

  private async removeTarget(target: string): Promise<void> {
    const info = await lstat(target)
    if (!info.isSymbolicLink()) {
      if (this.validatedExternalTargets.has(target)) {
        throw new Error(`clean: symlink output changed during cleanup: ${repositoryPath(this.root, target)}`)
      }
      await rm(target, { recursive: true, force: true })
      return
    }

    const expectedTarget = this.validatedExternalTargets.get(target)
    if (expectedTarget === undefined) throw new Error(`clean: refusing to remove unbound symlink output: ${target}`)
    const targetInfo = await stat(expectedTarget)
    if (targetInfo.isDirectory()) {
      for (const name of await readdir(expectedTarget)) {
        await rm(join(expectedTarget, name), { recursive: true, force: true })
      }
      return
    }
    if (!targetInfo.isFile()) {
      throw new Error(`clean: refusing to clear non-file external output: ${repositoryPath(this.root, target)}`)
    }
    // Truncate through the source link so the external target and the link stay usable.
    await writeFile(expectedTarget, '')
  }

  private async externalTargetFor(target: string): Promise<string | undefined> {
    const info = await lstat(target)
    if (!info.isSymbolicLink()) return undefined
    const relativePath = repositoryPath(this.root, target)
    const bindings = await this.readBindings()
    const declaredTarget = bindings.artifacts[relativePath]
    if (typeof declaredTarget !== 'string') {
      throw new Error(`clean: refusing to remove unbound symlink output: ${relativePath}`)
    }

    const externalRoot = dirname(this.bindingsPath)
    const expectedTarget = resolve(declaredTarget)
    const externalRelative = relative(externalRoot, expectedTarget)
    if (externalRelative === '' || externalRelative === '..' || externalRelative.startsWith(`..${sep}`) || isAbsolute(externalRelative)) {
      throw new Error(`clean: refusing external binding outside project output: ${relativePath}`)
    }

    const sourceRoot = await realpath(this.root)
    if (bindings.source !== sourceRoot) {
      throw new Error(`clean: external bindings source does not match repository: ${this.bindingsPath}`)
    }
    const volume = process.env.ECO_BUILD_VOLUME ?? '/Volumes/Mac Storage'
    const [
      sourceStat,
      volumeStat,
      canonicalVolume,
      canonicalExternalRoot,
      canonicalTarget,
      canonicalExpected,
      expectedInfo,
      targetInfo,
    ] = await Promise.all([
      stat(sourceRoot),
      stat(volume),
      realpath(volume),
      realpath(externalRoot),
      realpath(target),
      realpath(expectedTarget),
      lstat(expectedTarget),
      stat(target),
    ])
    if (sourceStat.dev === volumeStat.dev) {
      throw new Error(`clean: external build volume is not separate from the repository: ${volume}`)
    }
    const projectRelative = relative(canonicalVolume, canonicalExternalRoot)
    if (projectRelative === '..' || projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) {
      throw new Error(`clean: external bindings are outside the build volume: ${this.bindingsPath}`)
    }
    const targetRelative = relative(canonicalExternalRoot, canonicalExpected)
    if (targetRelative === '' || targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
      throw new Error(`clean: external target resolves outside project output: ${relativePath}`)
    }
    if (canonicalTarget !== canonicalExpected) {
      throw new Error(`clean: external binding target changed: ${relativePath}`)
    }
    if (expectedInfo.isSymbolicLink() || expectedInfo.dev !== volumeStat.dev || targetInfo.dev !== volumeStat.dev) {
      throw new Error(`clean: external output is not a direct entry on the build volume: ${relativePath}`)
    }
    if ((targetInfo.isDirectory() && !expectedInfo.isDirectory()) || (targetInfo.isFile() && !expectedInfo.isFile())) {
      throw new Error(`clean: external output type does not match its source link: ${relativePath}`)
    }
    return expectedTarget
  }

  private async readBindings(): Promise<ExternalBuildBindings> {
    let manifestInfo
    try {
      manifestInfo = await lstat(this.bindingsPath)
    } catch (error) {
      if (isMissing(error)) {
        throw new Error(`clean: external bindings are unavailable for symlink output: ${this.bindingsPath}`)
      }
      throw error
    }
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw new Error(`clean: external bindings must be a regular file: ${this.bindingsPath}`)
    }
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.bindingsPath, 'utf8'))
    } catch (error) {
      if (isMissing(error)) {
        throw new Error(`clean: external bindings are unavailable for symlink output: ${this.bindingsPath}`)
      }
      throw error
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`clean: invalid external bindings: ${this.bindingsPath}`)
    }
    const parsed = raw as Record<string, unknown>
    if (parsed.schema !== 'ecosystem-build-bindings.v1'
      || typeof parsed.source !== 'string'
      || !isStringRecord(parsed.artifacts)) {
      throw new Error(`clean: invalid external bindings: ${this.bindingsPath}`)
    }
    return {
      schema: 'ecosystem-build-bindings.v1',
      source: parsed.source,
      artifacts: parsed.artifacts,
    }
  }

  private async plan(): Promise<string[]> {
    const targets = new Set<string>()
    const unsafeOrphans: string[] = []
    const canonicalRoot = await realpath(this.root)

    await this.addIfPresent(targets, join(this.root, '.dsh-build'), canonicalRoot)
    await this.addIfPresent(targets, join(this.root, 'apps/desktop/.desktop-build'), canonicalRoot)

    // These checks cover legacy root-level incremental state emitted by older configs.
    await this.addIfPresent(targets, join(this.root, '.typecheck'), canonicalRoot)
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.tsbuildinfo')) {
        targets.add(join(this.root, entry.name))
      }
    }
    await this.addIfPresent(
      targets,
      join(this.root, 'native/system/tsconfig.tsbuildinfo'),
      canonicalRoot,
    )

    // The root project-reference graph is the source of truth for live build targets.
    // Each emitting project declares lib/types as outDir; its parent lib also owns
    // the sibling runtime bundles, so the complete build output root is removed.
    for (const outputDirectory of this.buildOutputDirectories()) {
      await this.addIfPresent(targets, outputDirectory, canonicalRoot)
    }

    for (const groupDirectory of await childDirectories(join(this.root, 'packages'))) {
      for (const packageDirectory of await childDirectories(groupDirectory)) {
        // A package.json marks a live package; its output was discovered from the
        // project graph above, and its package-local node_modules must be preserved.
        if (await exists(join(packageDirectory, 'package.json'))) {
          continue
        }

        // A manifest-less package directory is stale only when every remaining
        // entry is known generated residue; unknown files make the whole clean fail.
        const entries = await readdir(packageDirectory)
        const unknown = entries.filter(entry => !knownOrphanEntries.has(entry) && !entry.endsWith('.tsbuildinfo'))
        if (unknown.length > 0) {
          unsafeOrphans.push(...unknown.map(entry => repositoryPath(this.root, join(packageDirectory, entry))))
        } else {
          await this.addIfPresent(targets, packageDirectory, canonicalRoot)
        }
      }
    }

    if (unsafeOrphans.length > 0) {
      throw new Error([
        'clean: refusing to remove package directories without package.json; unknown entries remain:',
        ...unsafeOrphans.sort().map(path => `  ${path}`),
      ].join('\n'))
    }

    return [...targets].sort()
  }

  private buildOutputDirectories(): string[] {
    const outputs = new Set<string>()
    const pending = [join(this.root, 'tsconfig.json')]
    const visited = new Set<string>()
    const nativeEntryOutput = join(this.root, 'native/system/packages/entry/lib')

    while (pending.length > 0) {
      const nextConfigPath = pending.pop()
      if (nextConfigPath === undefined) break
      const configPath = resolve(nextConfigPath)
      if (visited.has(configPath)) continue
      visited.add(configPath)

      const parsed = parseConfig(configPath)
      if (parsed.options.outDir !== undefined) {
        const typesDirectory = resolve(parsed.options.outDir)
        const outputDirectory = basename(typesDirectory) === 'types'
          ? dirname(typesDirectory)
          : typesDirectory === nativeEntryOutput
            ? typesDirectory
            : undefined
        if (outputDirectory === undefined) {
          throw new Error(`clean: expected TypeScript outDir to end in /types: ${repositoryPath(this.root, typesDirectory)}`)
        }
        this.assertRepositoryTarget(outputDirectory)
        outputs.add(outputDirectory)
      }

      for (const reference of parsed.projectReferences ?? []) {
        pending.push(ts.resolveProjectReferencePath(reference))
      }
    }

    return [...outputs]
  }

  private assertRepositoryTarget(path: string): void {
    this.assertDescendant(this.root, path, path)
  }

  private assertDescendant(root: string, path: string, displayPath: string): void {
    const repositoryRelative = relative(root, path)
    if (repositoryRelative === '' || repositoryRelative === '..' || repositoryRelative.startsWith(`..${sep}`) || isAbsolute(repositoryRelative)) {
      throw new Error(`clean: refusing deletion target outside repository: ${displayPath}`)
    }
  }

  private async addIfPresent(targets: Set<string>, path: string, canonicalRoot: string): Promise<void> {
    // Missing outputs are normal on a clean checkout; only existing paths become deletion targets.
    if (!await exists(path)) return
    // Resolve the parent rather than the final entry: rm unlinks a final symlink,
    // but a symlink in an ancestor would make deletion cross the repository boundary.
    const canonicalParent = await realpath(dirname(path))
    this.assertDescendant(canonicalRoot, join(canonicalParent, basename(path)), path)
    targets.add(path)
  }
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    const removed = await new RepositoryCleaner(resolve(dirname(scriptPath), '..')).clean()
    if (removed.length === 0) {
      console.log('clean: already clean')
    } else {
      console.log(`clean: removed ${removed.length} paths`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
