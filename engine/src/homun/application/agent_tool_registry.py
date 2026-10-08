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
    if isinstance(pages, dict) and pages.get('policy') == 'public-http-v1' and pages.get('version') in {1, 2, 3}:
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
    if isinstance(browser, dict) and browser.get('policy') == 'owned-headless-v1' and browser.get('version') in {3, 4, 5, 6}:
        from homun.application.browser_form_contracts import entries as browser_form_entries
        from homun.application.browser_form_pages import execute as browser_form_execute
        for browser_entry in browser_form_entries(browser_form_execute, browser.get('version')):
            registry.register(browser_entry)
    desktop = run.get('desktop')
    if isinstance(desktop, dict) and desktop.get('policy') == 'native-desktop-v1' and desktop.get('version') == 1:
        from homun.application.desktop_tools import entries as desktop_entries
        from homun.application.desktop_tools import execute as desktop_execute
        for d_entry in desktop_entries(desktop_execute, desktop.get('version', 1)):
            registry.register(d_entry)
    cps = run.get('checkpoints')
    if isinstance(cps, dict) and cps.get('policy') == 'workspace-checkpoints-v1' and cps.get('version') == 1:
        from homun.application.checkpoint_contracts import entries as checkpoint_entries
        from homun.application.checkpoint_tools import execute as checkpoint_execute
        for cp_entry in checkpoint_entries(checkpoint_execute, cps.get('version', 1)):
            registry.register(cp_entry)
    mem = run.get('memory')
    if isinstance(mem, dict) and mem.get('policy') == 'scoped-workspace-v1' and mem.get('version') == 1:
        from homun.application.memory_contracts import entries as memory_entries
        from homun.application.memory_tools import execute as memory_execute
        for mem_entry in memory_entries(memory_execute, mem.get('version', 1)):
            registry.register(mem_entry)
    cu = run.get('computer_use')
    if isinstance(cu, dict) and cu.get('policy') == 'cua-driver-supervised-v1' and cu.get('version') == 1:
        from homun.application.computer_use_contracts import entries as cu_entries
        from homun.application.computer_use_contracts import execute as cu_execute
        for cu_entry in cu_entries(cu_execute, cu.get('version', 1)):
            registry.register(cu_entry)
    skills = run.get('skills')
    if isinstance(skills, dict) and skills.get('policy') == 'workspace-catalog-v1' and skills.get('version') == 1:
        from homun.application.skill_contracts import entries as skill_entries
        from homun.application.skill_tools import execute as skill_execute
        for skill_entry in skill_entries(skill_execute, skills.get('version', 1)):
            registry.register(skill_entry)
    delegation = run.get('delegation')
    if isinstance(delegation, dict) and delegation.get('policy') == 'isolated-subagent-v1' and delegation.get('version') == 1:
        from homun.application.delegation_contracts import entries as delegation_entries
        from homun.application.delegation_tools import execute as delegation_execute
        for del_entry in delegation_entries(delegation_execute, delegation.get('version', 1)):
            registry.register(del_entry)
    clarify = run.get('clarify')
    if isinstance(clarify, dict) and clarify.get('policy') == 'structured-clarify-v1' and clarify.get('version') == 1:
        from homun.application.clarify_contracts import entries as clarify_entries
        from homun.application.clarify_tools import execute as clarify_execute
        for c_entry in clarify_entries(clarify_execute, clarify.get('version', 1)):
            registry.register(c_entry)
    goals = run.get('goals')
    if isinstance(goals, dict) and goals.get('policy') == 'persistent-goals-v1' and goals.get('version') == 1:
        from homun.application.goal_contracts import entries as goal_entries
        from homun.application.goal_tools import execute as goal_execute
        for g_entry in goal_entries(goal_execute, goals.get('version', 1)):
            registry.register(g_entry)
    cron = run.get('cron')
    if isinstance(cron, dict) and cron.get('policy') == 'durable-cron-v1' and cron.get('version') == 1:
        from homun.application.cron_contracts import entries as cron_entries
        from homun.application.cron_tools import execute as cron_execute
        for cr_entry in cron_entries(cron_execute, cron.get('version', 1)):
            registry.register(cr_entry)
    session_mgmt = run.get('session_management')
    if isinstance(session_mgmt, dict) and session_mgmt.get('policy') == 'durable-sessions-v1' and session_mgmt.get('version') == 1:
        from homun.application.session_contracts import entries as session_entries
        from homun.application.session_tools import execute as session_execute
        for s_entry in session_entries(session_execute, session_mgmt.get('version', 1)):
            registry.register(s_entry)
    gateway = run.get('gateway')
    if isinstance(gateway, dict) and gateway.get('policy') == 'core-gateway-v1' and gateway.get('version') == 1:
        from homun.application.gateway_contracts import entries as gateway_entries
        from homun.application.gateway_tools import execute as gateway_execute
        for gw_entry in gateway_entries(gateway_execute, gateway.get('version', 1)):
            registry.register(gw_entry)
    code_exec = run.get('code_execution')
    if isinstance(code_exec, dict) and code_exec.get('policy') == 'programmatic-v1' and code_exec.get('version') == 1:
        from homun.application.code_execution_contracts import entries as code_exec_entries
        from homun.application.code_execution_tool import execute as code_exec_execute
        for ce_entry in code_exec_entries(code_exec_execute, code_exec.get('version', 1)):
            registry.register(ce_entry)
    plugins = run.get('plugins')
    if isinstance(plugins, dict) and plugins.get('policy') == 'extensible-plugins-v1' and plugins.get('version') == 1:
        from homun.application.plugin_manager import get_plugin_manager
        for p_entry in get_plugin_manager().get_active_tools():
            registry.register(p_entry)
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
    from homun.application.surface_toolset_policy import is_tool_allowed_for_surface
    for item in registry.manifest():
        if not is_tool_allowed_for_surface(item['name'], run, metadata=item):
            registry.unregister(item['name'])
    if 'tools' in run:
        registry.validate_manifest(run['tools'])
    return registry
