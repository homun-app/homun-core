"""Construct the exact tool surface pinned to an adaptive run."""
from homun.application import agent_tools
from homun.application.agent_tool_contracts import PROTOCOL, QUESTION, QuestionArguments, DiscoveryArguments
from homun.application.agent_team import Consultation, tool_definition
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry, ToolRegistry


def registry_for(run, *, material_executor=None, collaborator_executor=None):
    registry = ToolRegistry()
    material_executor = material_executor or agent_tools.run_tool
    for definition in agent_tools.catalog():
        name = definition.name
        def execute(ctx, actor, current, args, tool_name=name):
            return material_executor(ctx, actor, current['materials'], tool_name, args)
        registry.register(ToolEntry(definition, 'materials', '1',
            agent_tools.arguments_model(name), execute))
    for definition in tool_definition(run.get('team'), run['assignee_id']):
        registry.register(ToolEntry(definition, 'team', '1', Consultation,
            collaborator_executor, replay='model'))
    if run.get('_protocol') == PROTOCOL:
        registry.register(ToolEntry(QUESTION, 'human', '1',
            QuestionArguments, kind='ask', replay='never'))
    if run.get('_registry_version') == 1:
        definition = ToolDefinition(name='tool_search',
            description='Find available tools in the approved catalog by name or description. Returns schemas without executing them.',
            input_schema=DiscoveryArguments.model_json_schema())
        registry.register(ToolEntry(definition, 'discovery', '1', DiscoveryArguments,
            lambda ctx, actor, current, args: {'tools': registry.search(args['query'], args['limit'])}))
    if 'tools' in run:
        registry.validate_manifest(run['tools'])
    return registry
