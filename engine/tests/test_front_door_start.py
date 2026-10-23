"""«Procedi» in chat: il turno di ingresso avvia il lavoro confermato.

Il modello non dice mai di aver avviato qualcosa che non è partito: vede lo
stato vero dell'accordo e dell'esecuzione nel contesto, e per avviare chiama
`start_work`, che passa dallo stesso comando del motore della UI
(`work_start.start`) con la modalità di autonomia della conversazione.
"""
from homun.application.work.material_ingest import ingest_file
from homun.domain.models import Actor
from test_front_door import (Env, confirm_proposal, env, post_message, proposals,  # noqa: F401
                             script, text_message, tool_call)

SYNTHESIS_WORK = {
    'title': 'Nota operativa rinnovo Rossi',
    'objective': 'Preparare la nota operativa per il rinnovo del contratto Rossi',
    'output': 'Nota operativa breve',
    'capability': 'synthesize',
}


def _confirmed(env: Env, work=None) -> dict:
    script(env.ctx, tool_call('propose_work', dict(work or SYNTHESIS_WORK)))
    response = post_message(env, 'Prepara una nota operativa sul rinnovo Rossi.', command_id='ask')
    assert response.status_code == 200, response.text
    return confirm_proposal(env, response.json()['result']['intake_proposal'])


def _post(env: Env, text: str, command_id: str, autonomy: str | None = None):
    payload = {'conversation_id': env.conversation_id, 'text': text}
    if autonomy:
        payload['autonomy'] = autonomy
    return env.client.post('/v1/workspaces/ws_local/commands', headers=env.headers,
                           json={'command_id': command_id, 'type': 'conversation.post_message',
                                 'payload': payload})


def _execution(env: Env) -> dict:
    response = env.client.get(f'/v1/workspaces/ws_local/works/{env.work_id}/execution', headers=env.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _last_context(env: Env) -> str:
    calls = env.ctx.models._fake.native_calls
    return '\n'.join(str(m.get('content') or '') for m in calls[-1])


def test_go_ahead_on_a_confirmed_agreement_starts_the_work(env):
    _confirmed(env)
    script(env.ctx, tool_call('start_work', {'language': 'it'}))
    response = _post(env, 'Va bene, procedi pure.', 'go', autonomy='guarded')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    assert result['front_door']['kind'] == 'work_started'
    assert result['execution']['kind'] == 'synthesis'
    assert result['execution']['status'] == 'queued'
    assert _execution(env)['status'] == 'queued'
    assert result['assistant_text'].strip()


def test_supervised_go_ahead_prepares_the_start_and_waits(env):
    _confirmed(env)
    script(env.ctx, tool_call('start_work', {}))
    response = _post(env, 'Procedi.', 'go', autonomy='supervised')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    assert result['execution']['status'] == 'pending_approval'
    assert _execution(env)['status'] == 'pending_approval'


def test_start_without_a_confirmed_agreement_is_corrected_not_executed(env):
    script(env.ctx, tool_call('start_work', {}),
           text_message("Prima serve un accordo: dimmi cosa vuoi ottenere."))
    response = _post(env, 'Procedi.', 'go', autonomy='autonomous')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    assert result['front_door']['kind'] == 'text'
    assert 'execution' not in result
    # L'errore è tornato al modello come risultato dello strumento.
    tool_results = [m for m in env.ctx.models._fake.native_calls[-1] if m.get('role') == 'tool']
    assert tool_results and 'confirm' in tool_results[-1]['content'].lower()


def test_start_on_a_running_work_is_corrected_not_doubled(env):
    _confirmed(env)
    script(env.ctx, tool_call('start_work', {}))
    _post(env, 'Procedi.', 'go-1', autonomy='guarded')
    script(env.ctx, tool_call('start_work', {}), text_message('Il lavoro è già in corso.'))
    response = _post(env, 'Procedi di nuovo.', 'go-2', autonomy='guarded')
    result = response.json()['result']
    assert result['front_door']['kind'] == 'text'
    syntheses = env.client.get(f'/v1/workspaces/ws_local/works/{env.work_id}/syntheses',
                               headers=env.headers).json()['items']
    assert len(syntheses) == 1


def test_the_model_sees_the_real_execution_state(env):
    _confirmed(env)
    script(env.ctx, text_message('Va bene.'))
    _post(env, 'Ok', 'look-1')
    assert 'Esecuzione: non avviata' in _last_context(env)
    script(env.ctx, tool_call('start_work', {}))
    _post(env, 'Procedi.', 'go', autonomy='guarded')
    script(env.ctx, text_message('È in corso.'))
    _post(env, 'A che punto sei?', 'look-2')
    assert 'Esecuzione: in coda' in _last_context(env)


def test_a_failed_start_is_said_in_chat_never_silent(env):
    project = env.client.post('/v1/workspaces/ws_local/commands', headers=env.headers, json={
        'command_id': 'proj', 'type': 'project.create', 'payload': {'name': 'Fornitori'}}).json()['result']['project_id']
    version = env.client.get(f'/v1/workspaces/ws_local/works/{env.work_id}',
                             headers=env.headers).json()['work']['version']
    moved = env.client.post('/v1/workspaces/ws_local/commands', headers=env.headers, json={
        'command_id': 'move', 'type': 'work.set_project',
        'payload': {'work_id': env.work_id, 'project_id': project, 'expected_version': version}})
    assert moved.status_code == 200, moved.text
    actor = Actor(id='person_fabio', workspace_id=env.ctx.workspace_id, display_name='Fabio')
    for name in ('a.md', 'b.md'):
        ingest_file(env.ctx, actor, command_id=f'ingest-{name}', project_id=project,
                    filename=name, data=f'Testo {name}'.encode())
    _confirmed(env, {**SYNTHESIS_WORK, 'capability': 'read_material'})
    script(env.ctx, tool_call('start_work', {}))
    response = _post(env, 'Procedi.', 'go', autonomy='guarded')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    assert result['execution_error']['reason'] == 'work.start.materials_required'
    items = env.client.get(f'/v1/workspaces/ws_local/conversations/{env.conversation_id}/messages',
                           headers=env.headers).json()['items']
    engine_texts = [m['text'] for m in items if m['author_id'] == 'homun_engine']
    assert any('materiali' in text.lower() for text in engine_texts[-2:]), engine_texts[-2:]
