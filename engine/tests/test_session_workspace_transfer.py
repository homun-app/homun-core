"""Canonical continuation restores approved bytes into one owned execution context."""
from pathlib import Path
import pytest
from test_agent_runs import setup
from test_local_jobs import finished
from homun.application import agent_runs
from homun.application.workspace_files import root_for
from homun.execution.contracts import LocalJobSpec
from homun.execution.local_jobs import LocalJobs


def test_terminal_prompt_and_file_tools_share_backend_owned_root(setup):
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    agent_runs.propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'terminal_backend': 'local'})
    run = ctx.repository.load().commands['run'].result
    assert Path(run['_workspace_root']) == root_for(ctx, run)
    assert Path(run['_cwd']) == root_for(ctx, run)


def test_local_command_runs_in_confined_nested_cwd(tmp_path):
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws', run_id='run', call_id='read',
                        command='cat note.txt > "$HOME/result.txt"', cwd='nested')
    root = jobs.workspace(spec)
    (root/'nested').mkdir()
    (root/'nested/note.txt').write_bytes(b'approved bytes')
    jobs.start(spec)
    assert finished(jobs, spec)['exit_code'] == 0
    assert (root/'result.txt').read_bytes() == b'approved bytes'


@pytest.mark.parametrize('backend,deadline', [('docker', None), ('local', None), ('local', '2026-10-01T10:00:00+00:00')])
def test_default_cwd_preserves_preexisting_job_contract_hash(backend, deadline):
    from homun.execution.contracts import JobSpec, digest
    raw = {'workspace_id': 'ws', 'run_id': 'run', 'call_id': 'call', 'command': 'true'}
    if backend == 'docker':
        raw['image'] = 'sha256:' + 'a'*64
        spec = JobSpec(**raw)
        policy = 'docker-offline-v1'
    else:
        if deadline:
            raw['deadline_at'] = deadline
        spec = LocalJobSpec(**raw)
        policy = 'local-private-v1'
    assert spec.contract == digest({'spec': raw, 'policy': policy})
    assert spec.model_copy(update={'cwd': 'nested'}).contract != spec.contract


def test_approved_continuation_restores_bytes_before_first_model_call(setup):
    from types import SimpleNamespace
    from homun.application import session_runtime
    from homun.application.agent_run_execution import advance
    from homun.models.native_turn import NativeMessage
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    proposal = agent_runs.propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'terminal_backend': 'local'})
    agent_runs.approve(ctx, actor, work, 'run', {'command_id': 'start', 'digest': proposal['digest'], 'expected_version': proposal['expected_version']})
    jobs = LocalJobs(ctx.data_dir.resolve()/'execution')
    spec = LocalJobSpec(workspace_id=ctx.workspace_id, run_id='run', call_id='source-write', command='mkdir nested; printf approved-bytes > nested/note.txt')
    jobs.start(spec)
    assert finished(jobs, spec)['exit_code'] == 0
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant', content='Done'), usage=None)
    assert advance(ctx, 'run') == 'completed'
    result = session_runtime.execute(ctx, actor, work, {'action': 'resume', 'session_id': 'run', 'command_id': 'continue-files',
        'instruction': 'Read the existing note', 'workspace_mode': 'current_files', 'execution_cwd': 'nested',
        'proposal': {'terminal_backend': 'local', 'connection_id': 'openai_compatible'}})
    target = result['proposal']
    assert target['workspace_transfer']['manifest']['cwd'] == 'nested'
    target_root = jobs.workspace(spec.model_copy(update={'run_id': target['id']}))
    assert not (target_root/'nested/note.txt').exists()
    agent_runs.approve(ctx, actor, target['work_id'], target['id'], {'command_id': 'continue-approve', 'digest': target['digest'], 'expected_version': target['expected_version']})
    def restored_model(*args, **kwargs):
        assert (target_root/'nested/note.txt').read_bytes() == b'approved-bytes'
        from homun.models.native_turn import ToolCall
        return SimpleNamespace(message=NativeMessage(role='assistant', tool_calls=[ToolCall(id='read-restored', name='terminal_execute', arguments={'command': 'cat note.txt > result.txt'})]), usage=None)
    ctx.models.complete_tools = restored_model
    assert advance(ctx, target['id']) == 'waiting_external'
    from homun.application import terminal_jobs
    from homun.application.terminal_contracts import job_spec
    saved = ctx.repository.load().commands[target['id']].result
    terminal = ctx.repository.load().commands[saved['terminal_request_id']].result
    assert job_spec(ctx, terminal).cwd == 'nested'
    terminal_jobs.approve(ctx, actor, target['work_id'], terminal['id'], {'digest': terminal['digest']})
    terminal = ctx.repository.load().commands[terminal['id']].result
    assert finished(jobs, job_spec(ctx, terminal))['exit_code'] == 0
    assert (target_root/'nested/result.txt').read_bytes() == b'approved-bytes'
    assert (jobs.workspace(spec)/'nested/note.txt').read_bytes() == b'approved-bytes'
    saved = ctx.repository.load().commands[target['id']].result
    assert saved['workspace_transfer']['status'] == 'ready'


def test_repeated_local_start_returns_receipt_after_command_removed_cwd(tmp_path):
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws', run_id='run', call_id='remove', cwd='nested', command='cd ..; rmdir nested')
    (jobs.workspace(spec)/'nested').mkdir()
    jobs.start(spec)
    assert finished(jobs, spec)['exit_code'] == 0
    assert jobs.start(spec)['exit_code'] == 0


def test_docker_contract_uses_shared_root_nested_cwd_and_replays_without_cwd(tmp_path):
    from test_docker_jobs import FakeDocker, spec
    from homun.execution.docker import DockerJobs
    docker = FakeDocker()
    jobs = DockerJobs(tmp_path, client=docker)
    job = spec(cwd='nested')
    root = jobs.workspace(job)
    assert root == LocalJobs(tmp_path).workspace(LocalJobSpec(workspace_id='ws', run_id='run', call_id='call', command='true'))
    (root/'nested').mkdir()
    jobs.start(job)
    argv = next(call for call in docker.calls if call[0] == 'run')
    assert '--workdir=/workspace/nested' in argv
    assert f'type=bind,src={root},dst=/workspace' in argv
    (root/'nested').rmdir()
    jobs.start(job)
    assert sum(call[0] == 'run' for call in docker.calls) == 1


@pytest.mark.parametrize('selection', [{'command_id': [], 'digest': 'a'*64}, {'command_id': 'missing', 'digest': 3}, ['not', 'a', 'reference']])
def test_malformed_transfer_reference_is_typed(setup, selection):
    from homun.domain.errors import DomainError
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    with pytest.raises(DomainError):
        agent_runs.propose(ctx, actor, work, {'command_id': 'malformed', 'expected_version': 1, 'terminal_backend': 'local', 'workspace_transfer': selection})
