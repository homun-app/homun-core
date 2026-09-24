"""Computer use backend, permissions readiness, and platform safety controls (H16).

Derived from Hermes tools/computer_use/cua_backend.py, cua_backend_capture.py, cua_backend_input.py,
permissions.py, and doctor.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Without a verified OS driver, Homun reports unavailability — never fabricated windows,
permissions, screenshots, or input success.
"""
from __future__ import annotations

import logging
import sys
from typing import Any, Callable, Dict, List, Optional

from homun.application.desktop_contracts import (
    DesktopActionResult,
    DesktopCaptureResult,
    check_action_safety,
)

logger = logging.getLogger(__name__)

BACKEND_UNAVAILABLE = (
    "Computer-use backend is not configured. Homun requires a verified OS driver "
    "(for example cua-driver) before advertising permissions or performing input."
)


class ComputerUseDriver:
    """Homun-owned Computer Use Driver and OS control orchestrator."""

    def __init__(
        self,
        *,
        status_probe: Optional[Callable[[], Dict[str, Any]]] = None,
        apps_provider: Optional[Callable[[], List[Dict[str, Any]]]] = None,
        windows_provider: Optional[Callable[[Optional[str]], List[Dict[str, Any]]]] = None,
        capture_provider: Optional[Callable[[Optional[str], str], DesktopCaptureResult]] = None,
        action_provider: Optional[Callable[[str, Dict[str, Any]], DesktopActionResult]] = None,
    ) -> None:
        self._active_app: Optional[str] = None
        self._active_window_id: Optional[int] = None
        self._active_pid: Optional[int] = None
        self._last_capture: Optional[DesktopCaptureResult] = None
        self._permission_mode: str = "restricted"
        self._status_probe = status_probe
        self._apps_provider = apps_provider
        self._windows_provider = windows_provider
        self._capture_provider = capture_provider
        self._action_provider = action_provider

    def get_status(self) -> Dict[str, Any]:
        """Return platform readiness only after a real permission/driver probe."""
        plat = sys.platform
        supported = plat in ("darwin", "win32", "linux")
        if self._status_probe is not None:
            probed = dict(self._status_probe())
            probed.setdefault("platform", plat)
            probed.setdefault("platform_supported", supported)
            probed.setdefault("permissions_verified", True)
            probed.setdefault("permission_mode", self._permission_mode)
            probed.setdefault("active_app", self._active_app)
            probed.setdefault("active_window_id", self._active_window_id)
            return probed

        return {
            "platform": plat,
            "platform_supported": supported,
            "installed": False,
            "ready": False,
            "can_grant": False,
            "accessibility": None,
            "screen_recording": None,
            "permissions_verified": False,
            "permission_mode": self._permission_mode,
            "active_app": self._active_app,
            "active_window_id": self._active_window_id,
            "error": BACKEND_UNAVAILABLE,
            "code": "backend_unavailable",
        }

    def list_apps(self) -> List[Dict[str, Any]]:
        """List running applications from the OS driver only."""
        if self._apps_provider is None:
            return []
        return list(self._apps_provider())

    def list_windows(self, app: Optional[str] = None) -> List[Dict[str, Any]]:
        """Enumerate on-screen windows from the OS driver only."""
        if self._windows_provider is None:
            return []
        return list(self._windows_provider(app))

    def focus_app(self, app: str) -> DesktopActionResult:
        """Bring target application window to front via the OS driver."""
        if self._action_provider is None:
            return DesktopActionResult(
                ok=False,
                action="focus_app",
                message=BACKEND_UNAVAILABLE,
                code="backend_unavailable",
            )
        return self._action_provider("focus_app", {"app": app})

    def capture(self, app: Optional[str] = None, mode: str = "som") -> DesktopCaptureResult:
        """Capture screen or window state via the OS driver only."""
        if self._capture_provider is None:
            return DesktopCaptureResult(
                mode=mode,
                width=0,
                height=0,
                note=BACKEND_UNAVAILABLE,
            )
        capture_result = self._capture_provider(app, mode)
        self._last_capture = capture_result
        return capture_result

    def perform_action(self, action: str, params: Dict[str, Any]) -> DesktopActionResult:
        """Perform a guarded pointer or keyboard action via the OS driver only."""
        safety_error = check_action_safety(action, params)
        if safety_error:
            return DesktopActionResult(
                ok=False,
                action=action,
                message=safety_error,
                code="blocked_safety_violation",
            )

        if self._action_provider is None:
            return DesktopActionResult(
                ok=False,
                action=action,
                message=BACKEND_UNAVAILABLE,
                code="backend_unavailable",
            )

        act = action.strip().lower()
        if act not in {"click", "type", "key", "scroll", "focus_app"}:
            return DesktopActionResult(
                ok=False,
                action=action,
                message=f"Unknown action: {action}",
                code="unknown_action",
            )
        return self._action_provider(act, params)
