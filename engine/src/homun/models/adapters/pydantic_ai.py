"""Pydantic AI adapter — the only module that imports pydantic_ai for models."""

from __future__ import annotations

from typing import TypeVar

from pydantic import BaseModel

from homun.models.types import ChatMessage, CompletionResult, UsageEntry
from homun.domain.ids import new_id

T = TypeVar("T", bound=BaseModel)


def _require_pydantic_ai() -> None:
    try:
        import pydantic_ai  # noqa: F401
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "pydantic-ai is not installed. Install the engine package with its default deps."
        ) from exc


def build_openai_compatible_chat_model(*, model_id: str, base_url: str, api_key: str):
    _require_pydantic_ai()
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    return OpenAIChatModel(
        model_id,
        provider=OpenAIProvider(base_url=base_url, api_key=api_key),
    )


def structured_output(
    *,
    model: object,
    instructions: str,
    user_prompt: str,
    output_type: type[T],
    output_retries: int = 3,
    history: list[ChatMessage] | None = None,
) -> T:
    """Run a Pydantic AI Agent with structured output — Homun types only at the boundary."""
    _require_pydantic_ai()
    from pydantic_ai import Agent

    agent: Agent[None, T] = Agent(
        model,  # type: ignore[arg-type]
        output_type=output_type,
        instructions=instructions,
        retries=output_retries,
    )
    from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart

    message_history = []
    for message in history or []:
        if message.role == 'assistant':
            message_history.append(ModelResponse(parts=[TextPart(content=message.content)]))
        elif message.role == 'user':
            message_history.append(ModelRequest(parts=[UserPromptPart(content=message.content)]))
        else:
            raise ValueError('Conversation history cannot introduce system instructions')
    return agent.run_sync(user_prompt, message_history=message_history).output


def complete_chat(
    *,
    model_id: str,
    base_url: str,
    api_key: str,
    messages: list[ChatMessage],
    provider_id: str = "pydantic_ai",
) -> CompletionResult:
    """Plain chat completion via Pydantic AI OpenAI-compatible provider."""
    _require_pydantic_ai()
    from pydantic_ai import Agent

    model = build_openai_compatible_chat_model(
        model_id=model_id,
        base_url=base_url,
        api_key=api_key,
    )
    agent: Agent[None, str] = Agent(model, output_type=str, instructions="You are a helpful assistant.")
    # Flatten messages into a single prompt for v1; multi-turn Agent later.
    prompt = "\n".join(f"{m.role}: {m.content}" for m in messages)
    text = agent.run_sync(prompt).output
    usage = UsageEntry(
        id=new_id("usage"),
        provider_id=provider_id,
        model_id=model_id,
        status="ok",
        notes="pydantic_ai adapter complete_chat",
    )
    return CompletionResult(
        text=text if isinstance(text, str) else str(text),
        model_id=model_id,
        provider_id=provider_id,
        usage=usage,
    )
