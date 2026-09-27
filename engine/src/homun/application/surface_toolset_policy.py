"""Per-surface tool availability and dynamic toolset policy (H07).

Defines per-surface tool boundaries and toolset restrictions across surfaces:
CLI, TUI, Web, Desktop, BotScreen, and Headless.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Literal
from pydantic import BaseModel, Field, ValidationError as SchemaError
from homun.models.agent_turn import ToolDefinition

# Destructive or write tools excluded in readonly toolset
WRITE_TOOL_NAMES: Set[str] = {
    "write_workspace_file",
    "patch_workspace_file",
    "terminal_execute",
    "write_file",
    "replace_file_content",
    "patch_file",
    "delete_file",
    "execute_code",
    "terminal_exec",
    "terminal_stdin",
    "terminal_stop",
    "terminal_write",
    "skill_propose",
    "skill_trust",
    "memory_remember",
    "memory_review",
    "checkpoint_restore",
    "goal_set",
    "goal_complete",
    "goal_cancel",
    "cronjob_manage",
}

# Desktop / interactive window tools excluded on constrained surfaces
DESKTOP_ONLY_TOOL_NAMES: Set[str] = {
    "desktop_click",
    "desktop_type",
    "desktop_drag",
    "desktop_key",
    "read_window",
    "drive_preview",
}


class RunToolPolicy(BaseModel):
    surface: Literal['cli', 'tui', 'web', 'desktop', 'bot_screen', 'headless'] = 'desktop'
    toolset: Literal['full', 'readonly', 'minimal'] = 'full'
    allowed_tools: list[str] | None = Field(default=None, max_length=256)
    denied_tools: list[str] = Field(default_factory=list, max_length=256)
    micro_compaction: bool = True
    native_stream: bool = False
    parallel_read_tools: bool = False


def pin_policy(body: Dict[str, Any]) -> Dict[str, Any]:
    from homun.domain.errors import ValidationError
    try:
        return RunToolPolicy.model_validate(body).model_dump()
    except SchemaError as exc:
        raise ValidationError('Invalid tool or context policy') from exc


def is_tool_allowed_for_surface(tool_name: str, run: Dict[str, Any], *, metadata=None) -> bool:
    """Determine whether tool_name is permitted for the run's surface and toolset."""
    policy = run.get("tool_policy") if isinstance(run.get("tool_policy"), dict) else run
    allowed_list = policy.get("allowed_tools") if "allowed_tools" in policy else run.get("allowed_tools")
    if allowed_list is not None and isinstance(allowed_list, list):
        if tool_name not in allowed_list:
            return False

    denied_list = policy.get("denied_tools") if "denied_tools" in policy else run.get("denied_tools")
    if denied_list is not None and isinstance(denied_list, list):
        if tool_name in denied_list:
            return False

    toolset = policy.get("toolset") or run.get("toolset")
    if toolset == "readonly":
        if metadata is None:
            metadata = next((item for item in run.get('tools', []) if item['name'] == tool_name), None)
        if tool_name in WRITE_TOOL_NAMES or (metadata is not None and metadata.get('replay') != 'read_only'):
            return False
    elif toolset == "minimal":
        if tool_name not in {"clarify", "request_user_input", "ask_question", "tool_search", "tool_describe"}:
            return False

    surface = str(run.get("surface") or run.get("surface_kind") or "").lower()
    if surface == "bot_screen":
        if tool_name in DESKTOP_ONLY_TOOL_NAMES:
            return False
    elif surface == "headless":
        if tool_name in DESKTOP_ONLY_TOOL_NAMES:
            return False

    return True


def filter_definitions_for_surface(
    definitions: List[ToolDefinition],
    run: Dict[str, Any],
) -> List[ToolDefinition]:
    """Filter a list of ToolDefinition according to the run's surface and toolset policy."""
    return [d for d in definitions if is_tool_allowed_for_surface(d.name, run)]
