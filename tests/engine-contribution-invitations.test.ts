import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contributionLink, portalRequest } from '../apps/web/src/lib/engine-contribution-invitations.ts';

test('invitation credential stays in fragment not query', () => {
  const value = new URL(contributionLink('secret', 'http://localhost:4183/?old=value', 'http://localhost:8765'));
  assert.equal(value.search, '');
  assert.equal(new URLSearchParams(value.hash.slice(1)).get('contribution'), 'secret');
});

test('portal does not use local session identity and sends credential only in header', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url,init) => {
    assert.equal(url, 'http://localhost:8765/v1/contribution-portal/respond');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer invitation-token');
    assert.equal(headers.get('X-Homun-Actor-Id'), null);
    assert.equal(init?.referrerPolicy, 'no-referrer');
    assert.deepEqual(JSON.parse(String(init?.body)), { text: 'A response' });
    return Response.json({ status: 'ready' });
  };
  try { await portalRequest('http://localhost:8765','invitation-token','respond','A response'); }
  finally { globalThis.fetch = original; }
});
