/** Pack one workspace package while materializing only its declared distribution files. */

import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { globSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { tarballName, type ReleaseMember } from './families.ts'
import { capture, isEntry, pnpmCommand, runConcurrent } from './process.ts'

interface BuildBindings {
  schema: 'ecosystem-build-bindings.v1'
  source: string
  artifacts: Record<string, string>
}

interface DryRunPack {
  files: readonly { path: string }[]
}

interface PackageOutput {
  readonly path: string
  readonly target: string
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === 'string')
}

function repositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function readBuildBindings(root: string): { path: string; value: BuildBindings } | undefined {
  const volume = process.env.ECO_BUILD_VOLUME ?? '/Volumes/Mac Storage'
  const buildRoot = process.env.ECO_BUILD_ROOT ?? join(volume, 'agent-ecosystem-build')
  const identity = `${basename(root)}-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`
  const path = join(buildRoot, 'projects', identity, 'bindings.json')
  if (!existsSync(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`release pack: invalid external bindings: ${path}`)
  }
  const candidate = parsed as Record<string, unknown>
  if (candidate.schema !== 'ecosystem-build-bindings.v1'
    || candidate.source !== root
    || !isStringRecord(candidate.artifacts)) {
    throw new Error(`release pack: external bindings do not match the source root: ${path}`)
  }
  return {
    path,
    value: {
      schema: 'ecosystem-build-bindings.v1',
      source: root,
      artifacts: candidate.artifacts,
    },
  }
}

function declaredOutputRoots(member: ReleaseMember): Set<string> {
  const roots = new Set<string>()
  const files = member.manifest.files
  if (Array.isArray(files)) {
    for (const item of files) {
      if (typeof item !== 'string' || item.startsWith('!')) continue
      const normalized = item.replaceAll('\\', '/').replace(/^\.\//u, '')
      const first = normalized.split('/')[0]
      if (first !== undefined && first !== '' && !first.includes('*') && !first.includes('?')) roots.add(first)
    }
  }
  const addEntry = (entry: unknown): void => {
    if (typeof entry !== 'string') return
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//u, '')
    const first = normalized.split('/')[0]
    if (first !== undefined && first !== '' && !first.includes('*') && !first.includes('?')) roots.add(first)
  }
  addEntry(member.manifest.main)
  addEntry(member.manifest.types)
  addEntry(member.manifest.typings)
  const bin = member.manifest.bin
  if (typeof bin === 'string') addEntry(bin)
  else if (bin !== null && typeof bin === 'object') {
    for (const value of Object.values(bin)) addEntry(value)
  }
  const visitExports = (value: unknown): void => {
    if (typeof value === 'string') addEntry(value)
    else if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) visitExports(child)
    }
  }
  visitExports(member.manifest.exports)
  return roots
}

function workspaceVersions(root: string): Map<string, string> {
  const versions = new Map<string, string>()
  const manifests = globSync([
    'packages/*/*/package.json',
    'apps/*/package.json',
    'vendor/*/package.json',
    'native/system/package.json',
    'native/system/packages/*/package.json',
  ], { cwd: root })
  for (const path of manifests) {
    const manifest: unknown = JSON.parse(readFileSync(join(root, path), 'utf8'))
    if (manifest === null || typeof manifest !== 'object') continue
    const packageManifest = manifest as Record<string, unknown>
    if (typeof packageManifest.name === 'string' && typeof packageManifest.version === 'string') {
      versions.set(packageManifest.name, packageManifest.version)
    }
  }
  return versions
}

function normalizeWorkspaceDependencies(manifest: Record<string, unknown>, versions: ReadonlyMap<string, string>): void {
  for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const section = manifest[sectionName]
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue
    const dependencies = section as Record<string, unknown>
    for (const [name, rawRange] of Object.entries(section)) {
      if (typeof rawRange !== 'string' || !rawRange.startsWith('workspace:')) continue
      const version = versions.get(name)
      if (version === undefined) throw new Error(`release pack: cannot resolve ${name} ${rawRange}`)
      const range = rawRange.slice('workspace:'.length)
      dependencies[name] = range === '*'
        ? version
        : range === '^' || range === '~'
          ? `${range}${version}`
          : range
    }
  }
}

function copyRegularFile(source: string, destination: string): void {
  const info = statSync(source)
  if (!info.isFile()) throw new Error(`release pack: selected payload is not a regular file: ${source}`)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  chmodSync(destination, info.mode & 0o777)
}

function copyOutputTree(source: string, destination: string, outputRoot: string): void {
  const canonicalRoot = realpathSync(outputRoot)
  const canonicalSource = realpathSync(source)
  const sourceRelative = relative(canonicalRoot, canonicalSource)
  if (sourceRelative === '..' || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)) {
    throw new Error(`release pack: external output resolves outside its artifact root: ${source}`)
  }
  const info = lstatSync(source)
  if (info.isSymbolicLink()) throw new Error(`release pack: refusing nested output symlink: ${source}`)
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: info.mode & 0o777 })
    chmodSync(destination, info.mode & 0o777)
    for (const name of readdirSync(source)) copyOutputTree(join(source, name), join(destination, name), outputRoot)
    return
  }
  if (!info.isFile()) throw new Error(`release pack: refusing special output entry: ${source}`)
  copyRegularFile(source, destination)
}

