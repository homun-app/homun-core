"""Plugin bundled di riferimento: un tool reale che passa dai gate normalali."""
from pydantic import BaseModel, Field

from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class TextStatsArguments(BaseModel):
    text: str = Field(min_length=1, max_length=100_000, description="Il testo da analizzare")


def _stats(arguments: dict) -> dict:
    args = TextStatsArguments.model_validate(arguments)
    text = args.text
    return {
        "characters": len(text),
        "characters_no_spaces": len(text.replace(" ", "")),
        "words": len(text.split()),
        "sentences": max(1, len([s for s in text.replace("!", ".").replace("?", ".").split(".") if s.strip()])),
    }


def register(ctx) -> None:
    ctx.register_tool(ToolEntry(
        definition=ToolDefinition(
            name="text_stats",
            description="Conta parole, caratteri e frasi di un testo.",
            input_schema=TextStatsArguments.model_json_schema(),
        ),
        toolset="plugins",
        version="1",
        arguments_model=TextStatsArguments,
        handler=lambda ctx_engine, actor, run, args: _stats(args),
        replay="read_only",
    ))
    ctx.register_hook("on_load", lambda **_: None)
