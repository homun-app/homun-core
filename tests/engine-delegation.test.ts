import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDelegations } from '../apps/web/src/lib/engine-delegation-parser.ts';

test('extractDelegations parses delegate_task and updates with poll and cancel', () => {
  // Empty or invalid
  assert.deepEqual(extractDelegations(undefined), []);
  assert.deepEqual(extractDelegations([]), []);

  const observations = [
    {
      tool: 'delegate_task',
      result: {
        delegation_id: 'del_123',
        status: 'running',
        task: 'Analisi documenti finanziari',
        agent_id: 'agent_analyst',
      },
    },
    {
      tool: 'delegation_poll',
      result: {
        delegation_id: 'del_123',
        status: 'completed',
        result: 'Risultato completato dal subagente',
        structured_output: { total: 1500, valid: true },
        turns_used: 2,
      },
    },
    {
      tool: 'delegate_task',
      result: {
        delegation_id: 'del_456',
        status: 'running',
        task: 'Scrittura bozza email',
      },
    },
    {
      tool: 'delegation_cancel',
      result: {
        delegation_id: 'del_456',
        status: 'cancelled',
      },
    },
  ];

  const delegations = extractDelegations(observations);
  assert.equal(delegations.length, 2);

  const del1 = delegations.find(d => d.delegationId === 'del_123');
  assert.ok(del1);
  assert.equal(del1.status, 'completed');
  assert.equal(del1.task, 'Analisi documenti finanziari');
  assert.equal(del1.result, 'Risultato completato dal subagente');
  assert.deepEqual(del1.structuredOutput, { total: 1500, valid: true });
  assert.equal(del1.turnsUsed, 2);

  const del2 = delegations.find(d => d.delegationId === 'del_456');
  assert.ok(del2);
  assert.equal(del2.status, 'cancelled');
  assert.equal(del2.task, 'Scrittura bozza email');
});
