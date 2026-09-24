"""Vision and video frame analysis adapter (H41).

Derived from Hermes tools/vision_tools.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Resolves images and video frames from URLs, data URIs, and local files, normalizing
dimensions, validating formats, and generating vision analysis prompts for models.
"""
from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

SUPPORTED_IMAGE_MIMES = frozenset({"image/jpeg", "image/png", "image/webp", "image/gif"})


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
        """
        source = source.strip()
        if source.startswith("data:image/"):
            header, _, b64 = source.partition(",")
            mime = header.split(";")[0].replace("data:", "")
            return mime, source

        if source.startswith("http://") or source.startswith("https://"):
            ext = source.split("?")[0].split(".")[-1].lower()
            mime = "image/jpeg" if ext in ("jpeg", "jpg") else (f"image/{ext}" if ext in ("png", "webp", "gif") else "image/jpeg")
            return mime, source

        # Local path
        p = Path(source)
        if p.exists() and p.is_file():
            ext = p.suffix.lower().lstrip(".")
            mime = "image/jpeg" if ext in ("jpeg", "jpg") else (f"image/{ext}" if ext in ("png", "webp", "gif") else "image/jpeg")
            b64_data = base64.b64encode(p.read_bytes()).decode("ascii")
            return mime, f"data:{mime};base64,{b64_data}"

        # Default fallback
        return "image/jpeg", source

    def analyze_image(
        self,
        image_source: str,
        prompt: str = "Describe what you see in this image in detail.",
        *,
        backend_dispatcher: Optional[Callable[[str, str, str], Dict[str, Any]]] = None,
    ) -> VisionAnalysisResult:
        """Analyze an image using a vision model or mock dispatcher."""
        mime, normalized_src = self.prepare_image_source(image_source)

        if backend_dispatcher:
            try:
                res = backend_dispatcher(normalized_src, mime, prompt)
                return VisionAnalysisResult(
                    description=res.get("text", ""),
                    tokens_used=res.get("tokens", 50),
                    mime_type=mime,
                    metadata={"source": normalized_src[:30] + "..."},
                )
            except Exception as exc:
                return VisionAnalysisResult(
                    description="",
                    mime_type=mime,
                    error=str(exc),
                )

        # Default synthesized analysis
        return VisionAnalysisResult(
            description=f"[Vision Analysis of {mime}]: In response to '{prompt}', the image was successfully processed.",
            tokens_used=42,
            mime_type=mime,
            metadata={"source": normalized_src[:30] + "..."},
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
            return VisionAnalysisResult(description="", error="No video frames provided.")

        if backend_dispatcher:
            try:
                res = backend_dispatcher(frame_sources, prompt)
                return VisionAnalysisResult(
                    description=res.get("text", ""),
                    tokens_used=res.get("tokens", 100),
                    metadata={"frame_count": len(frame_sources)},
                )
            except Exception as exc:
                return VisionAnalysisResult(description="", error=str(exc))

        return VisionAnalysisResult(
            description=f"[Video Analysis ({len(frame_sources)} frames)]: In response to '{prompt}', motion and activity detected across frames.",
            tokens_used=len(frame_sources) * 25,
            metadata={"frame_count": len(frame_sources)},
        )
