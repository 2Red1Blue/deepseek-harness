#!/usr/bin/env node
/**
 * Pack every published package into release tarballs, in publish order
 * (platform packages first, then the entries that optionally depend on
 * them), and write `publish-order.txt` next to them. `pnpm pack` produces
 * the EXACT bytes `pnpm publish` would upload and runs each package's
 * `prepack` gate, so a missing binary or unbuilt `lib/` refuses here.
 *
 * Usage: `node scripts/pack-release.mjs [dest] [--current-platform-only]`.
 * The flag packs only THIS host's platform package plus the entries — for
 * per-architecture CI legs, where the other architecture's binary does not
 * exist (the exact refusal its prepack gate exists for).
 * Workflow repository metadata is projected only into disposable pack inputs;
 * source manifests retain the public source home. See docs/packaging.md.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { entryDirs, platformDirs, readJson, root } from './repo.mjs';

const args = process.argv.slice(2);
const currentPlatformOnly = args.includes('--current-platform-only');
const destination = path.resolve(args.find((arg) => !arg.startsWith('--')) || path.join(root, 'dist', 'npm'));

function hostPlatformDirs() {
  const hostPlatform = `${process.platform}-${process.arch}`;
  return platformDirs().filter((dir) => readJson(path.join(root, dir, 'prebuilds.json')).platform === hostPlatform);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (status=${result.status}, signal=${result.signal})`);
  }
}

function tarballName(manifest) {
  if (manifest.name.startsWith('@')) {
    return `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`;
  }
  return `${manifest.name}-${manifest.version}.tgz`;
}

/** Repository identity npm verifies against the workflow's OIDC claims. */
function workflowRepositoryUrl() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository === undefined && process.env.GITHUB_ACTIONS !== 'true') return undefined;
  if (repository === undefined || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must identify the workflow owner/repository');
  }
  const server = new URL(process.env.GITHUB_SERVER_URL || 'https://github.com');
  if (server.protocol !== 'https:' || server.pathname !== '/' || server.search || server.hash
    || server.username || server.password) {
    throw new Error('GITHUB_SERVER_URL must be an HTTPS origin');
  }
  return `git+${server.origin}/${repository}.git`;
}


/** Bind only selected published output symlinks to their existing external owner. */
function externalPackageOutputs(dirs) {
  const harnessRoot = path.resolve(root, '../..');
  const buildRoot = process.env.ECO_BUILD_ROOT || (process.env.ECO_BUILD_VOLUME ? path.join(process.env.ECO_BUILD_VOLUME, 'agent-ecosystem-build') : undefined);
  const identity = `${path.basename(harnessRoot)}-${crypto.createHash('sha256').update(harnessRoot).digest('hex').slice(0, 12)}`;
  const bindingsPath = buildRoot === undefined ? undefined : path.join(buildRoot, 'projects', identity, 'bindings.json');
  let bindings;
  const outputs = [];
  for (const dir of dirs) {
    const manifest = readJson(path.join(root, dir, 'package.json'));
    const roots = new Set((manifest.files || []).filter((value) => !value.startsWith('!'))
      .map((value) => value.replace(/^\.\//u, '').split('/')[0]));
    for (const name of roots) {
      if (!name || ['.', '..', '.git', 'node_modules'].includes(name)) throw new Error('invalid native published output root');
      const source = path.join(root, dir, name);
      let info;
      try { info = fs.lstatSync(source); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!info.isSymbolicLink()) continue;
      if (bindingsPath === undefined) throw new Error('native pack: published output symlink requires explicit ECO_BUILD_ROOT or ECO_BUILD_VOLUME');
      bindings ??= readJson(bindingsPath);
      if (bindings.schema !== 'ecosystem-build-bindings.v1' || bindings.source !== harnessRoot) {
        throw new Error('native pack: external binding source identity differs');
      }
      const key = path.relative(harnessRoot, source).split(path.sep).join('/');
      const declared = bindings.artifacts?.[key];
      if (typeof declared !== 'string') throw new Error(`native pack: undeclared published symlink ${key}`);
      const target = path.resolve(declared);
      const relative = path.relative(path.dirname(bindingsPath), target);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
        || fs.realpathSync(target) !== target
        || fs.realpathSync(source) !== fs.realpathSync(target)
        || fs.statSync(target).dev === fs.statSync(harnessRoot).dev
        || fs.statSync(target).dev !== fs.statSync(path.dirname(bindingsPath)).dev) {
        throw new Error(`native pack: external output identity differs ${key}`);
      }
      outputs.push({ directory: path.join(dir, name), target, device: fs.statSync(target).dev });
    }
  }
  return outputs;
}

/** Copy a verified compiled tree, preserving modes and refusing nested links. */
function copyCompiledTree(source, destination) {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) throw new Error('native pack: nested compiled-output symlink');
  if (info.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: info.mode & 0o777 });
    fs.chmodSync(destination, info.mode & 0o777);
    for (const name of fs.readdirSync(source)) copyCompiledTree(path.join(source, name), path.join(destination, name));
  } else if (info.isFile()) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, info.mode & 0o777);
  } else throw new Error('native pack: special compiled-output entry');
}

