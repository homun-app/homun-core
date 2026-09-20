import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listEngineWorks, listEngineConversations, defaultLocalActor } from '../apps/web/src/lib/engine-domain-client.ts';

test('domain reads carry current actor and permit explicit actor override', async () => {
  const previous = globalThis.fetch;
  const actors: string[] = [];
  globalThis.fetch = async (_url, init) => {
    actors.push(new Headers(init?.headers).get('X-Homun-Actor-Id') ?? '');
    return new Response(JSON.stringify({items: []}), {status: 200});
  };
  try {
    await listEngineWorks();
    await listEngineWorks('ws_local', 'http://localhost', {id: 'reader', displayName: 'Reader'});
    await listEngineConversations('ws_local', 'http://localhost', {id: 'reader', displayName: 'Reader'});
    assert.deepEqual(actors, [defaultLocalActor().id, 'reader', 'reader']);
  } finally { globalThis.fetch = previous; }
});
