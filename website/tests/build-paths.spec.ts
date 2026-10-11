import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertExternalWebsiteBuildRoot,
  bindWebsiteBuildDependencies,
  resolveWebsiteBuildPaths,
} from '../build-paths.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function siteTree(): { root: string; site: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'website-build-paths-'))
  roots.push(root)
  const site = join(root, 'website')
  const output = join(root, 'external', 'docs-build')
  mkdirSync(site, { recursive: true })
  mkdirSync(output, { recursive: true })
  return { root, site, output }
}

describe('VitePress build paths', () => {
  it('keeps the established local layout when no external root is configured', () => {
    const { site } = siteTree()
    expect(resolveWebsiteBuildPaths(site)).toEqual({
      generatedRoot: join(site, '.generated'),
      cacheDir: join(site, '.cache'),
      outDir: join(site, '.dist'),
    })
  })

  it('places projection, cache, and site output under the requested external root', () => {
    const { site, output } = siteTree()
    expect(resolveWebsiteBuildPaths(site, output)).toEqual({
      generatedRoot: join(output, '.generated'),
      cacheDir: join(output, '.cache'),
      outDir: join(output, '.dist'),
      externalOutputRoot: output,
    })
  })

  it('rejects relative or overlapping output roots before creating outputs', () => {
    const { site, output } = siteTree()
    expect(() => resolveWebsiteBuildPaths(site, 'docs-build')).toThrow('must be absolute')
    expect(() => resolveWebsiteBuildPaths(site, join(site, 'docs-build'))).toThrow('must not overlap')
    expect(() => resolveWebsiteBuildPaths(site, site)).toThrow('must not overlap')
    expect(() => { assertExternalWebsiteBuildRoot(site, output) }).toThrow('different mounted device')
  })

  it('links external Markdown resolution to the source dependency tree', () => {
    const { root, site, output } = siteTree()
    const sourceDependencies = join(root, 'node_modules')
    mkdirSync(sourceDependencies)
    bindWebsiteBuildDependencies(site, output)
    expect(realpathSync(join(output, 'node_modules'))).toBe(realpathSync(sourceDependencies))
    expect(() => { bindWebsiteBuildDependencies(site, output) }).not.toThrow()
  })

  it('does not replace an existing output dependency path', () => {
    const { site, output } = siteTree()
    const dependencies = join(output, 'node_modules')
    mkdirSync(dependencies)
    expect(() => { bindWebsiteBuildDependencies(site, output) }).toThrow('already contains another node_modules')
    expect(realpathSync(dependencies)).toBe(dependencies)
  })
})
