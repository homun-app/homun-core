"""Tests for Stage D3: Media production resolvers, VoiceSession pipeline binding, and integration routing."""
from __future__ import annotations

import http.server
import json
import socket
import threading
from pathlib import Path
from typing import Any, Callable, Dict, Tuple
from urllib.parse import unquote, urlparse

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.media_backends import (
    resolve_image_dispatcher,
    resolve_stt_dispatcher,
    resolve_tts_dispatcher,
    resolve_video_dispatcher,
    resolve_vision_dispatcher,
)
from homun.application.media_image_gen import ImageGenerator
from homun.application.media_stt import SpeechToTextTranscriber
from homun.application.media_video_gen import VideoGenerator
from homun.application.media_voice_mode import VoiceSession, WakeWordDetector


class MockMediaHTTPServer:
    """Threaded local HTTP server for testing media dispatchers without external calls."""

    def __init__(self) -> None:
        self.server: http.server.HTTPServer | None = None
        self.thread: threading.Thread | None = None
        self.port: int = 0
        self.handler_fn: Callable[[str, str, Dict[str, str], bytes], Tuple[int, Dict[str, str], bytes]] | None = None

    def start(self, handler_fn) -> str:
        self.handler_fn = handler_fn
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()

        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length) if length > 0 else b""
                status, headers, resp_body = outer.handler_fn("POST", self.path, dict(self.headers), body)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp_body)

            def log_message(self, format, *args):
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", self.port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.server = None


@pytest.fixture
def mock_media_server():
    server = MockMediaHTTPServer()
    yield server
    server.stop()


# ---------------------------------------------------------------------------
# 1. Media Resolvers: Image, Video, STT
# ---------------------------------------------------------------------------

def test_image_resolver_with_local_server(mock_media_server, monkeypatch):
    def handle_request(method, path, headers, body):
        assert path == "/images/generations"
        data = json.loads(body.decode("utf-8"))
        assert data["prompt"] == "An oil painting of a cat"
        assert data["size"] == "1024x1024"
        resp = {"data": [{"url": "http://example.com/generated_cat.png"}]}
        return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")

    server_url = mock_media_server.start(handle_request)
    monkeypatch.setenv("HOMUN_IMAGE_BASE_URL", server_url)
    monkeypatch.setenv("OPENAI_API_KEY", "test_key_123")

    dispatcher = resolve_image_dispatcher()
    assert dispatcher is not None

    gen = ImageGenerator()
    res = gen.generate("An oil painting of a cat", aspect_ratio="1:1", backend_dispatcher=dispatcher)
    assert res.error is None
    assert res.image_url == "http://example.com/generated_cat.png"
    assert res.metadata.get("provider") == "openai"


def test_video_resolver_with_local_server(mock_media_server, monkeypatch):
    def handle_request(method, path, headers, body):
        assert "/video/generate" in path
        data = json.loads(body.decode("utf-8"))
        assert data["prompt"] == "Flowing river in autumn"
        assert data["duration"] == 5
        resp = {"video_url": "http://example.com/river.mp4", "status": "completed"}
        return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")

    server_url = mock_media_server.start(handle_request)
    monkeypatch.setenv("HOMUN_VIDEO_BASE_URL", server_url)
    monkeypatch.setenv("FAL_KEY", "fal_test_key")

    dispatcher = resolve_video_dispatcher()
    assert dispatcher is not None

    vgen = VideoGenerator()
    res = vgen.generate("Flowing river in autumn", duration_seconds=5, backend_dispatcher=dispatcher)
    assert res.error is None
    assert res.video_url == "http://example.com/river.mp4"
    assert res.status == "completed"


