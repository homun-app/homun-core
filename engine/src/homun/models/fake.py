"""Deterministic fake model provider for tests (F3.1/F3.2). No network."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator

from homun.domain.ids import new_id
from homun.models.interpretation import (
    CommandProposal,
    MentionCandidate,
    MentionResolution,
    MessageInterpretation,
    PatchChangeDraft,
    RosterEntry,
)
from homun.models.types import ChatMessage, CompletionResult, UsageEntry, VerifyResult

_MENTION = re.compile(r"@([^\s@]+)")


class FakeProvider:
    """Always available. Completions are deterministic from the last user message."""

    provider_id = "fake"
    default_model = "fake-deterministic-v1"

    def __init__(self) -> None:
        self.last_stream_result: CompletionResult | None = None

    def verify_connection(self) -> VerifyResult:
        return VerifyResult(
            ok=True,
            provider_id=self.provider_id,
            message="Fake provider ready (no network).",
        )

    def complete(self, messages: list[ChatMessage], *, model_id: str | None = None) -> CompletionResult:
        model = model_id or self.default_model
        last_user = ""
        for message in reversed(messages):
            if message.role == "user":
                last_user = message.content.strip()
                break
        digest = hashlib.sha256(last_user.encode("utf-8")).hexdigest()[:8]
        lower = last_user.lower()
        if "catalogo" in lower or "listino" in lower:
            text = (
                f"[fake:{digest}] Proposta bozza catalogo: struttura prodotti/prezzi, "
                "senza elaborare file reali. Conferma obiettivo e materiali."
            )
        elif "mercato" in lower or "concorren" in lower:
            text = (
                f"[fake:{digest}] Proposta ricerca di mercato: perimetro, fonti da verificare, "
                "nessuna ricerca web eseguita in questa modalità fake."
            )
        elif "log" in lower or "error" in lower:
            text = (
                f"[fake:{digest}] Proposta analisi log: perimetro servizio/intervallo, "
                "priorità errori, nessun log letto in modalità fake."
            )
        elif not last_user:
            text = f"[fake:{digest}] Messaggio vuoto: indica obiettivo, vincoli e risultato atteso."
        else:
            text = (
                f"[fake:{digest}] Ho ricevuto: «{last_user[:180]}». "
                "In modalità fake non interpreto comandi di dominio: solo risposta deterministica."
            )
        usage = UsageEntry(
            id=new_id("usage"),
            provider_id=self.provider_id,
            model_id=model,
            input_tokens=max(1, len(last_user) // 4),
            output_tokens=max(1, len(text) // 4),
            estimated_cost=0.0,
            currency="EUR",
            status="ok",
            notes="Fake usage is synthetic and must not be billed.",
        )
        return CompletionResult(
            text=text,
            model_id=model,
            provider_id=self.provider_id,
            usage=usage,
        )

    def stream(self, messages: list[ChatMessage], *, model_id: str | None = None) -> Iterator[str]:
        result = self.complete(messages, model_id=model_id)
        self.last_stream_result = result
        size = 24
        text = result.text
        for i in range(0, len(text), size):
            yield text[i : i + size]

    def interpret(self, text: str, *, roster: list[RosterEntry]) -> MessageInterpretation:
        """Structured interpret for CI — roster @ resolution only, not multilingual NLU."""
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]
        mentions: list[MentionResolution] = []
        for raw_name in _MENTION.findall(text):
            raw = f"@{raw_name}"
            candidates = [
                MentionCandidate(id=entry.id, display_name=entry.display_name, kind=entry.kind)
                for entry in roster
                if entry.display_name.casefold() == raw_name.casefold() or entry.id == raw_name
            ]
            mentions.append(MentionResolution(raw=raw, candidates=candidates))
        stripped = text.strip()

        # F3.4: deterministic objective patch for CI (before generic command_proposal).
        objective_match = re.search(
            r"(?:cambia\s+obiettivo(?:\s+a|\s+in)?|nuovo\s+obiettivo[:\s]+)\s*(.+)$",
            stripped,
            flags=re.IGNORECASE,
        )
        if objective_match:
            new_objective = objective_match.group(1).strip().strip("«»\"'")
            if new_objective:
                return MessageInterpretation(
                    kind="patch_proposal",
                    text=(
                        f"[fake-interpret:{digest}] Propongo di aggiornare l'obiettivo "
                        "(anteprima; non applicato finché non confermi)."
                    ),
                    patch_changes=[
                        PatchChangeDraft(field="objective", to_value=new_objective),
                    ],
                    mentions=mentions,
                )

        # F3.4: assign first pending step to a unique @mention.
        assign_match = re.search(r"assegna(?:\s+passo)?\s+a\s+@([^\s@]+)", stripped, flags=re.IGNORECASE)
        if assign_match and mentions:
            unique = next((m for m in mentions if len(m.candidates) == 1), None)
            if unique and unique.candidates:
                return MessageInterpretation(
                    kind="patch_proposal",
                    text=(
                        f"[fake-interpret:{digest}] Propongo di riassegnare il primo passo "
                        f"a {unique.candidates[0].display_name}."
                    ),
                    patch_changes=[
                        PatchChangeDraft(
                            field="step_assignee",
                            to_value=unique.candidates[0].id,
                            step_id=None,
                        ),
                    ],
                    mentions=mentions,
                )

        # Short acknowledgements stay replies; longer asks become command proposals for F3.3.
        if len(stripped) < 12:
            return MessageInterpretation(
                kind="reply",
                text=(
                    f"[fake-interpret:{digest}] Ricevuto. "
                    "Modalità fake: risposta strutturata deterministica (nessun LLM)."
                ),
                mentions=mentions,
            )
        return MessageInterpretation(
            kind="command_proposal",
            text=(
                f"[fake-interpret:{digest}] Propongo di strutturare un piano di lavoro "
                "dalla richiesta (bozza non eseguita)."
            ),
            command=CommandProposal(
                type="plan.propose",
                payload={"source": "fake_interpret"},
                summary="Proposta piano di lavoro dalla chat",
            ),
            mentions=mentions,
        )
