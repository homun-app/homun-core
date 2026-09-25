"""Text-to-speech (TTS) speech synthesis adapter (H41).

Normalizes text and dispatches synthesis only through an explicit backend.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, Optional

logger = logging.getLogger(__name__)

SUPPORTED_AUDIO_FORMATS = frozenset({"mp3", "opus", "wav", "ogg"})
BACKEND_UNAVAILABLE = (
    "Text-to-speech backend is not configured. Pass a backend_dispatcher that "
    "calls a configured speech provider."
)


@dataclass
class SpeechSynthesisResult:
    audio_url: str
    audio_format: str = "mp3"
    duration_seconds: float = 0.0
    provider: str = "edge"
    text: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


class TextToSpeechSynthesizer:
    """TTS speech synthesis orchestrator."""

    def __init__(self, default_provider: str = "edge") -> None:
        self.default_provider = default_provider

    def normalize_text_for_speech(self, text: str) -> str:
        """Strip markdown links, code blocks, bold/italics for smooth vocal delivery."""
        if not text:
            return ""
        clean = re.sub(r"```[\s\S]*?```", " [code snippet omitted] ", text)
        clean = re.sub(r"`[^`]+`", " ", clean)
        clean = re.sub(r"!\[.*?\]\(.*?\)", "", clean)
        clean = re.sub(r"\[(.*?)\]\(.*?\)", r"\1", clean)
        clean = re.sub(r"[*_]{1,3}(.*?)[*_]{1,3}", r"\1", clean)
        clean = re.sub(r"\s+", " ", clean).strip()
        return clean

    def synthesize(
        self,
        text: str,
        *,
        voice: Optional[str] = None,
        audio_format: str = "mp3",
        provider: Optional[str] = None,
        backend_dispatcher: Optional[Callable[[str, Dict[str, Any]], Dict[str, Any]]] = None,
    ) -> SpeechSynthesisResult:
        """Synthesize spoken audio from text."""
        clean_text = self.normalize_text_for_speech(text)
        if not clean_text:
            return SpeechSynthesisResult(audio_url="", error="Text is empty after normalization.")

        used_prov = provider or self.default_provider
        fmt = audio_format if audio_format in SUPPORTED_AUDIO_FORMATS else "mp3"
        payload = {
            "text": clean_text,
            "voice": voice or "it-IT-ElsaNeural",
            "format": fmt,
        }

        if backend_dispatcher is None:
            return SpeechSynthesisResult(
                audio_url="",
                audio_format=fmt,
                provider=used_prov,
                text=clean_text,
                error=BACKEND_UNAVAILABLE,
                metadata={"code": "backend_unavailable"},
            )

        try:
            res = backend_dispatcher(used_prov, payload)
            return SpeechSynthesisResult(
                audio_url=res.get("audio_url", ""),
                audio_format=fmt,
                duration_seconds=float(res.get("duration", 0.0) or 0.0),
                provider=used_prov,
                text=clean_text,
                metadata=res.get("metadata", {}),
            )
        except Exception as exc:
            return SpeechSynthesisResult(
                audio_url="",
                audio_format=fmt,
                provider=used_prov,
                text=clean_text,
                error=str(exc),
            )

    def stream_speech_chunks(self, text: str, chunk_size: int = 150) -> Iterator[str]:
        """Split text into sentence/clause chunks suitable for low-latency streaming TTS."""
        normalized = self.normalize_text_for_speech(text)
        sentences = re.split(r"(?<=[.!?])\s+", normalized)
        for sentence in sentences:
            sentence = sentence.strip()
            if sentence:
                yield sentence
