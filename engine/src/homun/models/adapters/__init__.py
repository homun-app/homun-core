"""Model adapters package — only place allowed to import vendor SDKs."""

from homun.models.adapters.fake import FakeModelAdapter
from homun.models.adapters.openai_compat import OpenAICompatModelAdapter

__all__ = ["FakeModelAdapter", "OpenAICompatModelAdapter"]
