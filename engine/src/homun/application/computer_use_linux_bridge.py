"""Linux OS bridge for computer-use (H16).

Uses xdotool / wmctrl / import (ImageMagick) or scrot when available.
Never fabricates window lists, captures, or input success.
"""
from __future__ import annotations

import base64
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from homun.application.desktop_contracts import DesktopActionResult, DesktopCaptureResult

logger = logging.getLogger(__name__)

_XDOTOOL = shutil.which("xdotool")
_WMCTRL = shutil.which("wmctrl")
_IMPORT = shutil.which("import")  # ImageMagick
_SCROT = shutil.which("scrot")
_GNOME_SCREENSHOT = shutil.which("gnome-screenshot")


def probe_linux_computer_use() -> Dict[str, Any]:
    display = os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    has_tools = bool(_XDOTOOL or _WMCTRL)
    has_capture = bool(_IMPORT or _SCROT or _GNOME_SCREENSHOT)
    ready = bool(display) and has_tools and has_capture
    return {
        "platform": "linux",
        "platform_supported": True,
        "installed": has_tools or has_capture,
        "ready": ready,
        "can_grant": False,
        "accessibility": has_tools if display else False,
        "screen_recording": has_capture if display else False,
        "permissions_verified": True,
        "helpers": {
            "xdotool": bool(_XDOTOOL),
            "wmctrl": bool(_WMCTRL),
            "import": bool(_IMPORT),
            "scrot": bool(_SCROT),
            "gnome-screenshot": bool(_GNOME_SCREENSHOT),
            "display": bool(display),
        },
        "error": None if ready else (
            "Linux computer-use requires DISPLAY/WAYLAND_DISPLAY plus xdotool/wmctrl "
            "and a screenshot tool (import/scrot/gnome-screenshot)."
        ),
        "code": None if ready else "backend_unavailable",
    }


def _run(argv: List[str], *, timeout: float = 15.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)


def list_linux_apps() -> List[Dict[str, Any]]:
    probe = probe_linux_computer_use()
    if not probe.get("accessibility"):
        return []
    if _WMCTRL:
        reply = _run([_WMCTRL, "-l"])
        if reply.returncode != 0:
            return []
        apps = []
        for line in (reply.stdout or "").splitlines():
            parts = line.split(None, 3)
            if len(parts) >= 4:
                apps.append({"app": parts[3], "pid": None, "bundle_id": None, "is_active": False})
        return apps
    if _XDOTOOL:
        reply = _run([_XDOTOOL, "search", "--name", ""])
        return [{"app": wid.strip(), "pid": None, "bundle_id": None, "is_active": False}
                for wid in (reply.stdout or "").splitlines() if wid.strip()]
    return []


def list_linux_windows(app: Optional[str] = None) -> List[Dict[str, Any]]:
    apps = list_linux_apps()
    if app:
        apps = [a for a in apps if app.lower() in str(a.get("app") or "").lower()]
    return [
        {"id": None, "app": a.get("app"), "title": a.get("app"), "pid": None, "bounds": None, "z_index": 0}
        for a in apps
    ]


