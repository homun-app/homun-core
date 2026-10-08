"""Real Docker stdin: one approved background process receives one line."""
import json
import tempfile
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from homun.application import agent_runs, terminal_jobs
from homun.application.agent_run_execution import advance
from homun.application.agent_terminal import resume
from homun.application.agent_terminal_sessions import write_stdin
from homun.application.terminal_contracts import job_spec
from homun.context import create_context
from homun.domain.models import Actor
from homun.models.native_turn import NativeMessage, ToolCall

IMAGE = 'sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132'
COMMAND = "while IFS= read -r line; do printf '%s\\n' \"$line\" >> /workspace/got.txt; done"


def tool(call_id, name, arguments):
    return NativeMessage(role='assistant', tool_calls=[ToolCall(id=call_id, name=name, arguments=arguments)])


def main():
    output = Path('docs/research/evidence/2026-09-23-hermes-parity/terminal_stdin_docker.json')
    with tempfile.TemporaryDirectory(prefix='homun-terminal-stdin-') as temp:
        root = Path(temp).resolve()
        ctx = create_context(db_path=root / 'ws.db', data_dir=root, for_tests=True)
        ctx.models.set_active('openai_compatible')
        actor = Actor(id='proof', workspace_id=ctx.workspace_id, display_name='Proof')
        conversation = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'Stdin'})
        work_id = ctx.service.apply(actor, 'w', 'work.create', {
            'conversation_id': conversation['conversation_id'], 'title': 'Stdin',
            'objective': 'Start one background reader.'})['work_id']
        ctx.persist()
        proposal = agent_runs.propose(ctx, actor, work_id, {
            'command_id': uuid.uuid4().hex, 'expected_version': 1, 'material_ids': [], 'terminal_image': IMAGE})
        agent_runs.approve(ctx, actor, work_id, proposal['id'], {
            'command_id': 'approve-run', 'expected_version': proposal['expected_version'], 'digest': proposal['digest']})
        started = None
        backend = terminal_jobs.backend_for(ctx)
        try:
            ctx.models.complete_tools = lambda *_a, **_k: SimpleNamespace(
                message=tool('cmd1', 'terminal_execute', {'command': COMMAND, 'background': True}), usage=None)
            assert advance(ctx, proposal['id']) == 'waiting_external'
            run = ctx.repository.load().commands[proposal['id']].result
            job = ctx.repository.load().commands[run['terminal_request_id']].result
            assert job.get('stdin') is True and not backend.workspace(job_spec(ctx, job)).joinpath('got.txt').exists()
            terminal_jobs.approve(ctx, actor, work_id, job['id'], {'digest': job['digest']})
            assert resume(ctx, proposal['id'])
            started = job['id']
            with ctx.repository.transaction() as store:
                stored = store.commands[proposal['id']].result
                stored['status'] = 'running'
                stored['_messages'].append(tool('cmdw', 'terminal_write', {
                    'session_id': started, 'data': 'hello-stdin', 'newline': True}).model_dump())
            result = write_stdin(ctx, actor, ctx.repository.load().commands[proposal['id']].result, {
                'session_id': started, 'data': 'hello-stdin', 'newline': True})
            assert result['status'] == 'applied'
            spec = job_spec(ctx, ctx.repository.load().commands[started].result)
            found = ''
            for _ in range(20):
                path = backend.workspace(spec) / 'got.txt'
                if path.exists():
                    found = path.read_text()
                    if found == 'hello-stdin\n':
                        break
                time.sleep(0.1)
            assert found == 'hello-stdin\n'
            state = backend.inspect(spec)
            assert state['running'] is True
            evidence = {'image': IMAGE, 'container_started': True, 'stdin': 'pipe', 'pty': False,
                        'checks': {'no_file_before_write': True, 'one_line_delivered': True, 'process_still_running': True},
                        'container': state['container_id'], 'bytes': result['bytes']}
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(evidence, indent=2) + '\n')
            print(json.dumps(evidence, indent=2))
        finally:
            if started:
                try:
                    backend.remove(job_spec(ctx, ctx.repository.load().commands[started].result))
                except Exception:
                    pass
            ctx.close()


if __name__ == '__main__':
    main()
