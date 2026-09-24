"""Context-aware detached side questions (H03).

Derived from Hermes agent/side_question.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun answers side questions (/btw) about the active conversation without
affecting main conversation state: no synthetic turns, no role-alternation risk,
no prompt-cache invalidation, tools strictly denied, and token usage attributed
back to the parent task/session.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional

from homun.domain.errors import ValidationError

logger = logging.getLogger(__name__)

SIDE_QUESTION_TASK = "side_question"
FORK_MAX_ITERATIONS = 3
PER_MESSAGE_CHAR_CAP = 2000
TRANSCRIPT_CHAR_BUDGET = 24000

FORK_PROMPT = (
    "The user asked a quick SIDE question with /btw while main work continues in the original session.\n"
    "Rules:\n"
    "- Answer ONLY the side question, using the conversation context above.\n"
    "- Do NOT continue, redo, or critique the main task.\n"
    "- Do NOT call any tools — tools are completely disabled for this side question. Answer directly in text.\n"
    "- If the conversation does not contain enough information to answer, state that plainly instead of guessing.\n"
    "- Be concise and direct."
)

ONESHOT_INSTRUCTIONS = (
    "You are an AI assistant answering a quick SIDE question with /btw about the transcribed conversation.\n"
    "Rules:\n"
    "- Answer ONLY the side question using the transcript as context.\n"
    "- Do not continue, redo, or critique the main task.\n"
    "- Do NOT call any tools — tools are disabled.\n"
    "- If the transcript does not contain enough information to answer, state that plainly.\n"
    "- Be concise and direct."
)

ROLE_LABELS = {
    "user": "USER",
    "assistant": "ASSISTANT",
    "tool": "TOOL RESULT",
    "system": "SYSTEM",
}


@dataclass
class SideQuestionOutcome:
    """Outcome of answering a detached side question."""
    question: str
    answer: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_estimate: float = 0.0
    tool_calls_attempted: List[str] = field(default_factory=list)
    status: str = "success"             # success | error
    error_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def trim_snapshot_for_fork(history: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Drop trailing messages until snapshot ends with completed assistant text.

    Ensures role alternation is preserved when replaying prefixes to strict providers.
    """
    msgs = list(history or [])
    while msgs:
        last = msgs[-1]
        if isinstance(last, dict) and last.get("role") == "assistant" and not last.get("tool_calls"):
            break
        msgs.pop()
    return msgs


def render_history_for_side_question(
    history: Optional[List[Dict[str, Any]]],
    char_budget: int = TRANSCRIPT_CHAR_BUDGET,
) -> str:
    """Format plain-text transcript with newest-biased truncation and tool call summaries."""
    lines: List[str] = []
    for msg in history or []:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role == "system":
            continue

        text = str(msg.get("content") or "")
        tool_calls = msg.get("tool_calls")
        if role == "assistant" and tool_calls and isinstance(tool_calls, list):
            names = []
            for tc in tool_calls:
                if isinstance(tc, dict):
                    fn = tc.get("function") or {}
                    name = fn.get("name") or tc.get("tool") or tc.get("name") or "?"
                    names.append(name)
            lines.append(f"ASSISTANT [called tools: {', '.join(names)}]")

        label = ROLE_LABELS.get(str(role).lower())
        if label and text.strip():
            capped_text = text.strip()[:PER_MESSAGE_CHAR_CAP]
            lines.append(f"{label}: {capped_text}")

    kept: List[str] = []
    used = 0
    for line in reversed(lines):
        if used + len(line) + 1 > char_budget and kept:
            break
        kept.append(line)
        used += len(line) + 1

    if not kept:
        return "(no prior conversation)"
    prefix = "[...older conversation omitted...]\n" if len(kept) < len(lines) else ""
    return prefix + "\n".join(reversed(kept))


class SideQuestionRunner:
    """Runner for answering detached side questions with tool suppression and parent usage attribution."""

    def __init__(self, model_invoker: Optional[Callable[..., Any]] = None):
        self.model_invoker = model_invoker

    def answer(
        self,
        question: str,
        history: Optional[List[Dict[str, Any]]] = None,
        *,
        parent_run: Optional[Dict[str, Any]] = None,
        model_invoker: Optional[Callable[..., Any]] = None,
        max_tokens: int = 1024,
    ) -> SideQuestionOutcome:
        clean_q = str(question or "").strip()
        if not clean_q:
            raise ValidationError("A non-empty question is required for side questions (/btw)")

        invoker = model_invoker or self.model_invoker
        if not invoker:
            raise ValidationError("A model invoker is required to execute side questions")

        transcript = render_history_for_side_question(history)
        messages = [
            {"role": "system", "content": ONESHOT_INSTRUCTIONS},
            {
                "role": "user",
                "content": f"Conversation transcript (snapshot):\n-----\n{transcript}\n-----\n\nSide question: {clean_q}",
            },
        ]

        attempted_tools: List[str] = []
        try:
            # Model is called without tools (tools denied / stripped)
            res = invoker(messages, max_tokens=max_tokens, tools=[])
            if isinstance(res, dict):
                answer_text = str(res.get("text") or res.get("content") or "").strip()
                p_tokens = int(res.get("prompt_tokens") or 0)
                c_tokens = int(res.get("completion_tokens") or 0)
                cost = float(res.get("cost_estimate") or 0.0)
                if "tool_calls" in res and res["tool_calls"]:
                    for tc in res["tool_calls"]:
                        t_name = tc.get("name") if isinstance(tc, dict) else str(tc)
                        attempted_tools.append(t_name)
            else:
                answer_text = str(res).strip()
                p_tokens = len(transcript) // 4
                c_tokens = len(answer_text) // 4
                cost = 0.0

            outcome = SideQuestionOutcome(
                question=clean_q,
                answer=answer_text,
                prompt_tokens=p_tokens,
                completion_tokens=c_tokens,
                cost_estimate=cost,
                tool_calls_attempted=attempted_tools,
                status="success",
            )

            # Attribute usage to parent run if supplied
            if parent_run is not None:
                parent_run["prompt_tokens"] = parent_run.get("prompt_tokens", 0) + p_tokens
                parent_run["completion_tokens"] = parent_run.get("completion_tokens", 0) + c_tokens
                parent_run["cost_estimate"] = parent_run.get("cost_estimate", 0.0) + cost

            return outcome
        except Exception as exc:
            logger.warning("Side question execution failed: %s", exc, exc_info=True)
            return SideQuestionOutcome(
                question=clean_q,
                answer="",
                status="error",
                error_message=str(exc),
            )
