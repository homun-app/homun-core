"""Real Docker PTY: one new background session is a terminal and gets one cursor reply."""
import json
import tempfile
import time
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
COMMAND = (
    "if [ -t 0 ]; then printf PTY_YES > /workspace/tty; else printf PTY_NO > /workspace/tty; fi; "
    "stty raw -echo; printf 'alpha\\033[6n\\n'; "
    "dd bs=1 count=6 of=/workspace/reply 2>/dev/null; printf done > /workspace/done; sleep 30"
)
REPLY = b'\x1b[1;1R'


def tool(call_id, name, arguments):
    return NativeMessage(role='assistant', tool_calls=[ToolCall(id=call_id, name=name, arguments=arguments)])


def main():
    output = Path('docs/research/evidence/2026-09-23-hermes-parity/terminal_pty_docker.json')
    with tempfile.TemporaryDirectory(prefix='homun-terminal-pty-') as temp:
        root = Path(temp).resolve()
        ctx = create_context(db_path=root / 'ws.db', data_dir=root, for_tests=True)
        ctx.models.set_active('openai_compatible')
        actor = Actor(id='proof', workspace_id=ctx.workspace_id, display_name='Proof')
        conversation = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'PTY'})
        work_id = ctx.service.apply(actor, 'w', 'work.create', {
            'conversation_id': conversation['conversation_id'], 'title': 'PTY',
            'objective': 'Start one terminal session.'})['work_id']
        ctx.persist()
        proposal = agent_runs.propose(ctx, actor, work_id, {
            'command_id': uuid.uuid4().hex, 'expected_version': 1, 'material_ids': [], 'terminal_image': IMAGE})
        agent_runs.approve(ctx, actor, work_id, proposal['id'], {
            'command_id': 'approve-run', 'expected_version': proposal['expected_version'], 'digest': proposal['digest']})
        started = None
        backend = terminal_jobs.backend_for(ctx)
        try:
            ctx.models.complete_tools = lambda *_a, **_k: SimpleNamespace(
                message=tool('cmd1', 'terminal_execute', {'command': COMMAND, 'background': True, 'pty': True}), usage=None)
            assert advance(ctx, proposal['id']) == 'waiting_external'
            run = ctx.repository.load().commands[proposal['id']].result
            job = ctx.repository.load().commands[run['terminal_request_id']].result
            assert job.get('pty') is True and job.get('stdin') is True
            terminal_jobs.approve(ctx, actor, work_id, job['id'], {'digest': job['digest']})
            assert resume(ctx, proposal['id'])
            started = job['id']
            spec = job_spec(ctx, ctx.repository.load().commands[started].result)
            found = b''
            flag = ''
            for _ in range(40):
                terminal_jobs.refresh(ctx, actor, work_id, started)
                flag_path = backend.workspace(spec) / 'tty'
                reply_path = backend.workspace(spec) / 'reply'
                if flag_path.exists():
                    flag = flag_path.read_text()
                if reply_path.exists():
                    found = reply_path.read_bytes()
                    if found == REPLY:
                        break
                time.sleep(0.15)
            state = backend.inspect(spec)
            assert flag == 'PTY_YES' and found == REPLY and state['running'] is True
            evidence = {'image': IMAGE, 'container_started': True, 'stdin': 'open', 'pty': True,
                        'checks': {'isatty': True, 'cursor_reply_once': True, 'process_still_running': True},
                        'container': state['container_id'], 'reply_bytes': len(found)}
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
