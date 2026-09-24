"""Construct the exact tool surface pinned to an adaptive run."""
from homun.application import agent_tools
from homun.application.agent_tool_contracts import PROTOCOL, QUESTION, QuestionArguments, DiscoveryArguments
from homun.application.agent_team import Consultation, tool_definition
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry, ToolRegistry


def registry_for(run, *, material_executor=None, collaborator_executor=None, file_executor=None):
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
    from homun.application.agent_mcp import entries
    for entry in entries(run.get('_mcp_bindings', []), include_source=run.get('_tool_bridge_version') == 1):
        registry.register(entry)
    if run.get('terminal'):
        from homun.application.agent_terminal_contracts import entries as terminal_entries
        for terminal_entry in terminal_entries(run['terminal']):registry.register(terminal_entry)
    if run.get('_workspace_files_version') in {1, 2}:
        from homun.application.workspace_file_contracts import entries as file_entries
        for file_entry in file_entries(file_executor, run['_workspace_files_version']):registry.register(file_entry)
    pages = run.get('web_pages')
    if isinstance(pages, dict) and pages.get('policy') == 'public-http-v1' and pages.get('version') in {1, 2}:
        from homun.application.web_page_contracts import entries as web_entries
        from homun.application.web_pages import execute as web_execute
        for web_entry in web_entries(web_execute, pages.get('version', 1)):
            registry.register(web_entry)
    browser = run.get('browser')
    if isinstance(browser, dict) and browser.get('policy') == 'owned-headless-v1' and browser.get('version') in {1, 2}:
        from homun.application.browser_contracts import entries as browser_entries
        from homun.application.browser_pages import execute as browser_execute
        for browser_entry in browser_entries(browser_execute, browser.get('version', 1)):
            registry.register(browser_entry)
    if run.get('_result_storage_version') == 1:
        from homun.application.agent_results import entry
        registry.register(entry())
    if run.get('_protocol') == PROTOCOL:
        registry.register(ToolEntry(QUESTION, 'human', '1',
            QuestionArguments, kind='ask', replay='never'))
    if run.get('_tool_bridge_version') == 1 and run.get('_mcp_bindings'):
        from homun.application.agent_tool_bridge import entries as bridge_entries
        for bridge_entry in bridge_entries(run, registry):
            registry.register(bridge_entry)
    if run.get('_registry_version') == 1:
        definition = ToolDefinition(name='tool_search',
            description='Find available tools in the approved catalog by name or description. Returns schemas without executing them.',
            input_schema=DiscoveryArguments.model_json_schema())
        version = '1'
        excluded = ()
        if run.get('_tool_bridge_version') == 1 and run.get('_mcp_bindings'):
            from homun.application.agent_tool_bridge import search_description
            definition.description = search_description(run)
            version = '2'
            excluded = ('tool_search', 'tool_describe', 'tool_call')
        registry.register(ToolEntry(definition, 'discovery', version, DiscoveryArguments,
            lambda ctx, actor, current, args: {'tools': registry.search(args['query'], args['limit'], exclude=excluded)}))
    if 'tools' in run:
        registry.validate_manifest(run['tools'])
    return registry
