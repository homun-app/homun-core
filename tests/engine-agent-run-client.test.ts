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

test('control binds current work version and preserves its body after a lost response', async () => {
  const { controlAgentRun } = await import('../apps/web/src/lib/engine-agent-run-client.ts');
  assert.equal(typeof controlAgentRun, 'function');
  const old = globalThis.fetch;
  const operation = { commandId: 'stable-control' };
  const bodies: unknown[] = [];
  let reads = 0;
  globalThis.fetch = async (url, init) => {
    if (!init?.body) {
      reads++;
      return Response.json({items:[{id:'work/1', version:7}]});
    }
    assert.match(String(url), /works\/work%2F1\/agent-runs\/run%2F1\/control$/);
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length === 1) throw new TypeError('lost response');
    return Response.json({id:'run/1', status:'paused'});
  };
  try {
    await assert.rejects(controlAgentRun('work/1', 'run/1', 'pause', operation));
    const result = await controlAgentRun('work/1', 'run/1', 'pause', operation);
    assert.equal(result.status, 'paused');
    assert.equal(reads, 1);
    assert.deepEqual(bodies, [
      {command_id:'stable-control',expected_version:7,action:'pause'},
      {command_id:'stable-control',expected_version:7,action:'pause'},
    ]);
  } finally { globalThis.fetch = old; }
});

test('redirect sends correction and exposes typed authorization failures', async () => {
  const { controlAgentRun } = await import('../apps/web/src/lib/engine-agent-run-client.ts');
  assert.equal(typeof controlAgentRun, 'function');
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return Response.json({items:[{id:'w',version:9}]});
    assert.deepEqual(JSON.parse(String(init.body)), {command_id:'redirect',expected_version:9,action:'redirect',text:'Ricalcola solo settembre'});
    return Response.json({detail:{code:'permission_denied',message:'Only the owner may steer'}}, {status:403});
  };
  try {
    await assert.rejects(controlAgentRun('w', 'r', 'redirect', {commandId:'redirect'}, 'Ricalcola solo settembre'),
      (error: {code?: string}) => error.code === 'permission_denied');
  } finally { globalThis.fetch = old; }
});

test('control does not POST when the work is no longer accessible', async () => {
  const { controlAgentRun } = await import('../apps/web/src/lib/engine-agent-run-client.ts');
  assert.equal(typeof controlAgentRun, 'function');
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({items:[]}); };
  try {
    await assert.rejects(controlAgentRun('w', 'r', 'cancel', {commandId:'cancel'}),
      (error: {code?: string}) => error.code === 'not_found');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = old; }
});

 test('preparation pins selected external servers without approving actions', async () => {
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, init) => {
    if (++calls === 1) return Response.json({items:[]});
    if (calls === 2) return Response.json({items:[{id:'w',version:1}]});
    assert.deepEqual(JSON.parse(String(init?.body)).server_ids, ['s1','s2']);
    return Response.json({id:'r',status:'pending_approval'});
  };
  try { await prepareAgentRun({id:'w'} as never, [], 'r', undefined, undefined, ['s1','s2']); }
  finally { globalThis.fetch = old; }
});

test('preparation includes capability flags in request body', async () => {
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, init) => {
    if (++calls === 1) return Response.json({items:[]});
    if (calls === 2) return Response.json({items:[{id:'w',version:2}]});
    const body = JSON.parse(String(init?.body));
    assert.equal(body.memory, true);
    assert.equal(body.skills, true);
    assert.equal(body.delegation, true);
    assert.equal(body.clarify, true);
    assert.equal(body.goals, true);
    assert.equal(body.cron, true);
    assert.equal(body.session_management, true);
    assert.equal(body.gateway, true);
    assert.equal(body.code_execution, true);
    assert.equal(body.plugins, true);
    assert.deepEqual(body.moa, {preset: 'fast'});
    return Response.json({
      id: 'r_caps', status: 'pending_approval',
      memory: {policy: 'scoped-workspace-v1', version: 1},
      skills: {policy: 'workspace-catalog-v1', version: 1},
      delegation: {policy: 'isolated-subagent-v1', version: 1},
      clarify: {policy: 'structured-clarify-v1', version: 1},
      goals: {policy: 'persistent-goals-v1', version: 1},
      cron: {policy: 'durable-cron-v1', version: 1},
      session_management: {policy: 'durable-sessions-v1', version: 1},
      gateway: {policy: 'core-gateway-v1', version: 1},
      code_execution: {policy: 'programmatic-v1', version: 1},
      plugins: {policy: 'extensible-plugins-v1', version: 1},
      moa: {policy: 'mixture-of-agents-v1', version: 1},
    });
  };
  try {
    const res = await prepareAgentRun(
      {id:'w'} as never, [], 'r_caps', undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      true, true, true, true, true, true, true, true, true, true, {preset: 'fast'}
    );
    assert.equal(res.id, 'r_caps');
    assert.equal(res.memory?.policy, 'scoped-workspace-v1');
    assert.equal(res.skills?.policy, 'workspace-catalog-v1');
    assert.equal(res.delegation?.policy, 'isolated-subagent-v1');
    assert.equal(res.clarify?.policy, 'structured-clarify-v1');
    assert.equal(res.goals?.policy, 'persistent-goals-v1');
    assert.equal(res.cron?.policy, 'durable-cron-v1');
    assert.equal(res.session_management?.policy, 'durable-sessions-v1');
    assert.equal(res.gateway?.policy, 'core-gateway-v1');
    assert.equal(res.code_execution?.policy, 'programmatic-v1');
    assert.equal(res.plugins?.policy, 'extensible-plugins-v1');
    assert.equal(res.moa?.policy, 'mixture-of-agents-v1');
  } finally { globalThis.fetch = old; }
});

test('preparation includes fallback_connection_id in request body when provided', async () => {
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, init) => {
    if (++calls === 1) return Response.json({items:[]});
    if (calls === 2) return Response.json({items:[{id:'w',version:3}]});
    const body = JSON.parse(String(init?.body));
    assert.equal(body.fallback_connection_id, 'sec_provider');
    return Response.json({
      id: 'r_fallback', status: 'pending_approval', connection_id: 'primary', fallback_connection_id: 'sec_provider'
    });
  };
  try {
    const res = await prepareAgentRun(
      {id:'w'} as never, [], 'r_fallback', undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      false, false, false, false, false, false, false, false, false, false, false,
      'sec_provider'
    );
    assert.equal(res.id, 'r_fallback');
    assert.equal(res.fallback_connection_id, 'sec_provider');
  } finally { globalThis.fetch = old; }
});

test('sideQuestionAgentRun posts question and returns detached answer with usage', async () => {
  const { sideQuestionAgentRun } = await import('../apps/web/src/lib/engine-agent-run-client.ts');
  const old = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/agent-runs\/run_123\/side-question$/);
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.question, 'What is the current status?');
    return Response.json({
      answer: 'Currently scanning files.',
      usage: { prompt_tokens: 20, completion_tokens: 6, cost_estimate: 0.0001 },
      run_id: 'run_123',
      work_id: 'w_test',
      main_transcript_unchanged: true,
    });
  };
  try {
    const res = await sideQuestionAgentRun('w_test', 'run_123', 'What is the current status?');
    assert.equal(res.answer, 'Currently scanning files.');
    assert.equal(res.main_transcript_unchanged, true);
    assert.equal(res.usage.prompt_tokens, 20);
    assert.equal(res.usage.completion_tokens, 6);
  } finally { globalThis.fetch = old; }
});



