"""Deterministic fake model provider for tests (F3.1/F3.2). No network."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator
from typing import Any

from homun.domain.ids import new_id
from homun.models.types import ChatMessage, CompletionResult, UsageEntry, VerifyResult

_MENTION = re.compile(r"@([^\s@]+)")


class FakeProvider:
    """Always available. Completions are deterministic from the last user message."""

    provider_id = "fake"
    default_model = "fake-deterministic-v1"

    def __init__(self) -> None:
        self.last_stream_result: CompletionResult | None = None
        # Native front-door support: scripted responses consumed in order, and
        # a log of the message lists received (tests assert the correction
        # rounds and the prompt language here).
        self.native_script: list[Any] = []
        self.native_calls: list[list[dict]] = []

    def verify_connection(self) -> VerifyResult:
        return VerifyResult(
            ok=True,
            provider_id=self.provider_id,
            message="Fake provider ready (no network).",
        )

    def _usage_for(self, model: str, *, input_text: str = "", output_text: str = "") -> UsageEntry:
        return UsageEntry(
            id=new_id("usage"),
            provider_id=self.provider_id,
            model_id=model,
            input_tokens=max(1, len(input_text) // 4),
            output_tokens=max(1, len(output_text) // 4),
            estimated_cost=0.0,
            currency="EUR",
            status="ok",
            notes="Fake usage is synthetic and must not be billed.",
        )

    def complete_tools_native(self, messages, *, tools=None, model_id: str | None = None,
                              **_kwargs) -> Any:
        """Native tool turn: scripted queue first, then a deterministic decision.

        Mirrors what a real model does with the front-door catalog: work-like
        requests call ``propose_work``, objective changes call
        ``propose_plan_change``, everything else answers with text.
        """
        from homun.models.native_turn import NativeMessage, NativeResult, ToolCall
        self.native_calls.append([message.model_dump(mode="json") for message in messages])
        model = model_id or self.default_model
        if self.native_script:
            item = self.native_script.pop(0)
            if isinstance(item, Exception):
                raise item
            if isinstance(item, NativeMessage):
                return NativeResult(message=item, usage=self._usage_for(model))
            return item
        last_user = ""
        for message in reversed(messages):
            if message.role == "user":
                last_user = message.content.strip()
                break
        lowered = last_user.lower()
        digest = hashlib.sha256(last_user.encode("utf-8")).hexdigest()[:8]
        # An objective change is the more specific phrase: it wins over work keywords.
        change = re.search(r"cambia\s+(?:l['’]\s*)?obiettivo(?:\s+(?:in|a))?[:\s]+(.+)$", last_user,
                           flags=re.IGNORECASE)
        if change and change.group(1).strip():
            call = ToolCall(id="call_fake_patch", name="propose_plan_change", arguments={
                "changes": [{"field": "objective",
                             "to_value": change.group(1).strip().strip("«»\"'.")[:200]}]})
            return NativeResult(
                message=NativeMessage(role="assistant", content="", tool_calls=[call]),
                usage=self._usage_for(model, input_text=last_user, output_text="patch"))
        if re.search(r"\b(prepara|nota|relazion|ricerca|catalogo|report|analizza|analisi)\b", lowered):
            call = ToolCall(id="call_fake_work", name="propose_work", arguments={
                "title": "Nota operativa (fake)",
                "objective": last_user[:200] or "Obiettivo della richiesta",
                "output": "Nota operativa breve",
                "capability": "general",
            })
            return NativeResult(
                message=NativeMessage(role="assistant", content="", tool_calls=[call]),
                usage=self._usage_for(model, input_text=last_user, output_text="propose_work"))
        text = (f"[fake:{digest}] Sono Homun in modalità deterministica: "
                f"ricevuto «{last_user[:120]}». Per un lavoro concreto chiedi «prepara …».")
        return NativeResult(
            message=NativeMessage(role="assistant", content=text),
            usage=self._usage_for(model, input_text=last_user, output_text=text))

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

    def stream(
        self,
        messages: list[ChatMessage],
        *,
        model_id: str | None = None,
        cancel_check: Any | None = None,
    ) -> Iterator[str]:
        result = self.complete(messages, model_id=model_id)
        self.last_stream_result = result
        size = 24
        text = result.text
        for i in range(0, len(text), size):
            yield text[i : i + size]
            if cancel_check is not None and callable(cancel_check) and cancel_check():
                break
