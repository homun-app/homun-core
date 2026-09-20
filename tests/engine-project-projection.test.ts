import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectWorkspaceData, engineWorkPanelMessage } from '../apps/web/src/lib/engine-project-projection.ts';

test('engine project navigation uses only authoritative inventory, including after reload', () => {
  const simulated = { teams: [], routines: [], projects: [{ id: 'fake', name: 'Demo', teamId: '', brief: '' }] };
  const projects = [{ id: 'project_real', workspace_id: 'ws_local', name: 'Prezzi settembre', description: 'Confronto', version: 2, team_ids: [], member_ids: [], conversation_ids: ['conv_real'], status: 'active' }];
  const actual = projectWorkspaceData('engine', simulated, projects);
  assert.deepEqual(actual.projects, [{ id: 'project_real', name: 'Prezzi settembre', brief: 'Confronto', teamId: '' }]);
  assert.equal(projectWorkspaceData('engine', simulated, []).projects.length, 0);
  assert.equal(projectWorkspaceData('simulation', simulated, projects), simulated);
  assert.deepEqual(projectWorkspaceData('engine', simulated, JSON.parse(JSON.stringify(projects))), actual);
});

test('real work states never offer simulated delivery or approval', () => {
  assert.match(engineWorkPanelMessage('running'), /esecuzione/i);
  assert.match(engineWorkPanelMessage('review'), /report.*conversazione/);
  assert.match(engineWorkPanelMessage('failed'), /non.*completata/);
  for (const state of ['draft', 'ready', 'running', 'review', 'completed', 'failed', 'paused']) {
    assert.doesNotMatch(engineWorkPanelMessage(state), /simula|dimostrativa|Approva bozza/i);
  }
});

test('project inventory read carries actor identity and surfaces denial without demo fallback', async () => {
  const { listEngineProjects } = await import('../apps/web/src/lib/engine-projects-client.ts');
  const previous = globalThis.fetch;
  let identity = '';
  globalThis.fetch = async (_url, init) => {
    identity = new Headers(init?.headers).get('X-Homun-Actor-Id') ?? '';
    return new Response(JSON.stringify({ detail: { code: 'permission_denied', message: 'Revoked' } }), { status: 403 });
  };
  try {
    await assert.rejects(listEngineProjects('ws_local', 'http://localhost', { id: 'reader', displayName: 'Reader' }), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'permission_denied');
      return true;
    });
    assert.equal(identity, 'reader');
  } finally { globalThis.fetch = previous; }
});
