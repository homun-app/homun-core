"""La lingua dei testi del turno di ingresso segue chi scrive.

Invariante: senza preferenza esplicita, i testi che il MOTORE genera per una
conversazione (catalogo ``homun.i18n``) seguono la lingua in cui la persona
scrive. Catena: preferenza della persona → lingua rilevata della
conversazione → default del workspace → inglese. La rilevazione non costa
chiamate: il modello riporta la lingua nell'argomento comune ``language``
degli strumenti (o del ripiego strutturato) e il motore la ricorda sulla
conversazione, nella stessa transazione del turno.
"""
import pytest

from test_front_door import VALID_WORK, env, post_message, script, text_message, tool_call  # noqa: F401

pytestmark = pytest.mark.usefixtures('env')


def _proposal_text(language: str, title: str = VALID_WORK['title']) -> str:
    from homun.i18n import user_text

    return user_text('front_door.work_proposed', {'title': title}, language=language) or ''


def test_italian_writer_without_preference_gets_italian_texts(env):
    """Nessuna preferenza impostata: i testi del motore seguono la lingua in
    cui la persona scrive, che il modello riporta nella chiamata (argomento
    ``language`` comune agli strumenti) senza chiamate extra."""
    script(env.ctx, tool_call('propose_work', {**VALID_WORK, 'language': 'it'}))
    response = post_message(env, 'Prepara una nota operativa per il rinnovo Rossi.')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    assert result['front_door']['language'] == 'it'
    assert result['assistant_text'] == _proposal_text('it'), result['assistant_text']


def test_english_writer_without_preference_gets_english_texts(env):
    script(env.ctx, tool_call('propose_work', {**VALID_WORK, 'language': 'en'}))
    response = post_message(env, 'Prepare an operational note for the Rossi renewal.')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    assert result['front_door']['language'] == 'en'
    assert result['assistant_text'] == _proposal_text('en'), result['assistant_text']


def test_explicit_preference_beats_detection(env):
    """La preferenza esplicita della persona vince sulla lingua rilevata."""
    from homun.application.ops.preferences import set_person_language

    set_person_language(env.ctx, 'person_fabio', 'en')
    script(env.ctx, tool_call('propose_work', {**VALID_WORK, 'language': 'italiano'}))
    response = post_message(env, 'Prepara una nota operativa per il rinnovo Rossi.')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    assert result['front_door']['language'] == 'en'
    assert result['assistant_text'] == _proposal_text('en'), result['assistant_text']


def test_detected_language_is_remembered_for_the_conversation(env):
    """La lingua rilevata resta sulla conversazione: il turno successivo la
    usa anche se il modello non la ripete (catena persona → conversazione →
    workspace → en)."""
    script(env.ctx, tool_call('propose_work', {**VALID_WORK, 'language': 'it'}))
    first = post_message(env, 'Prepara una nota operativa per il rinnovo Rossi.')
    assert first.status_code == 200, first.text
    assert first.json()['result']['front_door']['language'] == 'it'

    script(env.ctx, text_message('Rispondo in italiano, senza dichiararla.'))
    second = post_message(env, 'A che punto siamo?', command_id='msg_lang_2')
    assert second.status_code == 200, second.text
    # Il prompt del secondo turno è già in italiano: la conversazione ricorda.
    calls = env.ctx.models._fake.native_calls
    system = next(m for m in calls[1] if m['role'] == 'system')
    assert 'Sei Homun' in system['content'], 'il prompt deve essere in italiano'
    assert 'work assistant' not in system['content'].lower()

    script(env.ctx, tool_call('propose_work', {**VALID_WORK, 'title': 'Altro lavoro'}))
    third = post_message(env, 'Prepara un’altra nota.', command_id='msg_lang_3')
    assert third.status_code == 200, third.text
    result = third.json()['result']
    assert result['front_door']['language'] == 'it'
    assert result['assistant_text'] == _proposal_text('it', 'Altro lavoro'), result['assistant_text']


def test_workspace_default_still_applies_without_detection(env):
    """Senza rilevazione e senza preferenze resta la catena documentata:
    default del workspace, altrimenti inglese."""
    from homun.application.ops.preferences import set_workspace_language

    set_workspace_language(env.ctx, 'it')
    script(env.ctx, tool_call('propose_work', dict(VALID_WORK)))
    response = post_message(env, 'Prepara una nota operativa per il rinnovo Rossi.')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    assert result['front_door']['language'] == 'it'
    assert result['assistant_text'] == _proposal_text('it'), result['assistant_text']


def test_structured_fallback_reports_the_language_too(env, monkeypatch):
    """Anche il ripiego vincolato riporta la lingua: campo ``language`` della
    decisione strutturata, proiettato negli argomenti della chiamata."""
    from homun.models import structured_fallback
    from homun.models.native_errors import INVALID_REQUEST, NativeModelError
    from homun.models.types import UsageEntry

    def rejecting_tools(*args, **kwargs):
        raise NativeModelError(INVALID_REQUEST, 'tools is not supported')

    def structured_decision(*args, **kwargs):
        return structured_fallback.StructuredResult(
            payload={'action': 'propose_work', 'work': dict(VALID_WORK), 'language': 'it'},
            usage=UsageEntry(id='usage_lang', provider_id='fake', model_id='fake-deterministic-v1',
                             input_tokens=4, output_tokens=4, status='ok'))

    monkeypatch.setattr(env.ctx.models, 'complete_tools', rejecting_tools)
    monkeypatch.setattr(env.ctx.models, 'complete_structured', structured_decision)
    structured_fallback.reset_mode_memory()
    response = post_message(env, 'Prepara una nota operativa per il rinnovo Rossi.')
    assert response.status_code == 200, response.text
    result = response.json()['result']
    assert result['front_door']['language'] == 'it'
    assert result['assistant_text'] == _proposal_text('it'), result['assistant_text']
