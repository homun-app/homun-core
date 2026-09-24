"""Tests for macOS computer-use bridge (H16)."""
from __future__ import annotations

from homun.application.computer_use_driver import ComputerUseDriver
from homun.application.computer_use_macos_bridge import (
    capture_macos,
    list_macos_apps,
    perform_macos_action,
)
from homun.application.desktop_contracts import DesktopCaptureResult


def test_capture_refuses_without_screen_recording(monkeypatch):
    monkeypatch.setattr(
        "homun.application.computer_use_macos_bridge.probe_macos_computer_use",
        lambda: {
            "accessibility": True,
            "screen_recording": False,
            "ready": False,
        },
    )
    cap = capture_macos(None, "som")
    assert isinstance(cap, DesktopCaptureResult)
    assert cap.width == 0
    assert cap.png_b64 is None
    assert "Screen Recording" in (cap.note or "")


def test_action_refuses_without_accessibility(monkeypatch):
    monkeypatch.setattr(
        "homun.application.computer_use_macos_bridge.probe_macos_computer_use",
        lambda: {
            "accessibility": False,
            "screen_recording": True,
            "ready": False,
        },
    )
    out = perform_macos_action("click", {"x": 10, "y": 10})
    assert out.ok is False
    assert out.code == "permissions_required"


def test_list_apps_empty_without_accessibility(monkeypatch):
    monkeypatch.setattr(
        "homun.application.computer_use_macos_bridge.probe_macos_computer_use",
        lambda: {"accessibility": False, "screen_recording": False},
    )
    assert list_macos_apps() == []


def test_driver_auto_wires_macos_bridge(monkeypatch):
    monkeypatch.setattr(
        "homun.application.computer_use_driver.sys.platform",
        "darwin",
    )
    fake_probe = lambda: {
        "platform": "darwin",
        "platform_supported": True,
        "installed": True,
        "ready": True,
        "can_grant": True,
        "accessibility": True,
        "screen_recording": True,
        "permissions_verified": True,
        "error": None,
        "code": None,
    }
    monkeypatch.setattr(
        "homun.application.computer_use_driver.probe_macos_computer_use",
        fake_probe,
    )
    monkeypatch.setattr(
        "homun.application.computer_use_macos_bridge.probe_macos_computer_use",
        fake_probe,
    )
    monkeypatch.setattr(
        "homun.application.computer_use_macos_bridge.list_macos_apps",
        lambda: [{"app": "TextEdit", "pid": 1, "bundle_id": None, "is_active": False}],
    )
    driver = ComputerUseDriver(auto_probe=True)
    status = driver.get_status()
    assert status["driver"] == "macos-bridge"
    assert status["ready"] is True
    assert any(a["app"] == "TextEdit" for a in driver.list_apps())
