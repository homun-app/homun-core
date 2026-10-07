"""Il gate anti-narrazione valuta il testo VISIBILE, mai il ragionamento grezzo.

Un modello locale senza tag <think> di apertura chiude il ragionamento con un
</think> orfano: la risposta vera segue il tag. Il gate deve giudicare solo
quello che l'utente vedrebbe (strip), altrimenti ogni risposta con preambolo
di ragionamento viene rifiutata all'infinito.
"""
from homun.application.agent_run_execution import _looks_like_pure_reasoning
from homun.models.finish_gates import strip_think_blocks


def _run(user_text: str) -> dict:
    return {"_messages": [{"role": "user", "content": user_text}]}


def test_orphan_think_prefix_does_not_gate_the_visible_answer():
    raw = ('The user asks "chi sei?" - who are you. No tools needed. '
           'Just answer.</think>Sono Homun, un assistente operativo che '
           'lavora con strumenti reali.')
    assert not _looks_like_pure_reasoning(strip_think_blocks(raw), _run("chi sei?"))


def test_paired_think_block_does_not_gate_the_visible_answer():
    raw = '<think>Domanda semplice, rispondo in italiano senza strumenti.</think>' \
          'Sono Homun, un assistente operativo per compiti concreti.'
    assert not _looks_like_pure_reasoning(strip_think_blocks(raw), _run("chi sei?"))


def test_visible_reasoning_narration_still_gated():
    raw = ('The user asks "chi sei?" - I should answer directly. '
           'This is a simple question about identity. No tools needed.')
    assert _looks_like_pure_reasoning(strip_think_blocks(raw), _run("chi sei?"))


def test_reasoning_without_any_think_marker_still_gated():
    raw = 'The user asks "chi sei?". I should answer directly. No tools needed.'
    assert _looks_like_pure_reasoning(strip_think_blocks(raw), _run("chi sei?"))
