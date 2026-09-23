/** Post-build verification of an electron-builder output tree.

Two modes:
  default      — the unsigned/dispatch path: the packaged engine must match the
                 staged receipt byte for byte (file set, hashes, symlinks).
  --signed     — the release path: code signing rewrites every Mach-O (hashes
                 are invalid BY DESIGN) and adds nested `_CodeSignature`
                 manifests. The engine file set must still match the receipt
                 (modulo those manifests), and integrity is proven by Apple's
                 own chain instead: deep strict code-signature verification and
                 the stapled notarization ticket.

Usage:
  node scripts/verify-release.mjs <path-to-Homun.app> [--expected-arch arm64] [--signed]
*/
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEngineInputs } from './package-app.mjs';
import { verifyWebAssets } from './artifact-inventory.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const appPath = process.argv[2];
const expectedArch = process.argv.includes('--expected-arch')
  ? process.argv[process.argv.indexOf('--expected-arch') + 1] : null;
const signed = process.argv.includes('--signed');
if (!appPath) throw new Error('Usage: verify-release.mjs <Homun.app> [--expected-arch arm64] [--signed]');

const resources = path.join(appPath, 'Contents', 'Resources');
const engineDir = path.join(resources, 'engine');

function run(command, args, what) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${what} failed\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

if (signed) {
  const { inventory } = await import('./artifact-inventory.mjs');
  const receipt = JSON.parse(await readFile(path.join(engineDir, 'build-receipt.json'), 'utf8'));
  const expected = new Set(receipt.artifact_files.map((entry) => entry.name));
  const actual = (await inventory(engineDir)).filter(
    (entry) => entry.name !== 'build-receipt.json' && !entry.name.split('/').includes('_CodeSignature'));
  const extra = actual.filter((entry) => !expected.has(entry.name));
  const missing = [...expected].filter((name) => !actual.some((entry) => entry.name === name));
  if (extra.length || missing.length) {
    throw new Error(`Signed engine file set differs from receipt. Extra: ${extra.map(e => e.name).join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}`);
  }
  const symlinkDrift = actual.filter((entry) => {
    const receiptEntry = receipt.artifact_files.find((r) => r.name === entry.name);
    return receiptEntry && Boolean(receiptEntry.symlink) !== Boolean(entry.symlink);
  });
  if (symlinkDrift.length) throw new Error('Engine symlinks differ from receipt: ' + symlinkDrift.map(e => e.name).join(', '));
  run('codesign', ['--verify', '--deep', '--strict', appPath], 'Deep code-signature verification');
  run('xcrun', ['stapler', 'validate', appPath], 'Notarization ticket validation');
  await verifyWebAssets(path.join(resources, 'web'));
  console.log(JSON.stringify({ app: appPath, mode: 'signed', notarized: true }, null, 2));
} else {
  const stagedHash = await verifyEngineInputs(repoRoot, path.resolve(scriptDir, '../.package/engine'));
  if (await verifyEngineInputs(repoRoot, engineDir) !== stagedHash) {
    throw new Error('Packaged engine differs from staged engine');
  }
  await verifyWebAssets(path.join(resources, 'web'));
}

await stat(path.join(resources, 'app.asar'));
const exe = path.join(appPath, 'Contents', 'MacOS', 'homun');
const info = spawnSync('file', [exe], { encoding: 'utf8' });
if (info.status !== 0) throw new Error('file(1) failed on the packaged executable');
if (expectedArch && !info.stdout.includes(` ${expectedArch}`)) {
  throw new Error(`Unexpected executable architecture: ${info.stdout.trim()}`);
}
const receipt = JSON.parse(await readFile(path.join(resources, 'build-receipt.json'), 'utf8'));
console.log(JSON.stringify({ app: appPath, mode: signed ? 'signed' : 'unsigned',
  arch: info.stdout.includes('arm64') ? 'arm64' : 'x64',
  appVersion: receipt.appVersion, engineReceiptHash: receipt.engineReceiptHash.slice(0, 12) }, null, 2));
