"""Real local model proof: search, guarded patch, approval, delivery.

Uses an isolated temporary profile. The terminal image is only the pinned
contract that enables the workspace; this proof does not start a container.
"""
import argparse
import hashlib
import json
import tempfile
import uuid
from pathlib import Path

from homun.application import agent_runs, workspace_file_edits, workspace_files, work_outputs
from homun.application.agent_run_execution import advance
from homun.context import create_context
from homun.domain.models import Actor


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = 'def ok():\n    return 1\n'
    with tempfile.TemporaryDirectory(prefix='homun-agent-edits-') as temp:
        root = Path(temp).resolve()
        ctx = create_context(db_path=root / 'ws.db', data_dir=root, for_tests=True)
        ctx.models.apply_ollama_preset(model='qwen3.5:4b')
        actor = Actor(id='proof', workspace_id=ctx.workspace_id, display_name='Proof')
        conversation = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'File edit proof'})
        work = ctx.service.apply(actor, 'w', 'work.create', {
            'conversation_id': conversation['conversation_id'], 'title': 'Patch a file',
            'objective': (
                'note.py already exists. Do not use terminal_execute. '
                'Call search_workspace_files with pattern "return" and target "content". '
                'Then read_workspace_lines path note.py. '
                'Then patch_workspace_file path note.py, old_string "return 1", new_string "return 7", '
                'baseline_sha256 equal to the sha256 from that read. '
                'After the patch result is applied, deliver_workspace_file path note.py '
                'using the sha256 from the patch result. Then finish, naming note.py.')})['work_id']
        ctx.persist()
        proposal = agent_runs.propose(ctx, actor, work, {
            'command_id': uuid.uuid4().hex, 'expected_version': 1, 'material_ids': [], 'terminal_image': args.image})
        agent_runs.approve(ctx, actor, work, proposal['id'], {
            'command_id': 'approve-run', 'expected_version': proposal['expected_version'], 'digest': proposal['digest']})
        workspace = workspace_files.root_for(ctx, ctx.repository.load().commands[proposal['id']].result)
        (workspace / 'note.py').write_text(source)
        edits = []
        try:
            status = None
            for _ in range(16):
                status = advance(ctx, proposal['id'])
                print('step', status, flush=True)
                if status == 'completed':
                    break
                if status == 'waiting_external':
                    run = ctx.repository.load().commands[proposal['id']].result
                    edit = ctx.repository.load().commands[run['file_edit_request_id']].result
                    assert edit['path'] == 'note.py' and edit['status'] == 'pending_approval'
                    assert hashlib.sha256(b'def ok():\n    return 7\n').hexdigest() == edit['after_sha256']
                    assert (workspace / 'note.py').read_text() == source
                    workspace_file_edits.approve(ctx, actor, work, edit['id'], {'digest': edit['digest']})
                    assert workspace_file_edits.resume(ctx, proposal['id'])
                    edits.append(edit['id'])
                    assert (workspace / 'note.py').read_text() == 'def ok():\n    return 7\n'
                else:
                    assert status == 'running', status
            assert status == 'completed', 'Model did not complete'
            delivered = work_outputs.list_for_work(ctx, actor, work)['items']
            assert len(delivered) == 1 and delivered[0]['filename'] == 'note.py'
            assert work_outputs.download(ctx, actor, work, delivered[0]['id'])[1] == b'def ok():\n    return 7\n'
            run = ctx.repository.load().commands[proposal['id']].result
            evidence = {
                'model': 'qwen3.5:4b via local Ollama', 'image': args.image,
                'container_started': False, 'edit_ids': edits,
                'checks': {
                    'search_then_patch_approved_once': len(edits) == 1,
                    'file_unchanged_until_approval': True,
                    'delivery_matches_patched_bytes': True,
                },
                'tools': [item['tool'] for item in run['observations']],
            }
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(evidence, indent=2) + '\n')
            print(json.dumps(evidence, indent=2))
        finally:
            ctx.close()


if __name__ == '__main__':
    main()
