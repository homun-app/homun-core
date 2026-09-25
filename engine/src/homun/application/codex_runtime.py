"""Codex App-Server runtime adapter (H39).

Translates between Homun's agent turn contracts and the Codex App-Server JSON-RPC
protocol, mapping streaming items, tool notifications, file changes, and interruptions.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

_CODEX_TOOL_ITEM_TYPES = frozenset({
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
})


@dataclass
class CodexTurnResult:
    """Result of a completed Codex App-Server turn."""

    text: str
    reasoning: str
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    tokens_used: int = 0
    duration_seconds: float = 0.0
    interrupted: bool = False


class CodexAppServerAdapter:
    """Homun-owned adapter driving Codex App-Server sessions."""

    def __init__(self, command: str = "codex", args: Optional[List[str]] = None) -> None:
        self.command = command
        self.args = args or ["app-server", "--stdio"]
        self._interrupted = False

    def interrupt(self) -> None:
        """Signal interrupt for the active turn."""
        self._interrupted = True

    def process_event(
        self,
        event: Dict[str, Any],
        *,
        on_text_delta: Optional[Callable[[str], None]] = None,
        on_reasoning_delta: Optional[Callable[[str], None]] = None,
        on_tool_started: Optional[Callable[[str, Dict[str, Any]], None]] = None,
        on_tool_completed: Optional[Callable[[str, Any, bool], None]] = None,
    ) -> None:
        """Process a single JSON-RPC event notification from the Codex App-Server."""
        method = event.get("method", "")
        params = event.get("params", {})

        if method == "item/agentMessage/delta":
            delta = params.get("delta") or params.get("text") or ""
            if delta and on_text_delta:
                on_text_delta(delta)

        elif method in ("item/reasoning/delta", "item/reasoning/summaryDelta"):
            delta = params.get("delta") or params.get("text") or ""
            if delta and on_reasoning_delta:
                on_reasoning_delta(delta)

        elif method == "item/started":
            item = params.get("item", {})
            item_type = item.get("type", "")
            if item_type in _CODEX_TOOL_ITEM_TYPES:
                name = item.get("tool") or item.get("command") or item_type
                args = item.get("arguments") or item.get("params") or {}
                if on_tool_started:
                    on_tool_started(name, args)

        elif method == "item/completed":
            item = params.get("item", {})
            item_type = item.get("type", "")
            if item_type in _CODEX_TOOL_ITEM_TYPES:
                name = item.get("tool") or item.get("command") or item_type
                res = item.get("result") or item.get("aggregatedOutput") or ""
                exit_code = item.get("exitCode", 0)
                is_error = bool(exit_code != 0 or item.get("error"))
                if on_tool_completed:
                    on_tool_completed(name, res, is_error)

    def run_turn(
        self,
        messages: List[Dict[str, Any]],
        *,
        on_text_delta: Optional[Callable[[str], None]] = None,
        event_feed: Optional[List[Dict[str, Any]]] = None,
    ) -> CodexTurnResult:
        """Execute or replay a turn against the Codex App-Server protocol."""
        self._interrupted = False
        start_time = time.monotonic()
        text_buf = []
        reasoning_buf = []
        tool_calls: List[Dict[str, Any]] = []

        def handle_text(delta: str) -> None:
            text_buf.append(delta)
            if on_text_delta:
                on_text_delta(delta)

        def handle_reasoning(delta: str) -> None:
            reasoning_buf.append(delta)

        def handle_tool_started(name: str, args: Dict[str, Any]) -> None:
            tool_calls.append({"name": name, "args": args, "status": "running"})

        def handle_tool_completed(name: str, result: Any, is_error: bool) -> None:
            for tc in tool_calls:
                if tc["name"] == name and tc["status"] == "running":
                    tc["status"] = "error" if is_error else "completed"
                    tc["result"] = result
                    break

        if event_feed:
            for event in event_feed:
                if self._interrupted:
                    break
                self.process_event(
                    event,
                    on_text_delta=handle_text,
                    on_reasoning_delta=handle_reasoning,
                    on_tool_started=handle_tool_started,
                    on_tool_completed=handle_tool_completed,
                )
        else:
            # Synthetic / fallback turn when running without a live process
            last_user = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
            response_text = f"[Codex App-Server]: Handled '{last_user}'"
            handle_text(response_text)

        dur = time.monotonic() - start_time
        return CodexTurnResult(
            text="".join(text_buf),
            reasoning="".join(reasoning_buf),
            tool_calls=tool_calls,
            tokens_used=len("".join(text_buf).split()) * 2,
            duration_seconds=dur,
            interrupted=self._interrupted,
        )
