/** Published PDF and spreadsheet chunks retain their bundled license notices. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const bundlePath = join(packageRoot, 'lib/client.js')
const pdfChunkPath = join(packageRoot, 'lib/client.pdf.js')
const require = createRequire(import.meta.url)
const licenseNames = [
  'LICENSE',
  'cmaps/LICENSE',
  'standard_fonts/LICENSE_FOXIT',
  'standard_fonts/LICENSE_LIBERATION',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS',
] as const

function run(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

describe('published document preview licenses', () => {
  it.skipIf(!existsSync(bundlePath))('keeps bundled licenses in the packed lazy chunks', async ({ task }) => {
    expect(existsSync(pdfChunkPath)).toBe(true)
    const output = mkdtempSync(join(tmpdir(), 'dsh-document-preview-pack-'))
    try {
      const repositoryRoot = resolve(packageRoot, '../../..')
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>
      expect(typeof manifest.name).toBe('string')
      expect(typeof manifest.version).toBe('string')
      const member = {
        directory: relative(repositoryRoot, packageRoot).replaceAll('\\', '/'),
        name: manifest.name as string,
        version: manifest.version as string,
      }
      const packScript = resolve(repositoryRoot, 'scripts/release/pack-member.ts')
      const packResult = run(process.execPath, [
        '--import', 'tsx/esm', packScript,
        '--member', member.directory,
        '--out', output,
      ], repositoryRoot, task.timeout)
      const filename = packResult.trim().split(/\r?\n/u).at(-1)
      expect(filename).toBeTruthy()
      const tarball = resolve(output, filename!)
      const packedFiles = run('tar', ['-tzf', tarball], output, task.timeout)
        .trim()
        .split(/\r?\n/u)
        .map(path => path.replace(/^package\//u, ''))
      expect(packedFiles).toContain('lib/client.js')
      expect(packedFiles).toContain('lib/client.pdf.js')
      expect(packedFiles).toContain('lib/client.frontmatter-fields.js')
      expect(packedFiles.some(path => path.endsWith('pdfjs-NOTICES.txt'))).toBe(false)
      expect(packedFiles.some(path => path.startsWith('src/'))).toBe(false)
      expect(packedFiles.some(path => path.split('/').includes('.git') || path.split('/').includes('node_modules'))).toBe(false)
      const packedManifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json'], output, task.timeout)) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      const schemastery = JSON.parse(readFileSync(resolve(repositoryRoot, 'vendor/schemastery/package.json'), 'utf8')) as { version: string }
      expect(packedManifest.dependencies?.['@deepseek-ai/schemastery']).toBe(`~${schemastery.version}`)
      for (const dependencies of [
        packedManifest.dependencies,
        packedManifest.devDependencies,
        packedManifest.optionalDependencies,
        packedManifest.peerDependencies,
      ]) {
        expect(Object.values(dependencies ?? {}).some(range => range.startsWith('workspace:'))).toBe(false)
      }

      const client = run('tar', ['-xOf', tarball, 'package/lib/client.js'], output, task.timeout)
      const pdf = run('tar', ['-xOf', tarball, 'package/lib/client.pdf.js'], output, task.timeout)
      expect([...client.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual(['./client.frontmatter-fields.js', './client.pdf.js', './client.excel.js'])
      expect(client).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect([...pdf.matchAll(/require\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual([])
      expect(client).not.toContain('//! Bundled PDF.js license notices')
      expect(client).not.toContain('/pdfjs-dist/')
      expect(pdf).toContain('//! Bundled PDF.js license notices')
      const excel = run('tar', ['-xOf', tarball, 'package/lib/client.excel.js'], output, task.timeout)
      expect(excel).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect(client).not.toContain('FortuneSheet')
      expect(excel).toContain('//! Bundled spreadsheet license notices')
      expect(excel).toContain('Copyright (c) 2022 Suzhou Ruilisi Technology Co., Ltd')
      expect(excel).toContain('Permission is hereby granted, free of charge')
      for (const dependency of ['xlsx', 'papaparse']) {
        const root = dirname(require.resolve(dependency === 'xlsx' ? dependency : `${dependency}/package.json`))
        const license = readFileSync(join(root, 'LICENSE'), 'utf8').trimEnd()
        expect(excel).toContain(license.split('\n').map(line => `// ${line}`).join('\n'))
      }
      const frontmatter = run('tar', ['-xOf', tarball, 'package/lib/client.frontmatter-fields.js'], output, task.timeout)
      expect(frontmatter).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      let frontmatterInitialized = false
      runInNewContext(frontmatter, { window: { __ModuleLoader__: { load: (registration: {
        factory: (resolve: (specifier: string) => unknown) => { FrontmatterFields: unknown }
      }) => {
        const loaded = registration.factory((specifier) => {
          if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier)
          throw new Error(`Unexpected browser dependency: ${specifier}`)
        })
        expect(typeof loaded.FrontmatterFields).toBe('function')
        frontmatterInitialized = true
      } } } })
      expect(frontmatterInitialized).toBe(true)
      let initialized = false
      runInNewContext(excel, { window: { __ModuleLoader__: { load: (registration: {
        factory: (resolve: (specifier: string) => unknown) => { ExcelBody: unknown }
      }) => {
        const loaded = registration.factory((specifier) => {
          if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}
          if (specifier === 'react' || specifier === 'react/jsx-runtime' || specifier === 'react-dom') return require(specifier)
          throw new Error(`Unexpected browser dependency: ${specifier}`)
        })
        expect(typeof loaded.ExcelBody).toBe('function')
        initialized = true
      } } } })
      expect(initialized).toBe(true)
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
      for (const name of licenseNames) {
        const source = readFileSync(join(pdfRoot, name), 'utf8').trimEnd()
        const commented = [`// ${name}`, '// ', ...source.split('\n').map(line => `// ${line}`)].join('\n')
        expect(pdf, `${name} must be visible in package/lib/client.pdf.js`).toContain(commented)
      }
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  }, 60_000)
})
