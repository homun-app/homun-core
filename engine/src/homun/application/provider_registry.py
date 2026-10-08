"""Inference provider catalog and registry (H38).

Maintains built-in provider profiles with their quirks and allows registration
of custom or plugin-provided profiles.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional
from homun.application.provider_contracts import ProviderProfile

logger = logging.getLogger(__name__)


def create_builtin_profiles() -> Dict[str, ProviderProfile]:
    """Instantiate the standard built-in provider profiles."""
    profiles = {
        "openai": ProviderProfile(
            name="openai",
            display_name="OpenAI",
            description="OpenAI official API (GPT-4o, o1, o3-mini)",
            base_url="https://api.openai.com/v1",
            env_vars=("OPENAI_API_KEY",),
            aliases=("chatgpt", "oai"),
            supports_vision=True,
            supports_vision_tool_messages=True,
            supports_prompt_cache_key=True,
            reasoning_format="top_level_reasoning_effort",
            supported_reasoning_efforts=("low", "medium", "high"),
            default_aux_model="gpt-4o-mini",
            fallback_models=("gpt-4o", "gpt-4o-mini", "o1", "o3-mini"),
        ),
        "anthropic": ProviderProfile(
            name="anthropic",
            display_name="Anthropic",
            description="Anthropic Claude API (Sonnet, Haiku, Opus)",
            base_url="https://api.anthropic.com/v1",
            api_mode="messages",
            env_vars=("ANTHROPIC_API_KEY",),
            aliases=("claude",),
            supports_vision=True,
            supports_vision_tool_messages=True,
            reasoning_format="anthropic_thinking",
            supported_reasoning_efforts=("low", "medium", "high"),
            default_aux_model="claude-3-5-haiku-20241022",
            fallback_models=("claude-3-7-sonnet-20250219", "claude-3-5-haiku-20241022"),
        ),
        "openrouter": ProviderProfile(
            name="openrouter",
            display_name="OpenRouter",
            description="OpenRouter unified model aggregator",
            base_url="https://openrouter.ai/api/v1",
            env_vars=("OPENROUTER_API_KEY",),
            aliases=("or",),
            supports_vision=True,
            supports_vision_tool_messages=True,
            reasoning_format="extra_body_reasoning",
            supported_reasoning_efforts=("low", "medium", "high"),
            default_aux_model="meta-llama/llama-3.3-70b-instruct",
            fallback_models=("anthropic/claude-3.7-sonnet", "openai/gpt-4o", "deepseek/deepseek-r1"),
        ),
        "deepseek": ProviderProfile(
            name="deepseek",
            display_name="DeepSeek",
            description="DeepSeek Direct API (DeepSeek-V3, R1)",
            base_url="https://api.deepseek.com/v1",
            env_vars=("DEEPSEEK_API_KEY",),
            supports_vision=False,
            supports_vision_tool_messages=False,
            reasoning_format="none",
            default_aux_model="deepseek-chat",
            fallback_models=("deepseek-chat", "deepseek-reasoner"),
        ),
        "gemini": ProviderProfile(
            name="gemini",
            display_name="Google Gemini",
            description="Google Gemini via OpenAI-compat or Vertex",
            base_url="https://generativelanguage.googleapis.com/v1beta/openai",
            env_vars=("GEMINI_API_KEY", "GOOGLE_API_KEY"),
            aliases=("google",),
            supports_vision=True,
            supports_vision_tool_messages=True,
            reasoning_format="extra_body_reasoning",
            default_aux_model="gemini-2.0-flash",
            fallback_models=("gemini-2.0-flash", "gemini-2.0-pro-exp-02-05"),
        ),
        "ollama": ProviderProfile(
            name="ollama",
            display_name="Ollama (Local)",
            description="Local inference server via Ollama",
            base_url="http://127.0.0.1:11434/v1",
            auth_type="custom",
            supports_vision=True,
            supports_vision_tool_messages=True,
            reasoning_format="none",
            default_aux_model="llama3.2:latest",
            fallback_models=("llama3.2:latest", "qwen2.5-coder:latest"),
        ),
        "custom": ProviderProfile(
            name="custom",
            display_name="Custom OpenAI-Compatible",
            description="Generic self-hosted or proxy OpenAI-compatible API",
            auth_type="api_key",
            supports_vision=True,
            supports_vision_tool_messages=True,
            reasoning_format="top_level_reasoning_effort",
            default_aux_model="",
            fallback_models=(),
        ),
    }
    return profiles


class ProviderRegistry:
    """Registry maintaining active provider profiles and model resolution."""

    def __init__(self) -> None:
        self._profiles: Dict[str, ProviderProfile] = create_builtin_profiles()

    def register(self, profile: ProviderProfile) -> None:
        """Register or override a provider profile."""
        self._profiles[profile.name] = profile
        for alias in profile.aliases:
            self._profiles[alias] = profile

    def get_profile(self, name_or_alias: str) -> Optional[ProviderProfile]:
        """Look up profile by exact name or alias."""
        return self._profiles.get(name_or_alias.lower())

    def list_profiles(self) -> List[ProviderProfile]:
        """Return unique list of registered profiles."""
        seen = set()
        unique = []
        for p in self._profiles.values():
            if p.name not in seen:
                seen.add(p.name)
                unique.append(p)
        return sorted(unique, key=lambda p: p.name)

    def resolve_provider_for_model(self, model_name: str) -> Optional[ProviderProfile]:
        """Heuristically resolve provider from model prefix or exact match."""
        m = model_name.lower()
        if "/" in m:
            prefix = m.split("/", 1)[0]
            if prefix in self._profiles:
                return self._profiles[prefix]
            return self.get_profile("openrouter")
        if m.startswith("gpt-") or m.startswith("o1") or m.startswith("o3"):
            return self.get_profile("openai")
        if m.startswith("claude"):
            return self.get_profile("anthropic")
        if m.startswith("deepseek"):
            return self.get_profile("deepseek")
        if m.startswith("gemini"):
            return self.get_profile("gemini")
        if ":" in m:
            # Tagged model like llama3.2:latest
            return self.get_profile("ollama")
        return self.get_profile("custom")


_GLOBAL_PROVIDER_REGISTRY: Optional[ProviderRegistry] = None


def get_provider_registry() -> ProviderRegistry:
    global _GLOBAL_PROVIDER_REGISTRY
    if _GLOBAL_PROVIDER_REGISTRY is None:
        _GLOBAL_PROVIDER_REGISTRY = ProviderRegistry()
    return _GLOBAL_PROVIDER_REGISTRY


def reset_provider_registry() -> None:
    global _GLOBAL_PROVIDER_REGISTRY
    _GLOBAL_PROVIDER_REGISTRY = None
