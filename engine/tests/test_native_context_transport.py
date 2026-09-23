"""Pinned context configuration and native summary transport, without network."""
import json
import pytest
from fastapi.testclient import TestClient
from homun.domain.errors import ValidationError
from homun.models.native_turn import NativeMessage
from homun.models.registry import ModelRegistry
from homun.models.secrets import MemorySecretStore


def registry(tmp_path):
    return ModelRegistry(data_dir=tmp_path, secrets=MemorySecretStore())


def configure(models, **kwargs):
    return models.upsert_connection(connection_id='openai_compatible', kind='openai_compatible',
        display_name='Local', model_id='model', **kwargs)


def test_local_default_is_not_an_explicit_cloud_pin(tmp_path):
    models = registry(tmp_path)
    assert models.get_connection('openai_compatible').context_window == 16384
    cloud = configure(models, base_url='https://example.test/v1')
    assert cloud.context_window is None
    assert cloud.max_output_tokens == 8192
    assert 'context_window' not in json.loads(models.config_path.read_text())['openai_compatible']


def test_pins_survive_restart_and_legacy_update(tmp_path):
    models = registry(tmp_path)
    configure(models, context_window=32768, max_output_tokens=2048)
    restarted = registry(tmp_path)
    conn = configure(restarted, api_key='test-only', base_url='https://example.test/v1')
    assert (conn.context_window, conn.max_output_tokens) == (32768, 2048)
    assert (registry(tmp_path).get_connection('openai_compatible').context_window) == 32768
    assert configure(restarted, context_window=None).context_window is None


@pytest.mark.parametrize('pins', [dict(context_window=0),dict(max_output_tokens=0),
    dict(context_window=4096,max_output_tokens=4096),dict(context_window=True)])
def test_invalid_pins_do_not_mutate_configuration(tmp_path, pins):
    models = registry(tmp_path)
    before = models._config.copy()
    with pytest.raises(ValidationError): configure(models, **pins)
    assert models._config == before


def test_fake_connection_rejects_native_pins(tmp_path):
    with pytest.raises(ValidationError):
        registry(tmp_path).upsert_connection(connection_id='fake',kind='fake',display_name='Fake',
            model_id='fake',context_window=32000)


def wire(models, monkeypatch, ollama, message=None, reason='stop'):
    provider = models._providers['openai_compatible']
    monkeypatch.setattr(provider, '_api_key', lambda: 'test-only')
    monkeypatch.setattr(provider, '_ollama_native_root', lambda: 'http://localhost:11434' if ollama else None)
    seen = []
    def post(*args, **kwargs):
        seen.append(args[0] if ollama else args[1])
        body = message if message is not None else {'content':'Summary of authorized work'}
        return ({'message':body,'done_reason':reason,'prompt_eval_count':12,'eval_count':8} if ollama else
            {'choices':[{'message':body,'finish_reason':reason}],'usage':{'prompt_tokens':12,'completion_tokens':8}})
    monkeypatch.setattr(provider, '_post_ollama_chat' if ollama else '_post', post)
    return seen


@pytest.mark.parametrize('ollama', [True,False])
def test_native_wire_honors_pinned_limits_and_legacy_omission(tmp_path,monkeypatch,ollama):
    models = registry(tmp_path)
    seen = wire(models,monkeypatch,ollama)
    messages = [NativeMessage(role='user',content='Read')]
    models.complete_tools(messages,tools=[],connection_id='openai_compatible',context_window=16384,max_output_tokens=1024)
    if ollama:
        assert seen[0]['options']['num_ctx'] == 16384
        assert seen[0]['options']['num_predict'] == 1024
    else:
        assert seen[0]['max_tokens'] == 1024
        assert 'num_ctx' not in seen[0] and 'context_window' not in seen[0]
    models.complete_tools(messages,tools=[],connection_id='openai_compatible')
    assert len(models.usage)==2
    if ollama:
        assert 'num_ctx' not in seen[1]['options']
        assert seen[1]['options']['num_predict']==8192
    else: assert seen[1]['max_tokens']==8192


@pytest.mark.parametrize('ollama', [True,False])
def test_summary_has_no_tools_and_records_usage_once(tmp_path,monkeypatch,ollama):
    models = registry(tmp_path)
    seen = wire(models,monkeypatch,ollama)
    result = models.complete_summary([NativeMessage(role='user',content='Summarize')],
        connection_id='openai_compatible',context_window=16384,max_output_tokens=1024)
    assert 'tools' not in seen[0]
    assert result.message.content == 'Summary of authorized work'
    assert result.usage.input_tokens==12 and result.usage.output_tokens==8
    assert [usage.id for usage in models.usage] == [result.usage.id]


