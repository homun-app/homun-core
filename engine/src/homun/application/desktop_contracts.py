"""Native computer use and desktop control contracts (H16).

Defines UI element representations, capture results, action requests, security filters,
and safety policies for desktop computer use.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

_BLOCKED_KEY_COMBOS = {
    frozenset({"cmd", "shift", "backspace"}),
    frozenset({"cmd", "option", "backspace"}),
    frozenset({"cmd", "ctrl", "q"}),
    frozenset({"cmd", "shift", "q"}),
    frozenset({"cmd", "option", "q"}),
    frozenset({"cmd", "option", "shift", "q"}),
    frozenset({"win", "l"}),
    frozenset({"ctrl", "option", "delete"}),
    frozenset({"ctrl", "option", "del"}),
    frozenset({"option", "f4"}),
    frozenset({"alt", "f4"}),
}

_KEY_ALIASES = {
    "command": "cmd",
    "control": "ctrl",
    "alt": "option",
    "⌥": "option",
    "⌘": "cmd",
    "windows": "win",
    "super": "win",
    "meta": "win",
}

_BLOCKED_TYPE_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"curl\s+[^|]*\|\s*bash",
        r"curl\s+[^|]*\|\s*sh",
        r"wget\s+[^|]*\|\s*bash",
        r"\bsudo\s+rm\s+-[rf]",
        r"\brm\s+-rf\s+/\s*$",
        r":\s*\(\)\s*\{\s*:\|:\s*&\s*\}",  # fork bomb
    )
]


def canon_key_combo(keys: str) -> frozenset[str]:
    """Canonicalize a key combination string like 'Cmd+Shift+Q' into normalized tokens."""
    tokens = [k.strip().lower() for k in re.split(r"[\s+\-]+", keys) if k.strip()]
    return frozenset(_KEY_ALIASES.get(t, t) for t in tokens)


def check_action_safety(action: str, params: Dict[str, Any]) -> Optional[str]:
    """Verify an action does not attempt destructive shortcuts or shell command injections.

    Returns an error message if unsafe, or None if acceptable.
    """
    act = action.strip().lower()
    if act == "type":
        text = str(params.get("text", ""))
        for pat in _BLOCKED_TYPE_PATTERNS:
            if pat.search(text):
                return f"Blocked pattern in type text: {pat.pattern!r}. Destructive shell commands cannot be typed."

    if act == "key":
        keys = str(params.get("keys", ""))
        combo = canon_key_combo(keys)
        for blocked in _BLOCKED_KEY_COMBOS:
            if blocked.issubset(combo):
                return f"Blocked key combo: {sorted(blocked)}. Destructive system shortcuts are hard-blocked."

    if params.get("bring_to_front") and params.get("delivery_mode") != "foreground":
        return "bring_to_front requires delivery_mode='foreground'"

    return None


@dataclass
class DesktopUIElement:
    """An interactable UI element discovered during screen or window capture."""

    index: int
    role: str
    label: str = ""
    bounds: Tuple[int, int, int, int] = (0, 0, 0, 0)  # x, y, width, height
    app: str = ""
    pid: int = 0
    window_id: int = 0
    attributes: Dict[str, Any] = field(default_factory=dict)
    element_token: Optional[str] = None


@dataclass
class DesktopCaptureResult:
    """Result of capturing the desktop or a specific application window."""

    mode: str  # vision, ax, som
    width: int
    height: int
    png_b64: Optional[str] = None
    elements: List[DesktopUIElement] = field(default_factory=list)
    app: str = ""
    window_title: str = ""
    image_mime_type: Optional[str] = "image/png"
    screen_unchanged: bool = False
    note: Optional[str] = None


@dataclass
class DesktopActionResult:
    """Outcome of a desktop pointer/keyboard action."""

    ok: bool
    action: str
    message: str = ""
    code: Optional[str] = None
    delivery_mode: str = "background"
    details: Dict[str, Any] = field(default_factory=dict)
