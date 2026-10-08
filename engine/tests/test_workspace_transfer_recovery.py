"""Crash and authorization boundaries of the canonical workspace transfer."""
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from homun.application import agent_runs, session_runtime, session_workspace
from homun.application.agent_run_execution import advance, _claim
from homun.application.workspace_files import root_for
from homun.models.native_turn import NativeMessage
from homun.domain.errors import DomainError


def prepared(setup):
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    p = agent_runs.propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'terminal_backend': 'local', 'material_ids': [material]})
    agent_runs.approve(ctx, actor, work, 'run', {'command_id': 'approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    source = root_for(ctx, ctx.repository.load().commands['run'].result)
    (source/'note').write_bytes(b'original')
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant', content='Done'), usage=None)
    assert advance(ctx, 'run') == 'completed'
    args = {'action': 'resume', 'session_id': 'run', 'command_id': 'transfer', 'instruction': 'Continue', 'workspace_mode': 'current_files', 'proposal': {'terminal_backend': 'local'}}
    p = session_runtime.execute(ctx, actor, work, args)['proposal']
    assert session_runtime.execute(ctx, actor, work, args)['proposal'] == p
    agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'approve-transfer', 'digest': p['digest'], 'expected_version': p['expected_version']})
    _, run = _claim(ctx, p['id'])
    return ctx, actor, run, source, material


@pytest.mark.parametrize('tamper', [None, 'extra', 'symlink', 'bytes'])
def test_publication_before_receipt_recovers_only_exact_tree(setup, monkeypatch, tamper):
    from homun.context import create_context
    ctx, actor, run, source, _ = prepared(setup)
    rename = session_workspace.os.rename
    def crash_after_publish(src, dst):
        rename(src, dst)
        raise RuntimeError('engine crash after publication')
    monkeypatch.setattr(session_workspace.os, 'rename', crash_after_publish)
    with pytest.raises(RuntimeError):
        session_workspace.materialize(ctx, actor, run)
    assert ctx.repository.load().commands[run['id']].result['workspace_transfer']['status'] == 'prepared'
    root = root_for(ctx, run)
    if tamper == 'extra':
        (root/'extra').write_text('unapproved')
    elif tamper == 'symlink':
        (root/'extra').symlink_to(source/'note')
    elif tamper == 'bytes':
        (root/'note').write_text('changed')
    reopened = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        if tamper:
            with pytest.raises(DomainError):
                session_workspace.materialize(reopened, actor, run)
            assert reopened.repository.load().commands[run['id']].result['model_attempts'] == 0
        else:
            session_workspace.materialize(reopened, actor, run)
            assert reopened.repository.load().commands[run['id']].result['workspace_transfer']['status'] == 'ready'
            (root/'note').write_text('legitimate new run write')
            session_workspace.materialize(reopened, actor, run)
            assert (root/'note').read_text() == 'legitimate new run write'
    finally:
        reopened.close()


@pytest.mark.parametrize('failure', ['revoked', 'blob', 'destination-symlink', 'destination-conflict'])
def test_transfer_blocks_before_model_io_when_authority_or_bytes_change(setup, failure):
    ctx, actor, run, source, material = prepared(setup)
    root = root_for(ctx, run)
    if failure == 'revoked':
        with ctx.repository.transaction() as store:
            del store.materials[material]
    elif failure == 'blob':
        from homun.application.session_workspace_capture import blob_root
        entry = run['workspace_transfer']['manifest']['files'][0]
        path = blob_root(ctx.data_dir)/entry['sha256']
        path.chmod(0o600)
        path.write_bytes(b'corrupt')
    elif failure == 'destination-symlink':
        root.rmdir()
        root.symlink_to(source, target_is_directory=True)
    else:
        (root/'unrelated').write_text('keep')
    with pytest.raises(DomainError):
        session_workspace.materialize(ctx, actor, run)
    assert ctx.repository.load().commands[run['id']].result['model_attempts'] == 0
    assert (source/'note').read_bytes() == b'original'


def test_side_question_cannot_bypass_workspace_ready_gate(setup):
    from homun.application.agent_side_questions import answer_side_question
    ctx, actor, run, _, _ = prepared(setup)
    ctx.models.complete_summary = lambda *a, **k: pytest.fail('Provider called before transfer receipt')
    with pytest.raises(DomainError):
        answer_side_question(ctx, actor, run['work_id'], run['id'], 'Read workspace')
    assert ctx.repository.load().commands[run['id']].result['model_attempts'] == 0


def test_partial_staging_failure_is_retryable_without_destination_writes(setup, monkeypatch):
    ctx, actor, run, _, _ = prepared(setup)
    original = session_workspace._verify
    monkeypatch.setattr(session_workspace, '_verify', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('partial staging failure')))
    with pytest.raises(RuntimeError):
        session_workspace.materialize(ctx, actor, run)
    root = root_for(ctx, run)
    assert not list(root.iterdir())
    monkeypatch.setattr(session_workspace, '_verify', original)
    session_workspace.materialize(ctx, actor, run)
    assert (root/'note').read_bytes() == b'original'


def test_source_file_changes_after_capture_do_not_replace_approved_bytes(setup):
    ctx, actor, run, source, _ = prepared(setup)
    (source/'note').write_bytes(b'later source content')
    session_workspace.materialize(ctx, actor, run)
    assert (root_for(ctx, run)/'note').read_bytes() == b'original'
    assert (source/'note').read_bytes() == b'later source content'


