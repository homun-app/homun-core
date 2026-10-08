"""wa-rs-bridge supervisor: spawn only when enabled, probe before spawning."""
import stat
import subprocess

import pytest

from homun.application import whatsapp_bridge_process as supervisor
from homun.application.engine_listening import set_listening_port
from homun.context import create_context, reset_context_for_tests


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    set_listening_port(48765)
    supervisor._spawned = None
    supervisor._last_check = 0.0
    yield ctx
    supervisor._spawned = None
    supervisor._last_check = 0.0
    set_listening_port  # port stays set; tests override it explicitly
    reset_context_for_tests(None)


def _enable_whatsapp(ctx, fields=None):
    import json

    path = ctx.data_dir / "channels.json"
    path.write_text(json.dumps({"whatsapp": {"enabled": True, "fields": fields or {}}}), encoding="utf-8")


def _fake_binary(tmp_path):
    binary = tmp_path / "wa-rs-bridge"
    binary.write_text("#!/bin/sh\nsleep 60\n", encoding="utf-8")
    binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
    return str(binary)


class _FakeProc:
    def __init__(self):
        self.pid = 4242
        self.terminated = False
        self._poll = None

    def poll(self):
        return self._poll

    def terminate(self):
        self.terminated = True
        self._poll = 0

    def wait(self, timeout=None):
        return 0


def test_disabled_channel_never_spawns(ctx, monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError("must not spawn when the channel is disabled")

    monkeypatch.setattr(supervisor.subprocess, "Popen", fail)
    assert supervisor.ensure_whatsapp_bridge(force=True) == "disabled"


def test_external_bridge_is_left_alone(ctx, monkeypatch):
    _enable_whatsapp(ctx)
    monkeypatch.setattr(supervisor, "_bridge_alive", lambda port: True)

    def fail(*args, **kwargs):
        raise AssertionError("must not spawn when a bridge already listens")

    monkeypatch.setattr(supervisor.subprocess, "Popen", fail)
    assert supervisor.ensure_whatsapp_bridge(force=True) == "already-listening"


def test_spawn_uses_callback_and_session_paths(ctx, tmp_path, monkeypatch):
    _enable_whatsapp(ctx)
    monkeypatch.setattr(supervisor, "_bridge_alive", lambda port: False)
    binary = _fake_binary(tmp_path)
    monkeypatch.setenv("HOMUN_WHATSAPP_BRIDGE_BIN", binary)
    monkeypatch.setenv("HOMUN_SESSION_TOKEN", "t" * 40)

    proc = _FakeProc()
    captured = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return proc

    monkeypatch.setattr(supervisor.subprocess, "Popen", fake_popen)
    assert supervisor.ensure_whatsapp_bridge(force=True) == "spawned"
    assert captured["args"] == [binary]
    env = captured["kwargs"]["env"]
    assert env["WA_BRIDGE_PORT"] == "8902"
    assert env["WA_BRIDGE_CALLBACK_URL"] == "http://127.0.0.1:48765/v1/gateway/channels/whatsapp/inbound"
    assert env["WA_BRIDGE_CALLBACK_TOKEN"] == "t" * 40
    assert env["WA_BRIDGE_DB"].endswith("channels/whatsapp-bridge.db")

    # A not-yet-healthy recent spawn is reported as starting, not re-spawned.
    assert supervisor.ensure_whatsapp_bridge(force=True) == "starting"


def test_missing_binary_is_reported_not_raised(ctx, monkeypatch):
    _enable_whatsapp(ctx)
    monkeypatch.setattr(supervisor, "_bridge_alive", lambda port: False)
    monkeypatch.delenv("HOMUN_WHATSAPP_BRIDGE_BIN", raising=False)
    monkeypatch.setattr(supervisor.shutil, "which", lambda name: None)
    monkeypatch.setattr(supervisor.os.path, "isfile", lambda p: False)
    assert supervisor.ensure_whatsapp_bridge(force=True) == "binary-missing"


def test_stop_terminates_spawned_bridge(monkeypatch):
    proc = _FakeProc()
    supervisor._spawned = proc
    supervisor.stop_whatsapp_bridge()
    assert proc.terminated is True
    assert supervisor._spawned is None
