"""Tests for Linux computer-use bridge (H16)."""
from __future__ import annotations

from homun.application.computer_use_driver import ComputerUseDriver
from homun.application.computer_use_linux_bridge import (
    capture_linux,
    list_linux_apps,
    perform_linux_action,
    probe_linux_computer_use,
)


def test_probe_reports_unavailable_without_display(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    st = probe_linux_computer_use()
    assert st["ready"] is False
    assert st["platform"] == "linux"


def test_capture_refuses_without_tools(monkeypatch):
    monkeypatch.setattr(
        "homun.application.computer_use_linux_bridge.probe_linux_computer_use",
        lambda: {"screen_recording": False, "error": "no tools"},
    )
    cap = capture_linux(None, "som")
    assert cap.width == 0
    assert cap.png_b64 is None


def test_action_refuses_without_xdotool(monkeypatch):
    monkeypatch.setattr(
        "homun.application.computer_use_linux_bridge.probe_linux_computer_use",
        lambda: {"accessibility": True},
    )
    monkeypatch.setattr("homun.application.computer_use_linux_bridge._XDOTOOL", None)
    out = perform_linux_action("click", {"x": 1, "y": 1})
    assert out.ok is False
    assert out.code == "backend_unavailable"


def test_driver_auto_wires_linux_bridge(monkeypatch):
    monkeypatch.setattr("homun.application.computer_use_driver.sys.platform", "linux")
    monkeypatch.setattr(
        "homun.application.computer_use_linux_bridge.probe_linux_computer_use",
        lambda: {
            "platform": "linux",
            "platform_supported": True,
            "installed": True,
            "ready": True,
            "accessibility": True,
            "screen_recording": True,
            "permissions_verified": True,
            "error": None,
            "code": None,
        },
    )
    monkeypatch.setattr(
        "homun.application.computer_use_linux_bridge.list_linux_apps",
        lambda: [{"app": "xterm", "pid": None, "bundle_id": None, "is_active": False}],
    )
    driver = ComputerUseDriver(auto_probe=True)
    status = driver.get_status()
    assert status["driver"] == "linux-bridge"
    assert status["ready"] is True
    assert any(a["app"] == "xterm" for a in driver.list_apps())
