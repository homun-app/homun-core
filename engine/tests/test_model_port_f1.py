"""ModelPort foundation tests — adapters must stay swappable."""

from __future__ import annotations

from pathlib import Path

from homun.models.adapters.fake import FakeModelAdapter
from homun.models.adapters.openai_compat import OpenAICompatModelAdapter
from homun.models.openai_compat import SECRET_KEY
from homun.models.secrets import MemorySecretStore
from homun.models.types import ChatMessage


def test_fake_port_complete_returns_text() -> None:
    port = FakeModelAdapter()
    result = port.complete([ChatMessage(role="user", content="ciao")])
    assert result.text
    assert result.provider_id == "fake"
    assert result.usage.status == "ok"


def test_fake_port_stream_chunks() -> None:
    port = FakeModelAdapter()
    chunks = list(port.stream([ChatMessage(role="user", content="ciao catalogo")]))
    assert chunks
    assert "".join(chunks)


def test_fake_port_list_connections() -> None:
    port = FakeModelAdapter()
    items = port.list_connections()
    assert len(items) == 1
    assert items[0].kind == "fake"
    assert items[0].active is True


def test_openai_compat_adapter_list_connections() -> None:
    secrets = MemorySecretStore()
    secrets.put(SECRET_KEY, "ollama")
    port = OpenAICompatModelAdapter(secrets=secrets)
    items = port.list_connections()
    assert len(items) == 1
    assert items[0].kind == "openai_compatible"
    assert items[0].credential_present is True


def test_pydantic_ai_not_imported_outside_adapters() -> None:
    root = Path(__file__).resolve().parents[1] / "src" / "homun"
    offenders: list[str] = []
    for path in root.rglob("*.py"):
        if "adapters" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if "import pydantic_ai" in stripped or "from pydantic_ai" in stripped:
                offenders.append(f"{path.relative_to(root)}: {stripped}")
    assert offenders == [], f"pydantic_ai leaked outside adapters:\n" + "\n".join(offenders)