def test_historical_fork_current_files_are_explicit_not_historical(setup):
    ctx, actor, run, source, _ = prepared(setup)
    work = run['workspace_transfer']['manifest']['work_id']
    branch = session_runtime.execute(ctx, actor, work, {'action': 'fork', 'session_id': 'run', 'command_id': 'branch'})['session']
    history = session_runtime.execute(ctx, actor, work, {'action': 'resume', 'session_id': branch['id'], 'command_id': 'history-only', 'instruction': 'Continue'})['proposal']
    assert 'workspace_transfer' not in history
    current = session_runtime.execute(ctx, actor, work, {'action': 'resume', 'session_id': branch['id'], 'command_id': 'branch-files', 'instruction': 'Continue', 'workspace_mode': 'current_files', 'proposal': {'terminal_backend': 'local'}})['proposal']
    assert current['workspace_transfer']['historical_checkpoint'] is False
    assert current['workspace_transfer']['mode'] == 'current_files'


def test_revoked_transfer_redacts_manifest_metadata_from_run_projection(setup):
    ctx, actor, run, _, material = prepared(setup)
    with ctx.repository.transaction() as store:
        del store.materials[material]
    view = next(item for item in agent_runs.list_runs(ctx, actor, run['work_id'])['items'] if item['id'] == run['id'])
    assert view['history_redacted'] is True
    assert 'workspace_transfer' not in view and 'execution_context' not in view


def test_corrupt_publication_marker_is_typed_and_cannot_admit_execution(setup, monkeypatch):
    ctx, actor, run, _, _ = prepared(setup)
    rename = session_workspace.os.rename
    def crash_after_publish(src, dst):
        rename(src, dst)
        raise RuntimeError('crash')
    monkeypatch.setattr(session_workspace.os, 'rename', crash_after_publish)
    with pytest.raises(RuntimeError):
        session_workspace.materialize(ctx, actor, run)
    (root_for(ctx, run)/'.homun-transfer.json').write_text('{truncated')
    with pytest.raises(DomainError):
        session_workspace.materialize(ctx, actor, run)


def test_target_authority_is_rechecked_inside_publication_transaction(setup):
    ctx, actor, run, _, _ = prepared(setup)
    with ctx.repository.transaction() as store:
        store.works[run['work_id']].owner_id = 'new-owner'
        store.works[run['work_id']].reviewer_id = 'new-reviewer'
    with pytest.raises(DomainError):
        session_workspace.materialize(ctx, actor, run)
    root = root_for(ctx, run)
    assert not list(root.iterdir())
    current = ctx.repository.load().commands[run['id']].result
    assert current['workspace_transfer']['status'] == 'prepared'
    assert current['model_attempts'] == 0


@pytest.mark.parametrize('tamper', [None, 'intermediate-source', 'intermediate-access'])
def test_nested_fork_workspace_source_is_resolved_and_authorized(setup, tamper):
    ctx, actor, run, _, material = prepared(setup)
    work = run['workspace_transfer']['manifest']['work_id']
    for parent, child in [('run', 'fork1'), ('fork1', 'fork2')]:
        session_runtime.execute(ctx, actor, work, {'action': 'fork', 'session_id': parent, 'command_id': child})
    if tamper:
        with ctx.repository.transaction() as store:
            if tamper == 'intermediate-source':
                store.commands['fork1'].result['sources'][0]['revision'] = '0'*64
            else:
                store.commands['fork1'].result['materials'][0]['id'] = 'missing'
    args = {'action': 'resume', 'session_id': 'fork2', 'command_id': 'nested-files', 'instruction': 'Continue', 'workspace_mode': 'current_files', 'proposal': {'terminal_backend': 'local'}}
    if tamper:
        with pytest.raises(DomainError):
            session_runtime.execute(ctx, actor, work, args)
        return
    p = session_runtime.execute(ctx, actor, work, args)['proposal']
    assert p['workspace_transfer']['historical_checkpoint'] is False
    assert p['workspace_transfer']['manifest']['run_id'] == 'run'
    agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'nested-approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    def continued_model(*args, **kwargs):
        target = ctx.repository.load().commands[p['id']].result
        assert (root_for(ctx, target)/'note').read_bytes() == b'original'
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Read restored files'), usage=None)
    ctx.models.complete_tools = continued_model
    assert advance(ctx, p['id']) == 'completed'


@pytest.mark.parametrize('tamper', ['cycle', 'ambiguous'])
def test_workspace_lineage_rejects_cycles_and_multiple_canonical_roots(setup, tamper):
    from copy import deepcopy
    from homun.application.session_workspace_lineage import workspace_source
    from homun.application.session_records import revision, rows
    ctx, actor, run, _, _ = prepared(setup)
    work = run['workspace_transfer']['manifest']['work_id']
    session_runtime.execute(ctx, actor, work, {'action': 'fork', 'session_id': 'run', 'command_id': 'fork'})
    with ctx.repository.transaction() as store:
        branch = store.commands['fork']
        if tamper == 'cycle':
            branch.result['sources'] = [{'work_id': work, 'session_id': 'fork', 'count': len(rows(branch)), 'revision': revision(rows(branch))}]
        else:
            other = store.commands['run'].model_copy(deep=True)
            other.result['id'] = 'second-source'
            store.commands['second-source'] = other
            branch.result['sources'].append({'work_id': work, 'session_id': 'second-source', 'count': len(rows(other)), 'revision': revision(rows(other))})
    with pytest.raises(DomainError):
        workspace_source(ctx.repository.load(), actor, work, 'fork')
