const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('packaging stages only shell and explicit runtime assets, never workspace secrets', async () => {
  const { stageApp } = await import('../scripts/package-app.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'homun-package-test-'));
  try {
    for (const dir of ['apps/desktop/src', 'engine', 'runtime', 'web', 'stage', 'engine/src/homun', 'engine/packaging', 'tools']) await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { electron: '44.4.3' } }));
    for (const name of ['package-lock.json', 'engine/requirements.lock', 'engine/requirements-packaging.lock']) await fs.writeFile(path.join(root,name), 'lock');
    await fs.writeFile(path.join(root, '.env'), 'DO_NOT_SHIP=secret');
    await fs.writeFile(path.join(root, 'engine/secrets.json'), 'DO_NOT_SHIP');
    for (const name of ['main.cjs','preload.cjs','engine-process.cjs','protocol.cjs']) await fs.writeFile(path.join(root, 'apps/desktop/src', name), 'shell');
    await fs.writeFile(path.join(root, 'apps/desktop/src/secrets.json'), 'DO_NOT_SHIP');
    await fs.writeFile(path.join(root, 'runtime/homun-engine'), 'binary');
    await fs.writeFile(path.join(root, 'web/index.html'), 'web');
    const digest = data => require('node:crypto').createHash('sha256').update(data).digest('hex');
    const receipt = { python_version: '3.13.12', architecture: 'arm64',
      locks: { 'requirements.lock': digest('lock'), 'requirements-packaging.lock': digest('lock') },
      source_sha256: digest(''), build_inputs: {}, artifact_files: [{name:'homun-engine',sha256:digest('binary')}]  };
    for (const name of ['engine/packaging/homun-engine.spec', 'engine/packaging/entrypoint.py', 'tools/build_engine_bundle.py', 'engine/pyproject.toml']) {
      await fs.writeFile(path.join(root, name), 'input'); receipt.build_inputs[name] = digest('input');
    }
    await fs.writeFile(path.join(root, 'runtime/build-receipt.json'), JSON.stringify(receipt));
    const result = await stageApp({ sourceRoot: root, stage: path.join(root, 'stage'), engineDir: path.join(root, 'runtime'), webDir: path.join(root, 'web') });
    assert.deepEqual((await fs.readdir(result.appDir)).sort(), ['package.json','src']);
    assert.deepEqual((await fs.readdir(result.engine)).sort(), ['build-receipt.json', 'homun-engine']);
    assert.deepEqual(await fs.readdir(result.web), ['index.html']);
    assert.equal(JSON.parse(await fs.readFile(result.receiptPath)).signedForDistribution, false);
    assert.equal((await fs.readdir(path.join(result.appDir, 'src'))).length, 4);
    const restage = () => stageApp({ sourceRoot: root, stage: path.join(root, 'other-stage'), engineDir: path.join(root, 'runtime'), webDir: path.join(root, 'web') });
    await fs.writeFile(path.join(root, 'runtime/homun-engine'), 'changed');
    await assert.rejects(restage(), /Engine artifact changed/);
    await fs.writeFile(path.join(root, 'runtime/homun-engine'), 'binary');
    await fs.writeFile(path.join(root, 'runtime/secrets.json'), 'DO_NOT_SHIP');
    await assert.rejects(restage(), /file set changed/);
    await fs.unlink(path.join(root, 'runtime/secrets.json'));
    await fs.writeFile(path.join(root, 'engine/requirements.lock'), 'changed');
    await assert.rejects(stageApp({ sourceRoot: root, stage: path.join(root, 'other-stage'), engineDir: path.join(root, 'runtime'), webDir: path.join(root, 'web') }), /Stale engine lock/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
