/** Production documentation-site build with project-owned output preparation. */

import { lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vitepress'
import { assertExternalWebsiteBuildRoot, resolveWebsiteBuildPaths } from './build-paths.ts'

const websiteRoot = resolve(import.meta.dirname)
type DocSiteBuildOptions = NonNullable<Parameters<typeof build>[1]>

function escapesRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)
}

function nearestExistingAncestor(path: string): string {
  let ancestor = path
  for (;;) {
    if (lstatSync(ancestor, { throwIfNoEntry: false }) !== undefined) return ancestor
    const parent = dirname(ancestor)
    if (parent === ancestor) {
      throw new Error(`website/build: no existing ancestor found for ${JSON.stringify(path)}.`)
    }
    ancestor = parent
  }
}

/**
 * Remove one documentation build output without traversing a link-shaped output or an outside parent.
 * @param siteRoot - VitePress site root that owns the output.
 * @param outDir - Resolved VitePress output directory.
 * @param externalOutputRoot - optional external root that owns `outDir`.
 * @throws When `outDir` is not a proper child of its owning root or its existing parent resolves outside it.
 */
export function cleanDocSiteOutput(siteRoot: string, outDir: string, externalOutputRoot?: string): void {
  const root = resolve(siteRoot)
  const output = resolve(outDir)
  const allowedRoot = externalOutputRoot === undefined ? root : resolve(externalOutputRoot)
  const allowedRootLabel = externalOutputRoot === undefined ? 'site root' : 'output root'
  const child = relative(allowedRoot, output)
  if (child === '' || escapesRoot(allowedRoot, output)) {
    throw new Error(`website/build: output directory ${JSON.stringify(output)} must be a child of ${allowedRootLabel} ${JSON.stringify(allowedRoot)}.`)
  }

  const realAllowedRoot = realpathSync(allowedRoot)
  const realParent = realpathSync(nearestExistingAncestor(dirname(output)))
  if (escapesRoot(realAllowedRoot, realParent)) {
    throw new Error(`website/build: output directory ${JSON.stringify(output)} must resolve inside ${allowedRootLabel} ${JSON.stringify(realAllowedRoot)}.`)
  }

  const outputStats = lstatSync(output, { throwIfNoEntry: false })
  if (outputStats?.isSymbolicLink()) {
    unlinkSync(output)
    return
  }
  rmSync(output, { recursive: true, force: true })
}

/**
 * Create VitePress build options that remove the resolved output directory before bundling.
 * @param siteRoot - VitePress site root to build.
 * @param mpa - Whether to use VitePress's multi-page application build.
 * @param externalOutputRoot - optional external root for generated website files.
 * @returns VitePress options with project-owned output preparation.
 */
export function docSiteBuildOptions(siteRoot: string, mpa: boolean, externalOutputRoot?: string): DocSiteBuildOptions {
  const root = resolve(siteRoot)
  const paths = resolveWebsiteBuildPaths(root, externalOutputRoot)
  if (paths.externalOutputRoot !== undefined) {
    assertExternalWebsiteBuildRoot(root, paths.externalOutputRoot)
  }
  return {
    ...mpa ? { mpa: 'true' } : {},
    outDir: paths.outDir,
    onAfterConfigResolve(siteConfig) {
      cleanDocSiteOutput(root, siteConfig.outDir, paths.externalOutputRoot)
    },
  }
}

async function buildDocSite(siteRoot: string, mpa: boolean): Promise<void> {
  const root = resolve(siteRoot)
  await build(root, docSiteBuildOptions(root, mpa, process.env.DSH_DOCS_OUTPUT_ROOT))
}

function parseMpa(args: string[]): boolean {
  if (args.length === 0) return false
  if (args.length === 1 && args[0] === '--mpa') return true
  throw new Error(`website/build: expected no arguments or --mpa, got ${JSON.stringify(args)}.`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await buildDocSite(websiteRoot, parseMpa(process.argv.slice(2)))
}
