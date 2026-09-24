"""macOS permission and readiness probes for computer use (H16).

Reports real Accessibility / Screen Recording trust state via ApplicationServices.
Never advertises ready=True without a verified probe result.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import logging
import shutil
import sys
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def _load_application_services() -> Optional[ctypes.CDLL]:
    path = ctypes.util.find_library("ApplicationServices")
    if not path:
        return None
    try:
        return ctypes.CDLL(path)
    except OSError as exc:
        logger.debug("ApplicationServices load failed: %s", exc)
        return None


def probe_macos_computer_use() -> Dict[str, Any]:
    """Probe TCC-related readiness on Darwin. Safe to call on other platforms (returns unsupported)."""
    if sys.platform != "darwin":
        return {
            "platform": sys.platform,
            "platform_supported": False,
            "installed": False,
            "ready": False,
            "can_grant": False,
            "accessibility": None,
            "screen_recording": None,
            "permissions_verified": True,
            "error": "Computer-use probes are only implemented for macOS in this build.",
            "code": "platform_unsupported",
        }

    as_lib = _load_application_services()
    accessibility: Optional[bool] = None
    screen_recording: Optional[bool] = None

    if as_lib is not None:
        try:
            # Boolean AXIsProcessTrusted(void)
            as_lib.AXIsProcessTrusted.restype = ctypes.c_bool
            accessibility = bool(as_lib.AXIsProcessTrusted())
        except Exception as exc:
            logger.debug("AXIsProcessTrusted failed: %s", exc)
            accessibility = None

        try:
            # bool CGPreflightScreenCaptureAccess(void) — macOS 10.15+
            as_lib.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
            screen_recording = bool(as_lib.CGPreflightScreenCaptureAccess())
        except Exception as exc:
            logger.debug("CGPreflightScreenCaptureAccess failed: %s", exc)
            screen_recording = None

    # Presence of common helper binaries is informational only — not readiness.
    helpers = {
        "screencapture": shutil.which("screencapture") is not None,
        "osascript": shutil.which("osascript") is not None,
    }

    trusted = accessibility is True
    # Screen recording is required for capture; without a conclusive probe we stay not-ready.
    capture_ok = screen_recording is True
    ready = trusted and capture_ok

    return {
        "platform": "darwin",
        "platform_supported": True,
        "installed": True,
        "ready": ready,
        "can_grant": True,
        "accessibility": accessibility,
        "screen_recording": screen_recording,
        "permissions_verified": accessibility is not None or screen_recording is not None,
        "helpers": helpers,
        "error": None if ready else (
            "macOS Accessibility and/or Screen Recording permission is not granted "
            "for this process. Grant them in System Settings → Privacy & Security."
        ),
        "code": None if ready else "permissions_required",
    }
