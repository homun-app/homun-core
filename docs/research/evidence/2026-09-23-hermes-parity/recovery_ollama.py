"""Real-provider recovery proof: genuine network failure, durable wait, real retry.

No provider mock: the first model call hits a genuinely closed local port
(connection refused), the retry completes against real Ollama qwen3.5:4b, and a
separate scenario feeds Ollama a nonexistent model to observe a real HTTP 404
classified as a permanent typed failure. Run from repo with PYTHONPATH=engine/src.
"""
import json
import socket
from datetime import timedelta
from pathlib import Path
import tempfile
from homun.context import create_context
from homun.domain.models import Actor, utc_now
from homun.application.material_ingest import ingest_file
from homun.application.agent_runs import propose, approve
from homun.application.agent_run_execution import advance
from homun.application.budgets import public as budget_public

trace = {'scenarios': []}
root = Path(tempfile.mkdtemp(prefix='homun-recovery-live-'))
ctx = create_context(db_path=root / 'ws.db', data_dir=root, for_tests=True)
ctx.models.upsert_connection(connection_id='openai_compatible', kind='openai_compatible',
    display_name='Ollama', model_id='qwen3.5:4b', base_url='http://127.0.0.1:11434/v1',
    context_window=12288, max_output_tokens=1536)
ctx.models.set_active('openai_compatible')
provider = ctx.models._providers['openai_compatible']
actor = Actor(id='person_a', workspace_id=ctx.workspace_id, display_name='Fabio')

# Scenario A: real connection refused, durable wait, real retry.
project = ctx.service.apply(actor, 'p', 'project.create', {'name': 'Recovery parity'})['project_id']
conversation = ctx.service.apply(actor, 'c', 'conversation.create',
    {'title': 'Recupero', 'project_id': project})['conversation_id']
work = ctx.service.apply(actor, 'w', 'work.create', {'conversation_id': conversation,
    'title': 'Nota consegna', 'objective':
    'Leggi il documento allegato e prepara una breve nota italiana con la data di consegna. '
    'Non fare domande.'})['work_id']
ctx.persist()
material = ingest_file(ctx, actor, command_id='m', project_id=project, filename='accordo.txt',
    data='La consegna finale è prevista entro venerdì 16 ottobre 2026.'.encode())['material_id']
p = propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'material_ids': [material]})
approve(ctx, actor, work, p['id'], {'command_id': 'go', 'digest': p['digest'],
                                   'expected_version': p['expected_version']})

probe = socket.socket(); probe.bind(('127.0.0.1', 0)); dead_port = probe.getsockname()[1]; probe.close()
provider.base_url = f'http://127.0.0.1:{dead_port}/v1'  # nothing listens: real refusal

steps = []
steps.append({'step': 'failing_advance', 'status': advance(ctx, p['id'])})
run = ctx.repository.load().commands[p['id']].result
recovery = run.get('recovery')
steps.append({'step': 'after_failure', 'status': run['status'],
              'recovery': {k: recovery.get(k) for k in ('phase', 'status', 'attempts', 'error_code')},
              'wait_seconds': round((__import__('datetime').datetime.fromisoformat(
                  recovery['next_attempt_at']) - utc_now()).total_seconds(), 1),
              'lease_held': '_lease_token' in run})
steps.append({'step': 'advance_while_waiting', 'status': advance(ctx, p['id'])})

provider.base_url = 'http://127.0.0.1:11434/v1'  # real Ollama again
with ctx.repository.transaction() as store:  # make the wait due now
    store.commands[p['id']].result['recovery']['next_attempt_at'] = (
        utc_now() - timedelta(seconds=1)).isoformat()
statuses = []
for _ in range(6):
    statuses.append(advance(ctx, p['id']))
    if statuses[-1] in {'completed', 'failed', 'blocked', 'cancelled'}:
        break
final = ctx.repository.load().commands[p['id']].result
budget = budget_public(ctx.repository.load().work_budgets[work])
steps.append({'step': 'after_real_retry', 'statuses': statuses, 'final_status': final['status'],
              'recovery': {k: final.get('recovery', {}).get(k) for k in ('phase', 'status', 'attempts')},
              'model_attempts': final['model_attempts'], 'turns': final['turns'],
              'budget': {'spent': budget['spent'], 'unknown': budget['unknown']}})
artifacts = ctx.repository.load().artifacts
steps.append({'step': 'artifact', 'count': len(artifacts),
              'title': next(iter(artifacts.values())).title if artifacts else None,
              'has_delivery_date': '16 ottobre' in next(iter(artifacts.values())).content if artifacts else False})
trace['scenarios'].append({'name': 'A: connection refused then real Ollama retry', 'steps': steps})

# Scenario B: real Ollama 404 for a nonexistent model is permanent, not retried.
ctx.models.upsert_connection(connection_id='openai_compatible', kind='openai_compatible',
    display_name='Ollama', model_id='homun-nonexistent-model', base_url='http://127.0.0.1:11434/v1')
work_b = ctx.service.apply(actor, 'w2', 'work.create', {'conversation_id': conversation,
    'title': 'Modello assente', 'objective': 'Produci una riga di testo.'})['work_id']
ctx.persist()
material_b = ingest_file(ctx, actor, command_id='m2', project_id=project, filename='vuoto.txt',
    data=b'Nessun contenuto utile.')['material_id']
q = propose(ctx, actor, work_b, {'command_id': 'runb', 'expected_version': 1, 'material_ids': [material_b]})
approve(ctx, actor, work_b, q['id'], {'command_id': 'gob', 'digest': q['digest'],
                                     'expected_version': q['expected_version']})
steps_b = [{'step': 'advance', 'status': advance(ctx, q['id'])}]
run_b = ctx.repository.load().commands[q['id']].result
steps_b.append({'step': 'result', 'status': run_b['status'], 'error_code': run_b.get('error_code'),
                'recovery': run_b.get('recovery'), 'lease_held': '_lease_token' in run_b,
                'work_status': ctx.repository.load().works[work_b].status.value
                if hasattr(ctx.repository.load().works[work_b].status, 'value')
                else str(ctx.repository.load().works[work_b].status)})
trace['scenarios'].append({'name': 'B: real Ollama 404 nonexistent model', 'steps': steps_b})

out = Path('docs/research/evidence/2026-09-23-hermes-parity/recovery_ollama.json')
out.write_text(json.dumps(trace, indent=1, ensure_ascii=False, default=str) + '\n')
print(json.dumps(trace, indent=1, ensure_ascii=False, default=str))
