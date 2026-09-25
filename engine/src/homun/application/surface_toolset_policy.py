"""Per-surface tool availability and dynamic toolset policy (H07).

Defines per-surface tool boundaries and toolset restrictions across surfaces:
CLI, TUI, Web, Desktop, BotScreen, and Headless.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set
from homun.models.agent_turn import ToolDefinition

# Destructive or write tools excluded in readonly toolset
WRITE_TOOL_NAMES: Set[str] = {
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
    "memory_remember",
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


def is_tool_allowed_for_surface(tool_name: str, run: Dict[str, Any]) -> bool:
    """Determine whether tool_name is permitted for the run's surface and toolset."""
    allowed_list = run.get("allowed_tools")
    if allowed_list is not None and isinstance(allowed_list, list):
        if tool_name not in allowed_list:
            return False

    denied_list = run.get("denied_tools")
    if denied_list is not None and isinstance(denied_list, list):
        if tool_name in denied_list:
            return False

    toolset = run.get("toolset")
    if toolset == "readonly":
        if tool_name in WRITE_TOOL_NAMES:
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
