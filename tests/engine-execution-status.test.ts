import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

test('paused execution continues polling and a repeated pause refreshes work state', async () => {
  assert.ok(existsSync('apps/web/src/lib/engine-execution-status.ts'));
  const { executionPolls, executionRefreshes } = await import('../apps/web/src/lib/engine-execution-status.ts');
  assert.equal(executionPolls('paused'), true);
  assert.equal(executionPolls('cancelled'), false);
  assert.equal(executionRefreshes('paused', 'running'), true);
  assert.equal(executionRefreshes('paused', 'paused'), false);
  assert.equal(executionRefreshes('cancelled', 'running'), true);
  assert.equal(executionRefreshes('queued', 'paused'), true);
});

test('external approval waits keep polling and refresh the work', async () => {
  const { executionPolls, executionRefreshes } = await import('../apps/web/src/lib/engine-execution-status.ts');
  assert.equal(executionPolls('waiting_external'), true);
  assert.equal(executionRefreshes('waiting_external', 'running'), true);
});

test('automation waits remain observable through wake and human controls', async () => {
  const { executionPolls, executionRefreshes } = await import('../apps/web/src/lib/engine-execution-status.ts');
  assert.equal(executionPolls('waiting_automation'), true);
  assert.equal(executionRefreshes('waiting_automation', 'running'), true);
  assert.equal(executionRefreshes('queued', 'waiting_automation'), true);
});
