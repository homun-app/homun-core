"""Implementation of human clarification, multi-select, batched questions, and partial timeouts (H08).

Derived from Hermes tools/clarify_tool.py and tools/clarify_gateway.py (MIT).
"""
from __future__ import annotations

import inspect
import json
from typing import Any, Callable, Dict, List, Optional
from homun.application.clarify_contracts import (
    MAX_CHOICES,
    MAX_QUESTIONS,
    RECOMMENDED_LABEL,
    TIMEOUT_RESPONSE,
)
from homun.domain.errors import ValidationError

_UNAVAILABLE = "Clarify tool is not available in this execution context."


def _flatten_choice(c: Any) -> str:
    """Coerce one choice to display text."""
    if isinstance(c, str):
        return c.strip()
    if isinstance(c, dict):
        return next(
            (
                v.strip()
                for k in ("label", "description", "text", "title")
                if isinstance(v := c.get(k), str) and v.strip()
            ),
            "",
        )
    if isinstance(c, (list, tuple)):
        return " ".join(_flatten_choice(x) for x in c).strip()
    return "" if c is None else str(c).strip()


def mark_recommended(choices: List[str]) -> List[str]:
    """Suffix the first choice with RECOMMENDED_LABEL when 2+ choices exist."""
    first = str(choices[0]).strip() if choices else ""
    if len(choices) < 2 or first != strip_recommended(first):
        return choices
    return [f"{first} {RECOMMENDED_LABEL}"] + list(choices[1:])


def strip_recommended(text: str) -> str:
    """Remove recommendation label so presentation never leaks into answers."""
    stripped = str(text).strip()
    if stripped.casefold().endswith(RECOMMENDED_LABEL.casefold()):
        return stripped[: -len(RECOMMENDED_LABEL)].strip()
    return stripped


def _accepts_kwarg(callback: Callable, name: str) -> bool:
    try:
        params = inspect.signature(callback).parameters
    except (TypeError, ValueError):
        return False
    return name in params or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())


def _invoke_callback(callback: Callable, question: str, choices: Optional[List[str]], multi_select: bool):
    if _accepts_kwarg(callback, "multi_select"):
        return callback(question, choices, multi_select=multi_select)
    return callback(question, choices)


def _json_as(raw: str, kind: type):
    try:
        parsed = json.loads(raw)
    except Exception:
        return None
    return parsed if isinstance(parsed, kind) else None


def _parse_multi_select_response(raw_response: Any) -> List[str]:
    items = raw_response
    if not isinstance(items, list):
        raw = str(items).strip()
        items = _json_as(raw, list) if raw.startswith("[") else None
        if items is None:
            items = raw.split(",")
    return [str(r).strip() for r in items if str(r).strip()]


def _clean_answer(raw: Any, multi: bool) -> Any:
    return [strip_recommended(r) for r in _parse_multi_select_response(raw)] if multi else strip_recommended(raw)


def _clean_choices(choices: list) -> Optional[List[str]]:
    cleaned = [s for s in (_flatten_choice(c) for c in choices) if s]
    return cleaned[:MAX_CHOICES] or None


def _is_timeout(raw: Any) -> bool:
    return raw is None or (isinstance(raw, str) and raw.strip() == TIMEOUT_RESPONSE)


def _normalize_questions(questions: Any) -> tuple[Optional[List[dict]], Optional[str]]:
    if not isinstance(questions, list):
        return None, "questions must be an array of question objects."
    if not questions:
        return None, None
    if len(questions) > MAX_QUESTIONS:
        return None, f"questions supports at most {MAX_QUESTIONS} items."
    normalized = []
    for index, item in enumerate(questions):
        if isinstance(item, str):
            item = {"question": item}
        if not isinstance(item, dict):
            return None, f"questions[{index}] must be an object with a 'question'."
        text = str(item.get("question") or "").strip()
        if not text:
            return None, f"questions[{index}].question must be non-empty text."
        choices = item.get("choices")
        if choices is not None:
            if not isinstance(choices, list):
                return None, f"questions[{index}].choices must be a list."
            choices = _clean_choices(choices)
        normalized.append(
            {
                "qid": f"q{index}",
                "id": str(item.get("id") or "").strip() or None,
                "question": text,
                "choices": mark_recommended(list(choices)) if choices else None,
                "choices_offered": list(choices) if choices else None,
                "multi_select": bool(item.get("multi_select")) and bool(choices),
            }
        )
    return normalized, None