function packedFile(tarball, relative) {
  const result = spawnSync('tar', ['-xOf', tarball, `package/${relative}`], { maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`native pack: packed payload missing ${relative}`);
  return result.stdout;
}

function exportTargets(value) {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(exportTargets) : [];
}

/** A prepack pass is insufficient: prove the actual tar carries these exact bytes. */
function verifyPackedPayload(tarball, dir, manifest) {
  const packed = JSON.parse(packedFile(tarball, 'package.json').toString('utf8'));
  for (const field of ['name', 'version', 'type', 'main', 'module', 'types', 'bin', 'exports', 'engines', 'os', 'cpu']) {
    if (JSON.stringify(packed[field]) !== JSON.stringify(manifest[field])) throw new Error(`native pack: runtime metadata changed ${field}`);
  }
  const versions = new Map([...platformDirs(), ...entryDirs()].map((member) => {
    const value = readJson(path.join(root, member, 'package.json'));
    return [value.name, value.version];
  }));
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const expected = Object.fromEntries(Object.entries(manifest[section] || {}).map(([name, value]) => {
      if (!value.startsWith('workspace:')) return [name, value];
      const selector = value.slice('workspace:'.length);
      const version = versions.get(name);
      if (!version) throw new Error(`native pack: workspace dependency is absent ${name}`);
      return [name, ['*', '~', '^'].includes(selector) ? `${selector === '*' ? '' : selector}${version}` : selector];
    }));
    const entries = (value) => Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right));
    if (JSON.stringify(entries(packed[section])) !== JSON.stringify(entries(expected))) {
      throw new Error(`native pack: runtime dependency metadata changed ${section}`);
    }
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (packed.scripts?.[hook]) throw new Error(`native pack: unexpected install lifecycle ${hook}`);
  }
  const targets = exportTargets(manifest.exports).filter((target) => target.startsWith('./lib/') && !target.includes('*'))
    .map((target) => target.slice(2));
  const prebuilds = path.join(root, dir, 'prebuilds.json');
  if (fs.existsSync(prebuilds)) {
    if (!packedFile(tarball, 'prebuilds.json').equals(fs.readFileSync(prebuilds))) {
      throw new Error('native pack: prebuild metadata bytes changed');
    }
    targets.push(...readJson(prebuilds).binaries.map((binary) => binary.path));
  }
  for (const target of new Set(targets)) {
    if (!packedFile(tarball, target).equals(fs.readFileSync(path.join(root, dir, target)))) {
      throw new Error(`native pack: compiled payload bytes changed ${target}`);
    }
  }
}

/** Copy pack inputs while keeping source manifests and completed tarballs untouched. */
function stagePackages(staging, repositoryUrl) {
  for (const directory of ['packages', 'scripts']) {
    fs.cpSync(path.join(root, directory), path.join(staging, directory), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  fs.copyFileSync(path.join(root, 'package.json'), path.join(staging, 'package.json'));
  // pnpm includes the repository workspace license when an entry has no package-local license.
  fs.copyFileSync(path.resolve(root, '../../LICENSE'), path.join(staging, 'LICENSE'));
  fs.writeFileSync(path.join(staging, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  for (const dir of [...platformDirs(), ...entryDirs()]) {
    const manifestPath = path.join(staging, dir, 'package.json');
    const manifest = readJson(manifestPath);
    if (repositoryUrl !== undefined) {
      manifest.repository = { ...manifest.repository, url: repositoryUrl };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
}

const dirs = [...(currentPlatformOnly ? hostPlatformDirs() : platformDirs()), ...entryDirs()];
const outputs = externalPackageOutputs(dirs);
const repositoryUrl = workflowRepositoryUrl();
const staging = repositoryUrl === undefined && outputs.length === 0 ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'native-system-pack-'));
try {
  if (staging !== undefined) {
    stagePackages(staging, repositoryUrl);
    for (const output of outputs) {
      if (fs.statSync(staging).dev !== output.device) throw new Error('native pack: distribution stage is not external');
      fs.rmSync(path.join(staging, output.directory), { recursive: true, force: true });
      copyCompiledTree(output.target, path.join(staging, output.directory));
    }
    if (outputs.length > 0 && fs.statSync(path.dirname(destination)).dev !== outputs[0].device) {
      throw new Error('native pack: destination is not on the external build volume');
    }
  }
  const packRoot = staging ?? root;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  const platformSet = new Set(platformDirs());
  const publishOrder = [];
  for (const dir of dirs) {
    const manifest = readJson(path.join(root, dir, 'package.json'));
    // Platform packages have no workspace dependencies; npm preserves their
    // executable modes. Entry packages need pnpm's workspace version conversion.
    if (platformSet.has(dir)) {
      run('npm', ['pack', `./${dir}`, '--pack-destination', destination], packRoot);
    } else {
      run('pnpm', ['--dir', dir, 'pack', '--pack-destination', destination], packRoot);
    }

    const tarball = tarballName(manifest);
    const tarballPath = path.join(destination, tarball);
    if (!fs.existsSync(tarballPath)) {
      throw new Error(`expected pack output not found: ${tarballPath}`);
    }
    verifyPackedPayload(tarballPath, dir, manifest);
    publishOrder.push(tarball);
  }

  fs.writeFileSync(path.join(destination, 'publish-order.txt'), `${publishOrder.join('\n')}\n`);
  console.log(`Packed ${publishOrder.length} packages into ${path.relative(root, destination)}`);
} finally {
  if (staging !== undefined) fs.rmSync(staging, { recursive: true, force: true });
}
