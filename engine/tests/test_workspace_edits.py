"""Workspace search, line pages, and approved edits."""
import hashlib
import io
import zipfile
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from homun.application import agent_runs, workspace_file_edits, workspace_files
from homun.application.agent_run_execution import advance
from homun.domain.errors import ConflictError
from homun.execution.file_match import replace
from homun.execution.file_syntax import delta
from homun.execution.files import WorkspaceFiles
from homun.models.native_turn import NativeMessage, ToolCall


def test_match_chain_and_ambiguous_refusal():
    content, count, strategy, error = replace('alpha\nbeta\n', '    beta', '    gamma')
    assert (error, strategy, content, count) == (None, 'line_trimmed', 'alpha\ngamma\n', 1)
    _same, count, strategy, error = replace('one one', 'one', 'two')
    assert count == 0 and '2 matches' in error
    updated, count, strategy, error = replace('one one', 'one', 'two', replace_all=True)
    assert updated == 'two two' and strategy == 'exact'
    _same, count, strategy, error = replace('value', 'value', 'value')
    assert 'identical' in error
    updated, count, strategy, error = replace('smart “quote”', 'smart "quote"', 'smart "quote" changed')
    assert error is None and '“quote”' in updated and 'changed' in updated


def test_syntax_delta_reports_only_new_errors_and_blocks_json():
    before = 'x =\n\ndef ok():\n    return 1\n'
    after = 'x =\n\ndef ok():\n    return 2\n'
    found = delta('sample.py', before, after)
    assert found['checked'] and found['introduced'] == [] and found['preexisting'] and found['lsp'] == 'unavailable'
    broken = delta('sample.py', 'def ok():\n    return 1\n', 'def ok(\n    return 1\n')
    assert broken['introduced'] and not broken.get('blocked')
    refused = delta('data.json', '{"a": 1}\n', '{"a":\n')
    assert refused['blocked']
    assert delta('note.md', 'a', 'b')['checked'] is False


def test_sorted_pages_cover_the_directory_without_symlink_entries(tmp_path):
    for name in ['c', 'a', 'b']:
        (tmp_path / name).write_text(name)
    (tmp_path / 'link').symlink_to(tmp_path / 'a')
    files = WorkspaceFiles(tmp_path)
    first = files.list_page(limit=2)
    assert [item['name'] for item in first['items']] == ['a', 'b'] and first['next_cursor'] == 'b'
    second = files.list_page(limit=2, cursor='b')
    assert [item['name'] for item in second['items']] == ['c'] and second['truncated'] is False


def test_search_skips_symlink_and_pages_matches(tmp_path):
    (tmp_path / 'keep.txt').write_text('alpha\nbeta\nalpha\n')
    (tmp_path / 'other').symlink_to(tmp_path / 'keep.txt')
    files = WorkspaceFiles(tmp_path)
    found = files and __import__('homun.execution.file_search', fromlist=['search']).search(files, 'alpha', limit=1)
    assert found['matches'] == [{'path': 'keep.txt', 'line': 1, 'text': 'alpha'}] and found['truncated']
    names = __import__('homun.execution.file_search', fromlist=['search']).search(files, '*.txt', target='filename')
    assert names['matches'][0]['path'] == 'keep.txt'


def test_docx_extracts_text_and_rejects_dtd(tmp_path):
    from homun.execution.file_pages import page
    payload = io.BytesIO()
    xml = b'''<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Ciao docx</w:t></w:r></w:p></w:body></w:document>'''
    with zipfile.ZipFile(payload, 'w') as package:
        package.writestr('word/document.xml', xml)
    (tmp_path / 'note.docx').write_bytes(payload.getvalue())
    viewed = page(WorkspaceFiles(tmp_path), 'note.docx')
    assert viewed['extraction_status'] == 'extracted' and viewed['lines'][0]['text'] == 'Ciao docx'
    assert viewed['file_coverage']['complete'] is False
    hostile = xml.replace(b'<?xml version="1.0"?>', b'<?xml version="1.0"?><!DOCTYPE w [<!ENTITY x "y">]>')
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, 'w') as package:
        package.writestr('word/document.xml', hostile)
    (tmp_path / 'bad.docx').write_bytes(payload.getvalue())
    failed = page(WorkspaceFiles(tmp_path), 'bad.docx')
    assert failed['extraction_status'] == 'failed' and 'lines' not in failed


