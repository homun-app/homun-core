"""Tests for media providers: vision, image generation, video generation, STT, TTS, and voice mode (H41)."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote, urlparse

from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.media_image_gen import ImageGenerator
from homun.application.media_stt import SpeechToTextTranscriber
from homun.application.media_tts import TextToSpeechSynthesizer
from homun.application.media_video_gen import VideoGenerator
from homun.application.media_vision import VisionAnalyzer
from homun.application.media_voice_mode import VoiceSession, WakeWordDetector


def test_vision_analysis(tmp_path: Path):
    analyzer = VisionAnalyzer()

    mime, src = analyzer.prepare_image_source("data:image/png;base64,iVBORw0KGgo=")
    assert mime == "image/png"
    assert src.startswith("data:image/png")

    mime_url, _src_url = analyzer.prepare_image_source("https://example.com/photo.webp")
    assert mime_url == "image/webp"

    local_img = tmp_path / "diagram.jpg"
    local_img.write_bytes(b"\xff\xd8\xff\xe0mockjpgdata")
    mime_loc, src_loc = analyzer.prepare_image_source(str(local_img))
    assert mime_loc == "image/jpeg"
    assert src_loc.startswith("data:image/jpeg;base64,")

    # Without a backend: typed unavailability (no invented tokens/description)
    res = analyzer.analyze_image("https://example.com/test.png", "What objects are present?")
    assert res.error is not None
    assert "backend" in res.error.lower()
    assert res.tokens_used == 0

    def mock_vision(src, mime, prompt):
        return {"text": f"Detected 2 cats in {mime}", "tokens": 75}

    res_custom = analyzer.analyze_image(
        "https://example.com/cats.png", backend_dispatcher=mock_vision
    )
    assert res_custom.description == "Detected 2 cats in image/png"
    assert res_custom.tokens_used == 75
    assert res_custom.error is None

    res_vid = analyzer.analyze_video_frames(["frame1.png", "frame2.png", "frame3.png"])
    assert res_vid.error is not None
    assert res_vid.tokens_used == 0

    res_vid_ok = analyzer.analyze_video_frames(
        ["frame1.png", "frame2.png", "frame3.png"],
        backend_dispatcher=lambda frames, prompt: {"text": "motion", "tokens": 9},
    )
    assert res_vid_ok.description == "motion"
    assert res_vid_ok.metadata["frame_count"] == 3

    res_empty = analyzer.analyze_video_frames([])
    assert res_empty.error == "No video frames provided."


def test_image_generation_and_editing():
    generator = ImageGenerator()

    assert generator.normalize_aspect_ratio("square") == "1:1"
    assert generator.normalize_aspect_ratio("landscape") == "16:9"
    assert generator.normalize_aspect_ratio("portrait") == "9:16"
    assert generator.normalize_aspect_ratio("custom") == "1:1"

    res = generator.generate("A cinematic view of the Alps", aspect_ratio="landscape", seed=123)
    assert res.aspect_ratio == "16:9"
    assert res.error is not None
    assert res.image_url == ""

    res_ok = generator.generate(
        "Alps",
        aspect_ratio="landscape",
        seed=123,
        backend_dispatcher=lambda model, payload: {
            "image_url": "https://cdn.example/real.png",
            "seed": 123,
        },
    )
    assert res_ok.error is None
    assert res_ok.image_url == "https://cdn.example/real.png"

    res_edit = generator.edit("Add snow", ["https://example.com/mountain.png"])
    assert res_edit.error is not None

    res_edit_ok = generator.edit(
        "Add snow",
        ["https://example.com/mountain.png"],
        backend_dispatcher=lambda model, payload: {
            "image_url": "https://cdn.example/edited.png",
            "metadata": {"edited_from": payload["image_urls"]},
        },
    )
    assert res_edit_ok.error is None
    assert "mountain.png" in res_edit_ok.metadata["edited_from"][0]

    res_no_src = generator.edit("Make it dark", [])
    assert "At least one source image URL" in (res_no_src.error or "")


def test_video_generation():
    generator = VideoGenerator(provider="fal")

    res = generator.generate("A drone shot over the ocean", duration_seconds=8, aspect_ratio="16:9")
    assert res.duration_seconds == 8
    assert res.status == "unavailable"
    assert res.error is not None
    assert res.video_url == ""

    res_ok = generator.generate(
        "ocean",
        duration_seconds=8,
        backend_dispatcher=lambda provider, payload: {
            "video_url": "https://cdn.example/clip.mp4",
            "status": "completed",
        },
    )
    assert res_ok.status == "completed"
    assert res_ok.video_url.endswith(".mp4")

    res_clamped = generator.generate(
        "Timelapse",
        duration_seconds=120,
        backend_dispatcher=lambda provider, payload: {
            "video_url": "https://cdn.example/long.mp4",
            "status": "completed",
        },
    )
    assert res_clamped.duration_seconds == 30


def test_speech_to_text(tmp_path: Path):
    stt = SpeechToTextTranscriber()

    res_missing = stt.transcribe("nonexistent.wav")
    assert "not found" in (res_missing.error or "")

    bad_file = tmp_path / "song.txt"
    bad_file.write_text("lyrics")
    res_bad = stt.transcribe(str(bad_file))
    assert "Unsupported audio format" in (res_bad.error or "")

    audio_file = tmp_path / "voice_note.ogg"
    audio_file.write_bytes(b"OggS\x00mockaudio")
    res_unavailable = stt.transcribe(str(audio_file), language="it")
    assert res_unavailable.error is not None
    assert "backend" in res_unavailable.error.lower()

    res_ok = stt.transcribe(
        str(audio_file),
        language="it",
        backend_dispatcher=lambda provider, params: {
            "text": f"heard {Path(params['path']).name}",
            "duration": 1.2,
            "language": "it",
        },
    )
    assert res_ok.error is None
    assert "voice_note.ogg" in res_ok.text
    assert res_ok.language == "it"


def test_text_to_speech():
    tts = TextToSpeechSynthesizer()

    markdown_text = (
        "Here is the report: [view report](https://example.com/doc) with **bold stats**.\n"
        "```python\nprint('hello')\n```\n"
        "Check `code` inline."
    )
    cleaned = tts.normalize_text_for_speech(markdown_text)
    assert "[code snippet omitted]" in cleaned
    assert "view report" in cleaned
    assert "https://example.com/doc" not in cleaned
    assert "**" not in cleaned
    assert "`" not in cleaned

    res = tts.synthesize("Buongiorno a tutti.", audio_format="opus")
    assert res.error is not None
    assert res.audio_url == ""

    res_ok = tts.synthesize(
        "Buongiorno a tutti.",
        audio_format="opus",
        backend_dispatcher=lambda provider, payload: {
            "audio_url": "https://cdn.example/speech.opus",
            "duration": 1.5,
        },
    )
    assert res_ok.error is None
    assert res_ok.audio_url.endswith(".opus")

    res_empty = tts.synthesize("    ")
    assert "Text is empty" in (res_empty.error or "")

    chunks = list(tts.stream_speech_chunks("First sentence. Second sentence! Third question?"))
    assert len(chunks) == 3


def test_voice_mode_and_wake_words():
    detector = WakeWordDetector(wake_words=["hey homun", "hey hermes"])

    evt = detector.check_phrase("Good morning, Hey Homun can you help?")
    assert evt is not None
    assert evt.wake_word == "hey homun"
    assert detector.check_phrase("Hey Homun again") is None

    session = VoiceSession(wake_detector=detector)
    assert session.state == "idle"
    detector._last_fire_time = 0.0
    evt2 = session.trigger_wake("Hey Hermes wake up")
    assert evt2 is not None
    assert session.state == "listening"
    session.model_started_speaking()
    assert session.state == "model_speaking"
    interrupted_notified = []
    session.on_interrupt(lambda: interrupted_notified.append(True))
    session.user_started_speaking()
    assert session.state == "interrupted"
    assert len(interrupted_notified) == 1


def test_media_api_routes_report_unavailability(tmp_path: Path):
    app = create_app()
    client = TestClient(app)

    def _detail_text(resp) -> str:
        detail = resp.json().get("detail")
        if isinstance(detail, dict):
            return str(detail.get("error") or detail)
        return str(detail or "")

    resp_vis = client.post(
        "/v1/media/vision/analyze",
        json={"image_source": "https://example.com/sample.png", "prompt": "Identify objects"},
    )
    # Remote URLs are rejected (400) or backend missing (503); never invent success.
    assert resp_vis.status_code in (400, 503)
    assert resp_vis.status_code != 200

    resp_img = client.post(
        "/v1/media/image/generate",
        json={"prompt": "Sunrise over ocean", "aspect_ratio": "16:9"},
    )
    assert resp_img.status_code in (400, 503)
    assert "not configured" in _detail_text(resp_img).lower() or "backend" in _detail_text(resp_img).lower()

    resp_edit = client.post(
        "/v1/media/image/edit",
        json={"prompt": "Add dolphins", "image_urls": ["https://example.com/ocean.png"]},
    )
    assert resp_edit.status_code in (400, 503)

    resp_vid = client.post(
        "/v1/media/video/generate",
        json={"prompt": "Running water stream", "duration_seconds": 6, "resolution": "1080p"},
    )
    assert resp_vid.status_code in (400, 503)

    wav_file = tmp_path / "sample.wav"
    wav_file.write_bytes(b"RIFFmockwav")
    resp_stt = client.post(
        "/v1/media/stt/transcribe",
        json={"audio_path": str(wav_file), "language": "en"},
    )
    assert resp_stt.status_code in (400, 503)

    resp_tts = client.post(
        "/v1/media/tts/synthesize",
        json={"text": "Saluti da Homun!", "audio_format": "mp3", "provider": "macos_say"},
    )
    # macOS say is a real backend when present — success must include a file artifact.
    assert resp_tts.status_code in (200, 400, 503)
    if resp_tts.status_code == 200:
        body = resp_tts.json()
        assert body["audio_url"].startswith("file:")
        path = Path(unquote(urlparse(body["audio_url"]).path))
        assert path.is_file()
    else:
        assert "backend" in _detail_text(resp_tts).lower() or "not configured" in _detail_text(resp_tts).lower()

    resp_wake = client.post(
        "/v1/media/voice/wake-check",
        json={"phrase": "Hello there, hey homun start the task"},
    )
    assert resp_wake.status_code == 200
    assert resp_wake.json()["detected"] is True
