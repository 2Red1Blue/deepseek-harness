/** Resolve disposable VitePress paths and validate an explicitly external output root. */

import { existsSync, lstatSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Build-only VitePress paths; canonical Markdown remains in the repository. */
export interface WebsiteBuildPaths {
  /** Disposable projected Markdown tree. */
  generatedRoot: string
  /** VitePress dependency and transform cache. */
  cacheDir: string
  /** Rendered site and raw-Markdown output. */
  outDir: string
  /** Explicit external output root, when configured. */
  externalOutputRoot?: string
}

function contains(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

/**
 * Resolve disposable website paths without changing the default local layout.
 * @param siteRoot - source directory containing `.vitepress/`.
 * @param externalOutputRoot - optional external root for generated Markdown, cache, and built site.
 * @returns Absolute generated, cache, and output paths.
 * @throws When the explicit root is relative or overlaps the website source tree.
 */
export function resolveWebsiteBuildPaths(siteRoot: string, externalOutputRoot?: string): WebsiteBuildPaths {
  const sourceRoot = resolve(siteRoot)
  if (externalOutputRoot === undefined) {
    return {
      generatedRoot: join(sourceRoot, '.generated'),
      cacheDir: join(sourceRoot, '.cache'),
      outDir: join(sourceRoot, '.dist'),
    }
  }
  if (!isAbsolute(externalOutputRoot)) {
    throw new Error('website/build-paths: DSH_DOCS_OUTPUT_ROOT must be absolute')
  }
  const outputRoot = resolve(externalOutputRoot)
  if (contains(sourceRoot, outputRoot) || contains(outputRoot, sourceRoot)) {
    throw new Error('website/build-paths: external output root must not overlap the website source tree')
  }
  return {
    generatedRoot: join(outputRoot, '.generated'),
    cacheDir: join(outputRoot, '.cache'),
    outDir: join(outputRoot, '.dist'),
    externalOutputRoot: outputRoot,
  }
}

/**
 * Ensure an explicit docs output root is outside the source tree and on another mounted device.
 * @param siteRoot - source directory containing `.vitepress/`.
 * @param externalOutputRoot - existing output root on the external build volume.
 * @throws When either path cannot resolve, the roots overlap, or both paths use one device.
 */
export function assertExternalWebsiteBuildRoot(siteRoot: string, externalOutputRoot: string): void {
  const sourceRoot = realpathSync(resolve(siteRoot))
  const outputRoot = realpathSync(resolve(externalOutputRoot))
  if (contains(sourceRoot, outputRoot) || contains(outputRoot, sourceRoot)) {
    throw new Error('website/build-paths: external output root resolves into the website source tree')
  }
  if (statSync(sourceRoot).dev === statSync(outputRoot).dev) {
    throw new Error('website/build-paths: external output root must use a different mounted device')
  }
}

/**
 * Expose the source dependency tree to Markdown projected outside the repository.
 * @param siteRoot - source directory containing `.vitepress/`.
 * @param externalOutputRoot - validated external root for website build outputs.
 * @throws When the source dependency tree is missing or the output root already owns another `node_modules` path.
 */
export function bindWebsiteBuildDependencies(siteRoot: string, externalOutputRoot: string): void {
  const sourceDependencies = resolve(siteRoot, '..', 'node_modules')
  const outputDependencies = join(resolve(externalOutputRoot), 'node_modules')
  const existing = lstatSync(outputDependencies, { throwIfNoEntry: false })
  if (existing !== undefined) {
    if (existing.isSymbolicLink() && existsSync(sourceDependencies)
      && realpathSync(outputDependencies) === realpathSync(sourceDependencies)) return
    throw new Error('website/build-paths: external output root already contains another node_modules path')
  }
  if (!existsSync(sourceDependencies)) throw new Error('website/build-paths: source node_modules is missing')
  symlinkSync(sourceDependencies, outputDependencies, 'dir')
}
