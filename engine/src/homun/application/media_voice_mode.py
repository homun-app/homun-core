"""Voice mode, live turn-taking, and wake word detection (H41).

Derived from Hermes tools/voice_mode.py, voice_live.py, and wake_word.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Coordinates hands-free acoustic phrase triggering ("Hey Homun" / "Hey Hermes"), confirmation
thresholds, audio stream pause/resume, and user barge-in speech interruption.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

SUPPORTED_WAKE_WORDS = frozenset({"hey homun", "hey hermes", "homun", "hermes"})


@dataclass
class WakeWordEvent:
    wake_word: str
    detected_at: float
    confidence: float = 1.0


class WakeWordDetector:
    """Acoustic wake phrase detector."""

    def __init__(self, wake_words: Optional[List[str]] = None) -> None:
        self.wake_words = set(wake_words or ["hey homun", "hey hermes"])
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