function copyLifecycleAssets(root: string, packageRoot: string, stageRoot: string, member: ReleaseMember): void {
  const scripts = member.manifest.scripts
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return
  for (const hook of ['prepack', 'prepare', 'postpack']) {
    const command = (scripts as Record<string, unknown>)[hook]
    if (command === undefined) continue
    if (typeof command !== 'string') throw new Error(`release pack: ${member.name} has an invalid ${hook} script`)
    const match = /^\s*node\s+((?:\.\.?\/)+[^\s]+)\s*$/u.exec(command)
    if (match === null) {
      throw new Error(`release pack: external staging cannot reproduce ${hook} for ${member.name}: ${command}`)
    }
    const scriptSpecifier = match[1]
    if (scriptSpecifier === undefined) throw new Error(`release pack: ${hook} script has no Node entry for ${member.name}`)
    const scriptPath = resolve(packageRoot, scriptSpecifier)
    const scriptRelative = relative(root, scriptPath)
    if (scriptRelative === '..' || scriptRelative.startsWith(`..${sep}`) || isAbsolute(scriptRelative)) {
      throw new Error(`release pack: ${hook} script leaves the workspace for ${member.name}: ${command}`)
    }
    copyRegularFile(scriptPath, join(stageRoot, scriptRelative))
  }
}

function externalPackageOutputs(
  root: string,
  member: ReleaseMember,
  bindings: { path: string; value: BuildBindings } | undefined,
): PackageOutput[] {
  const memberPath = resolve(root, member.directory)
  const selectedRoots = declaredOutputRoots(member)
  const packageRelative = repositoryPath(root, memberPath)
  const outputs: PackageOutput[] = []
  for (const name of selectedRoots) {
    const sourcePath = join(memberPath, name)
    let info
    try {
      info = lstatSync(sourcePath)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    if (!info.isSymbolicLink()) continue
    const key = `${packageRelative}/${name}`
    if (bindings === undefined) {
      throw new Error(`release pack: external build bindings are required for published output symlink: ${key}`)
    }
    const declaredTarget = bindings.value.artifacts[key]
    if (declaredTarget === undefined) {
      throw new Error(`release pack: published output symlink has no external binding: ${key}`)
    }
    const target = resolve(declaredTarget)
    if (realpathSync(sourcePath) !== realpathSync(target)) {
      throw new Error(`release pack: published output binding target changed: ${key}`)
    }
    const projectRoot = dirname(bindings.path)
    const targetRelative = relative(projectRoot, target)
    if (targetRelative === '' || targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
      throw new Error(`release pack: published output is outside the external project root: ${key}`)
    }
    const [sourceStat, targetStat] = [statSync(root), statSync(target)]
    if (sourceStat.dev === targetStat.dev) throw new Error(`release pack: published output is not external to the source: ${key}`)
    outputs.push({ path: name, target })
  }
  return outputs
}

function parsePackDryRun(output: string, member: ReleaseMember): DryRunPack {
  let start = output.lastIndexOf('{')
  while (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(output.slice(start))
      if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as DryRunPack).files)) {
        return parsed as DryRunPack
      }
    } catch {
      // A lifecycle hook may print before pnpm's JSON; search for its outer object.
    }
    start = output.lastIndexOf('{', start - 1)
  }
  throw new Error(`release pack: pnpm returned no valid dry-run file list for ${member.name}`)
}

/**
 * Resolve the metadata workspace used to schedule packages with external output bindings.
 * @param root - Internal workspace source root.
 * @param members - Selected release members whose manifests must match the metadata workspace.
 * @returns The external workspace path, or undefined when the members use ordinary local outputs.
 */
export function externalReleaseWorkspace(root: string, members: readonly ReleaseMember[]): string | undefined {
  const bindings = readBuildBindings(root)
  if (!members.some(member => externalPackageOutputs(root, member, bindings).length > 0)) return undefined
  if (bindings === undefined) throw new Error('release pack: external metadata workspace requires build bindings')
  const stage = join(dirname(bindings.path), 'install-stage')
  if (statSync(stage).dev !== statSync(dirname(bindings.path)).dev) {
    throw new Error('release pack: metadata workspace is not on the external build volume')
  }
  for (const member of members) {
    const relativeManifest = join(member.directory, 'package.json')
    if (!readFileSync(join(root, relativeManifest)).equals(readFileSync(join(stage, relativeManifest)))) {
      throw new Error(`release pack: metadata workspace differs from ${member.name}`)
    }
  }
  return stage
}

