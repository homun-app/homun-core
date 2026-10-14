"""The asked-repetition detector: pure, deterministic, IT + EN.

``repetition_requested`` decides ONCE per turn, from the person's message,
whether the runaway guards judge at the normal floor (400) or at the
asked-repetition floor (16_000, Hermes's stop-path scale). The generated
text never decides the mode.

Two case tables:
- ``DEVELOPMENT_CASES`` — the detector is developed against these; the
  invariants are the source of truth (production verb AND multiplicity,
  quoted text is data, in doubt False);
- ``HELD_OUT_CASES`` — written BEFORE the rewrite and never used to tune
  the detector; both tables must stay at 100%.
"""
import pytest

from homun.models.repetition import (
    MIN_FRAGMENT_LENGTH,
    STOP_PATH_MIN_CHARS,
    repetition_request,
    repetition_requested,
    turn_runaway_floor,
)

# (id, message, expected). The detector fires ONLY on a clause that carries
# BOTH a production verb directed at the assistant AND a multiplicity signal
# (copy count >= 3, or «la stessa riga/frase» + a row count), with the
# negation / meta-question / hypothetical / explainer guards applied to the
# NON-quoted text. A dozen cases the FIRST detector accepted are now False
# by invariant (marked «flip»): counts without a production verb are
# narration, and «ripeti» without multiplicity means «say it again once».
DEVELOPMENT_CASES = [
    # — chiede ripetizioni, IT —
    pytest.param('Scrivi "Ciao mondo" 200 volte, una per riga', True, id='it-count-verb'),
    pytest.param('ripeti questa frase 100 volte', True, id='it-imperative-count'),
    pytest.param('ripetere la riga 50 volte', True, id='it-infinitive-count'),
    pytest.param('ripetilo 3 volte', True, id='it-bare-imperative-with-count'),
    pytest.param('puoi ripetere il comando 10 volte?', True, id='it-bare-ask-with-count'),
    pytest.param('copia questa riga 30 volte', True, id='it-copy-count'),
    pytest.param('30 righe uguali', False, id='it-identical-rows'),  # flip: no production verb
    pytest.param('trenta righe identiche', False, id='it-identical-rows-word-number'),  # flip
    pytest.param('la stessa riga 5 volte', False, id='it-same-line-count'),  # flip: no verb
    pytest.param('trenta volte la stessa frase', False, id='it-word-count'),  # flip: no verb
    pytest.param('scrivi ciao mille volte', True, id='it-mille'),
    pytest.param('1.000 volte la stessa frase', False, id='it-thousands-separator'),  # flip
    # — chiede ripetizioni, EN —
    pytest.param('Say the word "go" 50 times', True, id='en-say-times'),
    pytest.param('write "loading" 100x', True, id='en-write-100x'),
    pytest.param('x50', False, id='en-bare-x50'),  # flip: count without a verb
    pytest.param('50 times', False, id='en-bare-times'),  # flip
    pytest.param('100x', False, id='en-bare-100x'),  # flip
    pytest.param('please repeat the list', False, id='en-bare-repeat'),  # flip: no multiplicity
    pytest.param('copy this line 50 times', True, id='en-copy-times'),
    # — narrazione al passato col conteggio: NIENTE verbo di produzione —
    pytest.param("te l'ho già detto 100 volte", False, id='it-narration-with-count'),
    # — cita la parola senza chiedere ripetizioni —
    pytest.param('non ripetere quello che hai detto', False, id='it-negated-imperative'),
    pytest.param('smetti di ripetere la riga', False, id='it-stop-gerund'),
    pytest.param("non voglio ripetere l'errore", False, id='it-negated-intent'),
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
    # — i dieci casi che hanno rotto il primo rilevatore —
    pytest.param("l'ho chiesto 3 volte", False, id='it-asked-3-times-past'),
    pytest.param('ho già provato 5 volte, non funziona', False, id='it-tried-5-times'),
    pytest.param('Controlla 3 volte i conti', False, id='it-check-3-times-not-production'),
    pytest.param('Rifai il calcolo 3 volte per sicurezza', False, id='it-redo-3-times-not-production'),
    pytest.param('ti ho scritto 4 volte la stessa cosa', False, id='it-wrote-4-times-past'),
    pytest.param('Ripeti la domanda, non ho capito', False, id='it-repeat-once-no-multiplicity'),
    pytest.param('Puoi ripetere l\'ultimo passaggio?', False, id='it-can-you-repeat-once'),
    pytest.param('Repeat after me: ciao', False, id='en-repeat-after-me-once'),
    pytest.param("Write 'I will not talk in class' 100 times", True, id='en-quote-negation-count'),
    pytest.param('Scrivi la stessa frase per 30 righe', True, id='it-same-sentence-30-righe'),
]

