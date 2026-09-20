"""Extract PlanDraft from user text (F3.3)."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any

from homun.models.interpretation import RosterEntry
from homun.models.conversation_context import ConversationContext, context_notice
from homun.models.prompt_store import prompts_for
from homun.models.types import ChatMessage
from homun.planning.draft import PlanDraft, PlanStepDraft, validate_plan_draft

if TYPE_CHECKING:
    from homun.models.registry import ModelRegistry


def extract_plan_draft_fake(text: str, *, roster: list[RosterEntry]) -> PlanDraft:
    """Deterministic draft for CI — not multilingual NLU."""
    assignee = roster[0].id if roster else ""
    stripped = text.strip()
    if len(stripped) < 12:
        return validate_plan_draft(
            PlanDraft(objective="", expected_result="", steps=[]),
            allowed_assignee_ids={e.id for e in roster},
        )
    draft = PlanDraft(
        objective=stripped[:240],
        expected_result="Consegna verificabile allineata alla richiesta",
        criteria=["Completo", "Revisionabile dal richiedente"],
        steps=[
            PlanStepDraft(
                title="Raccogliere input e vincoli",
                assignee_id=assignee,
                output_expected="Elenco input",
            ),
            PlanStepDraft(
                title="Produrre bozza del risultato",
                assignee_id=assignee,
                output_expected="Bozza",
            ),
        ],
    )
    return validate_plan_draft(draft, allowed_assignee_ids={e.id for e in roster})


def _extract_json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", stripped)
    if not match:
        raise ValueError("No JSON object found in model output")
    parsed = json.loads(match.group(0))
    if not isinstance(parsed, dict):
        raise ValueError("Model JSON was not an object")
    return parsed


def _extract_via_json_completion(
    registry: ModelRegistry,
    text: str,
    *,
    roster: list[RosterEntry],
    conversation_context: ConversationContext | None = None,
) -> PlanDraft:
    roster_lines = "\n".join(
        f"- {e.id} | {e.display_name} | {e.kind}" for e in roster
    ) or "(empty roster)"
    prompts = prompts_for(registry)
    preamble = getattr(conversation_context, 'preamble', '') if conversation_context else ''
    core = f"Roster:\n{roster_lines}\n\nUser message:\n{text}"
    prompt = (
        f"{prompts.get('planning/instructions').text}\n\n"
        f"Reply with ONE JSON object only, no markdown, matching:\n{prompts.get('planning/schema_hint').text}\n\n"
        + (f"{context_notice(conversation_context)}{preamble}\n\n{core}" if preamble
           else f"{context_notice(conversation_context)}{core}")
    )
    completion = registry.complete(
        [*(conversation_context.messages if conversation_context else []),
         ChatMessage(role="user", content=prompt)],
        provider_id="openai_compatible",
    )
    raw = PlanDraft.model_validate(_extract_json_object(completion.text))
    return validate_plan_draft(raw, allowed_assignee_ids={e.id for e in roster})


def extract_plan_draft(
    registry: ModelRegistry,
    text: str,
    *,
    roster: list[RosterEntry],
    provider_id: str | None = None,
    conversation_context: ConversationContext | None = None,
) -> PlanDraft:
    pid = provider_id or registry.active_provider_id
    allowed = {e.id for e in roster}
    if pid == "fake":
        return extract_plan_draft_fake(text, roster=roster)

    if pid != "openai_compatible":
        raise KeyError(f"Unknown provider for plan extract: {pid}")

    provider = registry._openai
    api_key = provider._api_key()
    if not api_key:
        raise RuntimeError("openai_compatible provider has no API key configured")

    host = provider.base_url.lower()
    local = "127.0.0.1" in host or "localhost" in host
    if local:
        return _extract_via_json_completion(registry, text, roster=roster, conversation_context=conversation_context)

    from homun.models.adapters.pydantic_ai import (
        build_openai_compatible_chat_model,
        structured_output,
    )

    model = build_openai_compatible_chat_model(
        model_id=provider.default_model,
        base_url=provider.base_url,
        api_key=api_key,
    )
    try:
        roster_lines = "\n".join(
            f"- {e.id} | {e.display_name} | {e.kind}" for e in roster
        ) or "(empty roster)"
        prompt = f"{context_notice(conversation_context)}Roster:\n{roster_lines}\n\nUser message:\n{text}"
        raw = structured_output(
            model=model,
            instructions=prompts_for(registry).get('planning/instructions').text,
            user_prompt=prompt,
            output_type=PlanDraft,
            output_retries=3,
            history=conversation_context.messages if conversation_context else None,
        )
        return validate_plan_draft(raw, allowed_assignee_ids=allowed)
    except Exception:  # noqa: BLE001 — local models often break structured output
        return _extract_via_json_completion(registry, text, roster=roster, conversation_context=conversation_context)
