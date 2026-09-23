"""Progressive MCP disclosure derived from Hermes tool_search.py (MIT notice).

The catalog is pinned per run. A bridge call resolves to one approved tool;
canonical history keeps the wrapper and its original call ID.
"""
from typing import Any
from pydantic import Field, ValidationError as PydanticValidationError
from homun.application.agent_tools import NoArguments
from homun.domain.errors import ValidationError
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class DescribeArguments(NoArguments):
    names: list[str] = Field(min_length=1, max_length=10)


class CallArguments(NoArguments):
    name: str = Field(min_length=1, max_length=64)
    arguments: dict[str, Any]


def deferred_names(run):
    return {b['name'] for b in run.get('_mcp_bindings', [])} if run.get('_tool_bridge_version') == 1 else set()


def visible_definitions(run, registry):
    hidden = deferred_names(run)
    return [d for d in registry.definitions() if d.name not in hidden]


def resolve_call(run, call):
    if call.name != 'tool_call' or run.get('_tool_bridge_version') != 1:
        return call
    try:
        args = CallArguments.model_validate(call.arguments, strict=True)
    except PydanticValidationError as exc:
        raise ValidationError('Invalid deferred tool call arguments') from exc
    if args.name not in deferred_names(run):
        raise ValidationError('Target is not an approved deferred tool; use directly listed tools without tool_call')
    return call.model_copy(update={'name': args.name, 'arguments': args.arguments})


def describe(run, registry, names):
    if any(name not in deferred_names(run) for name in names):
        raise ValidationError('Description requested for an unavailable deferred tool')
    definitions = {d.name: d for d in registry.definitions()}
    return {'tools': [definitions[name].model_dump(mode='json') for name in dict.fromkeys(names)]}


def entries(run, registry):
    yield ToolEntry(ToolDefinition(name='tool_describe',
        description='Get full input schemas for exact deferred tool names found with tool_search. This does not execute them.',
        input_schema=DescribeArguments.model_json_schema()), 'discovery', '1', DescribeArguments,
        lambda ctx, actor, current, args: describe(current, registry, args['names']))
    yield ToolEntry(ToolDefinition(name='tool_call',
        description='Call one approved deferred tool by exact name and arguments matching its schema. Use tool_search or tool_describe first when needed. External execution still requires human approval. Multiple calls are processed in order.',
        input_schema=CallArguments.model_json_schema()), 'discovery', '1', CallArguments,
        replay='never')


def search_description(run):
    # Names and bounded hints make external capabilities discoverable without schemas.
    lines = [f"{b['name']}: {b['server_name'][:80]} · {(b['descriptor'].get('description') or b['tool'])[:160]}"
             for b in run.get('_mcp_bindings', [])]
    return ('Find tools in the approved catalog by keywords. Returns input schemas without executing tools. '
            'Call deferred tools through tool_call using their exact name and arguments. '
            'If no results, retry with fewer specific keywords. Deferred catalog:\n' + '\n'.join(lines))
