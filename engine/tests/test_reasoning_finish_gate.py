"""Il gate anti-narrazione valuta il testo VISIBILE, mai il ragionamento grezzo.

Un modello locale senza tag <think> di apertura chiude il ragionamento con un
</think> orfano: la risposta vera segue il tag. Il gate deve giudicare solo
quello che l'utente vedrebbe (strip), altrimenti ogni risposta con preambolo
di ragionamento viene rifiutata all'infinito.
"""
from homun.application.agent.runs.run_execution import _looks_like_pure_reasoning
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


# ---------------------------------------------------------------------------
# split_think — lo scrubber di streaming di Hermes 572446308e, senza stato:
# il testo dentro i blocchi think alimenta il ragionamento e non arriva MAI
# al testo visibile, in qualsiasi posizione e anche non ancora chiuso.
# ---------------------------------------------------------------------------

from homun.models.finish_gates import split_think


def test_split_pairs_feed_reasoning_without_tag_markup():
    reasoning, visible = split_think("<think>Let me check config</think>The answer is 42.")
    assert reasoning == "Let me check config"
    assert visible == "The answer is 42."


def test_split_multiple_blocks_keep_all_reasoning_out_of_the_answer():
    text = "<think>first plan</think>visible one<think>second plan</think>visible two"
    reasoning, visible = split_think(text)
    assert reasoning.splitlines() == ["first plan", "second plan"]
    assert visible == "visible onevisible two"
    assert "think" not in reasoning and "think" not in visible


def test_split_unclosed_block_holds_the_tail_as_reasoning():
    """Un blocco aperto a metà risposta e mai chiuso: la coda è ragionamento
    (flush dello scrubber), non testo consegnato."""
    reasoning, visible = split_think("Answer starts.<think>hidden thought continues")
    assert visible == "Answer starts."
    assert reasoning == "hidden thought continues"


def test_split_orphan_close_keeps_prefix_as_reasoning():
    reasoning, visible = split_think("Pensa senza aprire il tag.</think>Risposta vera.")
    assert reasoning == "Pensa senza aprire il tag."
    assert visible == "Risposta vera."


def test_split_stray_close_after_a_real_block_drops_only_the_tag():
    reasoning, visible = split_think("<think>plan</think>answer</think>tail")
    assert reasoning == "plan"
    assert visible == "answertail"


def test_strip_think_blocks_drops_trailing_unclosed_think():
    assert strip_think_blocks("Some answer<think>stray tail") == "Some answer"


def test_split_partial_stream_stages_of_one_block():
    """Le fasi live di un blocco che si apre e poi si chiude."""
    assert split_think("<think>") == ("", "")
    assert split_think("<think>Let me ") == ("Let me", "")
    assert split_think("<think>Let me check</think>") == ("Let me check", "")
    assert split_think("<think>Let me check</think>The answer") == ("Let me check", "The answer")
