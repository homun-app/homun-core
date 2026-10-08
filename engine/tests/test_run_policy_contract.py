"""Policy has to survive HTTP, pinning and registry reconstruction, not just helpers."""
import pytest
from test_agent_runs_api import api_setup
from homun.application.agent_tool_registry import registry_for
from homun.application.agent_tool_bridge import resolve_call
from homun.domain.errors import ValidationError
from homun.models.native_turn import ToolCall


def test_http_pins_policy_and_filters_actual_write_tools(api_setup):
    ctx, actor, work, client, headers = api_setup
    url = f'/v1/workspaces/{ctx.workspace_id}/works/{work}/agent-runs'
    response = client.post(url, headers=headers, json={
        'command_id': 'policy', 'expected_version': 1, 'terminal_backend': 'local',
        'toolset': 'readonly', 'surface': 'headless', 'memory': True,
        'micro_compaction': True, 'denied_tools': ['tool_search'],
        'native_stream': True, 'parallel_read_tools': True,
    })
    assert response.status_code == 200, response.text
    view = response.json()
    assert view.get('toolset') == 'readonly'
    assert view.get('surface') == 'headless'
    assert view.get('micro_compaction') is True
    assert view.get('native_stream') is True
    assert view.get('parallel_read_tools') is True
    run = ctx.repository.load().commands['policy'].result
    names = {tool['name'] for tool in registry_for(run).manifest()}
    assert 'read_workspace_file' in names
    assert not names.intersection({'write_workspace_file', 'patch_workspace_file',
                                  'terminal_execute', 'memory_remember', 'tool_search'})
    with pytest.raises(ValidationError):
        resolve_call(run, ToolCall(id='forged', name='terminal_execute', arguments={}))
    assert client.get(url, headers=headers).json()['items'][0]['denied_tools'] == ['tool_search']


def test_empty_allowlist_is_not_treated_as_unrestricted(api_setup):
    ctx, actor, work, client, headers = api_setup
    url = f'/v1/workspaces/{ctx.workspace_id}/works/{work}/agent-runs'
    response = client.post(url, headers=headers, json={
        'command_id': 'none', 'expected_version': 1, 'allowed_tools': [],
    })
    assert response.status_code == 200
    assert response.json()['tools'] == []


def test_new_runs_activate_micro_compaction_without_provider_kwargs(api_setup):
    from homun.application.agent_context import prepare
    from homun.models.native_turn import NativeMessage
    ctx, actor, work, client, headers = api_setup
    url = f'/v1/workspaces/{ctx.workspace_id}/works/{work}/agent-runs'
    response = client.post(url, headers=headers, json={'command_id': 'compact', 'expected_version': 1})
    run = ctx.repository.load().commands['compact'].result
    run['_context_policy'] = {'context_window': 100000, 'max_output_tokens': 1000}
    run['_messages'] = []
    for i in range(4):
        run['_messages'].extend([
            NativeMessage(role='assistant', tool_calls=[ToolCall(id=f't{i}', name='read_material', arguments={})]).model_dump(),
            NativeMessage(role='tool', tool_call_id=f't{i}', name='read_material', content='x'*3000).model_dump(),
        ])
    result = prepare(ctx, run, [])
    assert len(result[1].content) < 3000
    assert len(result[-1].content) == 3000
    assert 'micro_compaction' not in run['_context_policy']
