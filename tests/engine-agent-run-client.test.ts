import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveAgentRun, prepareAgentRun } from '../apps/web/src/lib/engine-agent-run-client.ts';

test('adaptive approval binds the reviewed proposal and revision', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /agent-runs\/run1\/approve$/);
    assert.deepEqual(JSON.parse(String(init?.body)), {command_id:'approve', digest:'bound', expected_version:4});
    return Response.json({id:'run1', status:'queued'});
  };
  try { assert.equal((await approveAgentRun('work1', {id:'run1',digest:'bound',expected_version:4} as never,'approve')).status,'queued'); }
  finally { globalThis.fetch=old; }
});

test('lost preparation response recovers persisted run without a new POST', async () => {
  const old = globalThis.fetch; let calls=0;
  globalThis.fetch = async () => { calls++; return Response.json({items:[{id:'same',status:'pending_approval'}]}); };
  try {
    assert.equal((await prepareAgentRun({id:'w'} as never, [], 'same')).id,'same');
    assert.equal(calls,1);
  } finally { globalThis.fetch=old; }
});

test('preparation includes selected recipient in the reviewed proposal', async () => {
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (calls === 1) return Response.json({items:[]});
    if (calls === 2) return Response.json({items:[{id:'work1', version:3}]});
    assert.deepEqual(JSON.parse(String(init?.body)), {
      command_id:'new', expected_version:3, material_ids:[], person_id:'person_marta',
    });
    return Response.json({id:'new', person:{id:'person_marta', name:'Marta'}});
  };
  try {
    const result = await prepareAgentRun({id:'work1'} as never, [], 'new', undefined, 'person_marta');
    assert.equal(result.person?.name, 'Marta');
  } finally { globalThis.fetch = old; }
});

test('person creation reuses the supplied command id and returns the selectable recipient', async () => {
  const { createPerson } = await import('../apps/web/src/lib/engine-contribution-invitations.ts');
  const old = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/people$/);
    assert.deepEqual(JSON.parse(String(init?.body)), {command_id:'stable-person', name:'Marta'});
    return Response.json({id:'person_marta', name:'Marta'});
  };
  try {
    assert.deepEqual(await createPerson('Marta', 'stable-person'), {id:'person_marta', name:'Marta'});
  } finally { globalThis.fetch = old; }
});
