"""GitHub Copilot ACP alternate client adapter (H39).

Derived from Hermes agent/copilot_acp_client.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Communicates with `copilot --acp` over stdio / JSON-RPC, extracting tool calls from
`<tool_call>{...}</tool_call>` blocks and providing clean fallback when unavailable.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from homun.application.acp_stdio_transport import StdioAcpTransport

logger = logging.getLogger(__name__)

_TOOL_CALL_REGEX = re.compile(r"<tool_call>\s*({.*?})\s*</tool_call>", re.DOTALL)


@dataclass
class CopilotAcpResult:
    """Outcome of a Copilot ACP turn execution."""

    text: str
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    raw_response: str = ""
    is_available: bool = True
    error: Optional[str] = None


class CopilotAcpClient:
    """Client adapter driving the GitHub Copilot CLI in ACP mode."""

    def __init__(self, command: Optional[str] = None, args: Optional[List[str]] = None) -> None:
        self.command = command or os.getenv("HERMES_COPILOT_ACP_COMMAND") or "copilot"
        self.args = args or ["--acp", "--stdio"]

    def is_available(self) -> bool:
        """Check if the copilot CLI executable is installed on PATH."""
        return shutil.which(self.command) is not None

    def extract_tool_calls(self, raw_text: str) -> tuple[str, List[Dict[str, Any]]]:
        """Extract embedded <tool_call> JSON blocks from output text.

        Returns (cleaned_text, tool_calls_list).
        """
        tool_calls: List[Dict[str, Any]] = []
        cleaned = raw_text

        for match in _TOOL_CALL_REGEX.finditer(raw_text):
            payload_str = match.group(1)
            try:
                data = json.loads(payload_str)
                name = data.get("name") or data.get("tool") or ""
                arguments = data.get("arguments") or data.get("args") or {}
                if name:
                    tool_calls.append({"name": name, "arguments": arguments})
            except Exception:
                pass

        cleaned = _TOOL_CALL_REGEX.sub("", raw_text).strip()
        return cleaned, tool_calls

    def run_turn(
        self,
        prompt: str,
        *,
        simulated_response: Optional[str] = None,
        transport: Optional[Any] = None,
        timeout_seconds: float = 60.0,
        cwd: Optional[str] = None,
    ) -> CopilotAcpResult:
        """Execute a turn via Copilot ACP or return explicit unavailable status.

        ``simulated_response`` is reserved for explicit test doubles. When the
        binary is on PATH and no transport is injected, Homun opens a real
        ``StdioAcpTransport`` session (initialize → session/new → session/prompt).
        """
        if simulated_response is not None:
            cleaned_text, tool_calls = self.extract_tool_calls(simulated_response)
            return CopilotAcpResult(
                text=cleaned_text,
                tool_calls=tool_calls,
                raw_response=simulated_response,
                is_available=True,
            )

        if not self.is_available():
            return CopilotAcpResult(
                text="",
                is_available=False,
                error=f"Copilot binary '{self.command}' is not installed or not found on PATH.",
            )

        active = transport
        if active is None:
            active = StdioAcpTransport(
                self.command,
                self.args,
                cwd=cwd,
                timeout_seconds=timeout_seconds,
            )

        try:
            raw = active.run(prompt)
        except Exception as exc:
            return CopilotAcpResult(
                text="",
                is_available=False,
                error=f"Copilot ACP transport failed: {exc}",
            )

        cleaned_text, tool_calls = self.extract_tool_calls(raw or "")
        return CopilotAcpResult(
            text=cleaned_text,
            tool_calls=tool_calls,
            raw_response=raw or "",
            is_available=True,
        )