@pytest.mark.parametrize('message,reason', [({'content':'truncated'},'length'),
    ({'thinking':'hidden reasoning'},'stop'),
    ({'content':'', 'tool_calls':[{'id':'call', 'function':{'name':'read','arguments':'{}'}}]},'tool_calls')])
def test_summary_rejects_truncation_reasoning_and_toolcalls(tmp_path,monkeypatch,message,reason):
    models = registry(tmp_path)
    wire(models,monkeypatch,False,message,reason)
    with pytest.raises(ValueError):
        models.complete_summary([NativeMessage(role='user',content='Summarize')],
            connection_id='openai_compatible',context_window=16384,max_output_tokens=1024)
    assert models.usage == []


def test_http_connection_update_preserves_omitted_pins(tmp_path,monkeypatch):
    from homun.routes import models as routes
    from fastapi import FastAPI
    from types import SimpleNamespace
    models = registry(tmp_path)
    monkeypatch.setattr(routes,'get_context',lambda:SimpleNamespace(models=models))
    app=FastAPI();app.include_router(routes.router)
    with TestClient(app) as client:
        payload={'connection_id':'openai_compatible','kind':'openai_compatible','display_name':'Local','model_id':'local'}
        first=client.post('/v1/models/connections',json={**payload,'context_window':32768,'max_output_tokens':1024})
        assert first.status_code==200,first.text
        assert first.json()['context_window']==32768
        second=client.post('/v1/models/connections',json=payload)
        assert second.status_code==200
        assert (second.json()['context_window'],second.json()['max_output_tokens'])==(32768,1024)
        invalid=client.post('/v1/models/connections',json={**payload,'context_window':1024})
        assert invalid.status_code==400


def test_legacy_credentials_cannot_save_output_larger_than_local_window(tmp_path):
    models = registry(tmp_path)
    configure(models,base_url='https://example.test/v1',max_output_tokens=20000)
    before=json.loads(models.config_path.read_text())
    with pytest.raises(ValidationError):
        models.set_openai_credentials(api_key='test-only',base_url='http://127.0.0.1:11434/v1')
    assert json.loads(models.config_path.read_text())==before
    from homun.models.openai_compat import SECRET_KEY
    assert not models.secrets.has(SECRET_KEY)


def test_adapter_pins_and_summary_match_registry(monkeypatch):
    from homun.models.adapters.openai_compat import OpenAICompatModelAdapter
    adapter = OpenAICompatModelAdapter(secrets=MemorySecretStore())
    assert adapter.get_connection('openai_compatible').context_window==16384
    kwargs=dict(connection_id='openai_compatible',kind='openai_compatible',display_name='Local',model_id='local')
    adapter.upsert_connection(**kwargs,context_window=24576,max_output_tokens=1024)
    assert adapter.upsert_connection(**kwargs).context_window==24576
    assert adapter.upsert_connection(**kwargs,context_window=None,base_url='https://example.test/v1').context_window is None
    monkeypatch.setattr(adapter._provider,'_api_key',lambda:'test-only')
    calls=[]
    def post(path,payload,**kw):
        calls.append(payload)
        return {'choices':[{'message':{'content':'Summary'},'finish_reason':'stop'}],
                'usage':{'prompt_tokens':4,'completion_tokens':2}}
    monkeypatch.setattr(adapter._provider,'_post',post)
    result=adapter.complete_summary([NativeMessage(role='user',content='Summarize')],
        connection_id='openai_compatible',context_window=24576,max_output_tokens=1024)
    assert len(adapter.usage)==1 and adapter.usage[0].id==result.usage.id
    assert 'tools' not in calls[0] and calls[0]['max_tokens']==1024


def test_native_invalid_limits_fail_before_network(tmp_path,monkeypatch):
    models=registry(tmp_path)
    seen=wire(models,monkeypatch,True)
    with pytest.raises(ValueError):
        models.complete_tools([NativeMessage(role='user',content='Read')],tools=[],
            connection_id='openai_compatible',context_window=100,max_output_tokens=100)
    assert seen==[] and models.usage==[]
