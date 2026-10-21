import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'

const temporaryRoots: string[] = []
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; trusted: string } {
  const root = mkdtempSync(join(tmpdir(), 'typert-external-registration-'))
  temporaryRoots.push(root)
  cpSync(resolve(import.meta.dirname, 'fixtures/remote-model'), root, { recursive: true })
  const trusted = join(root, 'trusted-packages')
  const protocol = join(trusted, 'protocol')
  mkdirSync(join(protocol, 'src'), { recursive: true })
  const ambient = readFileSync(join(root, 'typert-protocol.d.ts'), 'utf8')
  writeFileSync(join(protocol, 'src/index.d.ts'), ambient.slice(ambient.indexOf('\n') + 1, ambient.lastIndexOf('}')))
  writeFileSync(join(protocol, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol', exports: { '.': './src/index.d.ts' } }))
  writeFileSync(join(protocol, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json', include: ['src'] }))
  const config = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8'))
  config.compilerOptions.paths['@deepseek-ai/dsh-typert-protocol'] = ['./trusted-packages/protocol/src/index.d.ts']
  writeFileSync(join(root, 'tsconfig.base.json'), JSON.stringify(config))
  const aggregate = JSON.parse(readFileSync(join(root, 'tsconfig.host.json'), 'utf8'))
  aggregate.references.push({ path: './trusted-packages/protocol' })
  writeFileSync(join(root, 'tsconfig.host.json'), JSON.stringify(aggregate))
  renameSync(join(root, 'tsconfig.host.json'), join(root, 'external.host.json'))
  return { root, trusted }
}

describe('explicit additional package roots', { timeout: 60_000 }, () => {
  it('discovers the referenced external protocol only with an explicit trusted root and aggregate', () => {
    const { root, trusted } = fixture()
    const without = new WorkspaceTypertGenerator(root, { hostConfig: 'external.host.json' }).generate(['@fixture/remote'], ['host'])
    expect(without[0]?.remote).toBeUndefined()
    const withRoot = new WorkspaceTypertGenerator(root, { hostConfig: 'external.host.json', additionalPackageRoots: [trusted] })
      .generate(['@fixture/remote'], ['host'])
    expect(withRoot).toHaveLength(1)
    expect(withRoot[0]?.remote?.js).toContain('TYPERT_REMOTE')
    expect(withRoot[0]?.remote?.dts).toContain('TypertRemoteMethod')
  })

  it('rejects conflicting package identities across trusted references', () => {
    const { root, trusted } = fixture()
    cpSync(join(trusted, 'protocol'), join(trusted, 'other-protocol'), { recursive: true })
    const path = join(root, 'external.host.json')
    const aggregate = JSON.parse(readFileSync(path, 'utf8'))
    aggregate.references.push({ path: './trusted-packages/other-protocol' })
    writeFileSync(path, JSON.stringify(aggregate))
    expect(() => new WorkspaceTypertGenerator(root, { hostConfig: 'external.host.json', additionalPackageRoots: [trusted] })
      .generate(['@fixture/remote'], ['host'])).toThrow('conflicting roots')
  })

  it('keeps strict Remote JSON diagnostics for a referenced external protocol', () => {
    const { root, trusted } = fixture()
    const path = join(root, 'packages/remote/src/types.ts')
    writeFileSync(path, readFileSync(path, 'utf8').replace('readonly title: string', 'readonly title: bigint'))
    expect(() => new WorkspaceTypertGenerator(root, { hostConfig: 'external.host.json', additionalPackageRoots: [trusted] })
      .generate(['@fixture/remote'], ['host'])).toThrow('bigint')
  })
})
