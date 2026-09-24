import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentRenderer } from './helpers/render-component.ts';
import { approveFileEdit, listFileEdits } from '../apps/web/src/lib/engine-file-edit-client.ts';

test('file edit consent shows the exact diff and hides approval when inactive', async () => {
  const renderer = await componentRenderer('apps/web/src/components/builder/EngineWorkspaceEditApproval.tsx', 'FileEditProposal');
  try {
    const edit = {
      id: 'file-edit:abc', path: 'note.py', operation: 'patch', status: 'pending_approval',
      diff_preview: 'return 2', diagnostics: {lsp: 'unavailable', introduced: []},
    };
    const props = {edit, busy: false, active: true, approve: () => {}};
    const html = renderer.render(props);
    assert.match(html, /note\.py/);
    assert.match(html, /return 2/);
    assert.match(html, /Approva e scrivi il file/);
    assert.match(html, /language server/);
    assert.doesNotMatch(renderer.render({...props, active: false}), /Approva e scrivi il file/);
    const introduced = renderer.render({...props, edit: {...edit, diagnostics: {lsp: 'unavailable', introduced: ['SyntaxError: invalid']}}});
    assert.match(introduced, /SyntaxError: invalid/);
  } finally { await renderer.close(); }
});

test('file edit approval sends only the reviewed digest', async () => {
  const old = globalThis.fetch;
  const calls: {method: string; url: string; body: unknown}[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null});
    return Response.json({items: [], id: 'file-edit:abc', status: 'applied'});
  };
  try {
    await listFileEdits('work/1');
    await approveFileEdit('work/1', {id: 'file-edit:abc', digest: 'reviewed'} as never);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].body, null);
    assert.match(calls[1].url, /works\/work%2F1\/file-edits\/file-edit%3Aabc\/approve$/);
    assert.deepEqual(calls[1].body, {digest: 'reviewed'});
  } finally { globalThis.fetch = old; }
});
