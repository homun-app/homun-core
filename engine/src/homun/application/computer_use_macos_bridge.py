"""macOS OS bridge for computer-use (H16).

Uses osascript / screencapture / System Events — no fabricated apps, captures,
or input success. Actions refuse when Accessibility / Screen Recording probes fail.
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

from homun.application.computer_use_macos import probe_macos_computer_use
from homun.application.desktop_contracts import DesktopActionResult, DesktopCaptureResult

logger = logging.getLogger(__name__)

_OSASCRIPT = shutil.which("osascript")
_SCREENCAPTURE = shutil.which("screencapture")


def _run(argv: List[str], *, timeout: float = 15.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def list_macos_apps() -> List[Dict[str, Any]]:
    probe = probe_macos_computer_use()
    if probe.get("accessibility") is not True:
        return []
    if not _OSASCRIPT:
        return []
    script = (
        'tell application "System Events" to '
        "get name of every process whose background only is false"
    )
    try:
        reply = _run([_OSASCRIPT, "-e", script])
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.debug("list_macos_apps failed: %s", exc)
        return []
    if reply.returncode != 0:
        return []
    names = [n.strip() for n in (reply.stdout or "").split(",") if n.strip()]
    return [{"app": name, "pid": None, "bundle_id": None, "is_active": False} for name in names]


def list_macos_windows(app: Optional[str] = None) -> List[Dict[str, Any]]:
    probe = probe_macos_computer_use()
    if probe.get("accessibility") is not True:
        return []
    if not _OSASCRIPT:
        return []
    if app:
        script = (
            f'tell application "System Events" to tell process {app!r} to '
            "get {name, position, size} of every window"
        )
    else:
        script = (
            'tell application "System Events" to '
            "get {name, title} of every window of "
            "(every process whose background only is false)"
        )
    try:
        reply = _run([_OSASCRIPT, "-e", script], timeout=20.0)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if reply.returncode != 0:
        return []
    # Best-effort parse: one line of AppleScript list output.
    text = (reply.stdout or "").strip()
    if not text:
        return []
    return [{"id": None, "app": app or "unknown", "title": text[:200], "pid": None, "bounds": None, "z_index": 0}]


def capture_macos(app: Optional[str], mode: str) -> DesktopCaptureResult:
    probe = probe_macos_computer_use()
    if probe.get("screen_recording") is not True:
        return DesktopCaptureResult(
            mode=mode,
            width=0,
            height=0,
            note=(
                "Screen Recording permission is required for capture. "
                "Grant it in System Settings → Privacy & Security."
            ),
        )
    if not _SCREENCAPTURE:
        return DesktopCaptureResult(
            mode=mode,
            width=0,
            height=0,
            note="screencapture binary not found on PATH",
        )
    fd, path = tempfile.mkstemp(suffix=".png", prefix="homun-cua-")
    os.close(fd)
    out = Path(path)
    try:
        argv = [_SCREENCAPTURE, "-x", "-t", "png", str(out)]
        reply = _run(argv, timeout=30.0)
        if reply.returncode != 0 or not out.is_file() or out.stat().st_size < 32:
            return DesktopCaptureResult(
                mode=mode,
                width=0,
                height=0,
                note=f"screencapture failed: {(reply.stderr or reply.stdout or '').strip()[:200]}",
            )
        raw = out.read_bytes()
        # PNG IHDR width/height at bytes 16-24
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
            note="Captured via macOS screencapture",
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return DesktopCaptureResult(
            mode=mode,
            width=0,
            height=0,
            note=f"Capture unavailable: {exc}",
        )
    finally:
        try:
            out.unlink(missing_ok=True)
        except OSError:
            pass


def perform_macos_action(action: str, params: Dict[str, Any]) -> DesktopActionResult:
    probe = probe_macos_computer_use()
    if probe.get("accessibility") is not True:
        return DesktopActionResult(
            ok=False,
            action=action,
            message=(
                "Accessibility permission is required for input. "
                "Grant it in System Settings → Privacy & Security."
            ),
            code="permissions_required",
        )
    if not _OSASCRIPT:
        return DesktopActionResult(
            ok=False,
            action=action,
            message="osascript not found on PATH",
            code="backend_unavailable",
        )
    act = action.strip().lower()
    try:
        if act == "focus_app":
            app = str(params.get("app") or "").strip()
            if not app:
                return DesktopActionResult(ok=False, action=act, message="app is required", code="invalid_params")
            reply = _run([_OSASCRIPT, "-e", f'tell application "{app}" to activate'])
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
            script = (
                'tell application "System Events" to click at '
                f"{{{x}, {y}}}"
            )
            reply = _run([_OSASCRIPT, "-e", script])
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
            # AppleScript string escaping
            escaped = text.replace("\\", "\\\\").replace('"', '\\"')
            script = f'tell application "System Events" to keystroke "{escaped}"'
            reply = _run([_OSASCRIPT, "-e", script])
            if reply.returncode != 0:
                return DesktopActionResult(
                    ok=False,
                    action=act,
                    message=(reply.stderr or "type failed").strip()[:300],
                    code="execution_failed",
                )
            return DesktopActionResult(ok=True, action=act, message="Typed text")

        if act == "key":
            keys = str(params.get("keys") or "")
            # Only single characters via keystroke for safety; combos already filtered upstream.
            token = keys.split("+")[-1].strip()
            if len(token) != 1:
                return DesktopActionResult(
                    ok=False,
                    action=act,
                    message="Only single printable keys are supported without a full CGEvent bridge",
                    code="backend_unavailable",
                )
            escaped = token.replace("\\", "\\\\").replace('"', '\\"')
            reply = _run([_OSASCRIPT, "-e", f'tell application "System Events" to keystroke "{escaped}"'])
            if reply.returncode != 0:
                return DesktopActionResult(
                    ok=False,
                    action=act,
                    message=(reply.stderr or "key failed").strip()[:300],
                    code="execution_failed",
                )
            return DesktopActionResult(ok=True, action=act, message=f"Key {token}")

        if act == "scroll":
            return DesktopActionResult(
                ok=False,
                action=act,
                message="Scroll requires CGEvent bridge; not yet wired",
                code="backend_unavailable",
            )
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        return DesktopActionResult(
            ok=False,
            action=action,
            message=str(exc),
            code="execution_failed",
        )

    return DesktopActionResult(
        ok=False,
        action=action,
        message=f"Unknown action: {action}",
        code="unknown_action",
    )


def attach_macos_providers(driver: Any) -> None:
    """Wire real macOS providers onto an existing ComputerUseDriver."""
    driver._apps_provider = list_macos_apps
    driver._windows_provider = list_macos_windows
    driver._capture_provider = capture_macos
    driver._action_provider = perform_macos_action