def capture_linux(app: Optional[str], mode: str) -> DesktopCaptureResult:
    probe = probe_linux_computer_use()
    if not probe.get("screen_recording"):
        return DesktopCaptureResult(
            mode=mode,
            width=0,
            height=0,
            note=probe.get("error") or "Linux screenshot tools unavailable",
        )
    fd, path = tempfile.mkstemp(suffix=".png", prefix="homun-cua-linux-")
    os.close(fd)
    out = Path(path)
    try:
        if _IMPORT:
            reply = _run([_IMPORT, "-window", "root", str(out)], timeout=30.0)
        elif _SCROT:
            reply = _run([_SCROT, str(out)], timeout=30.0)
        elif _GNOME_SCREENSHOT:
            reply = _run([_GNOME_SCREENSHOT, "-f", str(out)], timeout=30.0)
        else:
            return DesktopCaptureResult(mode=mode, width=0, height=0, note="No screenshot binary")
        if reply.returncode != 0 or not out.is_file() or out.stat().st_size < 32:
            return DesktopCaptureResult(
                mode=mode,
                width=0,
                height=0,
                note=f"screenshot failed: {(reply.stderr or reply.stdout or '').strip()[:200]}",
            )
        raw = out.read_bytes()
        width = height = 0
        if len(raw) >= 24 and raw[:8] == b"\x89PNG\r\n\x1a\n":
            width = int.from_bytes(raw[16:20], "big")
            height = int.from_bytes(raw[20:24], "big")
        return DesktopCaptureResult(
            mode=mode,
            width=width,
            height=height,
            png_b64=base64.b64encode(raw).decode("ascii"),
            elements=[],
            app=app or "",
            window_title="",
            note="Captured via Linux screenshot tool",
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return DesktopCaptureResult(mode=mode, width=0, height=0, note=str(exc))
    finally:
        try:
            out.unlink(missing_ok=True)
        except OSError:
            pass


def perform_linux_action(action: str, params: Dict[str, Any]) -> DesktopActionResult:
    probe = probe_linux_computer_use()
    if not probe.get("accessibility"):
        return DesktopActionResult(
            ok=False,
            action=action,
            message=probe.get("error") or "Linux input tools unavailable",
            code="backend_unavailable",
        )
    if not _XDOTOOL:
        return DesktopActionResult(
            ok=False,
            action=action,
            message="xdotool is required for Linux input",
            code="backend_unavailable",
        )
    act = action.strip().lower()
    try:
        if act == "focus_app":
            app = str(params.get("app") or "").strip()
            if not app:
                return DesktopActionResult(ok=False, action=act, message="app is required", code="invalid_params")
            reply = _run([_XDOTOOL, "search", "--name", app, "windowactivate"])
            if reply.returncode != 0:
                return DesktopActionResult(
                    ok=False,
                    action=act,
                    message=(reply.stderr or reply.stdout or "focus failed").strip()[:300],
                    code="execution_failed",
                )
            return DesktopActionResult(ok=True, action=act, message=f"Focused {app}")
        if act == "click":
            x = int(params.get("x", 0))
            y = int(params.get("y", 0))
            reply = _run([_XDOTOOL, "mousemove", str(x), str(y), "click", "1"])
            if reply.returncode != 0:
                return DesktopActionResult(
                    ok=False,
                    action=act,
                    message=(reply.stderr or "click failed").strip()[:300],
                    code="execution_failed",
                )
            return DesktopActionResult(ok=True, action=act, message=f"Clicked ({x},{y})")
        if act == "type":
            text = str(params.get("text") or "")
            reply = _run([_XDOTOOL, "type", "--", text])
            if reply.returncode != 0:
                return DesktopActionResult(
                    ok=False,
                    action=act,
                    message=(reply.stderr or "type failed").strip()[:300],
                    code="execution_failed",
                )
            return DesktopActionResult(ok=True, action=act, message="Typed text")
        if act == "key":
            keys = str(params.get("keys") or "").replace("+", "+")
            reply = _run([_XDOTOOL, "key", keys])
            if reply.returncode != 0:
                return DesktopActionResult(
                    ok=False,
                    action=act,
                    message=(reply.stderr or "key failed").strip()[:300],
                    code="execution_failed",
                )
            return DesktopActionResult(ok=True, action=act, message=f"Key {keys}")
        if act == "scroll":
            return DesktopActionResult(
                ok=False,
                action=act,
                message="Scroll not yet wired on Linux bridge",
                code="backend_unavailable",
            )
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        return DesktopActionResult(ok=False, action=action, message=str(exc), code="execution_failed")
    return DesktopActionResult(ok=False, action=action, message=f"Unknown action: {action}", code="unknown_action")


def attach_linux_providers(driver: Any) -> None:
    driver._apps_provider = list_linux_apps
    driver._windows_provider = list_linux_windows
    driver._capture_provider = capture_linux
    driver._action_provider = perform_linux_action
