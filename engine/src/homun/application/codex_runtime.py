"""Codex App-Server runtime adapter (H39).

Translates between Homun's agent turn contracts and the Codex App-Server JSON-RPC
protocol, mapping streaming items, tool notifications, file changes, and interruptions.
"""
from __future__ import annotations

import json
import logging
import time
import os
import threading

from homun.application.codex_stdio_transport import CodexStdioTransport, CodexTransportError
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
    status: str = "completed"
    source: str = "engine"
    error_code: Optional[str] = None
    error: Optional[str] = None
    thread_id: Optional[str] = None
    turn_id: Optional[str] = None


class CodexAppServerAdapter:
    """Homun-owned adapter driving Codex App-Server sessions."""

    def __init__(self, command: Optional[str] = None, args: Optional[List[str]] = None) -> None:
        self.command = command or os.getenv("HOMUN_CODEX_COMMAND") or "codex"
        self.args = list(args if args is not None else ["app-server"])
        self._interrupted = False
        self._interrupt_event = threading.Event()

    def interrupt(self) -> None:
        """Signal interrupt for the active turn."""
        self._interrupted = True
        self._interrupt_event.set()

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
        self, messages: List[Dict[str, Any]], *,
        on_text_delta: Optional[Callable[[str], None]] = None,
        event_feed: Optional[List[Dict[str, Any]]] = None,
        cwd: Optional[str] = None,
        timeout_seconds: float = 60.0,
    ) -> CodexTurnResult:
        """Execute a real one-shot turn, or an explicitly supplied simulation feed."""
        self._interrupted = False
        self._interrupt_event.clear()
        started = time.monotonic()
        result = CodexTurnResult(text="", reasoning="", source="simulation" if event_feed is not None else "engine")

        def handle_text(delta):
            result.text += delta
            if on_text_delta:
                on_text_delta(delta)

        def handle_reasoning(delta):
            result.reasoning += delta

        def absorb(event):
            self.process_event(event, on_text_delta=handle_text, on_reasoning_delta=handle_reasoning)
            method = event.get("method")
            params = event.get("params") or {}
            item = params.get("item") or {}
            if method == 'item/completed' and item.get('type') == 'agentMessage':
                text = item.get('text')
                if isinstance(text, str):
                    result.text = text
            if method == "thread/tokenUsage/updated":
                usage = (params.get("tokenUsage") or {}).get("last") or {}
                tokens = usage.get("totalTokens")
                if isinstance(tokens, int) and not isinstance(tokens, bool) and tokens >= 0:
                    result.tokens_used = tokens
            if item.get("type") not in _CODEX_TOOL_ITEM_TYPES:
                return
            name = item.get("tool") or item.get("command") or item.get("type")
            item_id = item.get("id")
            # Legacy explicit replay fixtures lack IDs. Live items are ID-correlated.
            key = item_id or (name if event_feed is not None else None)
            if key is None:
                return
            existing = next((tc for tc in result.tool_calls if tc["id"] == key), None)
            if method == "item/started" and existing is None:
                result.tool_calls.append({"id": key, "name": name,
                                          "args": item.get("arguments") or item.get("params") or {},
                                          "status": "running"})
            elif method == "item/completed":
                if existing is None:
                    existing = {"id": key, "name": name, "args": {}}
                    result.tool_calls.append(existing)
                failed = item.get("exitCode", 0) != 0 or bool(item.get("error")) or item.get("status") == "failed"
                existing.update(status="error" if failed else "completed",
                                result=item.get("result", item.get("aggregatedOutput", "")))

        try:
            if event_feed is not None:
                for event in event_feed:
                    if self._interrupt_event.is_set():
                        result.status = "interrupted"
                        break
                    absorb(event)
            else:
                # Preserve supplied history as labelled context in the one-shot input.
                if len(messages) == 1 and messages[0].get("role") == "user":
                    prompt = str(messages[0].get("content") or "")
                else:
                    prompt = "\n\n".join(f"{m.get('role', 'user')}: {m.get('content', '')}" for m in messages)
                outcome = CodexStdioTransport(self.command, self.args, cwd=cwd,
                                             timeout_seconds=timeout_seconds).run(
                    prompt, on_event=absorb, interrupt_event=self._interrupt_event)
                result.thread_id = outcome["thread_id"]
                result.turn_id = outcome["turn_id"]
                result.status = outcome["status"]
        except CodexTransportError as exc:
            result.error_code = exc.code
            result.error = str(exc)
            result.status = "interrupted" if exc.code == "runtime_interrupted" else "unavailable" if exc.code == "backend_unavailable" else "failed"
        result.interrupted = result.status == "interrupted" or self._interrupt_event.is_set()
        result.duration_seconds = time.monotonic() - started
        return result
