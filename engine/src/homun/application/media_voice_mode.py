"""Voice mode, live turn-taking, and wake word detection (H41).

Coordinates hands-free acoustic phrase triggering ("Hey Homun"), confirmation
thresholds, audio stream pause/resume, and user barge-in speech interruption.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

SUPPORTED_WAKE_WORDS = frozenset({"hey homun", "homun"})


@dataclass
class WakeWordEvent:
    wake_word: str
    detected_at: float
    confidence: float = 1.0


class WakeWordDetector:
    """Acoustic wake phrase detector."""

    def __init__(self, wake_words: Optional[List[str]] = None) -> None:
        self.wake_words = set(wake_words or ["hey homun"])
        self._last_fire_time: float = 0.0
        self._cooldown_seconds: float = 2.0

    def check_phrase(self, text_or_transcript: str) -> Optional[WakeWordEvent]:
        """Check if incoming transcript or phrase matches active wake phrases."""
        clean = text_or_transcript.strip().lower()
        now = time.monotonic()
        if (now - self._last_fire_time) < self._cooldown_seconds:
            return None

        for phrase in self.wake_words:
            if phrase in clean:
                self._last_fire_time = now
                return WakeWordEvent(
                    wake_word=phrase,
                    detected_at=time.time(),
                    confidence=0.95,
                )
        return None


class VoiceSession:
    """Stateful voice mode session coordinator with barge-in interruption."""

    def __init__(self, wake_detector: Optional[WakeWordDetector] = None) -> None:
        self.wake_detector = wake_detector or WakeWordDetector()
        self.state: str = "idle"  # idle, listening, user_speaking, model_speaking, interrupted
        self._lock = threading.Lock()
        self._interrupt_callbacks: List[Callable[[], None]] = []

    def on_interrupt(self, callback: Callable[[], None]) -> None:
        """Register callback invoked when user speech interrupts model speaking."""
        with self._lock:
            self._interrupt_callbacks.append(callback)

    def trigger_wake(self, phrase: str) -> Optional[WakeWordEvent]:
        """Process an audio transcript or phrase for wake activation."""
        evt = self.wake_detector.check_phrase(phrase)
        if evt:
            with self._lock:
                self.state = "listening"
        return evt

    def user_started_speaking(self) -> None:
        """Signal that user speech has begun (handles barge-in interruption)."""
        with self._lock:
            if self.state == "model_speaking":
                self.state = "interrupted"
                callbacks = list(self._interrupt_callbacks)
            else:
                self.state = "user_speaking"
                callbacks = []

        for cb in callbacks:
            try:
                cb()
            except Exception as exc:
                logger.warning("Error in voice interruption callback: %s", exc)

    def model_started_speaking(self) -> None:
        """Signal that model audio playback has begun."""
        with self._lock:
            self.state = "model_speaking"

    def playback_finished(self) -> None:
        """Signal that audio playback concluded normally."""
        with self._lock:
            if self.state == "model_speaking":
                self.state = "listening"

    def cancel_playback(self) -> None:
        """Explicitly cancel active model playback (e.g. barge-in or stop requested)."""
        self.user_started_speaking()

    def bind_audio_pipeline(
        self,
        *,
        stt_transcriber: Optional[Any] = None,
        tts_synthesizer: Optional[Any] = None,
        playback_cancel: Optional[Callable[[], None]] = None,
    ) -> None:
        """Bind STT, TTS and audio playback cancellation primitives to this voice session."""
        self._stt = stt_transcriber
        self._tts = tts_synthesizer
        if playback_cancel:
            self.on_interrupt(playback_cancel)

    def feed_audio_chunk(
        self,
        audio_data: bytes,
        *,
        sample_rate: int = 16000,
        text_hint: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Ingest an incoming audio chunk, detect speech/wake word, and manage turn taking."""
        if not audio_data and not text_hint:
            return {"state": self.state, "detected": False, "text": ""}

        # Signal user speech began
        self.user_started_speaking()

        text = text_hint or ""
        if not text and getattr(self, "_stt", None) is not None and callable(getattr(self._stt, "transcribe", None)):
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(audio_data)
                f.flush()
                try:
                    res = self._stt.transcribe(f.name)
                    text = getattr(res, "text", "") or ""
                finally:
                    try:
                        import os
                        os.unlink(f.name)
                    except OSError:
                        pass

        wake_evt = None
        if text:
            wake_evt = self.trigger_wake(text)

        return {
            "state": self.state,
            "detected": wake_evt is not None,
            "wake_word": wake_evt.wake_word if wake_evt else None,
            "text": text,
        }