# Held-out cases, written BEFORE the detector rewrite and never used to tune
# it: realistic work messages that cite counts («volte»/«times») without
# asking the assistant to PRODUCE copies, repetition asks whose quoted
# content carries negations or questions, and word numbers. The expectations
# follow the invariants (production verb AND multiplicity; quoted text is
# data; in doubt False) — these cases are not consulted when they fail.
HELD_OUT_CASES = [
    # — lavoro reale con numeri e «volte», NON chiede ripetizioni —
    pytest.param("Ho chiamato il cliente 6 volte oggi, non risponde", False, id='it-called-6-times'),
    pytest.param("Il backup deve girare 3 volte al giorno", False, id='it-frequency-per-day'),
    pytest.param("Ho già inviato la fattura 4 volte all'indirizzo sbagliato", False, id='it-invoice-sent-4-times'),
    pytest.param("Ho provato a riavviare il servizio 5 volte, stesso errore", False, id='it-retried-5-times'),
    pytest.param("Il server è caduto 3 volte questa settimana", False, id='it-server-crashed-3-times'),
    pytest.param("Te l'ho ripetuto 10 volte, adesso basta", False, id='it-repeated-to-you-10-times'),
    pytest.param("Leggi il contratto 2 volte prima di firmare", False, id='it-read-twice'),
    pytest.param("Verifica le righe della fattura 3 volte", False, id='it-verify-invoice-3-times'),
    pytest.param("Rileggi la mail 3 volte prima di inviarla", False, id='it-reread-mail-3-times'),
    pytest.param("Ci siamo sentiti 3 volte questa settimana", False, id='it-met-3-times'),
    pytest.param("Il test fallisce 3 volte su 10", False, id='it-flaky-test-3-of-10'),
    pytest.param("Ho riletto il documento 5 volte e non trovo l'errore", False, id='it-reread-5-times'),
    pytest.param("Il campanello suona 3 volte quando la lavatrice finisce", False, id='it-doorbell-3-times'),
    pytest.param("Controlla i totali 4 volte, devo essere sicuro", False, id='it-check-totals-4-times'),
    pytest.param("I've emailed support 5 times about this bug", False, id='en-emailed-5-times'),
    pytest.param("The build failed 4 times today", False, id='en-build-failed-4-times'),
    pytest.param("I've told you 100 times: don't touch that config", False, id='en-told-100-times'),
    pytest.param("Check the numbers 3 times before sending the report", False, id='en-check-3-times'),
    pytest.param("We retry the request 5 times with backoff", False, id='en-retry-5-times'),
    pytest.param("The alarm rings three times every morning", False, id='en-alarm-three-times'),
    pytest.param("I've repeated the question twice already", False, id='en-repeated-twice'),
    pytest.param("Run the suite 3 times to check for flakiness", False, id='en-run-suite-3-times'),
    pytest.param("I wrote three essays this week", False, id='en-wrote-three-essays'),
    pytest.param("Elenca i materiali del progetto con i prezzi", False, id='it-list-materials-no-count'),
    # — ripetizioni chieste, con citazioni che contengono negazioni/domande —
    pytest.param("Scrivi 'Non parlerò in classe' 100 volte", True, id='it-quote-with-negation'),
    pytest.param('Ripeti la riga "perché no?" 30 volte', True, id='it-quote-with-question'),
    pytest.param("Scrivi la stessa frase «non posso ora» per 40 righe", True, id='it-guillemet-quote-negation-40-righe'),
    pytest.param("Copia questa riga cento volte", True, id='it-copy-word-number-cento'),
    pytest.param("Genera la riga 'test superato' venti volte", True, id='it-genera-word-number-venti'),
    pytest.param("Scrivi questa parola dieci volte, una per riga", True, id='it-scrivi-word-number-dieci'),
    pytest.param("Stampa la riga 'PAGATO' tre volte", True, id='it-stampa-tre-volte'),
    pytest.param("Dimmi la parola 'stop' 3 volte", True, id='it-dimmi-3-volte'),
    pytest.param('Print "I will not complain" 50 times, one per line', True, id='en-print-quote-negation'),
    pytest.param("Write 'why me?' 25 times", True, id='en-write-quote-question'),
    pytest.param("Say the word 'never' a hundred times", True, id='en-say-word-number-hundred'),
    pytest.param("Output the line 'error: not found' 30 times", True, id='en-output-quote-negation'),
    pytest.param('Repeat the sentence "don\'t stop" 15 times', True, id='en-repeat-quote-negation'),
    pytest.param("Write the same line for 30 rows", True, id='en-same-line-30-rows'),
]

ALL_CASES = DEVELOPMENT_CASES + HELD_OUT_CASES


@pytest.mark.parametrize('message,expected', ALL_CASES)
def test_repetition_requested_table(message, expected):
    assert repetition_requested(message) is expected


@pytest.mark.parametrize('message,expected', DEVELOPMENT_CASES)
def test_repetition_requested_development_only(message, expected):
    """Same verdicts through the full API entry point."""
    assert (repetition_request(message) is not None) is expected


@pytest.mark.parametrize('message,copies', [
    ('Scrivi "Ciao mondo" 200 volte, una per riga', 200),
    ('ripeti questa frase 100 volte', 100),
    ('ripetere la riga 50 volte', 50),
    ('copia questa riga 30 volte', 30),
    ('scrivi ciao mille volte', 1000),
    ('Say the word "go" 50 times', 50),
    ('write "loading" 100x', 100),
    ('copy this line 50 times', 50),
    ("Write 'I will not talk in class' 100 times", 100),
    ('Scrivi la stessa frase per 30 righe', 30),
    ('scrivi questa riga 5 volte, anzi 20 volte', 20),  # l'ultima correzione vince
])
def test_repetition_request_carries_the_explicit_copies(message, copies):
    assert repetition_request(message) is not None
    assert repetition_request(message).copies == copies


def test_non_text_input_is_not_a_request():
    assert repetition_requested(None) is False
    assert repetition_requested(123) is False
    assert repetition_request(None) is None


def test_floor_never_exceeds_the_asked_cap():
    # INVARIANT — 16_000 is the ceiling in every mode; the normal turn stays
    # at the fragment floor the single criterion already uses.
    assert turn_runaway_floor('Scrivi "Ciao mondo" 200 volte') == STOP_PATH_MIN_CHARS
    assert turn_runaway_floor('ciao, come stai?') == MIN_FRAGMENT_LENGTH
    assert turn_runaway_floor('') == MIN_FRAGMENT_LENGTH
    assert STOP_PATH_MIN_CHARS == 16_000
