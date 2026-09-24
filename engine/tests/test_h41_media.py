"""Tests for media providers: vision, image generation, video generation, STT, TTS, and voice mode (H41)."""
from __future__ import annotations

from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.media_image_gen import ImageGenerator
from homun.application.media_stt import SpeechToTextTranscriber
from homun.application.media_tts import TextToSpeechSynthesizer
from homun.application.media_video_gen import VideoGenerator
from homun.application.media_vision import VisionAnalyzer
from homun.application.media_voice_mode import VoiceSession, WakeWordDetector


# 1. Vision and Video Frame Analysis
def test_vision_analysis(tmp_path: Path):
    analyzer = VisionAnalyzer()

    # Image source preparation
    mime, src = analyzer.prepare_image_source("data:image/png;base64,iVBORw0KGgo=")
    assert mime == "image/png"
    assert src.startswith("data:image/png")

    mime_url, src_url = analyzer.prepare_image_source("https://example.com/photo.webp")
    assert mime_url == "image/webp"

    # Local file source
    local_img = tmp_path / "diagram.jpg"
    local_img.write_bytes(b"\xff\xd8\xff\xe0mockjpgdata")
    mime_loc, src_loc = analyzer.prepare_image_source(str(local_img))
    assert mime_loc == "image/jpeg"
    assert src_loc.startswith("data:image/jpeg;base64,")

    # Analyze image
    res = analyzer.analyze_image("https://example.com/test.png", "What objects are present?")
    assert "In response to 'What objects are present?'" in res.description
    assert res.tokens_used > 0
    assert res.error is None

    # Custom backend dispatcher
    def mock_vision(src, mime, prompt):
        return {"text": f"Detected 2 cats in {mime}", "tokens": 75}

    res_custom = analyzer.analyze_image("https://example.com/cats.png", backend_dispatcher=mock_vision)
    assert res_custom.description == "Detected 2 cats in image/png"
    assert res_custom.tokens_used == 75

    # Video frames analysis
    res_vid = analyzer.analyze_video_frames(["frame1.png", "frame2.png", "frame3.png"])
    assert res_vid.metadata["frame_count"] == 3
    assert res_vid.tokens_used == 75

    # Empty frames error
    res_empty = analyzer.analyze_video_frames([])
    assert res_empty.error == "No video frames provided."


# 2. Image Generation & Editing
def test_image_generation_and_editing():
    generator = ImageGenerator()

    # Aspect ratio normalization
    assert generator.normalize_aspect_ratio("square") == "1:1"
    assert generator.normalize_aspect_ratio("landscape") == "16:9"
    assert generator.normalize_aspect_ratio("portrait") == "9:16"
    assert generator.normalize_aspect_ratio("custom") == "1:1"

    # Image generation
    res = generator.generate("A cinematic view of the Alps", aspect_ratio="landscape", seed=123)
    assert res.aspect_ratio == "16:9"
    assert res.seed == 123
    assert res.image_url.startswith("https://")
    assert res.error is None

    # Image editing
    res_edit = generator.edit("Add snow to mountain tops", ["https://example.com/mountain.png"])
    assert res_edit.error is None
    assert "mountain.png" in res_edit.metadata["edited_from"][0]

    # Image editing missing sources
    res_no_src = generator.edit("Make it dark", [])
    assert "At least one source image URL" in (res_no_src.error or "")


# 3. Video Generation
def test_video_generation():
    generator = VideoGenerator(provider="fal")

    # Video generation with duration clamping
    res = generator.generate("A drone shot over the ocean", duration_seconds=8, aspect_ratio="16:9")
    assert res.duration_seconds == 8
    assert res.aspect_ratio == "16:9"
    assert res.status == "completed"
    assert res.video_url.endswith(".mp4")

    # Over-limit duration clamped to 30s
    res_clamped = generator.generate("Timelapse", duration_seconds=120)
    assert res_clamped.duration_seconds == 30


# 4. Speech-to-Text (STT)
def test_speech_to_text(tmp_path: Path):
    stt = SpeechToTextTranscriber()

    # Missing file error
    res_missing = stt.transcribe("nonexistent.wav")
    assert "not found" in (res_missing.error or "")

    # Unsupported format error
    bad_file = tmp_path / "song.txt"
    bad_file.write_text("lyrics")
    res_bad = stt.transcribe(str(bad_file))
    assert "Unsupported audio format" in (res_bad.error or "")

    # Valid audio file simulation
    audio_file = tmp_path / "voice_note.ogg"
    audio_file.write_bytes(b"OggS\x00mockaudio")
    res_ok = stt.transcribe(str(audio_file), language="it")
    assert res_ok.error is None
    assert "voice_note.ogg" in res_ok.text
    assert res_ok.language == "it"


