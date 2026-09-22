"""Run message interpretation via fake or model provider (F3.2).

Ollama often fails strict tool/structured-output retries; we fall back to
JSON-in-prompt parsing so local models remain usable.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from homun.domain.ids import new_id
from homun.models.json_payload import extract_json_payload
from homun.models.interpretation import MessageInterpretation, RosterEntry
from homun.models.conversation_context import ConversationContext, context_notice
from homun.models.prompt_store import prompts_for
from homun.models.types import AttemptContext, ChatMessage, UsageAttempt, utc_now


def _prompt_with_preamble(conversation_context, core):
    """The authorized work-state preamble travels with the request, never as a command."""
    preamble = getattr(conversation_context, 'preamble', '') if conversation_context else ''
    if preamble:
        return f"{context_notice(conversation_context)}{preamble}\n\n{core}"
    return f"{context_notice(conversation_context)}{core}"

if TYPE_CHECKING:
    from homun.models.registry import ModelRegistry


def _extract_json_object(text: str) -> dict[str, Any]:
    # Same failure the intake parser already survived: thinking models wrap
    # JSON in prose or append commentary. Reuse the tolerant extractor instead
    # of a greedy brace regex that swallows the trailing output.
    parsed = json.loads(extract_json_payload(text))
    if not isinstance(parsed, dict):
        raise ValueError("Model JSON was not an object")
    return parsed


def _interpret_via_json_completion(
    registry: ModelRegistry,
    text: str,
    *,
    roster: list[RosterEntry],
    conversation_context: ConversationContext | None = None,
) -> MessageInterpretation:
    roster_lines = "\n".join(
        f"- {entry.id} | {entry.display_name} | {entry.kind}" for entry in roster
    ) or "(empty roster)"
    prompts = prompts_for(registry)
    prompt = (
        f"{prompts.get('interpret/instructions').text}\n\n"
        f"Reply with ONE JSON object only, no markdown, matching:\n{prompts.get('interpret/schema_hint').text}\n\n"
        f"{_prompt_with_preamble(conversation_context, f'Roster:\n{roster_lines}\n\nUser message:\n{text}')}"
    )
    completion = registry.complete(
        [*(conversation_context.messages if conversation_context else []),
         ChatMessage(role="user", content=prompt)],
        provider_id="openai_compatible",
    )
    raw = _extract_json_object(completion.text)
    return MessageInterpretation.model_validate(raw)


def _interpret_via_pydantic_ai(
    registry: ModelRegistry,
    text: str,
    *,
    roster: list[RosterEntry],
    conversation_context: ConversationContext | None = None,
) -> MessageInterpretation:
    from homun.models.adapters.pydantic_ai import (
        build_openai_compatible_chat_model,
        structured_output,
    )

    provider = registry._openai
    api_key = provider._api_key()
    if not api_key:
        raise RuntimeError("openai_compatible provider has no API key configured")

    model = build_openai_compatible_chat_model(
        model_id=provider.default_model,
        base_url=provider.base_url,
        api_key=api_key,
    )
    roster_lines = "\n".join(
        f"- {entry.id} | {entry.display_name} | {entry.kind}" for entry in roster
    ) or "(empty roster)"
    prompt = _prompt_with_preamble(
        conversation_context, f"Roster:\n{roster_lines}\n\nUser message:\n{text}")
    return structured_output(
        model=model,
        instructions=prompts_for(registry).get('interpret/instructions').text,
        user_prompt=prompt,
        output_type=MessageInterpretation,
        output_retries=3,
        history=conversation_context.messages if conversation_context else None,
    )


def run_interpret(
    registry: ModelRegistry,
    text: str,
    *,
    roster: list[RosterEntry],
    provider_id: str,
    conversation_context: ConversationContext | None = None,
) -> MessageInterpretation:
    if provider_id == "fake":
        return registry._fake.interpret(text, roster=roster)

    if provider_id != "openai_compatible":
        raise KeyError(f"Unknown provider for interpret: {provider_id}")

    provider = registry._openai
    if not provider._api_key():
        raise RuntimeError("openai_compatible provider has no API key configured")

    host = provider.base_url.lower()
    local = "127.0.0.1" in host or "localhost" in host
    # Local Ollama rarely supports reliable tool/structured retries — prefer JSON prompt.
    if local:
        try:
            return _interpret_via_json_completion(registry, text, roster=roster, conversation_context=conversation_context)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Local model interpret failed: {exc}") from exc

    try:
        return _interpret_via_pydantic_ai(registry, text, roster=roster, conversation_context=conversation_context)
    except Exception:  # noqa: BLE001
        try:
            return _interpret_via_json_completion(registry, text, roster=roster, conversation_context=conversation_context)
        except Exception as fallback_exc:  # noqa: BLE001
            raise RuntimeError(
                f"Model interpret failed (structured + JSON fallback): {fallback_exc}"
            ) from fallback_exc


def run_interpret_with_retry(
    registry: ModelRegistry,
    text: str,
    *,
    roster: list[RosterEntry],
    provider_id: str,
    attempts: int = 2,
    context: AttemptContext | None = None,
    conversation_context: ConversationContext | None = None,
) -> MessageInterpretation:
    """Retry once on provider RuntimeError only — never invent a successful action."""
    last: Exception | None = None
    total = max(1, min(attempts, 3))
    for index in range(total):
        usage_before = len(registry.usage)
        started = utc_now()
        try:
            result = run_interpret(registry, text, roster=roster, provider_id=provider_id,
                                   conversation_context=conversation_context)
            usage_entry = registry.usage[-1] if len(registry.usage) > usage_before else None
            model_id = usage_entry.model_id if usage_entry else None
            if model_id is None:
                provider = registry._providers.get(provider_id)
                model_id = getattr(provider, "default_model", None) if provider else None
            registry.append_attempt(
                UsageAttempt(
                    id=new_id("uat"),
                    workspace_id=getattr(registry, "workspace_id", "") or "",
                    command_id=context.command_id if context else None,
                    conversation_id=context.conversation_id if context else None,
                    work_id=context.work_id if context else None,
                    actor_id=context.actor_id if context else "",
                    purpose=context.purpose if context else "interpret",
                    attempt_index=index,
                    provider_id=provider_id,
                    model_id=model_id,
                    status="ok",
                    usage_entry_id=usage_entry.id if usage_entry else None,
                    input_tokens=usage_entry.input_tokens if usage_entry else None,
                    output_tokens=usage_entry.output_tokens if usage_entry else None,
                    started_at=started,
                    finished_at=utc_now(),
                    notes="Interpret attempt succeeded; no action claimed executed.",
                )
            )
            return result
        except RuntimeError as exc:
            last = exc
            registry.append_attempt(
                UsageAttempt(
                    id=new_id("uat"),
                    workspace_id=getattr(registry, "workspace_id", "") or "",
                    command_id=context.command_id if context else None,
                    conversation_id=context.conversation_id if context else None,
                    work_id=context.work_id if context else None,
                    actor_id=context.actor_id if context else "",
                    purpose=context.purpose if context else "interpret",
                    attempt_index=index,
                    provider_id=provider_id,
                    model_id=None,
                    status="error",
                    error_code="provider_error",
                    usage_entry_id=None,
                    input_tokens=None,
                    output_tokens=None,
                    started_at=started,
                    finished_at=utc_now(),
                    notes=str(exc)[:240],
                )
            )
            if index + 1 >= total:
                raise
    assert last is not None
    raise last


def format_interpretation_for_chat(interp: MessageInterpretation) -> str:
    if interp.kind == "reply":
        return interp.text or "(vuoto)"
    if interp.kind == "clarification":
        base = interp.text or "Serve un chiarimento."
        if interp.mentions:
            # Product language only: internal ids never reach the person.
            opts = "; ".join(
                f"{m.raw}: "
                + (", ".join(c.display_name for c in m.candidates) or "nessun candidato")
                for m in interp.mentions
            )
            return f"{base}\nCandidati: {opts}"
        return base
    if interp.kind == "patch_proposal":
        bits = [interp.text or "Propongo una modifica al lavoro."]
        for change in interp.patch_changes:
            bits.append(f"- {change.field}: → {change.to_value or '?'}")
        bits.append("(Anteprima — conferma nella card per applicare)")
        return "\n".join(bits)
    summary = interp.command.summary if interp.command else (interp.text or "Proposta")
    return f"{summary}\n(Proposta non applicata — F3.3)"