def _start(setup):
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    proposal = agent_runs.propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'material_ids': [], 'terminal_image': 'sha256:' + 'a' * 64})
    agent_runs.approve(ctx, actor, work, proposal['id'], {'command_id': 'go', 'digest': proposal['digest'], 'expected_version': proposal['expected_version']})
    run = ctx.repository.load().commands[proposal['id']].result
    root = workspace_files.root_for(ctx, run)
    (root / 'note.py').write_text('def ok():\n    return 1\n')
    return ctx, actor, work, proposal, root


def _call(ctx, name, args, call_id='edit1'):
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=NativeMessage(role='assistant', tool_calls=[ToolCall(id=call_id, name=name, arguments=args)]), usage=None)


def test_new_runs_offer_edits_and_unread_replacement_does_not_write(setup):
    ctx, actor, work, proposal, root = _start(setup)
    names = {tool['name'] for tool in proposal['tools']}
    assert {'read_workspace_lines', 'search_workspace_files', 'write_workspace_file', 'patch_workspace_file'} <= names
    original = (root / 'note.py').read_bytes()
    _call(ctx, 'write_workspace_file', {'path': 'note.py', 'content': 'def ok():\n    return 2\n', 'baseline_sha256': hashlib.sha256(original).hexdigest()})
    assert advance(ctx, proposal['id']) == 'running'
    result = ctx.repository.load().commands[proposal['id']].result['observations'][-1]['result']
    assert result['error_code'] == 'workspace_file_stale'
    assert (root / 'note.py').read_bytes() == original


def test_patch_waits_for_exact_approval_and_resume_writes_once(setup):
    ctx, actor, work, proposal, root = _start(setup)
    _call(ctx, 'read_workspace_lines', {'path': 'note.py'}, 'read1')
    assert advance(ctx, proposal['id']) == 'running'
    sha = hashlib.sha256((root / 'note.py').read_bytes()).hexdigest()
    _call(ctx, 'patch_workspace_file', {'path': 'note.py', 'old_string': 'return 1', 'new_string': 'return 2', 'baseline_sha256': sha})
    assert advance(ctx, proposal['id']) == 'waiting_external'
    assert (root / 'note.py').read_text() == 'def ok():\n    return 1\n'
    edit_id = ctx.repository.load().commands[proposal['id']].result['file_edit_request_id']
    edit = ctx.repository.load().commands[edit_id].result
    assert edit['diagnostics']['introduced'] == [] and not workspace_file_edits.resume(ctx, proposal['id'])
    approved = workspace_file_edits.approve(ctx, actor, work, edit_id, {'digest': edit['digest']})
    assert approved['status'] == 'applied' and (root / 'note.py').read_text() == 'def ok():\n    return 2\n'
    assert workspace_file_edits.resume(ctx, proposal['id']) and not workspace_file_edits.resume(ctx, proposal['id'])
    messages = ctx.repository.load().commands[proposal['id']].result['_messages']
    assert len([item for item in messages if item.get('tool_call_id') == 'edit1']) == 1
    again = workspace_file_edits.approve(ctx, actor, work, edit_id, {'digest': edit['digest']})
    assert again['status'] == 'applied' and (root / 'note.py').read_text() == 'def ok():\n    return 2\n'


def test_changed_file_conflicts_without_a_second_write(setup, monkeypatch):
    ctx, actor, work, proposal, root = _start(setup)
    _call(ctx, 'read_workspace_lines', {'path': 'note.py'}, 'read1')
    advance(ctx, proposal['id'])
    sha = hashlib.sha256((root / 'note.py').read_bytes()).hexdigest()
    _call(ctx, 'patch_workspace_file', {'path': 'note.py', 'old_string': 'return 1', 'new_string': 'return 2', 'baseline_sha256': sha})
    advance(ctx, proposal['id'])
    (root / 'note.py').write_text('def ok():\n    return 9\n')
    edit_id = ctx.repository.load().commands[proposal['id']].result['file_edit_request_id']
    digest = ctx.repository.load().commands[edit_id].result['digest']
    calls = []
    original = WorkspaceFiles.write_bytes
    def spy(self, path, data, *, before_sha):
        calls.append(path)
        return original(self, path, data, before_sha=before_sha)
    monkeypatch.setattr(WorkspaceFiles, 'write_bytes', spy)
    result = workspace_file_edits.approve(ctx, actor, work, edit_id, {'digest': digest})
    assert result['status'] == 'conflict' and (root / 'note.py').read_text() == 'def ok():\n    return 9\n'
    assert workspace_file_edits.resume(ctx, proposal['id'])
    assert calls  # the guarded compare ran, but the bytes stayed external


