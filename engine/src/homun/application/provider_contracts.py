"""Contracts and profile specifications for inference providers (H38).

Declarative profiles capture provider-specific quirks: reasoning syntax, media/vision
support, schema adaptations, endpoints, and auxiliary models.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse

OMIT_TEMPERATURE = object()


@dataclass
class ProviderProfile:
    """Declarative specification for an inference provider."""

    name: str
    display_name: str = ""
    description: str = ""
    api_mode: str = "chat_completions"  # chat_completions | messages | responses
    auth_type: str = "api_key"          # api_key | oauth | custom
    base_url: str = ""
    models_url: str = ""
    env_vars: Tuple[str, ...] = ()
    aliases: Tuple[str, ...] = ()

    # Multimodal / Vision support
    supports_vision: bool = False
    supports_vision_tool_messages: bool = True
    supports_prompt_cache_key: bool = False

    # Reasoning / Thinking parameters
    # format: "extra_body_reasoning" (OpenRouter), "top_level_reasoning_effort" (OpenAI/Kimi),
    # "anthropic_thinking" (Anthropic), "none" (providers that reject reasoning parameters)
    reasoning_format: str = "top_level_reasoning_effort"
    supported_reasoning_efforts: Tuple[str, ...] = ("low", "medium", "high")

    # Quirks & defaults
    fixed_temperature: Any = None
    default_max_tokens: Optional[int] = None
    unsupported_response_formats: Tuple[str, ...] = ()
    default_aux_model: str = ""
    fallback_models: Tuple[str, ...] = ()
    model_aliases: Dict[str, str] = field(default_factory=dict)
    hostname: str = ""

    def get_hostname(self) -> str:
        """Return base hostname for URL-based provider detection."""
        if self.hostname:
            return self.hostname
        if self.base_url:
            return urlparse(self.base_url).hostname or ""
        return ""

    def prepare_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Preprocess messages for provider-specific wire formatting."""
        return list(messages)

    def adapt_reasoning(
        self, reasoning_effort: Optional[str] = None, model: Optional[str] = None
    ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """Adapt reasoning effort into provider-specific wire arguments.

        Returns (extra_body_additions, top_level_kwargs).
        """
        if not reasoning_effort:
            return {}, {}

        effort = reasoning_effort.lower()
        if self.supported_reasoning_efforts and effort not in self.supported_reasoning_efforts:
            # Clamp or fallback to default supported
            effort = self.supported_reasoning_efforts[0]

        if self.reasoning_format == "top_level_reasoning_effort":
            return {}, {"reasoning_effort": effort}
        elif self.reasoning_format == "extra_body_reasoning":
            return {"reasoning": {"effort": effort}}, {}
        elif self.reasoning_format == "anthropic_thinking":
            budget_map = {"low": 1024, "medium": 4096, "high": 8192}
            budget = budget_map.get(effort, 4096)
            return {"thinking": {"type": "enabled", "budget_tokens": budget}}, {}
        elif self.reasoning_format == "none":
            # Model rejects reasoning parameter entirely
            return {}, {}
        return {}, {"reasoning_effort": effort}

    def adapt_media_fixture(self, media_item: Dict[str, Any]) -> Dict[str, Any]:
        """Adapt a multimodal media item (image/document) based on provider capabilities.

        If the provider supports vision, returns formatted image_url block.
        If the provider does not support vision, returns fallback text representation.
        """
        url = media_item.get("url") or media_item.get("image_url") or ""
        alt_text = media_item.get("alt") or media_item.get("description") or "Image fixture"

        if self.supports_vision:
            return {
                "type": "image_url",
                "image_url": {"url": url},
            }
        else:
            # Fallback text representation so non-vision models do not crash
            return {
                "type": "text",
                "text": f"[{alt_text}: {url}]",
            }

    def adapt_tool_result_media(self, content_parts: List[Dict[str, Any]]) -> Any:
        """Adapt tool result containing media parts.

        If supports_vision_tool_messages is False, flattens parts to text representation.
        """
        if self.supports_vision and self.supports_vision_tool_messages:
            return content_parts

        # Flatten to string
        text_pieces = []
        for part in content_parts:
            if part.get("type") == "text":
                text_pieces.append(part.get("text", ""))
            elif part.get("type") == "image_url":
                img_url = part.get("image_url", {}).get("url", "")
                text_pieces.append(f"[Media item: {img_url}]")
        return "\n".join(text_pieces)

    def adapt_schema(self, schema: Dict[str, Any]) -> Dict[str, Any]:
        """Adapt a JSON schema or response format for this provider."""
        adapted = dict(schema)
        if "json_schema" in self.unsupported_response_formats:
            if adapted.get("type") == "json_schema":
                return {"type": "json_object"}
        return adapted

    def fetch_models(self, api_key: Optional[str] = None) -> List[str]:
        """Return fallback or curated models for this provider."""
        return list(self.fallback_models)
