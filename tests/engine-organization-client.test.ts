import assert from 'node:assert/strict';
import { test } from 'node:test';
import { organizationRequest } from '../apps/web/src/lib/engine-organization-client.ts';

test('organization confirmation sends only explicit revision and proposal with actor identity', async () => {
  const original = globalThis.fetch;
  const body = { command_id: 'confirm', proposal_id: 'proposal', expected_revision: 3 };
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /organization\/confirm$/);
    assert.equal(new Headers(init?.headers).get('X-Homun-Actor-Id'), 'person_fabio');
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    return Response.json({ status: 'confirmed' });
  };
  try { assert.deepEqual(await organizationRequest('/confirm', body), { status: 'confirmed' }); }
  finally { globalThis.fetch = original; }
});

test('organization stale context is a visible typed conflict', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ detail: { code: 'version_conflict', message: 'Context changed' } }, { status: 409 });
  try { await assert.rejects(organizationRequest('/confirm', {}), { code: 'version_conflict' }); }
  finally { globalThis.fetch = original; }
});
