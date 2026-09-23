/** Post-build verification of an electron-builder output tree (no signing assumptions).

Verifies the packaged app carries the SAME engine receipt as the staged bundle
and the web assets, before any installer artifact is published. Usage:
  node scripts/verify-release.mjs <path-to-Homun.app> [--expected-arch arm64]
*/
import { stat } from 'node:fs/promises';
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
if (!appPath) throw new Error('Usage: verify-release.mjs <Homun.app> [--expected-arch arm64]');

const resources = path.join(appPath, 'Contents', 'Resources');
const stagedHash = await verifyEngineInputs(repoRoot, path.resolve(scriptDir, '../.package/engine'));
if (await verifyEngineInputs(repoRoot, path.join(resources, 'engine')) !== stagedHash) {
  throw new Error('Packaged engine differs from staged engine');
}
await verifyWebAssets(path.join(resources, 'web'));
await stat(path.join(resources, 'app.asar'));

const exe = path.join(appPath, 'Contents', 'MacOS', 'homun');
const info = spawnSync('file', [exe], { encoding: 'utf8' });
if (info.status !== 0) throw new Error('file(1) failed on the packaged executable');
if (expectedArch && !info.stdout.includes(` ${expectedArch}`)) {
  throw new Error(`Unexpected executable architecture: ${info.stdout.trim()}`);
}
const receipt = JSON.parse(await (await import('node:fs/promises')).readFile(
  path.join(resources, 'build-receipt.json'), 'utf8'));
console.log(JSON.stringify({ app: appPath, arch: info.stdout.includes('arm64') ? 'arm64' : 'x64',
  appVersion: receipt.appVersion, engineReceiptHash: receipt.engineReceiptHash.slice(0, 12) }, null, 2));
