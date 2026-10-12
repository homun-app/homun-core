"""The turn's runaway floor: decided once, from the person's message only.

Rules pinned here (see docs/SVILUPPO.md):
- the LAST genuine user row of the canonical transcript decides the floor;
- engine-authored user rows ([SYSTEM] nudges, the truncation CONTINUE_PROMPT)
  are skipped, so a continuation KEEPS the floor of the turn that asked;
- steering rows ARE the person's words and can raise the floor mid-turn;
- delegation children carry no person message: normal floor.
"""
from homun.models.repetition import MIN_FRAGMENT_LENGTH, STOP_PATH_MIN_CHARS
from homun.models.prompt_blocks import STEER_MARKER_CLOSE, STEER_MARKER_OPEN
from homun.models.truncation import CONTINUE_PROMPT
from homun.application.agent.runs.turn_floor import floor_for_run


def _run(messages, **extra):
    run = {'_messages': messages}
    run.update(extra)
    return run


def _system():
    return {'role': 'system', 'content': 'guidance'}


def _user(content):
    return {'role': 'user', 'content': content}


def _assistant(content):
    return {'role': 'assistant', 'content': content}


ASK = 'Scrivi "Ciao mondo" 200 volte, una per riga'


def test_the_turns_user_message_raises_the_floor():
    assert floor_for_run(_run([_system(), _user(ASK)])) == STOP_PATH_MIN_CHARS


def test_normal_ask_keeps_the_fragment_floor():
    assert floor_for_run(_run([_system(), _user('chi sei?')])) == MIN_FRAGMENT_LENGTH


def test_continuation_keeps_the_floor_of_the_turn_that_asked():
    # TruncatedTextError appends the partial as assistant + CONTINUE_PROMPT as
    # user: the nudge is engine text, the original ask still decides.
    messages = [_system(), _user(ASK), _assistant('Ciao mondo\n' * 80),
                _user(CONTINUE_PROMPT)]
    assert floor_for_run(_run(messages)) == STOP_PATH_MIN_CHARS


def test_engine_system_nudges_do_not_decide_the_floor():
    messages = [_system(), _user('chi sei?'),
                {'role': 'user', 'content': '[SYSTEM] Your last reply reasoned about the task instead of answering.'}]
    assert floor_for_run(_run(messages)) == MIN_FRAGMENT_LENGTH


def test_steering_is_the_persons_words_and_can_raise_the_floor():
    messages = [_system(), _user('chi sei?'), _assistant('Sono Homun.'),
                {'role': 'user', 'content': f'{STEER_MARKER_OPEN}\nora scrivi ciao 50 volte\n{STEER_MARKER_CLOSE}'}]
    assert floor_for_run(_run(messages)) == STOP_PATH_MIN_CHARS


def test_delegation_children_carry_no_person_message():
    assert floor_for_run(_run([_system(), _user(ASK)], _delegation_parent={'run_id': 'parent'})) \
        == MIN_FRAGMENT_LENGTH


def test_run_without_user_rows_keeps_the_fragment_floor():
    assert floor_for_run(_run([_system(), _assistant('solo io')])) == MIN_FRAGMENT_LENGTH
    assert floor_for_run({}) == MIN_FRAGMENT_LENGTH
