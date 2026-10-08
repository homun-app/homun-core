import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listEngineGoals, getEngineGoal } from '../apps/web/src/lib/engine-goals-client.ts';

test('engine-goals-client fetches goals and handles errors', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/v1/goals')) {
        return new Response(JSON.stringify({
          count: 1,
          goals: [
            {
              session_id: 'session_123',
              goal: 'Completare audit di conformità',
              status: 'active',
              turns_used: 3,
              max_turns: 10,
              contract: {
                outcome: 'Report approvato',
                verification: 'Tutte le sezioni compilate',
                stop_when: 'Approvazione operatore',
              },
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr.endsWith('/v1/goals/session_123')) {
        return new Response(JSON.stringify({
          session_id: 'session_123',
          goal: 'Completare audit di conformità',
          status: 'active',
          turns_used: 3,
          max_turns: 10,
          contract: { outcome: 'Report approvato' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ detail: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    };

    const goals = await listEngineGoals();
    assert.equal(goals.length, 1);
    assert.equal(goals[0].session_id, 'session_123');
    assert.equal(goals[0].status, 'active');
    assert.equal(goals[0].contract?.outcome, 'Report approvato');

    const single = await getEngineGoal('session_123');
    assert.equal(single.session_id, 'session_123');
    assert.equal(single.turns_used, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
