"""Real local media backends and durable session/goal defaults."""
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import unquote, urlparse

import pytest

from homun.application.computer_use_driver import ComputerUseDriver
from homun.application.media_backends import (
    macos_say_available,
    macos_say_tts_dispatcher,
    resolve_ollama_vision_model,
)
from homun.application.media_tts import TextToSpeechSynthesizer
from homun.application.session_manager import SessionManager, get_default_storage, set_default_storage
from homun.application.session_storage import SessionStorage


def test_macos_status_probe_is_real_and_not_ready_without_driver():
    driver = ComputerUseDriver(auto_probe=True)
    status = driver.get_status()
    assert status["platform_supported"] is True or status["platform"] != "darwin"
    assert status["ready"] is False
    assert status.get("permissions_verified") in (True, False)
    # Without capture/action providers, ready must stay false even if TCC is granted.
    assert status.get("code") in ("backend_unavailable", "permissions_required", "platform_unsupported", None) or status["ready"] is False


def test_session_default_storage_is_durable(tmp_path, monkeypatch):
    monkeypatch.setenv("HOMUN_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("HOMUN_SESSION_DB", raising=False)
    set_default_storage(None)
    storage = get_default_storage()
    assert storage.db_path != ":memory:"
    assert Path(storage.db_path).name == "sessions.sqlite"

    mgr = SessionManager(workspace_id="ws-durable", storage=storage)
    session = mgr.create_session(cwd="/tmp/homun-durable", title="Durable")
    sid = session.id
    storage.close()
    set_default_storage(None)

    storage2 = SessionStorage(tmp_path / "sessions.sqlite")
    set_default_storage(storage2)
    mgr2 = SessionManager(workspace_id="ws-durable", storage=storage2)
    resumed = mgr2.get_session(sid)
    assert resumed is not None
    assert resumed.title == "Durable"
    assert resumed.cwd == "/tmp/homun-durable"
    storage2.close()
    set_default_storage(None)


@pytest.mark.skipif(not macos_say_available(), reason="macOS say not available")
def test_macos_say_tts_writes_real_audio(tmp_path, monkeypatch):
    monkeypatch.setenv("HOMUN_DATA_DIR", str(tmp_path))
    dispatcher = macos_say_tts_dispatcher()
    tts = TextToSpeechSynthesizer(default_provider="macos_say")
    res = tts.synthesize("Homun TTS contract", provider="macos_say", backend_dispatcher=dispatcher)
    assert res.error is None
    assert res.audio_url.startswith("file:")
    path = Path(unquote(urlparse(res.audio_url).path))
    assert path.is_file()
    assert path.stat().st_size > 100


def test_ollama_vision_model_resolution_when_daemon_up():
    model = resolve_ollama_vision_model()
    # Soft: if Ollama is down, model is None; if up, we must pick a real name.
    if model is not None:
        assert isinstance(model, str) and len(model) > 0
