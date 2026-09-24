"""Vision and video frame analysis adapter (H41).

Derived from Hermes tools/vision_tools.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Resolves images and video frames from URLs, data URIs, and local files, normalizing
dimensions and validating formats. Analysis requires an explicit vision backend;
missing inputs or backends are reported as errors, never as synthetic success.
"""
from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

SUPPORTED_IMAGE_MIMES = frozenset({"image/jpeg", "image/png", "image/webp", "image/gif"})
BACKEND_UNAVAILABLE = (
    "Vision backend is not configured. Pass a backend_dispatcher that calls a "
    "vision-capable model, or configure an auxiliary vision provider."
)


@dataclass
class VisionAnalysisResult:
    description: str
    tokens_used: int = 0
    mime_type: str = "image/png"
    metadata: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


class VisionAnalyzer:
    """Homun-owned vision analysis orchestrator."""

    def __init__(self) -> None:
        pass

    def prepare_image_source(self, source: str) -> Tuple[str, str]:
        """Normalize an image input to (mime_type, data_or_url).

        Accepts: data:image/png;base64,..., https://..., or local file path.
        Raises ValueError when a local path does not exist.
        """
        source = source.strip()
        if source.startswith("data:image/"):
            header, _, b64 = source.partition(",")
            mime = header.split(";")[0].replace("data:", "")
            return mime, source

        if source.startswith("http://") or source.startswith("https://"):
            ext = source.split("?")[0].split(".")[-1].lower()
            mime = (
                "image/jpeg"
                if ext in ("jpeg", "jpg")
                else (f"image/{ext}" if ext in ("png", "webp", "gif") else "image/jpeg")
            )
            return mime, source

        p = Path(source)
        if not p.exists() or not p.is_file():
            raise ValueError(f"Image source not found: {source}")
        ext = p.suffix.lower().lstrip(".")
        mime = (
            "image/jpeg"
            if ext in ("jpeg", "jpg")
            else (f"image/{ext}" if ext in ("png", "webp", "gif") else "image/jpeg")
        )
        b64_data = base64.b64encode(p.read_bytes()).decode("ascii")
        return mime, f"data:{mime};base64,{b64_data}"

    def analyze_image(
        self,
        image_source: str,
        prompt: str = "Describe what you see in this image in detail.",
        *,
        backend_dispatcher: Optional[Callable[[str, str, str], Dict[str, Any]]] = None,
    ) -> VisionAnalysisResult:
        """Analyze an image using a configured vision backend only."""
        try:
            mime, normalized_src = self.prepare_image_source(image_source)
        except ValueError as exc:
            return VisionAnalysisResult(description="", tokens_used=0, error=str(exc))

        if backend_dispatcher is None:
            return VisionAnalysisResult(
                description="",
                tokens_used=0,
                mime_type=mime,
                error=BACKEND_UNAVAILABLE,
                metadata={"code": "backend_unavailable"},
            )

        try:
            res = backend_dispatcher(normalized_src, mime, prompt)
            meta = dict(res.get("metadata") or {})
            meta.setdefault("source", normalized_src[:30] + "...")
            return VisionAnalysisResult(
                description=res.get("text", ""),
                tokens_used=int(res.get("tokens", 0) or 0),
                mime_type=mime,
                metadata=meta,
            )
        except Exception as exc:
            return VisionAnalysisResult(
                description="",
                tokens_used=0,
                mime_type=mime,
                error=str(exc),
            )

    def analyze_video_frames(
        self,
        frame_sources: List[str],
        prompt: str = "Analyze the actions and scene transition across these video frames.",
        *,
        backend_dispatcher: Optional[Callable[[List[str], str], Dict[str, Any]]] = None,
    ) -> VisionAnalysisResult:
        """Analyze multiple sequential frames from a video."""
        if not frame_sources:
            return VisionAnalysisResult(description="", tokens_used=0, error="No video frames provided.")

        if backend_dispatcher is None:
            return VisionAnalysisResult(
                description="",
                tokens_used=0,
                error=BACKEND_UNAVAILABLE,
                metadata={"code": "backend_unavailable", "frame_count": len(frame_sources)},
            )

        try:
            res = backend_dispatcher(frame_sources, prompt)
            return VisionAnalysisResult(
                description=res.get("text", ""),
                tokens_used=int(res.get("tokens", 0) or 0),
                metadata={"frame_count": len(frame_sources)},
            )
        except Exception as exc:
            return VisionAnalysisResult(description="", tokens_used=0, error=str(exc))
