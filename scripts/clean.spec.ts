import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { RepositoryCleaner } from './clean.ts'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-clean-'))
  roots.push(root)
  return root
}

function externalFixture(): string {
  const base = '/Volumes/Mac Storage/agent-ecosystem-build/tmp'
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'dsh-clean-'))
  roots.push(root)
  return root
}

function internalFixture(): string {
  const root = mkdtempSync(join('/private/tmp', 'dsh-clean-source-'))
  roots.push(root)
  return root
}

const hasExternalBuildVolume = (() => {
  try {
    return statSync('/Volumes/Mac Storage').dev !== statSync('/private/tmp').dev
  } catch {
    return false
  }
})()

function write(path: string, content = ''): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function addProject(root: string, path: string, outDir = 'lib/types'): void {
  write(join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path }] }))
  write(join(root, path, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { composite: true, outDir },
    include: ['src'],
  }))
  write(join(root, path, 'src/index.ts'), 'export {}\n')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RepositoryCleaner', () => {
  it('derives live build outputs from project references and removes safe stale package residue', async () => {
    const root = fixture()
    addProject(root, 'products/shell')
    write(join(root, 'products/shell/lib/types/index.js'))
    write(join(root, 'products/shell/lib/index.js'))
    write(join(root, '.typecheck/legacy.tsbuildinfo'))
    write(join(root, '.dsh-build/client-build-environment.json'))
    write(join(root, 'apps/desktop/renderer/assets/welcome-brand.svg'))
    write(join(root, 'apps/desktop/renderer/assets/welcome-loading.svg'))
    write(join(root, 'apps/desktop/renderer/welcome.css'))
    write(join(root, 'root.tsbuildinfo'))
    write(join(root, 'packages/removed/ghost/node_modules/.bin/tool'))

    await new RepositoryCleaner(root).clean()

    expect(existsSync(join(root, 'products/shell/lib'))).toBe(false)
    expect(existsSync(join(root, 'products/shell/src/index.ts'))).toBe(true)
    expect(existsSync(join(root, '.typecheck'))).toBe(false)
    expect(existsSync(join(root, '.dsh-build'))).toBe(false)
    expect(existsSync(join(root, 'apps/desktop/renderer/assets/welcome-brand.svg'))).toBe(true)
    expect(existsSync(join(root, 'apps/desktop/renderer/assets/welcome-loading.svg'))).toBe(true)
    expect(existsSync(join(root, 'apps/desktop/renderer/welcome.css'))).toBe(true)
    expect(existsSync(join(root, 'root.tsbuildinfo'))).toBe(false)
    expect(existsSync(join(root, 'packages/removed/ghost'))).toBe(false)
  })

  it('does not delete any target when a manifest-less package contains an unknown file', async () => {
    const root = fixture()
    addProject(root, 'products/shell')
    write(join(root, 'products/shell/lib/types/index.js'))
    write(join(root, 'packages/removed/ghost/notes.txt'))

    await expect(new RepositoryCleaner(root).clean()).rejects.toThrow('packages/removed/ghost/notes.txt')
    expect(existsSync(join(root, 'products/shell/lib'))).toBe(true)
  })

  it('removes the native Landlock entry output and solution build info', async () => {
    const root = fixture()
    const entry = 'native/system/packages/entry'
    addProject(root, entry, 'lib')
    write(join(root, entry, 'lib/index.js'))
    write(join(root, 'native/system/tsconfig.tsbuildinfo'))

    await new RepositoryCleaner(root).clean()

    expect(existsSync(join(root, entry, 'lib'))).toBe(false)
    expect(existsSync(join(root, entry, 'src/index.ts'))).toBe(true)
    expect(existsSync(join(root, 'native/system/tsconfig.tsbuildinfo'))).toBe(false)
  })

  it('refuses project outputs reached through a symlink outside the repository', async () => {
    const root = fixture()
    const externalProject = fixture()
    write(join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './linked' }] }))
    write(join(externalProject, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { composite: true, outDir: 'lib/types' },
      include: ['src'],
    }))
    write(join(externalProject, 'src/index.ts'), 'export {}\n')
    write(join(externalProject, 'lib/types/index.js'))
    symlinkSync(externalProject, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(new RepositoryCleaner(root).clean()).rejects.toThrow('outside repository')

    expect(existsSync(join(externalProject, 'lib/types/index.js'))).toBe(true)
  })

  it.skipIf(!hasExternalBuildVolume)('clears bound external outputs while preserving source links', async () => {
    const root = internalFixture()
    const externalRoot = externalFixture()
    addProject(root, 'products/shell')
    const externalLib = join(externalRoot, 'artifacts/products/shell/lib')
    const sourceLib = join(root, 'products/shell/lib')
    write(join(externalLib, 'types/index.js'))
    symlinkSync(externalLib, sourceLib, 'dir')

    const externalBuildInfo = join(externalRoot, 'artifacts/root.tsbuildinfo')
    writeFileSync(externalBuildInfo, 'stale build state')
    symlinkSync(externalBuildInfo, join(root, 'root.tsbuildinfo'))

    const bindingsPath = join(externalRoot, 'bindings.json')
    writeFileSync(bindingsPath, JSON.stringify({
      schema: 'ecosystem-build-bindings.v1',
      source: root,
      artifacts: {
        'products/shell/lib': externalLib,
        'root.tsbuildinfo': externalBuildInfo,
      },
    }))

    await new RepositoryCleaner(root, bindingsPath).clean()

    expect(lstatSync(sourceLib).isSymbolicLink()).toBe(true)
    expect(readdirSync(externalLib)).toEqual([])
    expect(existsSync(join(root, 'products/shell/src/index.ts'))).toBe(true)
    expect(lstatSync(join(root, 'root.tsbuildinfo')).isSymbolicLink()).toBe(true)
    expect(readFileSync(externalBuildInfo, 'utf8')).toBe('')
  })

  it('refuses an unbound output symlink before deleting its target', async () => {
    const root = fixture()
    const externalRoot = fixture()
    addProject(root, 'products/shell')
    const externalLib = join(externalRoot, 'artifacts/products/shell/lib')
    const externalOutput = join(externalLib, 'types/index.js')
    const sourceLib = join(root, 'products/shell/lib')
    write(externalOutput, 'keep')
    symlinkSync(externalLib, sourceLib, 'dir')

    const bindingsPath = join(externalRoot, 'bindings.json')
    writeFileSync(bindingsPath, JSON.stringify({
      schema: 'ecosystem-build-bindings.v1',
      source: root,
      artifacts: {},
    }))

    await expect(new RepositoryCleaner(root, bindingsPath).clean()).rejects.toThrow('unbound symlink output')

    expect(lstatSync(sourceLib).isSymbolicLink()).toBe(true)
    expect(readFileSync(externalOutput, 'utf8')).toBe('keep')
  })
})
