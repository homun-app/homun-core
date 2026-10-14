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


# Held-out cases, written BEFORE the detector rewrite and never used to tune
# it: realistic work messages that cite counts («volte»/«times») without
# asking the assistant to PRODUCE copies, repetition asks whose quoted
# content carries negations or questions, and word numbers. The expectations
# follow the invariants (production verb AND multiplicity; quoted text is
# data; in doubt False) — the cases above are not consulted when they fail.
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


@pytest.mark.parametrize('message,expected', HELD_OUT_CASES)
def test_repetition_requested_held_out(message, expected):
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