def test_cancel_before_approval_prevents_the_write(setup):
    from homun.application.agent_control import control
    ctx, actor, work, proposal, root = _start(setup)
    _call(ctx, 'read_workspace_lines', {'path': 'note.py'}, 'read1')
    advance(ctx, proposal['id'])
    sha = hashlib.sha256((root / 'note.py').read_bytes()).hexdigest()
    _call(ctx, 'write_workspace_file', {'path': 'note.py', 'content': 'def ok():\n    return 3\n', 'baseline_sha256': sha})
    advance(ctx, proposal['id'])
    control(ctx, actor, work, proposal['id'], {'command_id': 'cancel', 'action': 'cancel', 'expected_version': ctx.repository.load().works[work].version})
    edit_id = ctx.repository.load().commands[proposal['id']].result['file_edit_request_id']
    with pytest.raises(ConflictError):
        workspace_file_edits.approve(ctx, actor, work, edit_id, {'digest': ctx.repository.load().commands[edit_id].result['digest']})
    assert (root / 'note.py').read_text() == 'def ok():\n    return 1\n'


def test_recovery_after_the_bytes_land_does_not_write_again(setup, monkeypatch):
    ctx, actor, work, proposal, root = _start(setup)
    _call(ctx, 'read_workspace_lines', {'path': 'note.py'}, 'read1')
    advance(ctx, proposal['id'])
    sha = hashlib.sha256((root / 'note.py').read_bytes()).hexdigest()
    _call(ctx, 'patch_workspace_file', {'path': 'note.py', 'old_string': 'return 1', 'new_string': 'return 4', 'baseline_sha256': sha})
    advance(ctx, proposal['id'])
    edit_id = ctx.repository.load().commands[proposal['id']].result['file_edit_request_id']
    approved = workspace_file_edits.approve(ctx, actor, work, edit_id, {'digest': ctx.repository.load().commands[edit_id].result['digest']})
    assert approved['status'] == 'applied'
    with ctx.repository.transaction() as store:
        store.commands[edit_id].result['status'] = 'applying'
        store.commands[proposal['id']].result.update(status='waiting_external', file_edit_request_id=edit_id)
    calls = []
    def forbid(self, path, data, *, before_sha):
        calls.append(path)
        return 'already'
    monkeypatch.setattr(WorkspaceFiles, 'write_bytes', forbid)
    assert workspace_file_edits.resume(ctx, proposal['id'])
    assert calls == ['note.py']
    assert (root / 'note.py').read_text() == 'def ok():\n    return 4\n'
    assert not workspace_file_edits.resume(ctx, proposal['id'])


def test_invalid_json_is_refused_before_approval(setup):
    ctx, actor, work, proposal, root = _start(setup)
    (root / 'data.json').write_text('{"a": 1}\n')
    _call(ctx, 'read_workspace_lines', {'path': 'data.json'}, 'read1')
    advance(ctx, proposal['id'])
    sha = hashlib.sha256((root / 'data.json').read_bytes()).hexdigest()
    _call(ctx, 'write_workspace_file', {'path': 'data.json', 'content': '{"a":\n', 'baseline_sha256': sha})
    assert advance(ctx, proposal['id']) == 'running'
    result = ctx.repository.load().commands[proposal['id']].result['observations'][-1]['result']
    assert result['error_code'] == 'validation_error' and (root / 'data.json').read_text() == '{"a": 1}\n'


def test_create_without_baseline_and_partial_read_blocks_overwrite(setup):
    ctx, actor, work, proposal, root = _start(setup)
    (root / 'long.txt').write_text('one\n' * 300)
    _call(ctx, 'read_workspace_lines', {'path': 'long.txt', 'limit': 1}, 'read1')
    advance(ctx, proposal['id'])
    sha = hashlib.sha256((root / 'long.txt').read_bytes()).hexdigest()
    _call(ctx, 'write_workspace_file', {'path': 'long.txt', 'content': 'short\n', 'baseline_sha256': sha})
    advance(ctx, proposal['id'])
    assert ctx.repository.load().commands[proposal['id']].result['observations'][-1]['result']['error_code'] == 'workspace_file_stale'
    _call(ctx, 'write_workspace_file', {'path': 'fresh.txt', 'content': 'nuovo\n'}, 'create')
    assert advance(ctx, proposal['id']) == 'waiting_external'
    edit_id = ctx.repository.load().commands[proposal['id']].result['file_edit_request_id']
    workspace_file_edits.approve(ctx, actor, work, edit_id, {'digest': ctx.repository.load().commands[edit_id].result['digest']})
    assert (root / 'fresh.txt').read_text() == 'nuovo\n'
    assert WorkspaceFiles(root).write_bytes('fresh.txt', b'x', before_sha='0' * 64) == 'mismatch'
    assert (root / 'fresh.txt').read_text() == 'nuovo\n'
