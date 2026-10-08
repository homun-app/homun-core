"""Windows computer-use bridge placeholder (H16).

Homun does not yet ship a verified Win32/UI Automation driver. This module
only reports honest unavailability so the product never invents captures or
input success on Windows.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from homun.application.desktop_contracts import DesktopActionResult, DesktopCaptureResult


def probe_windows_computer_use() -> Dict[str, Any]:
    return {
        "platform": "win32",
        "platform_supported": True,
        "installed": False,
        "ready": False,
        "can_grant": False,
        "accessibility": False,
        "screen_recording": False,
        "permissions_verified": True,
        "error": (
            "Windows computer-use requires a verified Win32/UI Automation driver; "
            "Homun has not wired one yet."
        ),
        "code": "backend_unavailable",
    }


def list_windows_apps() -> List[Dict[str, Any]]:
    return []


def list_windows_windows(app: Optional[str] = None) -> List[Dict[str, Any]]:
    return []


def capture_windows(app: Optional[str], mode: str) -> DesktopCaptureResult:
    return DesktopCaptureResult(
        mode=mode,
        width=0,
        height=0,
        app=app or "",
        note="Windows computer-use backend unavailable",
    )


def perform_windows_action(action: str, params: Dict[str, Any]) -> DesktopActionResult:
    return DesktopActionResult(
        ok=False,
        action=action,
        message="Windows computer-use backend unavailable",
        code="backend_unavailable",
    )


def attach_windows_providers(driver: Any) -> None:
    """Attach honest Windows providers that refuse until a real driver exists."""
    driver._apps_provider = list_windows_apps
    driver._windows_provider = list_windows_windows
    driver._capture_provider = capture_windows
    driver._action_provider = perform_windows_action
