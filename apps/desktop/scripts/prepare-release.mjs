/** Stage verified release inputs for electron-builder: engine bundle, web dist, receipt.

Reuses package-app.mjs's staging (receipt verification included) so the
electron-builder path and the legacy packager path share one source of truth:
`.package/` ends up holding web/, engine/ and build-receipt.json.
Expects `dist/engine` (tools/build_engine_bundle.py) and `apps/web/dist` (vite)
to exist already; both are verified, never built here. */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageApp } from './package-app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const stage = path.resolve(root, 'apps/desktop/.package');

await rm(stage, { recursive: true, force: true });
const inputs = await stageApp({
  sourceRoot: root, stage,
  engineDir: path.join(root, 'dist/engine'),
  webDir: path.join(root, 'apps/web/dist'),
});
console.log(JSON.stringify({
  staged: stage,
  web: path.relative(root, inputs.web),
  engine: path.relative(root, inputs.engine),
  receipt: path.relative(root, inputs.receiptPath),
}, null, 2));