def test_stt_resolver_with_local_server(mock_media_server, tmp_path, monkeypatch):
    wav_file = tmp_path / "speech.wav"
    wav_file.write_bytes(b"RIFFmockdatawav")

    def handle_request(method, path, headers, body):
        assert "/stt/transcribe" in path
        data = json.loads(body.decode("utf-8"))
        assert data["language"] == "it"
        resp = {"text": "Buongiorno mondo", "duration": 2.5, "language": "it"}
        return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")

    server_url = mock_media_server.start(handle_request)
    monkeypatch.setenv("HOMUN_STT_BASE_URL", server_url)
    monkeypatch.setenv("OPENAI_API_KEY", "whisper_key")

    dispatcher = resolve_stt_dispatcher()
    assert dispatcher is not None

    stt = SpeechToTextTranscriber()
    res = stt.transcribe(str(wav_file), language="it", backend_dispatcher=dispatcher)
    assert res.error is None
    assert res.text == "Buongiorno mondo"
    assert res.duration_seconds == 2.5


def test_resolvers_return_none_when_unconfigured(monkeypatch):
    monkeypatch.delenv("HOMUN_IMAGE_BASE_URL", raising=False)
    monkeypatch.delenv("HOMUN_IMAGE_PROVIDER", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("HOMUN_VIDEO_BASE_URL", raising=False)
    monkeypatch.delenv("HOMUN_VIDEO_PROVIDER", raising=False)
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("FAL_API_KEY", raising=False)
    monkeypatch.delenv("HOMUN_STT_BASE_URL", raising=False)
    monkeypatch.delenv("HOMUN_STT_PROVIDER", raising=False)

    assert resolve_image_dispatcher() is None
    assert resolve_video_dispatcher() is None
    assert resolve_stt_dispatcher() is None


# ---------------------------------------------------------------------------
# 2. Voice Mode: Pipeline Binding, Audio Chunks, Barge-in Cancellation
# ---------------------------------------------------------------------------

def test_voice_mode_pipeline_binding_and_interruption():
    detector = WakeWordDetector(wake_words=["hey homun"])
    session = VoiceSession(wake_detector=detector)

    playback_stopped = []

    def mock_playback_cancel():
        playback_stopped.append(True)

    session.bind_audio_pipeline(
        stt_transcriber=None,
        tts_synthesizer=None,
        playback_cancel=mock_playback_cancel,
    )

    # 1. Trigger wake
    evt = session.trigger_wake("Hey Homun what time is it?")
    assert evt is not None
    assert session.state == "listening"

    # 2. Model begins speaking
    session.model_started_speaking()
    assert session.state == "model_speaking"

    # 3. User barge-in speech chunk arrives
    res = session.feed_audio_chunk(b"user voice audio bytes", text_hint="Wait stop!")
    assert session.state == "interrupted"
    assert len(playback_stopped) == 1
    assert res["state"] == "interrupted"

    # 4. Explicit cancel playback
    session.model_started_speaking()
    session.cancel_playback()
    assert len(playback_stopped) == 2


# ---------------------------------------------------------------------------
# 3. Integration Credential Configuration & Status
# ---------------------------------------------------------------------------

def test_integration_credential_configure_and_status():
    app = create_app()
    client = TestClient(app)

    # Initial status
    status_resp = client.get("/v1/integrations/status")
    assert status_resp.status_code == 200

    # Configure credentials dynamically
    conf_payload = {
        "homeassistant_token": "hass_tok_abc",
        "homeassistant_base_url": "http://192.168.1.100:8123",
        "discord_bot_token": "disc_bot_123",
        "feishu_access_token": "feishu_tok_xyz",
        "yuanbao_connected": True,
        "spotify_access_token": "spot_tok_999",
    }
    post_resp = client.post("/v1/integrations/configure", json=conf_payload)
    assert post_resp.status_code == 200
    assert post_resp.json()["status"] == "ok"

    # Re-check status shows configured
    updated_status = client.get("/v1/integrations/status").json()
    assert updated_status["homeassistant"] is True
    assert updated_status["discord"] is True
    assert updated_status["feishu"] is True
    assert updated_status["yuanbao"] is True
    assert updated_status["spotify"] is True
