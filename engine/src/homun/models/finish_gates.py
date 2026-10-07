"""Stop-gates sulla risposta finale — porta dei guard di hermes-agent.

Fonte: agent/turn_final_response.py, agent/agent_runtime_helpers.py
(NousResearch/hermes-agent, MIT License, Copyright Nous Research).
I gate accettano o rinviano il testo finale di un run prima che diventi la
risposta consegnata: risposta vuota/solo-thinking recuperata, guardia
"annuncia la prossima azione ma si ferma" (max 2 rilanci), guardia frammento
degenere, e promozione del reasoning quando il modello chiude pulito senza
contenuto visibile. Le soglie e le regex sono quelle originali.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# agent_runtime_helpers.py:3069-3121 — costanti e detector verbatim
_DEGENERATE_FINAL_MAX_CHARS = 24
_SENTENCE_TERMINALS = (".", "!", "?", "。", "！", "？")
_DEGENERATE_LEADING_PUNCT = "?!,;:)]}"
_TRAILING_CONTINUE_INTENT_MAX_CHARS = 400

_TRAILING_CONTINUE_INTENT_RE = re.compile(
    r"(?:\blet me now\b|\bi(?:['\u2019])?ll now\b|\bi will now\b"
    r"|\bnow i(?:['\u2019]ll| will)\b|\bnext[,:] i\b)"
    r"[^.!?\n]{0,100}[.:\u2026]?\s*$", re.IGNORECASE,
)

# agent_runtime_helpers.py:3145 — tail detector per reasoning promosso
_PROMOTED_REASONING_PLAN_TAIL_RE = re.compile(
    r"(?:^|[.!?:\u3002\uff01\uff1f\u2014\u2013\n]\s*|\u2026\s*)"
    r"(?:let(?:['\u2019]s| me)\b|i(?:['\u2019]ll| will| need to| should| am going to|['\u2019]m going to)\b"
    r"|next[,:]? i\b|now i(?:['\u2019]ll| will| need to)\b|first[,:]? i(?:['\u2019]ll| will| need to)\b"
    r"|next[,:]? i\b|now i(?:['\u2019]ll| will| need to)\b"
    r"|(?:\u0e08\u0e30\u0e43\u0e2b\u0e49\u0e1c\u0e21|\u0e1c\u0e21\u0e08\u0e30))"
    r"[^.!?\n\u3002\uff01\uff1f]{0,160}(?:[.:\u2026]+)?\s*$",
    re.IGNORECASE,
)

THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
# il modello locale spesso apre senza <think> e chiude con </think> orfano:
# tutto ciò che precede la chiusura è ragionamento, non risposta
ORPHAN_THINK_RE = re.compile(r"^.*?</think>", re.DOTALL)
_OPENING_THINK_RE = re.compile(r"^\s*<think>(.*?)</think>", re.DOTALL)


def looks_like_degenerate_final(text: str, user_message: str | None = None) -> bool:
    """agent_runtime_helpers.py:3076 — un frammento collassato, non una risposta tersa."""
    t = (text or "").strip()
    if not t or len(t) > _DEGENERATE_FINAL_MAX_CHARS or t.endswith(_SENTENCE_TERMINALS):
        return False
    if t[0] in _DEGENERATE_LEADING_PUNCT and len(t) > 1 and t[1].isalpha():
        return True
    if not any(ch.isalpha() for ch in t) or any(ch.isascii() and ch.isalnum() for ch in t):
        return False
    user_text = user_message or ""
    return not any(ch.isalpha() and not ch.isascii() for ch in user_text)


def trailing_continue_intent(text: str) -> bool:
    """agent_runtime_helpers.py:3124 — risposta corta che FINISCE su un'azione annunciata."""
    t = (text or "").strip()
    if not t or len(t) > _TRAILING_CONTINUE_INTENT_MAX_CHARS:
        return False
    return bool(_TRAILING_CONTINUE_INTENT_RE.search(t[-160:]))


def promoted_reasoning_announces_action(text: str) -> bool:
    """agent_runtime_helpers.py:3145 — reasoning promosso che termina su un piano."""
    return bool(_PROMOTED_REASONING_PLAN_TAIL_RE.search((text or "").strip()))


def strip_think_blocks(text: str) -> str:
    """Il testo visibile senza i blocchi di ragionamento (coppie e orfani)."""
    result = THINK_BLOCK_RE.sub("", text or "")
    result = ORPHAN_THINK_RE.sub("", result)
    return result.strip()


@dataclass
class FinalGateVerdict:
    accept: bool
    text: str
    reason: str
    """accept=False → il chiamante rilancia il modello (nudge) o recupera."""


def gate_final_response(
    text: str,
    *,
    user_message: str | None = None,
    had_tool_results: bool,
    continuations: int,
    promoted_from_reasoning: bool = False,
) -> FinalGateVerdict:
    """La scaletta di accettazione del finale, nell'ordine dei guard Hermes.

    1. vuoto/solo-thinking → rifiuta (il chiamante recupera col continuo)
    2. degenerato (frammento) → rifiuta se c'è lavoro di tool dietro
    3. annuncia-continua-ma-si-ferma → rifiuta finché continuations < 2
    """
    visible = strip_think_blocks(text)

    if not visible:
        return FinalGateVerdict(False, text, "empty_or_think_only")

    if looks_like_degenerate_final(visible, user_message) and had_tool_results:
        return FinalGateVerdict(False, text, "degenerate_fragment")

    stall = trailing_continue_intent(visible) or (
        promoted_from_reasoning and promoted_reasoning_announces_action(visible)
    )
    if stall and had_tool_results and continuations < 2:
        return FinalGateVerdict(False, text, "trailing_continue_intent")

    return FinalGateVerdict(True, visible, "accepted")
