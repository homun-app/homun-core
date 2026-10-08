"""Tests for Windows computer-use honesty bridge (H16)."""
from __future__ import annotations

from homun.application.computer_use_driver import ComputerUseDriver
from homun.application.computer_use_windows_bridge import (
    capture_windows,
    perform_windows_action,
    probe_windows_computer_use,
)


def test_windows_probe_never_ready():
    st = probe_windows_computer_use()
    assert st["ready"] is False
    assert st["code"] == "backend_unavailable"


def test_windows_actions_refuse():
    cap = capture_windows(None, "som")
    assert cap.width == 0
    out = perform_windows_action("click", {"x": 1, "y": 1})
    assert out.ok is False
    assert out.code == "backend_unavailable"


def test_driver_wires_windows_honesty(monkeypatch):
    monkeypatch.setattr("homun.application.computer_use_driver.sys.platform", "win32")
    driver = ComputerUseDriver(auto_probe=True)
    status = driver.get_status()
    assert status["ready"] is False
    assert status["driver"] == "windows-bridge-unavailable"
    assert driver.list_apps() == []
