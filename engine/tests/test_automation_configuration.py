"""Human automation setup enters the same persisted runtime as idle wakes."""
import pytest
from test_agent_runs_api import api_setup
from homun.application.automation_store import AutomationStore, set_automation_store
from homun.application.agent_runs import approve
from homun.application.agent_run_execution import advance
from homun.application.agent_automation import wake_due_automation
from homun.models.native_turn import NativeMessage
from types import SimpleNamespace


@pytest.fixture(autouse=True)
def automation_db(tmp_path):
    store = AutomationStore(tmp_path/'automation.sqlite')
    set_automation_store(store)
    yield store
    set_automation_store(None)
    store.close()


def test_http_configure_replay_wake_and_clear(api_setup):
    ctx, actor, work, client, headers = api_setup
    base = f'/v1/workspaces/{ctx.workspace_id}/works/{work}/agent-runs'
    run = client.post(base, headers=headers, json={'command_id':'run','expected_version':1,'goals':True}).json()
    approve(ctx, actor, work, run['id'], {'command_id':'approve','expected_version':run['expected_version'],'digest':run['digest']})
    url = base+'/run/automations/heartbeat'
    body = {'command_id':'heartbeat-1','action':'set','prompt':'Watch this work','interval_seconds':60}
    first = client.post(url, headers=headers, json=body)
    assert first.status_code == 200, first.text
    assert client.post(url, headers=headers, json=body).json() == first.json()
    changed = client.post(url, headers=headers, json={**body,'prompt':'different'})
    assert changed.status_code == 409
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant',content='Observed'),usage=None)
    assert advance(ctx, 'run') == 'waiting_automation'
    visible = client.get(base, headers=headers).json()['items'][0]
    assert visible['automation_wait']['reason'] == 'scheduled_automation'
    now = first.json()['state']['created_at'] + 61
    assert wake_due_automation(ctx, now=now) == ['run']
    assert advance(ctx, 'run', epoch=1) == 'waiting_automation'
    assert client.post(url, headers=headers, json={'command_id':'clear','action':'clear'}).status_code == 200
    assert wake_due_automation(ctx, now=now+61) == ['run']
    assert advance(ctx,'run',epoch=2) == 'completed'
    assert client.post(url, headers=headers, json={**body,'command_id':'after-completion'}).status_code == 409


def test_configuration_requires_approved_capability_and_human_auth(api_setup):
    ctx, actor, work, client, headers = api_setup
    base = f'/v1/workspaces/{ctx.workspace_id}/works/{work}/agent-runs'
    client.post(base, headers=headers, json={'command_id':'run','expected_version':1})
    url = base+'/run/automations/loop'
    body = {'command_id':'config','action':'set','prompt':'Check','times':2}
    assert client.post(url,json=body).status_code == 401
    assert client.post(url,headers=headers,json=body).status_code == 409


def test_configuration_arriving_during_finish_prevents_publication(api_setup, monkeypatch):
    from homun.application import agent_automation
    from homun.application.automation_configuration import configure, AutomationCommand
    ctx, actor, work, client, headers = api_setup
    base = f'/v1/workspaces/{ctx.workspace_id}/works/{work}/agent-runs'
    run = client.post(base,headers=headers,json={'command_id':'run','expected_version':1,'goals':True}).json()
    approve(ctx,actor,work,'run',{'command_id':'approve','expected_version':run['expected_version'],'digest':run['digest']})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant',content='Observed'),usage=None)
    evaluate = agent_automation.evaluate_finish
    def concurrent_config(*args):
        result = evaluate(*args)
        configure(ctx,actor,work,'run','heartbeat',AutomationCommand(command_id='late',action='set',prompt='Watch',interval_seconds=60))
        return result
    monkeypatch.setattr(agent_automation,'evaluate_finish',concurrent_config)
    assert advance(ctx,'run') == 'running'
    assert not ctx.repository.load().artifacts
    monkeypatch.setattr(agent_automation,'evaluate_finish',evaluate)
    assert advance(ctx,'run') == 'waiting_automation'
