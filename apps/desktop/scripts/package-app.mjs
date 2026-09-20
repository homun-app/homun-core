/** Build a local, unsigned macOS bundle from an explicit file allowlist. */
import { cp, mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyEngineArtifact, verifyWebAssets } from './artifact-inventory.mjs';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const digest = data => createHash('sha256').update(data).digest('hex');

async function engineSourceHash(sourceRoot) {
  const base = path.join(sourceRoot, 'engine/src');
  async function files(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(entry => entry.isDirectory()
      ? files(path.join(directory, entry.name))
      // Prompts are engine behavior: hash them exactly like the build receipt does.
      : (entry.name.endsWith('.py') || entry.name.endsWith('.txt')) ? [path.join(directory, entry.name)] : []));
    return nested.flat();
  }
  const hash = createHash('sha256');
  for (const name of (await files(path.join(base, 'homun'))).sort()) {
    hash.update(path.relative(base, name).split(path.sep).join('/')+'\0');
    hash.update(await readFile(name));
  }
  return hash.digest('hex');
}

export async function verifyEngineInputs(sourceRoot, engineDir) {
  const raw = await readFile(path.join(engineDir, 'build-receipt.json'));
  const receipt = JSON.parse(raw);
  if (receipt.python_version !== '3.13.12' || receipt.architecture !== 'arm64') throw new Error('Unverified engine interpreter or architecture');
  for (const name of ['requirements.lock', 'requirements-packaging.lock']) {
    if (receipt.locks?.[name] !== digest(await readFile(path.join(sourceRoot, 'engine', name)))) throw new Error('Stale engine lock: '+name);
  }
  for (const name of ['engine/packaging/homun-engine.spec', 'engine/packaging/entrypoint.py', 'tools/build_engine_bundle.py', 'engine/pyproject.toml']) {
    if (receipt.build_inputs?.[name] !== digest(await readFile(path.join(sourceRoot, name)))) throw new Error('Stale engine build input: '+name);
  }
  if (receipt.source_sha256 !== await engineSourceHash(sourceRoot)) throw new Error('Stale engine source');
  await verifyEngineArtifact(engineDir, receipt);
  return digest(raw);
}

export async function stageApp({ sourceRoot, stage, engineDir, webDir }) {
  for (const required of [path.join(engineDir, 'homun-engine'), path.join(webDir, 'index.html')]) {
    if (!(await stat(required)).isFile()) throw new Error('Missing build input: '+required);
  }
  const engineReceiptHash = await verifyEngineInputs(sourceRoot, engineDir);
  const config = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  const electronVersion = config.devDependencies.electron;
  if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) throw new Error('Electron must be pinned exactly');
  const appDir = path.join(stage, 'app');
  await mkdir(appDir, { recursive: true });
  await mkdir(path.join(appDir, 'src'));
  for (const name of ['main.cjs','preload.cjs','engine-process.cjs','protocol.cjs']) {
    await cp(path.join(sourceRoot, 'apps/desktop/src', name), path.join(appDir, 'src', name));
  }
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'homun-desktop', productName: 'Homun', version: '0.1.0',
    description: 'Homun local workspace', main: 'src/main.cjs', private: true,
  }, null, 2));
  const web = path.join(stage, 'web');
  const engine = path.join(stage, 'engine');
  await verifyWebAssets(webDir);
  await cp(webDir, web, { recursive: true });
  await verifyWebAssets(web);
  await cp(engineDir, engine, { recursive: true, verbatimSymlinks: true });
  if (await verifyEngineInputs(sourceRoot, engine) !== engineReceiptHash) throw new Error('Engine changed during staging');
  const receipt = {
    format: 'homun-desktop-build', version: 1, appVersion: '0.1.0',
    electronVersion, platform: process.platform, arch: process.arch,
    signedForDistribution: false, notarized: false, engineReceiptHash,
    inputHashes: {},
  };
  for (const name of ['package-lock.json', 'engine/requirements.lock', 'engine/requirements-packaging.lock']) {
    receipt.inputHashes[name] = digest(await readFile(path.join(sourceRoot, name)));
  }
  const receiptPath = path.join(stage, 'build-receipt.json');
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2)+'\n');
  return { appDir, web, engine, receiptPath, electronVersion };
}

export async function packageApp() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This verified build profile requires macOS arm64');
  const stage = await mkdtemp(path.join(os.tmpdir(), 'homun-package-'));
  try {
    const inputs = await stageApp({ sourceRoot: root, stage, engineDir: path.join(root, 'dist/engine'), webDir: path.join(root, 'apps/web/dist') });
    const output = path.join(root, 'dist/desktop', new Date().toISOString().replace(/[:.]/g, '-'));
    const bundles = await packager({
      dir: inputs.appDir, name: 'Homun', appBundleId: 'dev.homun.desktop',
      appVersion: '0.1.0', electronVersion: inputs.electronVersion,
      platform: 'darwin', arch: 'arm64', out: output, asar: true,
      prune: false, overwrite: false,
      extraResource: [inputs.web, inputs.receiptPath],
      osxSign: false, osxNotarize: false,
    });
    // Packager's extraResource copier rewrites symlinks to absolute staging paths.
    // Copy the engine ourselves, preserve its links, then verify the actual app.
    for (const bundle of bundles) {
      const resources = path.join(bundle, 'Homun.app/Contents/Resources');
      const finalEngine = path.join(resources, 'engine');
      await cp(inputs.engine, finalEngine, { recursive: true, verbatimSymlinks: true });
      if (await verifyEngineInputs(root, finalEngine) !== await verifyEngineInputs(root, inputs.engine)) throw new Error('Final application engine differs from staged engine');
      await verifyWebAssets(path.join(resources, 'web'));
    }
    const archive = path.join(output, 'Homun-0.1.0-macos-arm64.zip');
    await promisify(execFile)('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(bundles[0], 'Homun.app'), archive]);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    await writeFile(archive+'.sha256', hash.digest('hex')+'  '+path.basename(archive)+'\n');
    console.log(JSON.stringify({ bundles, archive, unsigned: true }, null, 2));
    return bundles;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  packageApp().catch(error => { console.error(error.message); process.exitCode = 1; });
}