/** Pack one member, materializing its selected external build outputs into an external distribution stage when needed. */
export async function packReleaseMember(root: string, member: ReleaseMember, destination: string): Promise<void> {
  const commandPrefix = pnpmCommand()
  const packageRoot = resolve(root, member.directory)
  const bindings = readBuildBindings(root)
  const outputs = externalPackageOutputs(root, member, bindings)
  const packArgs = ['--dir', packageRoot, 'pack', '--pack-destination', destination]
  if (outputs.length === 0) {
    await runConcurrent(commandPrefix[0], [...commandPrefix.slice(1), ...packArgs])
    return
  }

  if (bindings === undefined) throw new Error(`release pack: external build bindings are required for ${member.name}`)
  const stageRoot = mkdtempSync(join(tmpdir(), 'dsh-release-package-'))
  const stagePackageRoot = resolve(stageRoot, member.directory)
  const stagePackageRelative = relative(stageRoot, stagePackageRoot)
  if (stagePackageRelative === '..' || stagePackageRelative.startsWith(`..${sep}`) || isAbsolute(stagePackageRelative)) {
    throw new Error(`release pack: staged package path leaves the distribution stage: ${member.directory}`)
  }
  try {
    if (statSync(stageRoot).dev !== statSync(dirname(bindings.path)).dev) {
      throw new Error(`release pack: distribution stage must be on the external build volume: ${stageRoot}`)
    }
    const dryRunText = capture(commandPrefix[0], [...commandPrefix.slice(1), '--dir', packageRoot, 'pack', '--dry-run', '--json'], { cwd: root })
    const dryRun = parsePackDryRun(dryRunText, member)
    for (const file of dryRun.files) {
      if (typeof file.path !== 'string' || file.path === '' || isAbsolute(file.path)) {
        throw new Error(`release pack: pnpm returned an unsafe packed path for ${member.name}`)
      }
      const sourcePath = resolve(packageRoot, file.path)
      const packageRelative = relative(packageRoot, sourcePath)
      if (packageRelative === '..' || packageRelative.startsWith(`..${sep}`) || isAbsolute(packageRelative)) {
        throw new Error(`release pack: pnpm returned a path outside ${member.name}: ${file.path}`)
      }
      if (packageRelative.split(sep).some(part => part === '.git' || part === 'node_modules')) {
        throw new Error(`release pack: pnpm selected non-distribution files for ${member.name}: ${file.path}`)
      }
      const sharedLicense = packageRelative === 'LICENSE' || packageRelative === 'LICENCE' || packageRelative === 'COPYING'
      const payloadSource = existsSync(sourcePath) ? sourcePath : sharedLicense ? join(root, packageRelative) : sourcePath
      copyRegularFile(payloadSource, join(stagePackageRoot, packageRelative))
    }

    copyLifecycleAssets(root, packageRoot, stageRoot, member)

    const stagedManifestPath = join(stagePackageRoot, 'package.json')
    const manifest = JSON.parse(readFileSync(stagedManifestPath, 'utf8')) as Record<string, unknown>
    normalizeWorkspaceDependencies(manifest, workspaceVersions(root))
    writeFileSync(stagedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    for (const output of outputs) {
      copyOutputTree(output.target, join(stagePackageRoot, output.path), output.target)
    }

    const outputRoot = resolve(destination)
    mkdirSync(outputRoot, { recursive: true })
    if (statSync(outputRoot).dev !== statSync(dirname(bindings.path)).dev) {
      throw new Error(`release pack: package tarballs must be written on the external build volume: ${outputRoot}`)
    }
    const stagedArgs = ['--dir', stagePackageRoot, 'pack', '--pack-destination', outputRoot]
    await runConcurrent(commandPrefix[0], [...commandPrefix.slice(1), ...stagedArgs], { cwd: root })
  } finally {
    rmSync(stageRoot, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { member: { type: 'string' }, root: { type: 'string' }, 'stage-root': { type: 'string' }, out: { type: 'string' } },
    allowPositionals: false,
  })
  if ((values.member === undefined && values.root === undefined) || values.out === undefined) {
    throw new Error('usage: pack-member.ts [--root <workspace root>] [--member <workspace package path>] --out <external output directory>')
  }
  const root = resolve(values.root ?? process.cwd())
  const stageRoot = values['stage-root'] === undefined ? undefined : resolve(values['stage-root'])
  const currentPackage = stageRoot === undefined ? process.cwd() : resolve(root, relative(stageRoot, process.cwd()))
  const packageRoot = values.member === undefined ? currentPackage : resolve(root, values.member)
  const packageRelative = relative(root, packageRoot)
  if (packageRelative === '..' || packageRelative.startsWith(`..${sep}`) || isAbsolute(packageRelative)) {
    throw new Error(`release pack: member must be inside the workspace: ${values.member}`)
  }
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`release pack: ${packageRelative} must declare name and version`)
  }
  const member: ReleaseMember = {
    directory: repositoryPath(root, packageRoot),
    name: manifest.name,
    version: manifest.version,
    manifest,
  }
  await packReleaseMember(root, member, resolve(root, values.out))
  console.log(tarballName(member))
}

if (isEntry(import.meta.url)) await main()
