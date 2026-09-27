"""Contracts and schemas for Programmatic Tool Calling (PTC) via code execution (H13).

at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun enables models to write Python scripts that invoke tools programmatically
over an authenticated local RPC socket, collapsing multi-step workflows into
a single turn with output reduction, error handling, and timeout enforcement.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional

from pydantic import BaseModel, Field

DEFAULT_TIMEOUT = 300           # 5 minutes
DEFAULT_MAX_TOOL_CALLS = 50
MAX_STDOUT_BYTES = 50_000       # 50 KB
MAX_STDERR_BYTES = 10_000       # 10 KB


@dataclass
class CodeExecutionResult:
    """Outcome of programmatic Python script execution."""
    exit_code: int
    stdout: str
    stderr: str
    tool_calls_count: int = 0
    tool_call_log: List[Dict[str, Any]] = field(default_factory=list)
    truncated: bool = False
    duration_seconds: float = 0.0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class CodeExecutionArguments(BaseModel):
    code: str = Field(
        description="Python code to execute. Can call tools via `call_tool(tool_name, args)`."
    )
    timeout: Optional[int] = Field(
        default=DEFAULT_TIMEOUT, ge=1, le=600,
        description="Execution timeout in seconds (default 300).",
    )
    max_tool_calls: Optional[int] = Field(
        default=DEFAULT_MAX_TOOL_CALLS, ge=1, le=1000,
        description="Maximum number of programmatic tool calls allowed (default 50).",
    )


def entries(executor: Callable, version: int) -> list:
    from homun.application.agent_tool_contracts import ToolDefinition
    from homun.tools.registry import ToolEntry

    def dispatch(ctx, actor, run, args):
        return executor(ctx, actor, run, 'execute_code', args)

    return [
        ToolEntry(
            ToolDefinition(
                name="execute_code",
                description="Execute Python code with programmatic tool access (call_tool). Collapses multi-step discovery and data filtering into a single turn.",
                input_schema=CodeExecutionArguments.model_json_schema(),
            ),
            "code_execution",
            str(version),
            CodeExecutionArguments,
            dispatch,
            replay="never",
        ),
    ]
