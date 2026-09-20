"""Post-model guardrails for message interpretation (F3.2).

These are not NLU: they only enforce roster ID existence and mention cardinality.
"""

from __future__ import annotations

from homun.models.interpretation import (
    MentionResolution,
    MessageInterpretation,
    RosterEntry,
)


def apply_interpretation_guardrails(
    interpretation: MessageInterpretation,
    roster: list[RosterEntry],
) -> MessageInterpretation:
    allowed = {entry.id for entry in roster}
    cleaned_mentions: list[MentionResolution] = []
    for mention in interpretation.mentions:
        candidates = [c for c in mention.candidates if c.id in allowed]
        cleaned_mentions.append(MentionResolution(raw=mention.raw, candidates=candidates))

    data = interpretation.model_copy(deep=True)
    data.mentions = cleaned_mentions

    ambiguous = [m for m in cleaned_mentions if len(m.candidates) != 1]
    if ambiguous and data.kind in {"command_proposal", "patch_proposal"}:
        names = ", ".join(m.raw for m in ambiguous)
        data.kind = "clarification"
        data.command = None
        data.patch_changes = []
        data.ambiguity = data.ambiguity or f"Ambiguous mention(s): {names}"
        data.text = data.text or (
            f"Non posso assegnare senza una scelta univoca per: {names}. "
            "Seleziona il candidato in elenco."
        )
    return data
