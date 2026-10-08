"""Two real Docker sessions: stopping one leaves the other running."""
import json
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace
from homun.application import agent_runs, terminal_jobs
from homun.application.agent_run_execution import advance
from homun.application.agent_terminal import resume
from homun.application.terminal_contracts import job_spec
from homun.context import create_context
from homun.domain.models import Actor
from homun.models.native_turn import NativeMessage, ToolCall

IMAGE = 'sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132'


def tool(call_id, name, arguments):
    return NativeMessage(role='assistant', tool_calls=[ToolCall(id=call_id, name=name, arguments=arguments)])


def main():
    output = Path('docs/research/evidence/2026-09-23-hermes-parity/terminal_background_docker.json')
    planned = [
        tool('cmd1', 'terminal_execute', {'command': 'sleep 30', 'background': True}),
        tool('cmd2', 'terminal_execute', {'command': 'sleep 30', 'background': True}),
        tool('cmd3', 'terminal_stop', {'session_id': ''}),
    ]
    with tempfile.TemporaryDirectory(prefix='homun-terminal-background-') as temp:
        root = Path(temp).resolve()
        ctx = create_context(db_path=root / 'ws.db', data_dir=root, for_tests=True)
        ctx.models.set_active('openai_compatible')
        actor = Actor(id='proof', workspace_id=ctx.workspace_id, display_name='Proof')
        conversation = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'Background sessions'})
        work_id = ctx.service.apply(actor, 'w', 'work.create', {
            'conversation_id': conversation['conversation_id'], 'title': 'Background sessions',
            'objective': 'Start two background sleeps, then stop only the first.'})['work_id']
        ctx.persist()
        proposal = agent_runs.propose(ctx, actor, work_id, {
            'command_id': uuid.uuid4().hex, 'expected_version': 1, 'material_ids': [], 'terminal_image': IMAGE})
        agent_runs.approve(ctx, actor, work_id, proposal['id'], {
            'command_id': 'approve-run', 'expected_version': proposal['expected_version'], 'digest': proposal['digest']})
        started = []
        backend = terminal_jobs.backend_for(ctx)
        try:
            def complete(*_args, **_kwargs):
                return SimpleNamespace(message=planned.pop(0), usage=None)
            ctx.models.complete_tools = complete
            for command_id in ('cmd1', 'cmd2'):
                assert advance(ctx, proposal['id']) == 'waiting_external'
                run = ctx.repository.load().commands[proposal['id']].result
                job = ctx.repository.load().commands[run['terminal_request_id']].result
                terminal_jobs.approve(ctx, actor, work_id, job['id'], {'digest': job['digest']})
                assert resume(ctx, proposal['id'])
                started.append(job['id'])
                assert command_id == job['_agent_binding']['call_id']
            planned[0] = tool('cmd3', 'terminal_stop', {'session_id': started[0]})
            first = terminal_jobs.refresh(ctx, actor, work_id, started[0])
            second = terminal_jobs.refresh(ctx, actor, work_id, started[1])
            assert first['status'] == 'running' and second['status'] == 'running'
            assert advance(ctx, proposal['id']) == 'running'
            first = terminal_jobs.refresh(ctx, actor, work_id, started[0])
            second = terminal_jobs.refresh(ctx, actor, work_id, started[1])
            specs = [job_spec(ctx, ctx.repository.load().commands[item].result) for item in started]
            states = [backend.inspect(spec) for spec in specs]
            assert first['status'] == 'exited' and second['status'] == 'running'
            assert states[0]['container_id'] != states[1]['container_id']
            assert states[1]['running'] is True
            evidence = {
                'image': IMAGE, 'model': 'scripted tool calls', 'container_started': True,
                'checks': {'both_running_before_stop': True, 'stopped_only_first': True,
                           'sibling_still_running': True, 'distinct_containers': True},
                'first_status': first['status'], 'second_status': second['status'],
                'first_container': states[0]['container_id'], 'second_container': states[1]['container_id']}
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(evidence, indent=2) + '\n')
            print(json.dumps(evidence, indent=2))
        finally:
            for item in started:
                try:
                    backend.remove(job_spec(ctx, ctx.repository.load().commands[item].result))
                except Exception:
                    pass
            ctx.close()


if __name__ == '__main__':
    main()