# 5. Text-to-Speech (TTS)
def test_text_to_speech():
    tts = TextToSpeechSynthesizer()

    # Text normalization
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

    # Synthesis
    res = tts.synthesize("Buongiorno a tutti, l'elaborazione è completata.", audio_format="opus")
    assert res.error is None
    assert res.audio_format == "opus"
    assert res.audio_url.endswith(".opus")

    # Empty text error
    res_empty = tts.synthesize("    ")
    assert "Text is empty" in (res_empty.error or "")

    # Stream speech chunks
    chunks = list(tts.stream_speech_chunks("First sentence. Second sentence! Third question?"))
    assert len(chunks) == 3
    assert chunks[0] == "First sentence."
    assert chunks[1] == "Second sentence!"
    assert chunks[2] == "Third question?"


# 6. Voice Mode & Wake Word Detection
def test_voice_mode_and_wake_words():
    detector = WakeWordDetector(wake_words=["hey homun", "hey hermes"])

    # Wake phrase detection
    evt = detector.check_phrase("Good morning, Hey Homun can you help?")
    assert evt is not None
    assert evt.wake_word == "hey homun"

    # Cooldown prevents rapid re-triggering
    assert detector.check_phrase("Hey Homun again") is None

    # Voice session turn-taking and barge-in interruption
    session = VoiceSession(wake_detector=detector)
    assert session.state == "idle"

    # Fast-forward detector cooldown for next test
    detector._last_fire_time = 0.0
    evt2 = session.trigger_wake("Hey Hermes wake up")
    assert evt2 is not None
    assert session.state == "listening"

    # Model begins speaking
    session.model_started_speaking()
    assert session.state == "model_speaking"

    # User barge-in interrupt
    interrupted_notified = []
    session.on_interrupt(lambda: interrupted_notified.append(True))
    session.user_started_speaking()

    assert session.state == "interrupted"
    assert len(interrupted_notified) == 1


# 7. REST API Routes
def test_media_api_routes(tmp_path: Path):
    app = create_app()
    client = TestClient(app)

    # 1. POST /v1/media/vision/analyze
    resp_vis = client.post(
        "/v1/media/vision/analyze",
        json={"image_source": "https://example.com/sample.png", "prompt": "Identify objects"},
    )
    assert resp_vis.status_code == 200
    assert "sample.png" in resp_vis.json()["description"] or "Identify objects" in resp_vis.json()["description"]

    # 2. POST /v1/media/image/generate
    resp_img = client.post(
        "/v1/media/image/generate",
        json={"prompt": "Sunrise over ocean", "aspect_ratio": "16:9"},
    )
    assert resp_img.status_code == 200
    assert resp_img.json()["aspect_ratio"] == "16:9"
    assert resp_img.json()["image_url"].startswith("https://")

    # 3. POST /v1/media/image/edit
    resp_edit = client.post(
        "/v1/media/image/edit",
        json={"prompt": "Add dolphins", "image_urls": ["https://example.com/ocean.png"]},
    )
    assert resp_edit.status_code == 200
    assert resp_edit.json()["image_url"].startswith("https://")

    # 4. POST /v1/media/video/generate
    resp_vid = client.post(
        "/v1/media/video/generate",
        json={"prompt": "Running water stream", "duration_seconds": 6, "resolution": "1080p"},
    )
    assert resp_vid.status_code == 200
    assert resp_vid.json()["duration_seconds"] == 6

    # 5. POST /v1/media/stt/transcribe
    wav_file = tmp_path / "sample.wav"
    wav_file.write_bytes(b"RIFFmockwav")
    resp_stt = client.post(
        "/v1/media/stt/transcribe",
        json={"audio_path": str(wav_file), "language": "en"},
    )
    assert resp_stt.status_code == 200
    assert "sample.wav" in resp_stt.json()["text"]

    # 6. POST /v1/media/tts/synthesize
    resp_tts = client.post(
        "/v1/media/tts/synthesize",
        json={"text": "Saluti da Homun!", "audio_format": "mp3"},
    )
    assert resp_tts.status_code == 200
    assert resp_tts.json()["audio_format"] == "mp3"

    # 7. POST /v1/media/voice/wake-check
    resp_wake = client.post(
        "/v1/media/voice/wake-check",
        json={"phrase": "Hello there, hey homun start the task"},
    )
    assert resp_wake.status_code == 200
    assert resp_wake.json()["detected"] is True
    assert resp_wake.json()["wake_word"] == "hey homun"
