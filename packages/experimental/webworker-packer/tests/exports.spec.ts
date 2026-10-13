/** Runtime reachability ignores declaration-only export roots, not runtime requests. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { packVfsImage, type PackOptions } from '../src/pack.ts'

const SUBJECT = '@deepseek-ai/dsh-image-export-fixture'

function fixture(test: TestContext, face: unknown, source = 'export const value = 1'): PackOptions {
  const root = mkdtempSync(join(tmpdir(), 'dsh-image-exports-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: SUBJECT,
    type: 'module',
    files: ['lib'],
    exports: {
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      './contract': face,
    },
  }))
  writeFileSync(join(root, 'lib/index.js'), source)
  writeFileSync(join(root, 'lib/index.d.ts'), 'export declare const value: number')
  writeFileSync(join(root, 'lib/contract.js'), 'export const value = 2')
  return {
    config: `- id: subject\n  name: '${SUBJECT}'\n`,
    profile: 'export-check',
    workspaces: new Map([[SUBJECT, root]]),
    resolveFrom: root,
    entries: [],
  }
}

function boundFixture(
  test: TestContext,
  linkTarget: 'bound' | 'outside' = 'bound',
  declaredTarget: 'bound' | 'outside' = 'bound',
): PackOptions {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-image-bound-'))
  test.onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })
  const root = join(temporary, 'source')
  const packageRoot = join(root, 'packages/image-export-fixture')
  const output = join(temporary, 'build')
  const bound = join(output, 'artifacts/packages/image-export-fixture/lib')
  const outside = join(temporary, 'outside/lib')
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(bound, { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(join(output, 'install-stage/node_modules'), { recursive: true })
  symlinkSync(join(output, 'install-stage/node_modules'), join(root, 'node_modules'), 'dir')
  symlinkSync(linkTarget === 'bound' ? bound : outside, join(packageRoot, 'lib'), 'dir')
  writeFileSync(join(bound, 'index.js'), 'export const value = 7\n')
  writeFileSync(join(outside, 'index.js'), 'export const value = 9\n')
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: SUBJECT,
    type: 'module',
    files: ['lib'],
    exports: { '.': './lib/index.js' },
  }))
  writeFileSync(join(output, 'bindings.json'), JSON.stringify({
    schema: 'ecosystem-build-bindings.v1',
    source: realpathSync(root),
    artifacts: {
      'packages/image-export-fixture/lib': declaredTarget === 'bound' ? bound : outside,
    },
  }))
  return {
    config: `- id: subject\n  name: '${SUBJECT}'\n`,
    profile: 'external-lib-check',
    workspaces: new Map([[SUBJECT, packageRoot]]),
    resolveFrom: root,
    entries: [],
  }
}

it.for([
  { types: './lib/index.d.ts' },
  { 'types@>=5.2': './lib/index.d.ts' },
  { browser: { types: './lib/index.d.ts' } },
  [{ types: './lib/index.d.ts' }],
])('packs a declaration-only export without requesting a runtime entry: %j', (face, test) => {
  const result = packVfsImage(fixture(test, face))
  expect(result.missing).toEqual([])
  expect(Object.keys(result.files)).toContain(`node_modules/${SUBJECT}/lib/index.js`)
  expect(Object.keys(result.files)).not.toContain(`node_modules/${SUBJECT}/lib/index.d.ts`)
  expect(Object.keys(result.files)).not.toContain(`node_modules/${SUBJECT}/lib/contract.js`)
})

it.for([
  { types: './lib/index.d.ts', default: './lib/contract.js' },
  [{ types: './lib/index.d.ts' }, './lib/contract.js'],
])('retains the runtime target beside a types condition: %j', (face, test) => {
  const result = packVfsImage(fixture(test, face))
  expect(Object.keys(result.files)).toContain(`node_modules/${SUBJECT}/lib/contract.js`)
})

it('rejects a runtime import of a declaration-only export', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts' }, `export { value } from '${SUBJECT}/contract'`)
  expect(() => packVfsImage(options)).toThrow('does not export "./contract"')
})

it('rejects an assembly entry that requests a declaration-only export', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts' })
  expect(() => packVfsImage({ ...options, entries: [`${SUBJECT}/contract`] })).toThrow('worker assembly entry')
})

it('rejects a missing runtime target beside a types condition', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts', default: './lib/missing.js' })
  expect(() => packVfsImage(options)).toThrow('cannot resolve')
})

it('packs a package lib symlink only from its exact external project binding', (test) => {
  const result = packVfsImage(boundFixture(test))
  expect(result.missing).toEqual([])
  const packed = new TextDecoder().decode(result.files[`node_modules/${SUBJECT}/lib/index.js`])
  expect(packed).toContain('const value = 7')
  expect(packed).not.toContain('value = 9')
})

it('rejects a package lib symlink that leaves its declared artifact directory', (test) => {
  expect(() => packVfsImage(boundFixture(test, 'outside')))
    .toThrow('workspace lib symlink does not match its external build binding')
})

it('rejects a project binding whose target leaves the project artifact root', (test) => {
  expect(() => packVfsImage(boundFixture(test, 'outside', 'outside')))
    .toThrow('workspace lib binding escapes project artifacts')
})
