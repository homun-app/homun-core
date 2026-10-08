"""Tool contracts for human clarification, batched questions, and multi-select (H08).

"""
from __future__ import annotations

import json
from typing import Any
from pydantic import BaseModel, ConfigDict, Field
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry

MAX_CHOICES = 4
MAX_QUESTIONS = 5
RECOMMENDED_LABEL = "(Recommended)"
TIMEOUT_RESPONSE = (
    "The user did not provide a response within the time limit. "
    "Use your best judgement to make the choice and proceed."
)

CLARIFY_DESCRIPTION = (
    "Ask the user one or more questions when you need a decision, "
    "clarification, or feedback before proceeding. Pass every question "
    f"in `questions` (1-{MAX_QUESTIONS} entries) — a single question is a "
    "one-entry array, and several INDEPENDENT questions belong in ONE "
    "call (one form beats a chain of clarify calls; if one answer would "
    "change another question, ask separately). Per question: "
    f"single-select (up to {MAX_CHOICES} choices — put your recommended "
    "option FIRST, the UI marks it '(Recommended)' and auto-appends an "
    "'Other' free-text row), multi-select (multi_select=true), or "
    "open-ended (omit choices). Options go ONLY in `choices`, never "
    "enumerated inside the question text (choices render as pickable "
    "rows; options written into the question are dead prose the user "
    "can't click). Result: {responses: [...]} in question order (plus "
    "timed_out=true, and a notice saying why, if the user stopped "
    "part-way or the prompt could not be delivered). Prefer deciding "
    "low-stakes questions yourself; don't use this for dangerous-command "
    "confirmation (the terminal tool handles that)."
)

CLARIFY_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "timeout_seconds": {"type":"integer", "minimum":1, "maximum":604800,
            "description":"Optional input deadline, in seconds. Omit to wait indefinitely. Expiration is missing input, never consent or approval."},
        "questions": {
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_QUESTIONS,
            "description": (
                "The question(s). Each: question text (options excluded), "
                "optional choices (recommended first; omit for free-text), "
                "optional multi_select. Responses come back in question "
                "order with the question text echoed."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "choices": {
                        "type": "array",
                        "items": {"type": "string"},
                        "maxItems": MAX_CHOICES,
                    },
                    "multi_select": {"type": "boolean"},
                },
                "required": ["question"],
            },
        },
    },
    "required": ["questions"],
}


class ClarifyArguments(BaseModel):
    model_config = ConfigDict(extra="allow")
    questions: list[Any] | None = None
    question: str | None = None
    choices: list[Any] | None = None
    multi_select: bool = False
    timeout_seconds: int | None = Field(default=None, ge=1, le=604800, strict=True)


def entries(handler, version=1):
    clarify_def = ToolDefinition(
        name="clarify",
        description=CLARIFY_DESCRIPTION,
        input_schema=CLARIFY_INPUT_SCHEMA,
    )

    def run_clarify(ctx, actor, run, args):
        return handler(ctx, actor, run, "clarify", args)

    return [
        ToolEntry(clarify_def, "clarify", str(version), ClarifyArguments, run_clarify, replay="never"),
    ]
