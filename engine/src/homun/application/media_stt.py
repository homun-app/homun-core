"""Speech-to-text (STT) audio transcription adapter (H41).

Validates audio inputs and dispatches transcription only through an explicit backend.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

SUPPORTED_AUDIO_EXTENSIONS = frozenset({".wav", ".mp3", ".ogg", ".m4a", ".flac", ".webm"})
BACKEND_UNAVAILABLE = (
    "Speech-to-text backend is not configured. Pass a backend_dispatcher that "
    "calls a local or cloud transcription provider."
)


@dataclass
class TranscriptionResult:
    text: str
    duration_seconds: float = 0.0
    language: Optional[str] = None
    provider: str = "local"
    metadata: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


class SpeechToTextTranscriber:
    """STT transcription coordinator."""

    def __init__(self, default_provider: str = "local") -> None:
        self.default_provider = default_provider

    def transcribe(
        self,
        audio_path: str,
        *,
        language: Optional[str] = None,
        provider: Optional[str] = None,
        backend_dispatcher: Optional[Callable[[str, Dict[str, Any]], Dict[str, Any]]] = None,
    ) -> TranscriptionResult:
        """Transcribe an audio file into text."""
        p = Path(audio_path)
        if not audio_path.startswith("http") and not audio_path.startswith("data:"):
            if not p.exists():
                return TranscriptionResult(text="", error=f"Audio file '{audio_path}' not found.")
            if p.suffix.lower() not in SUPPORTED_AUDIO_EXTENSIONS:
                return TranscriptionResult(
                    text="",
                    error=f"Unsupported audio format '{p.suffix}'. Supported: {sorted(SUPPORTED_AUDIO_EXTENSIONS)}",
                )

        used_prov = provider or self.default_provider
        params = {"path": str(p), "language": language}

        if backend_dispatcher is None:
            return TranscriptionResult(
                text="",
                provider=used_prov,
                language=language,
                error=BACKEND_UNAVAILABLE,
                metadata={"code": "backend_unavailable"},
            )

        try:
            res = backend_dispatcher(used_prov, params)
            return TranscriptionResult(
                text=res.get("text", ""),
                duration_seconds=float(res.get("duration", 0.0) or 0.0),
                language=res.get("language", language),
                provider=used_prov,
                metadata=res.get("metadata", {}),
            )
        except Exception as exc:
            return TranscriptionResult(text="", provider=used_prov, error=str(exc))
