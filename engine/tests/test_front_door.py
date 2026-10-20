"""Il turno di ingresso nativo: ogni messaggio passa da UNA chiamata a strumenti.

Il modello propone (testo, chiarimento, proposta di accordo, modifica del
piano); il motore valida e decide. Gli errori del modello sono esiti da
correggere, non crash: l'errore di validazione torna al modello come risultato
dello strumento, al massimo due giri per turno.
"""
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.models.native_errors import EMPTY, INVALID_REQUEST, MALFORMED, NETWORK, NativeModelError
from homun.models.native_turn import NativeMessage, NativeResult, ToolCall
from homun.models.types import UsageEntry


@dataclass
class Env:
    ctx: object
    client: TestClient
    headers: dict
    conversation_id: str
    work_id: str


@pytest.fixture(autouse=True)
def _clean_mode_memory():
    from homun.models import structured_fallback
    structured_fallback.reset_mode_memory()
    yield
    structured_fallback.reset_mode_memory()


@pytest.fixture
def env(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    headers = {'X-Homun-Actor-Id': 'person_fabio'}
    conversation_id = client.post(
        '/v1/workspaces/ws_local/commands', headers=headers,
        json={'command_id': 'conv', 'type': 'conversation.create', 'payload': {'title': 'Test porta d\'ingresso'}},
    ).json()['result']['conversation_id']
    work_id = client.post(
        '/v1/workspaces/ws_local/commands', headers=headers,
        json={'command_id': 'work', 'type': 'work.create',
              'payload': {'conversation_id': conversation_id, 'title': 'Nuova richiesta',
                          'objective': 'Obiettivo da concordare'}},
    ).json()['result']['work_id']
    yield Env(ctx, client, headers, conversation_id, work_id)
    client.close()
    reset_context_for_tests(None)


def _usage() -> UsageEntry:
    return UsageEntry(id='usage_test', provider_id='fake', model_id='fake-deterministic-v1',
                      input_tokens=4, output_tokens=4, status='ok')


def text_message(text: str) -> NativeMessage:
    return NativeMessage(role='assistant', content=text)


def tool_call(name: str, arguments: dict, *, call_id: str = 'call_1') -> NativeMessage:
    return NativeMessage(role='assistant', content='', tool_calls=[
        ToolCall(id=call_id, name=name, arguments=arguments)])


def script(ctx, *items) -> None:
    """Risposte native scripted del provider fake, consumate in ordine."""
    ctx.models._fake.native_script = list(items)


def post_message(env: Env, text: str, command_id: str = 'msg'):
    return env.client.post(
        '/v1/workspaces/ws_local/commands', headers=env.headers,
        json={'command_id': command_id, 'type': 'conversation.post_message',
              'payload': {'conversation_id': env.conversation_id, 'text': text}},
    )


VALID_WORK = {
    'title': 'Nota operativa rinnovo Rossi',
    'objective': 'Preparare la nota operativa per il rinnovo del contratto Rossi',
    'output': 'Nota operativa breve',
    'capability': 'general',
}


def proposals(env: Env) -> list[dict]:
    response = env.client.get(f'/v1/workspaces/ws_local/works/{env.work_id}/intake', headers=env.headers)
    return response.json()['items']


# -- testo -------------------------------------------------------------------


def test_text_reply_becomes_assistant_message(env):
    script(env.ctx, text_message('Ciao! Sono Homun, il tuo assistente di lavoro.'))
    response = post_message(env, 'Cosa sai fare?')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    assert result['assistant_text'].startswith('Ciao!')
    messages = env.client.get(
        f'/v1/workspaces/ws_local/conversations/{env.conversation_id}/messages',
        headers=env.headers).json()['items']
    assert any(m['author_id'] == 'homun_engine' and m['text'].startswith('Ciao!') for m in messages)
    assert not proposals(env), 'una risposta testuale non crea proposte'


def test_ask_clarification_ends_the_turn_with_questions(env):
    script(env.ctx, tool_call('ask_clarification', {
        'questions': [{'question': 'Per quando ti serve la relazione?'},
                      {'question': 'Quali fornitori ti interessano?', 'choices': ['Diretti', 'Indiretti']}]}))
    response = post_message(env, 'Crea una relazione sui fornitori 2027')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    questions = (result.get('front_door') or {}).get('questions') or []
    assert [q['question'] for q in questions] == [
        'Per quando ti serve la relazione?', 'Quali fornitori ti interessano?']
    assert 'Per quando ti serve la relazione?' in result['assistant_text']
    assert not proposals(env), 'un chiarimento non crea proposte'


# -- propose_work ------------------------------------------------------------


def test_propose_work_creates_pending_confirmation_proposal(env):
    script(env.ctx, tool_call('propose_work', {
        **VALID_WORK, 'unknown_extra_key': 'ignorato',
        'constraints': None, 'missing_information': None}))
    response = post_message(env, 'Prepara una nota operativa: rinnovo contratto Rossi entro il 30 novembre.')
    assert response.status_code == 200, response.text
    proposal = response.json()['result']['intake_proposal']
    assert proposal['status'] == 'pending_confirmation', proposal
    assert proposal['title'] == VALID_WORK['title']
    assert proposal['constraints'] == []
    assert proposal['missing_information'] == []
    # Stesso record, stessa UI della proposta del primo messaggio.
    items = proposals(env)
    assert [p['id'] for p in items if p['status'] == 'pending_confirmation'] == [proposal['id']]
    # Nessun lavoro avviato senza conferma: il lavoro resta in bozza.
    work = env.client.get(f'/v1/workspaces/ws_local/works/{env.work_id}', headers=env.headers).json()['work']
    assert work['status'] == 'draft'


def test_propose_work_from_conversation_without_work_creates_it(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    headers = {'X-Homun-Actor-Id': 'person_fabio'}
    try:
        conversation_id = client.post(
            '/v1/workspaces/ws_local/commands', headers=headers,
            json={'command_id': 'conv', 'type': 'conversation.create', 'payload': {'title': 'Senza lavoro'}},
        ).json()['result']['conversation_id']
        script(ctx, tool_call('propose_work', dict(VALID_WORK)))
        response = client.post(
            '/v1/workspaces/ws_local/commands', headers=headers,
            json={'command_id': 'msg', 'type': 'conversation.post_message',
                  'payload': {'conversation_id': conversation_id, 'text': 'Prepara una nota sui fornitori.'}})
        assert response.status_code == 200, response.text
        proposal = response.json()['result']['intake_proposal']
        assert proposal['status'] == 'pending_confirmation'
        works = client.get('/v1/workspaces/ws_local/works', headers=headers).json()['items']
        assert any(w['id'] == proposal['work_id'] for w in works), 'il lavoro della proposta non esiste'
    finally:
        client.close()
        reset_context_for_tests(None)


def test_invalid_capability_returns_error_to_model_then_corrects(env):
    script(env.ctx,
           tool_call('propose_work', {**VALID_WORK, 'capability': 'volo_magico'}, call_id='call_bad'),
           tool_call('propose_work', VALID_WORK, call_id='call_good'))
    response = post_message(env, 'Prepara una nota operativa.')
    assert response.status_code == 200, response.text
    assert response.json()['result']['intake_proposal']['status'] == 'pending_confirmation'
    calls = env.ctx.models._fake.native_calls
    assert len(calls) == 2, 'il secondo giro deve riusare lo stesso turno'
    tool_results = [m for m in calls[1] if m['role'] == 'tool']
    assert tool_results, 'l\'errore di validazione deve tornare al modello come risultato dello strumento'
    assert tool_results[0]['tool_call_id'] == 'call_bad'
    assert 'capability' in tool_results[0]['content'].lower()


def test_unknown_plan_step_assignee_returns_error_to_model(env):
    script(env.ctx,
           tool_call('propose_work', {**VALID_WORK,
                                      'plan_steps': [{'title': 'Fase legale', 'assignee': 'Avvocato Inesistente'}]},
                     call_id='call_bad'),
           tool_call('propose_work', {**VALID_WORK, 'plan_steps': [{'title': 'Fase legale', 'assignee': ''}]},
                     call_id='call_good'))
    response = post_message(env, 'Prepara una nota con una fase legale.')
    assert response.status_code == 200, response.text
    proposal = response.json()['result']['intake_proposal']
    assert proposal['status'] == 'pending_confirmation'
    assert proposal['plan_steps'][0]['title'] == 'Fase legale'
    # The correction names the offender and what is allowed: the model can act on it.
    tool_result = next(m for m in env.ctx.models._fake.native_calls[1] if m['role'] == 'tool')
    assert "'Avvocato Inesistente'" in tool_result['content']
    assert 'leave assignee empty' in tool_result['content']


def test_three_invalid_argument_rounds_raise_output_invalid(env):
    script(env.ctx, *(tool_call('propose_work', {**VALID_WORK, 'capability': f'mai_{index}'},
                                call_id=f'call_{index}') for index in range(3)))
    response = post_message(env, 'Prepara una nota operativa.')
    assert response.status_code == 400, response.text
    detail = response.json()['detail']
    assert detail['code'] == 'model.output_invalid'
    record = env.ctx.repository.load().commands['msg']
    assert record.followup_status == 'failed'
    assert record.followup_error == 'model.output_invalid'
    assert record.followup_next_attempt_at is None, 'model.output_invalid non si ripete in automatico'


def test_missing_required_fields_return_error_to_model(env):
    script(env.ctx,
           tool_call('propose_work', {'title': 'Solo titolo'}, call_id='call_bad'),
           tool_call('propose_work', VALID_WORK, call_id='call_good'))
    response = post_message(env, 'Prepara una nota operativa.')
    assert response.status_code == 200, response.text
    assert response.json()['result']['intake_proposal']['status'] == 'pending_confirmation'


# -- risposta vuota ----------------------------------------------------------


def test_empty_response_twice_raises_empty_response(env):
    script(env.ctx, text_message(''), text_message(''))
    response = post_message(env, 'Cosa sai fare?')
    assert response.status_code == 400, response.text
    detail = response.json()['detail']
    assert detail['code'] == 'model.empty_response'
    record = env.ctx.repository.load().commands['msg']
    assert record.followup_status == 'failed'
    assert record.followup_next_attempt_at is None, 'model.empty_response non si ripete in automatico'


def test_empty_response_once_recovers_with_reminder(env):
    script(env.ctx, text_message(''), text_message('Ora rispondo: sono Homun.'))
    response = post_message(env, 'Cosa sai fare?')
    assert response.status_code == 200, response.text
    assert response.json()['result']['assistant_text'].startswith('Ora rispondo')


def test_transport_empty_twice_is_model_empty_response_not_provider_unavailable(env):
    """Il trasporto classifica una risposta senza testo né strumenti come EMPTY:
    dopo il promemoria il turno finisce in model.empty_response, mai in un
    provider_unavailable ripetibile in automatico."""
    from homun.application.ops.preferences import set_person_language
    set_person_language(env.ctx, 'person_fabio', 'it')
    script(env.ctx, NativeModelError(EMPTY, 'neither tools nor a final answer'),
           NativeModelError(EMPTY, 'neither tools nor a final answer'))
    response = post_message(env, 'Dimmi qualcosa.')
    assert response.status_code == 400, response.text
    assert response.json()['detail']['code'] == 'model.empty_response'
    assert len(env.ctx.models._fake.native_calls) == 2, 'un promemoria, un nuovo tentativo, poi basta'
    reminder = env.ctx.models._fake.native_calls[1][-1]
    assert reminder['role'] == 'user' and 'vuota' in reminder['content'].lower()
    record = env.ctx.repository.load().commands['msg']
    assert record.followup_next_attempt_at is None


def test_malformed_output_gets_a_correction_round_then_output_invalid(env):
    """JSON rotto o risposta troncata sono errori del modello: una nota di
    correzione in lingua, poi model.output_invalid; mai provider_unavailable."""
    from homun.application.ops.preferences import set_person_language
    set_person_language(env.ctx, 'person_fabio', 'it')
    script(env.ctx, NativeModelError(MALFORMED, 'bad json in tool arguments'),
           text_message('Riprovo: sono Homun.'))
    response = post_message(env, 'Cosa sai fare?')
    assert response.status_code == 200, response.text
    assert response.json()['result']['assistant_text'].startswith('Riprovo')
    note = env.ctx.models._fake.native_calls[1][-1]
    assert note['role'] == 'user' and 'non era valida' in note['content']

    script(env.ctx, *(NativeModelError(MALFORMED, f'broken {i}') for i in range(3)))
    response = post_message(env, 'Cosa sai fare?', command_id='msg2')
    assert response.status_code == 400, response.text
    assert response.json()['detail']['code'] == 'model.output_invalid'
    assert env.ctx.repository.load().commands['msg2'].followup_next_attempt_at is None


# -- tolleranza della forma --------------------------------------------------


def test_null_lists_and_extra_keys_are_accepted(env):
    script(env.ctx, tool_call('propose_work', {
        **VALID_WORK,
        'constraints': None,
        'missing_information': 'Perimetro da confermare',
        'plan_steps': [{'title': 'Raccolta', 'expected_materials': 'Elenco fornitori', 'surprise': True}],
        'changed_fields': 'title',
        'rationale': None,
        'model_invented_field': {'a': 1},
    }))
    response = post_message(env, 'Prepara una relazione sui fornitori 2027.')
    assert response.status_code == 200, response.text
    proposal = response.json()['result']['intake_proposal']
    assert proposal['status'] == 'pending_confirmation'
    assert proposal['constraints'] == []
    assert proposal['missing_information'] == ['Perimetro da confermare']
    assert proposal['plan_steps'][0]['expected_materials'] == ['Elenco fornitori']
    assert proposal['changed_fields'] == ['title']


# -- propose_plan_change -----------------------------------------------------


def test_plan_change_without_plan_returns_error_to_model(env):
    script(env.ctx,
           tool_call('propose_plan_change', {'changes': [{'field': 'objective', 'to_value': 'Nuovo obiettivo'}]},
                     call_id='call_bad'),
           text_message('Serve prima confermare l\'accordo: procedo quando vuoi.'))
    response = post_message(env, 'Cambia l\'obiettivo del lavoro.')
    assert response.status_code == 200, response.text
    assert response.json()['result']['assistant_text'].startswith('Serve prima confermare')
    tool_results = [m for m in env.ctx.models._fake.native_calls[1] if m['role'] == 'tool']
    assert tool_results and 'plan' in tool_results[0]['content'].lower()


def test_plan_change_with_plan_builds_preview(env):
    # Un lavoro con piano ACCETTATO: proposta → conferma con fasi, come la UI.
    proposed = env.client.post('/v1/workspaces/ws_local/commands', headers=env.headers,
                               json={'command_id': 'plan', 'type': 'plan.propose',
                                     'payload': {'work_id': env.work_id, 'expected_version': 1,
                                                 'steps': [{'title': 'Nota', 'capability': 'general',
                                                            'assignee_id': 'person_fabio'}]}})
    assert proposed.status_code == 200, proposed.text
    version = env.client.get(f'/v1/workspaces/ws_local/works/{env.work_id}',
                             headers=env.headers).json()['work']['version']
    accepted = env.client.post('/v1/workspaces/ws_local/commands', headers=env.headers,
                               json={'command_id': 'plan_accept', 'type': 'plan.accept',
                                     'payload': {'work_id': env.work_id, 'expected_version': version}})
    assert accepted.status_code == 200, accepted.text
    script(env.ctx, tool_call('propose_plan_change',
                              {'changes': [{'field': 'objective', 'to_value': 'Nuovo obiettivo condiviso'}]}))
    response = post_message(env, 'Cambia l\'obiettivo in: nuovo obiettivo condiviso.')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    preview = result['patch_proposal']
    assert preview['summary_lines'], preview
    assert any('obiettivo' in line.lower() for line in preview['summary_lines'])
    # L'anteprima non scrive nello stato: il lavoro non cambia.
    work = env.client.get(f'/v1/workspaces/ws_local/works/{env.work_id}', headers=env.headers).json()['work']
    assert work['objective'] != 'Nuovo obiettivo condiviso'


# -- ripiego vincolato -------------------------------------------------------


def test_structured_fallback_when_provider_rejects_tools(env, monkeypatch):
    from homun.models import structured_fallback

    calls = {'tools': 0, 'structured': 0}

    def rejecting_tools(*args, **kwargs):
        calls['tools'] += 1
        raise NativeModelError(INVALID_REQUEST, 'tools is not supported by this model')

    def structured_decision(*args, **kwargs):
        calls['structured'] += 1
        return structured_fallback.StructuredResult(
            payload={'action': 'propose_work', 'work': dict(VALID_WORK)}, usage=_usage())

    monkeypatch.setattr(env.ctx.models, 'complete_tools', rejecting_tools)
    monkeypatch.setattr(env.ctx.models, 'complete_structured', structured_decision)
    structured_fallback.reset_mode_memory()
    response = post_message(env, 'Prepara una nota operativa.')
    assert response.status_code == 200, response.text
    assert response.json()['result']['intake_proposal']['status'] == 'pending_confirmation'
    assert calls == {'tools': 1, 'structured': 1}
    # La memoria registra il rifiuto: il secondo turno non ritenta con tools.
    def structured_reply(*args, **kwargs):
        calls['structured'] += 1
        return structured_fallback.StructuredResult(
            payload={'action': 'reply', 'reply_text': 'Pronta un\'altra proposta quando vuoi.'},
            usage=_usage())

    monkeypatch.setattr(env.ctx.models, 'complete_structured', structured_reply)
    response = post_message(env, 'Un\'altra nota.', command_id='msg2')
    assert response.status_code == 200, response.text
    assert calls == {'tools': 1, 'structured': 2}, 'la memoria deve evitare la chiamata con tools destinata a fallire'


def test_structured_fallback_transport_uses_response_format(tmp_path):
    """Il ripiego passa lo schema dell'unione discriminata come format/response_format."""
    import json as _json
    from homun.models import structured_fallback
    from homun.models.openai_compat import OpenAICompatibleProvider
    from homun.models.secrets import MemorySecretStore

    secrets = MemorySecretStore()
    secrets.put('provider:openai_compatible:api_key', 'k')
    provider = OpenAICompatibleProvider(secrets=secrets, base_url='https://api.example.com/v1',
                                        default_model='test-model')

    sent = {}

    def fake_post(path, body, *, api_key):
        sent['path'] = path
        sent['body'] = body
        return {'choices': [{'message': {'role': 'assistant', 'content': _json.dumps(
            {'action': 'reply', 'reply_text': 'Risposta vincolata'})}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 3, 'completion_tokens': 3}}

    provider._post = fake_post  # type: ignore[method-assign]
    schema = {'type': 'object', 'properties': {'action': {'type': 'string'}}, 'required': ['action']}
    result = structured_fallback.complete_structured(
        provider, [NativeMessage(role='user', content='domanda')], schema=schema)
    assert sent['path'] == '/chat/completions'
    assert sent['body']['response_format']['type'] == 'json_schema'
    assert sent['body']['response_format']['json_schema']['schema'] == schema
    assert 'tools' not in sent['body']
    assert result.payload['action'] == 'reply'
    assert result.payload['reply_text'] == 'Risposta vincolata'


def test_structured_fallback_ollama_uses_format(tmp_path):
    import json as _json
    from homun.models import structured_fallback
    from homun.models.openai_compat import OpenAICompatibleProvider
    from homun.models.secrets import MemorySecretStore

    secrets = MemorySecretStore()
    secrets.put('provider:openai_compatible:api_key', 'k')
    provider = OpenAICompatibleProvider(secrets=secrets, base_url='http://127.0.0.1:11434/v1',
                                        default_model='test-model')

    sent = {}

    def fake_ollama(body):
        sent['body'] = body
        return {'message': {'role': 'assistant', 'content': _json.dumps(
            {'action': 'propose_work', 'work': dict(VALID_WORK)})}, 'done_reason': 'stop'}

    provider._post_ollama_chat = fake_ollama  # type: ignore[method-assign]
    schema = {'type': 'object', 'properties': {'action': {'type': 'string'}}, 'required': ['action']}
    result = structured_fallback.complete_structured(
        provider, [NativeMessage(role='user', content='domanda')], schema=schema)
    assert sent['body']['format'] == schema
    assert 'tools' not in sent['body']
    assert result.payload['action'] == 'propose_work'


def test_structured_reply_text_is_used_directly(env, monkeypatch):
    from homun.models import structured_fallback

    def rejecting_tools(*args, **kwargs):
        raise NativeModelError(INVALID_REQUEST, 'tools is not supported by this model')

    def structured_decision(*args, **kwargs):
        return structured_fallback.StructuredResult(
            payload={'action': 'reply', 'reply_text': 'Risposta dal ripiego vincolato.'}, usage=_usage())

    monkeypatch.setattr(env.ctx.models, 'complete_tools', rejecting_tools)
    monkeypatch.setattr(env.ctx.models, 'complete_structured', structured_decision)
    structured_fallback.reset_mode_memory()
    response = post_message(env, 'Cosa sai fare?')
    assert response.status_code == 200, response.text
    assert response.json()['result']['assistant_text'] == 'Risposta dal ripiego vincolato.'


# -- precedenza del nuovo messaggio ------------------------------------------


def test_new_message_cancels_pending_automatic_retries(env):
    script(env.ctx, NativeModelError(NETWORK, 'provider irraggiungibile'))
    response = post_message(env, 'Primo messaggio che fallirà.')
    assert response.status_code == 503, response.text
    record = env.ctx.repository.load().commands['msg']
    assert record.followup_status == 'failed'
    assert record.followup_next_attempt_at is not None, 'il fallimento di trasporto resta ripetibile'

    # Il messaggio nuovo ha la precedenza: accettato SUBITO, senza finestra di retry.
    script(env.ctx, text_message('Riproviamo: sono qui.'))
    response = post_message(env, 'Riprovo con la connessione normale.', command_id='msg2')
    assert response.status_code == 200, response.text
    assert response.json()['result']['assistant_text'].startswith('Riproviamo')
    # Il messaggio precedente resta salvato, non completato e riprobabile a mano.
    record = env.ctx.repository.load().commands['msg']
    assert record.followup_status == 'failed'
    assert record.followup_next_attempt_at is None
    messages = env.ctx.repository.load().messages
    assert any(m.text == 'Primo messaggio che fallirà.' for m in messages.values())


def test_message_rejected_while_turn_really_in_flight(env, monkeypatch):
    """Un turno davvero in corso (processing con lease valida) blocca ancora."""
    from homun.application.sessions.command_delivery import Delivery
    from homun.application.sessions.command_types import CommandRequest
    from homun.domain.errors import CommandInProgressError
    from homun.domain.models import Actor

    ctx = env.ctx
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    body = CommandRequest.model_validate({
        'command_id': 'first', 'type': 'conversation.post_message',
        'payload': {'conversation_id': env.conversation_id, 'text': 'Turno in volo'}})
    from homun.application.sessions.command_delivery import admit
    admit(ctx, actor, body)
    other = CommandRequest.model_validate({
        'command_id': 'second', 'type': 'conversation.post_message',
        'payload': {'conversation_id': env.conversation_id, 'text': 'Messaggio nuovo'}})
    with pytest.raises(CommandInProgressError) as excinfo:
        admit(ctx, actor, other)
    assert excinfo.value.reason == 'message.in_progress.other'


# -- multilingua --------------------------------------------------------------


def test_english_instructions_for_english_person(env):
    from homun.application.ops.preferences import set_person_language

    set_person_language(env.ctx, 'person_fabio', 'en')
    script(env.ctx, text_message('Hello! I can help you with everyday work.'))
    response = post_message(env, 'What can you do?')
    assert response.status_code == 200, response.text
    calls = env.ctx.models._fake.native_calls
    system = next(m for m in calls[0] if m['role'] == 'system')
    assert 'work assistant' in system['content'].lower(), 'le istruzioni devono essere in inglese'
    tool_block = system['content'].lower()
    assert 'propose_work' in tool_block
    assert 'propose a work agreement' in tool_block, 'le descrizioni degli strumenti seguono la lingua del prompt'


def test_italian_instructions_for_italian_person(env):
    from homun.application.ops.preferences import set_person_language

    set_person_language(env.ctx, 'person_fabio', 'it')
    script(env.ctx, text_message('Ciao! Sono Homun.'))
    response = post_message(env, 'Cosa sai fare?')
    assert response.status_code == 200, response.text
    calls = env.ctx.models._fake.native_calls
    system = next(m for m in calls[0] if m['role'] == 'system')
    assert 'proposta di lavoro' in system['content'].lower() or 'accord' in system['content'].lower()