def _batch_result(normalized: List[dict], answers: dict, timed_out: bool, notice: Optional[str] = None) -> str:
    responses = []
    for entry in normalized:
        raw = answers.get(entry["qid"])
        resp: Dict[str, Any] = {}
        if entry["id"]:
            resp["id"] = entry["id"]
        resp["question"] = entry["question"]
        resp["choices_offered"] = entry["choices_offered"]
        resp["user_response"] = _clean_answer(raw, entry["multi_select"]) if raw else ""
        responses.append(resp)
    result: Dict[str, Any] = {"responses": responses}
    if timed_out:
        result["timed_out"] = True
        if notice:
            result["notice"] = str(notice)
    return json.dumps(result, ensure_ascii=False)


def _run_batch(normalized: List[dict], callback: Callable, question: str) -> str:
    answers: dict = {}
    timed_out = False
    notice = None
    if _accepts_kwarg(callback, "questions"):
        raw = callback(question, None, questions=normalized)
        timed_out = _is_timeout(raw)
        if isinstance(raw, str):
            raw = _json_as(raw, dict)
        if isinstance(raw, dict):
            answers = dict(raw.get("answers") or {})
            timed_out = bool(raw.get("timed_out"))
            notice = raw.get("notice")
        return _batch_result(normalized, answers, timed_out, notice)
    for entry in normalized:
        raw = _invoke_callback(callback, entry["question"], entry["choices"], entry["multi_select"])
        if _is_timeout(raw):
            timed_out = True
            break
        answers[entry["qid"]] = raw
    return _batch_result(normalized, answers, timed_out)


def clarify_tool(
    question: str = "",
    choices: Optional[List[str]] = None,
    multi_select: bool = False,
    questions: Optional[List[dict]] = None,
    callback: Optional[Callable] = None,
) -> str:
    if questions is not None:
        normalized, error = _normalize_questions(questions)
        if error:
            return json.dumps({"error": error})
        if normalized:
            if callback is None:
                return json.dumps({"error": _UNAVAILABLE})
            try:
                return _run_batch(normalized, callback, str(question or "").strip())
            except Exception as exc:
                return json.dumps({"error": f"Failed to get user input: {exc}"})
    if not question or not str(question).strip():
        return json.dumps(
            {
                "error": (
                    "No question provided. Pass questions=[{question: '...', "
                    "choices?: [...], multi_select?: bool}, ...] — a single question "
                    "is a one-entry array."
                )
            }
        )
    q_text = str(question).strip()
    if choices is not None:
        if not isinstance(choices, list):
            return json.dumps({"error": "choices must be a list of strings."})
        choices = _clean_choices(choices)
    if callback is None:
        return json.dumps({"error": _UNAVAILABLE})
    shown = mark_recommended(choices) if choices is not None else None
    try:
        raw_response = _invoke_callback(callback, q_text, shown, multi_select)
    except Exception as exc:
        return json.dumps({"error": f"Failed to get user input: {exc}"})
    return json.dumps(
        {
            "question": q_text,
            "choices_offered": choices,
            "user_response": _clean_answer(raw_response, bool(multi_select) and bool(choices)),
        },
        ensure_ascii=False,
    )


def execute(ctx, actor, run, tool, args):
    if run.get("clarify", {}).get("policy") != "structured-clarify-v1":
        raise ValidationError("Clarify tools are not enabled for this run")
    if tool != "clarify":
        raise ValidationError(f"Unknown clarify tool: {tool}")

    callback = run.get("_clarify_callback")
    if callback is None and "_clarify_answers" in run:
        answers_cfg = run["_clarify_answers"]

        def _preset_callback(q, c, multi_select=False, questions=None):
            if questions is not None:
                if isinstance(answers_cfg, dict) and "answers" in answers_cfg:
                    return answers_cfg
                if isinstance(answers_cfg, dict):
                    return {"answers": answers_cfg}
                return answers_cfg
            if isinstance(answers_cfg, dict):
                return answers_cfg.get(q, "")
            return answers_cfg

        callback = _preset_callback

    raw_json = clarify_tool(
        question=args.get("question", ""),
        choices=args.get("choices"),
        multi_select=bool(args.get("multi_select", False)),
        questions=args.get("questions"),
        callback=callback,
    )
    return json.loads(raw_json)
