"""Product defaults: Ollama for runtime, fake only in tests."""

from __future__ import annotations

from pathlib import Path

from homun.models.openai_compat import SECRET_KEY
from homun.models.registry import build_default_registry


def test_runtime_registry_defaults_to_ollama(tmp_path: Path) -> None:
    registry = build_default_registry(tmp_path, for_tests=False)
    assert registry.active_provider_id == "openai_compatible"
    assert "11434" in str(registry._openai.base_url)
    assert registry.secrets.has(SECRET_KEY)


def test_test_registry_stays_on_fake(tmp_path: Path) -> None:
    registry = build_default_registry(tmp_path, for_tests=True)
    assert registry.active_provider_id == "fake"
