"""The asked-repetition detector: pure, deterministic, IT + EN.

``repetition_requested`` decides ONCE per turn, from the person's message,
whether the runaway guards judge at the normal floor (400) or at the
asked-repetition floor (16_000, Hermes's stop-path scale). The generated
text never decides the mode.
"""
import pytest

from homun.models.repetition import (
    MIN_FRAGMENT_LENGTH,
    STOP_PATH_MIN_CHARS,
    repetition_requested,
    turn_runaway_floor,
)

# (id, message, expected). Few clear patterns, pinned by this table: an
# explicit copy count (>= 3), an unnegated repetition verb, or identical-rows
# phrasing — with negation / meta-question / hypothetical guards.
TABLE = [
    # — chiede ripetizioni, IT —
    pytest.param('Scrivi "Ciao mondo" 200 volte, una per riga', True, id='it-count-verb'),
    pytest.param('ripeti questa frase 100 volte', True, id='it-imperative-count'),
    pytest.param('ripetere la riga 50 volte', True, id='it-infinitive-count'),
    pytest.param('ripetilo due volte', True, id='it-bare-imperative'),
    pytest.param('puoi ripetere il comando?', True, id='it-bare-ask'),
    pytest.param('copia questa riga 30 volte', True, id='it-copy-count'),
    pytest.param('30 righe uguali', True, id='it-identical-rows'),
    pytest.param('trenta righe identiche', True, id='it-identical-rows-word-number'),
    pytest.param('la stessa riga 5 volte', True, id='it-same-line-count'),
    pytest.param('trenta volte la stessa frase', True, id='it-word-count'),
    pytest.param('scrivi ciao mille volte', True, id='it-mille'),
    pytest.param('1.000 volte la stessa frase', True, id='it-thousands-separator'),
    # — chiede ripetizioni, EN —
    pytest.param('Say the word "go" 50 times', True, id='en-say-times'),
    pytest.param('write "loading" 100x', True, id='en-write-100x'),
    pytest.param('x50', True, id='en-bare-x50'),
    pytest.param('50 times', True, id='en-bare-times'),
    pytest.param('100x', True, id='en-bare-100x'),
    pytest.param('please repeat the list', True, id='en-bare-repeat'),
    pytest.param('copy this line 50 times', True, id='en-copy-times'),
    # — costi accettati e documentati: la narrazione al passato col conteggio
    #   alza solo la soglia (16k): un loop vero resta tagliato, dopo —
    pytest.param('te l\'ho già detto 100 volte', True, id='it-narration-accepted-true'),
    # — cita la parola senza chiedere ripetizioni —
    pytest.param('non ripetere quello che hai detto', False, id='it-negated-imperative'),
    pytest.param('smetti di ripetere la riga', False, id='it-stop-gerund'),
    pytest.param('non voglio ripetere l\'errore', False, id='it-negated-intent'),
    pytest.param('perché ti ripeti sempre?', False, id='it-why-meta-question'),
    pytest.param('cosa significa ripetere una stringa?', False, id='it-explanation-request'),
    pytest.param('cosa vuol dire repeat?', False, id='it-explanation-request-en-word'),
    pytest.param('cosa succede se lo rifaccio due volte?', False, id='it-hypothetical'),
    pytest.param('e se ti chiedessi di scriverlo 20 volte?', False, id='it-hypothetical-e-se'),
    pytest.param('cosa succede se ripeti 100 volte la stessa cosa?', False, id='it-hypothetical-verb'),
    pytest.param('spiega perché il modello si ripete', False, id='it-explain-meta'),
    # — EN —
    pytest.param('why do you repeat yourself?', False, id='en-why-meta-question'),
    pytest.param("don't write it 5 times", False, id='en-negated-count'),
    pytest.param('never say the word 5 times', False, id='en-never-count'),
    pytest.param('what happens if a model repeats 100 times?', False, id='en-hypothetical'),
    pytest.param('what is repetition?', False, id='en-noun-mention'),
    # — nessun segnale —
    pytest.param('ciao, come stai?', False, id='plain-greeting'),
    pytest.param('scrivi ciao due volte', False, id='two-copies-below-minimum'),
    pytest.param('', False, id='empty'),
]


@pytest.mark.parametrize('message,expected', TABLE)
def test_repetition_requested_table(message, expected):
    assert repetition_requested(message) is expected


def test_non_text_input_is_not_a_request():
    assert repetition_requested(None) is False
    assert repetition_requested(123) is False


def test_floor_never_exceeds_the_asked_cap():
    # INVARIANT — 16_000 is the ceiling in every mode; the normal turn stays
    # at the fragment floor the single criterion already uses.
    assert turn_runaway_floor('Scrivi "Ciao mondo" 200 volte') == STOP_PATH_MIN_CHARS
    assert turn_runaway_floor('ciao, come stai?') == MIN_FRAGMENT_LENGTH
    assert turn_runaway_floor('') == MIN_FRAGMENT_LENGTH
    assert STOP_PATH_MIN_CHARS == 16_000
