"""Regression: product paths must not invent success when backends are absent (audit 2026-09-24)."""
from __future__ import annotations

from pathlib import Path

import pytest

from homun.application.batch_eval_runner import BatchEvalRunner, BatchItem
from homun.application.channel_adapters import TelegramAdapter
from homun.application.computer_use_driver import ComputerUseDriver
from homun.application.copilot_acp_client import CopilotAcpClient
from homun.application.hosted_mcp_agent import HostedMcpAgentServer
from homun.application.integration_meetings import MeetingManager
from homun.application.integration_yuanbao import YuanbaoAdapter, YuanbaoNotConnectedError
from homun.application.media_image_gen import ImageGenerator
from homun.application.media_stt import SpeechToTextTranscriber
from homun.application.media_tts import TextToSpeechSynthesizer
from homun.application.media_video_gen import VideoGenerator
from homun.application.media_vision import VisionAnalyzer


def test_vision_missing_file_is_error_not_success():
    res = VisionAnalyzer().analyze_image("/tmp/homun-does-not-exist-xyz.png", "What?")
    assert res.error is not None
    assert res.tokens_used == 0
    assert "successfully processed" not in (res.description or "").lower()


def test_vision_without_backend_is_unavailable():
    # Existing tiny PNG bytes still need a vision backend
    png = Path("/tmp/homun-audit-1x1.png")
    png.write_bytes(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
            "0000000a49444154789a63000100000500010d0a2db40000000049454e44ae426082"
        )
    )
    res = VisionAnalyzer().analyze_image(str(png), "Describe")
    assert res.error is not None
    assert "unavailable" in res.error.lower() or "backend" in res.error.lower()
    assert res.tokens_used == 0


def test_image_video_gen_without_backend_no_fake_urls():
    img = ImageGenerator().generate("a cat")
    assert img.error is not None
    assert not (img.image_url or "").startswith("https://generated.")
    vid = VideoGenerator().generate("ocean")
    assert vid.error is not None
    assert vid.status != "completed" or vid.error
    assert "internal" not in (vid.video_url or "")


def test_stt_tts_without_backend_no_synthesis():
    wav = Path("/tmp/homun-audit-stt.wav")
    wav.write_bytes(b"RIFFxxxxWAVE")
    stt = SpeechToTextTranscriber().transcribe(str(wav))
    assert stt.error is not None
    assert "successfully" not in (stt.text or "").lower()

    tts = TextToSpeechSynthesizer().synthesize("hello")
    assert tts.error is not None
    assert "internal" not in (tts.audio_url or "")


def test_computer_use_does_not_claim_ready_or_fake_os_effects():
    driver = ComputerUseDriver()
    status = driver.get_status()
    # Ready only when a real probe reports Accessibility + Screen Recording.
    if status.get("ready"):
        assert status.get("permissions_verified") is True
        assert status.get("accessibility") is True
        assert status.get("screen_recording") is True
        assert status.get("driver") == "macos-bridge"
        apps = driver.list_apps()
        assert isinstance(apps, list)
        cap = driver.capture(mode="som")
        # Real capture yields PNG bytes, or an honest note — never tiny fake payload.
        if cap.png_b64:
            raw = __import__("base64").b64decode(cap.png_b64)
            assert len(raw) > 200 and raw[:8] == b"\x89PNG\r\n\x1a\n"
            assert cap.width > 0 and cap.height > 0
        else:
            assert cap.width == 0 or cap.note
    else:
        assert status.get("code") in (
            "backend_unavailable",
            "permissions_required",
            "platform_unsupported",
            None,
        )
        apps = driver.list_apps()
        assert apps == [] or (isinstance(apps, dict) and apps.get("error"))
        cap = driver.capture(mode="som")
        assert cap.width == 0 or not cap.png_b64 or cap.note
        assert not (
            cap.width == 1200
            and cap.png_b64
            and len(__import__("base64").b64decode(cap.png_b64)) < 200
        )

    # Without Accessibility, click must fail; with it, still must not fabricate.
    click = driver.perform_action("click", {"x": 1, "y": 1})
    if status.get("accessibility") is not True:
        assert click.ok is False


def test_channel_send_without_transport_not_delivered():
    result = TelegramAdapter().send("123", "hello")
    assert result.get("delivered") is not True
    assert result.get("error") or result.get("code")


def test_hosted_mcp_task_does_not_fake_completion():
    server = HostedMcpAgentServer()
    # tools/call shape used by the server
    if hasattr(server, "call_tool"):
        out = server.call_tool("homun_task", {"objective": "do something"})
    elif hasattr(server, "handle_call"):
        out = server.handle_call("homun_task", {"objective": "do something"})
    else:
        # Fall back to internal dispatch if exposed
        out = server._dispatch("homun_task", {"objective": "do something"})  # noqa: SLF001
    payload = out if isinstance(out, dict) else {}
    text = str(payload)
    assert "completed" not in text.lower() or payload.get("isError") is True
    assert payload.get("isError") is True or "unavailable" in text.lower() or "not configured" in text.lower()


def test_copilot_does_not_synthesize_when_binary_missing_or_unwired():
    missing = CopilotAcpClient(command="copilot-homun-missing-xyz")
    r = missing.run_turn("hi")
    assert r.is_available is False
    assert r.error
    assert "[Copilot ACP]" not in r.text

    class PretendInstalled(CopilotAcpClient):
        def is_available(self) -> bool:
            return True

    r2 = PretendInstalled(command="copilot-homun-missing-xyz").run_turn("hi")
    assert "[Copilot ACP]: Response to" not in r2.text
    assert r2.error or r2.is_available is False


def test_yuanbao_and_meetings_no_invented_success():
    with pytest.raises((YuanbaoNotConnectedError, Exception)):
        YuanbaoAdapter(connected=False).get_group_info("xyz")
    # Default adapter must not invent member_count 42 without a provider
    adapter = YuanbaoAdapter()
    try:
        info = adapter.get_group_info("xyz")
    except Exception:
        return
    assert info.get("member_count") != 42 or info.get("success") is not True
    assert info.get("error") or info.get("success") is not True

    meet = MeetingManager().join_google_meet("https://meet.google.com/abc-defg-hij")
    assert meet.get("success") is not True
    assert meet.get("error") or meet.get("state") != "joined"


def test_batch_eval_requires_real_executor(tmp_path: Path):
    with pytest.raises((TypeError, ValueError, RuntimeError)):
        BatchEvalRunner(tmp_path).run_batch([BatchItem(id="1", prompt="x")])
