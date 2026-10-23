"""ask_clarification: le domande arrivano alla persona come domande, mai come JSON grezzo.

I modelli piccoli (visto con qwen3.5:4b) a volte mettono l'elenco delle domande
in UNA stringa JSON, o concatenano più oggetti JSON, o ne fanno cinque. Il
motore decodifica ciò che è decodificabile; ciò che non è una domanda torna al
modello come errore da correggere, e oltre tre domande per turno l'errore gli
dice di tenere solo l'essenziale (le istruzioni: «una o due domande
sull'essenziale»).
"""
import json

import pytest

from homun.application.sessions.front_door.tools import (
    MAX_CLARIFY_QUESTIONS, AskClarificationArgs, parse_arguments,
)
from test_front_door import env, post_message, script, tool_call  # noqa: F401

TWO = [{'question': 'Qual è l\'obiettivo della relazione?', 'choices': ['Confronto prezzi', 'Panoramica']},
       {'question': 'Per quando ti serve?'}]


def questions_of(arguments: dict) -> list[dict]:
    return parse_arguments('ask_clarification', arguments).normalized_questions()


def assert_no_raw_json(questions: list[dict]) -> None:
    for item in questions:
        assert not item['question'].lstrip().startswith(('[', '{')), item
        for choice in item['choices']:
            assert not choice.lstrip().startswith(('[', '{')), item


# -- decodifica -----------------------------------------------------------------


def test_questions_as_one_json_string_are_decoded():
    questions = questions_of({'questions': json.dumps(TWO)})
    assert [q['question'] for q in questions] == [TWO[0]['question'], TWO[1]['question']]
    assert questions[0]['choices'] == ['Confronto prezzi', 'Panoramica']
    assert_no_raw_json(questions)


def test_concatenated_json_lists_and_objects_are_decoded():
    """`[{…}][{…}]` e `{…}{…}`: più valori JSON uno dopo l'altro nello stesso campo."""
    concatenated_lists = json.dumps([TWO[0]]) + json.dumps([TWO[1]])
    assert [q['question'] for q in questions_of({'questions': concatenated_lists})] == [
        TWO[0]['question'], TWO[1]['question']]
    concatenated_objects = json.dumps(TWO[0]) + '\n' + json.dumps(TWO[1])
    assert [q['question'] for q in questions_of({'questions': [concatenated_objects]})] == [
        TWO[0]['question'], TWO[1]['question']]
    assert_no_raw_json(questions_of({'questions': concatenated_lists}))


def test_single_question_field_holding_json_is_decoded():
    questions = questions_of({'question': json.dumps(TWO)})
    assert [q['question'] for q in questions] == [TWO[0]['question'], TWO[1]['question']]
    assert_no_raw_json(questions)


def test_question_text_inside_an_object_holding_json_is_decoded():
    questions = questions_of({'questions': [{'question': json.dumps(TWO)}]})
    assert [q['question'] for q in questions] == [TWO[0]['question'], TWO[1]['question']]


def test_plain_text_questions_stay_as_they_are():
    questions = questions_of({'questions': ['Per quando ti serve?', {'question': 'Per chi?'}]})
    assert [q['question'] for q in questions] == ['Per quando ti serve?', 'Per chi?']


# -- errori che tornano al modello ---------------------------------------------


def test_json_that_is_not_a_question_is_an_error_for_the_model():
    with pytest.raises(ValueError, match='question'):
        questions_of({'questions': '{"foo": "bar"}'})
    with pytest.raises(ValueError):
        questions_of({'questions': '[{"question": "ok?"}] e poi testo non JSON'})


def test_more_than_three_questions_is_an_error_that_asks_for_the_essential_ones():
    assert MAX_CLARIFY_QUESTIONS == 3
    five = [{'question': f'Domanda {index}?'} for index in range(5)]
    with pytest.raises(ValueError) as caught:
        questions_of({'questions': five})
    message = str(caught.value)
    assert '3' in message and '5' in message
    assert 'essential' in message.lower()
    # Tre domande vanno bene.
    assert len(questions_of({'questions': five[:3]})) == 3


def test_arguments_model_keeps_the_same_contract():
    """Il modello tollerante accetta ancora stringa sola, null e chiavi ignote."""
    args = AskClarificationArgs.model_validate({'questions': None, 'question': 'Per chi?', 'extra': 1})
    assert [q['question'] for q in args.normalized_questions()] == ['Per chi?']


# -- il turno vero: errore come risultato dello strumento, poi la correzione -----


def test_five_questions_go_back_to_the_model_which_keeps_two(env):
    five = [{'question': f'Domanda {index}?'} for index in range(5)]
    script(env.ctx,
           tool_call('ask_clarification', {'questions': five}, call_id='call_five'),
           tool_call('ask_clarification', {'questions': TWO}, call_id='call_two'))
    response = post_message(env, 'Crea una relazione sui fornitori 2027')
    assert response.status_code == 200, response.text
    questions = response.json()['result']['front_door']['questions']
    assert [q['question'] for q in questions] == [TWO[0]['question'], TWO[1]['question']]
    calls = env.ctx.models._fake.native_calls
    assert len(calls) == 2, 'il secondo giro deve riusare lo stesso turno'
    tool_results = [m for m in calls[1] if m['role'] == 'tool']
    assert tool_results and tool_results[0]['tool_call_id'] == 'call_five'
    assert '3' in tool_results[0]['content'] and 'essential' in tool_results[0]['content'].lower()


def test_json_string_questions_reach_the_person_decoded(env):
    """Lo scenario del giro: le domande in UNA stringa JSON con oggetti concatenati."""
    payload = json.dumps([TWO[0]]) + json.dumps([TWO[1]])
    script(env.ctx, tool_call('ask_clarification', {'questions': payload}))
    response = post_message(env, 'Crea una relazione sui fornitori 2027')
    assert response.status_code == 200, response.text
    questions = response.json()['result']['front_door']['questions']
    assert [q['question'] for q in questions] == [TWO[0]['question'], TWO[1]['question']]
    assert questions[0]['choices'] == ['Confronto prezzi', 'Panoramica']
    assert_no_raw_json(questions)
