const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, symlink, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProtocolHandler } = require('../src/protocol.cjs');

test('static origin rejects host/path/symlink escapes and includes restrictive CSP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'homun-protocol-'));
  try {
    await writeFile(path.join(root, 'index.html'), '<h1>Homun</h1>');
    await symlink('/etc/hosts', path.join(root, 'escape.txt'));
    const handler = createProtocolHandler({ webRoot: root, engine: {} });
    const response = await handler(new Request('homun://app/'));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    for (const url of ['homun://other/', 'homun://app/escape.txt', 'homun://app/..%2F..%2Fetc/hosts']) {
      assert.equal((await handler(new Request(url))).status, 403);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('proxy forwards allowed request content and replaces spoofed authorization', async () => {
  const original = global.fetch;
  try {
    global.fetch = async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:4321/v1/commands?q=1');
      assert.equal(init.headers.get('authorization'), 'Bearer ephemeral');
      assert.equal(init.headers.get('x-secret'), null);
      assert.equal(init.redirect, 'error');
      assert.equal(await new Response(init.body).text(), '{"hello":true}');
      return new Response('data: event\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const handler = createProtocolHandler({ webRoot: '/unused', engine: { baseUrl: 'http://127.0.0.1:4321', token: 'ephemeral' } });
    const response = await handler(new Request('homun://app/engine/v1/commands?q=1', { method: 'POST', headers: { Authorization: 'Bearer attacker', 'X-Secret': 'hidden' }, body: '{"hello":true}' }));
    assert.equal(await response.text(), 'data: event\n\n');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { global.fetch = original; }
});
