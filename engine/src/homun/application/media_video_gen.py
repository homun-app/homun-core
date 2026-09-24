"""Video generation provider adapter (H41).

Derived from Hermes tools/video_generation_tool.py and xai_video_tools.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Dispatches prompt-to-video generation through an explicit backend only.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

COMMON_ASPECT_RATIOS = frozenset({"16:9", "9:16", "1:1", "4:3", "3:4"})
COMMON_RESOLUTIONS = frozenset({"720p", "1080p", "4k"})
DEFAULT_DURATION_SECONDS = 5
BACKEND_UNAVAILABLE = (
    "Video generation backend is not configured. Pass a backend_dispatcher that "
    "calls a configured video provider, or set provider credentials."
)


@dataclass
class VideoGenerationResult:
    video_url: str
    prompt: str
    duration_seconds: int
    aspect_ratio: str
    resolution: str
    status: str = "completed"
    metadata: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


class VideoGenerator:
    """Video generation orchestrator."""

    def __init__(self, provider: str = "fal") -> None:
        self.provider = provider

    def generate(
        self,
        prompt: str,
        *,
        duration_seconds: int = DEFAULT_DURATION_SECONDS,
        aspect_ratio: str = "16:9",
        resolution: str = "720p",
        backend_dispatcher: Optional[Callable[[str, Dict[str, Any]], Dict[str, Any]]] = None,
    ) -> VideoGenerationResult:
        """Generate a video clip from a text prompt."""
        norm_ratio = aspect_ratio if aspect_ratio in COMMON_ASPECT_RATIOS else "16:9"
        norm_res = resolution if resolution in COMMON_RESOLUTIONS else "720p"
        clamped_duration = max(1, min(duration_seconds, 30))
        payload = {
            "prompt": prompt,
            "duration": clamped_duration,
            "aspect_ratio": norm_ratio,
            "resolution": norm_res,
        }

        if backend_dispatcher is None:
            return VideoGenerationResult(
                video_url="",
                prompt=prompt,
                duration_seconds=clamped_duration,
                aspect_ratio=norm_ratio,
                resolution=norm_res,
                status="unavailable",
                error=BACKEND_UNAVAILABLE,
                metadata={"code": "backend_unavailable"},
            )

        try:
            res = backend_dispatcher(self.provider, payload)
            return VideoGenerationResult(
                video_url=res.get("video_url", ""),
                prompt=prompt,
                duration_seconds=clamped_duration,
                aspect_ratio=norm_ratio,
                resolution=norm_res,
                status=res.get("status", "completed"),
                metadata=res.get("metadata", {}),
            )
        except Exception as exc:
            return VideoGenerationResult(
                video_url="",
                prompt=prompt,
                duration_seconds=clamped_duration,
                aspect_ratio=norm_ratio,
                resolution=norm_res,
                status="failed",
                error=str(exc),
            )
