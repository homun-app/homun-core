"""Image generation and editing provider adapter (H41).

Derived from Hermes tools/image_generation_tool.py and image_generation_catalog.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Normalizes aspect ratios and dispatches image creation through an explicit backend.
Without a backend, returns a typed unavailability error — never a fabricated URL.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

ASPECT_RATIO_PRESETS = {
    "square": "1:1",
    "landscape": "16:9",
    "portrait": "9:16",
    "1:1": "1:1",
    "16:9": "16:9",
    "9:16": "9:16",
    "4:3": "4:3",
    "3:4": "3:4",
}

DEFAULT_IMAGE_MODEL = "fal-ai/flux-2/klein/9b"
BACKEND_UNAVAILABLE = (
    "Image generation backend is not configured. Pass a backend_dispatcher that "
    "calls a configured image provider, or set provider credentials."
)


@dataclass
class ImageGenerationResult:
    image_url: str
    prompt: str
    model: str
    aspect_ratio: str
    seed: Optional[int] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


class ImageGenerator:
    """Image generation and editing service."""

    def __init__(self, default_model: str = DEFAULT_IMAGE_MODEL) -> None:
        self.default_model = default_model

    def normalize_aspect_ratio(self, ratio: str) -> str:
        """Map aspect ratio string or preset name to standard W:H format."""
        clean = (ratio or "").strip().lower()
        return ASPECT_RATIO_PRESETS.get(clean, "1:1")

    def generate(
        self,
        prompt: str,
        *,
        aspect_ratio: str = "1:1",
        model: Optional[str] = None,
        seed: Optional[int] = None,
        backend_dispatcher: Optional[Callable[[str, Dict[str, Any]], Dict[str, Any]]] = None,
    ) -> ImageGenerationResult:
        """Generate a new image from a text prompt."""
        used_model = model or self.default_model
        norm_ratio = self.normalize_aspect_ratio(aspect_ratio)
        payload = {"prompt": prompt, "aspect_ratio": norm_ratio, "seed": seed}

        if backend_dispatcher is None:
            return ImageGenerationResult(
                image_url="",
                prompt=prompt,
                model=used_model,
                aspect_ratio=norm_ratio,
                seed=seed,
                error=BACKEND_UNAVAILABLE,
                metadata={"code": "backend_unavailable"},
            )

        try:
            res = backend_dispatcher(used_model, payload)
            return ImageGenerationResult(
                image_url=res.get("image_url", ""),
                prompt=prompt,
                model=used_model,
                aspect_ratio=norm_ratio,
                seed=res.get("seed", seed),
                metadata=res.get("metadata", {}),
            )
        except Exception as exc:
            return ImageGenerationResult(
                image_url="",
                prompt=prompt,
                model=used_model,
                aspect_ratio=norm_ratio,
                error=str(exc),
            )

    def edit(
        self,
        prompt: str,
        image_urls: List[str],
        *,
        aspect_ratio: str = "1:1",
        model: Optional[str] = None,
        backend_dispatcher: Optional[Callable[[str, Dict[str, Any]], Dict[str, Any]]] = None,
    ) -> ImageGenerationResult:
        """Edit or extend existing images with prompt instructions."""
        if not image_urls:
            return ImageGenerationResult(
                image_url="",
                prompt=prompt,
                model=model or self.default_model,
                aspect_ratio=aspect_ratio,
                error="At least one source image URL must be provided for editing.",
            )

        used_model = model or f"{self.default_model}/edit"
        norm_ratio = self.normalize_aspect_ratio(aspect_ratio)
        payload = {"prompt": prompt, "image_urls": image_urls, "aspect_ratio": norm_ratio}

        if backend_dispatcher is None:
            return ImageGenerationResult(
                image_url="",
                prompt=prompt,
                model=used_model,
                aspect_ratio=norm_ratio,
                error=BACKEND_UNAVAILABLE,
                metadata={"code": "backend_unavailable"},
            )

        try:
            res = backend_dispatcher(used_model, payload)
            return ImageGenerationResult(
                image_url=res.get("image_url", ""),
                prompt=prompt,
                model=used_model,
                aspect_ratio=norm_ratio,
                metadata=res.get("metadata", {}),
            )
        except Exception as exc:
            return ImageGenerationResult(
                image_url="",
                prompt=prompt,
                model=used_model,
                aspect_ratio=norm_ratio,
                error=str(exc),
            )
