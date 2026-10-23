"""Il messaggio del turno che ha prodotto una scheda: UNA frase, non un echo.

Invariante: quando l'esito del turno è una scheda (proposta di accordo,
chiarimento, modifica del piano), il messaggio assistente in trascrizione è
una frase breve nella lingua della persona che rimanda alla scheda. Non ne
ripete il contenuto (titolo, informazioni mancanti, righe di riepilogo) e non
contiene istruzioni scritte in voce motore («Usa Conferma o Annulla sulla
card»): i testi vengono dal catalogo condiviso contracts/i18n.
"""
import pytest

from test_front_door import VALID_WORK, env, post_message, script, tool_call  # noqa: F401

pytestmark = pytest.mark.usefixtures('env')


def test_proposal_message_is_one_sentence_and_does_not_repeat_the_card(env):
    """Il messaggio di una proposta: una frase che rimanda alla scheda, senza
    titolo, senza l'elenco delle informazioni mancanti, senza istruzioni."""
    from homun.i18n import user_text

    script(env.ctx, tool_call('propose_work', {
        **VALID_WORK, 'missing_information': ['Perimetro da confermare'], 'language': 'it'}))
    response = post_message(env, 'Prepara una relazione sui fornitori.')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    text = result['assistant_text']
    assert text == (user_text('front_door.work_proposed', language='it') or ''), text
    assert '\n' not in text, 'una frase sola, la scheda porta il resto'
    assert VALID_WORK['title'] not in text, 'il titolo sta nella scheda, non nel messaggio'
    assert 'Perimetro' not in text, 'le informazioni mancanti stanno nella scheda'
    assert 'Usa' not in text and 'Use' not in text, 'niente istruzioni in voce motore'


def test_plan_change_message_is_one_sentence_and_does_not_repeat_the_card(env):
    """Il messaggio di una modifica del piano: una frase, senza le righe di
    riepilogo ripetute né «Usa Conferma o Annulla sulla card»."""
    from homun.i18n import user_text

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
    script(env.ctx, tool_call('propose_plan_change', {
        'changes': [{'field': 'objective', 'to_value': 'Nuovo obiettivo condiviso'}], 'language': 'it'}))
    response = post_message(env, 'Cambia l\'obiettivo in: nuovo obiettivo condiviso.')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    text = result['assistant_text']
    assert text == (user_text('front_door.plan_change_proposed', language='it') or ''), text
    assert '\n' not in text, 'una frase sola: il riepilogo sta nella scheda'
    assert 'obiettivo' not in text.lower(), 'le righe di riepilogo stanno nella scheda'
    assert 'Usa' not in text and 'Use' not in text, 'niente istruzioni in voce motore'
