"""Native streaming exercised over owned local HTTP servers, never providers."""
import json
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from homun.models.native_errors import NativeModelError
from homun.models.native_turn import NativeMessage
from homun.models.registry import ModelRegistry
from homun.models.secrets import MemorySecretStore


def sse(value):
    return ('data: ' + (value if isinstance(value, str) else json.dumps(value)) + '\n\n').encode()


def chunk(delta=None, reason=None):
    return {'choices': [{'index': 0, 'delta': delta or {}, 'finish_reason': reason}]}


@contextmanager
def server(parts, *, delay=0, headers_delay=0, content_encoding=None):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            time.sleep(headers_delay)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            if content_encoding: self.send_header('Content-Encoding',content_encoding)
            self.end_headers()
            try:
                for part in parts:
                    self.wfile.write(part)
                    self.wfile.flush()
                    time.sleep(delay)
            except (BrokenPipeError, ConnectionResetError): pass
    http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try: yield f'http://127.0.0.1:{http.server_port}', requests
    finally:
        http.shutdown()
        http.server_close()
        thread.join()


def models(tmp_path, url, monkeypatch, *, ollama=False):
    registry = ModelRegistry(data_dir=tmp_path, secrets=MemorySecretStore())
    registry.upsert_connection(connection_id='openai_compatible', kind='openai_compatible',
        display_name='Fixture', model_id='fixture', base_url=url + '/v1')
    if ollama:
        monkeypatch.setattr(registry._providers['openai_compatible'], '_ollama_native_root', lambda: url)
    return registry


def invoke(registry, **kwargs):
    return registry.complete_tools([NativeMessage(role='user', content='Read')], tools=[], stream=True, **kwargs)


def test_openai_fragmented_tools_usage_and_registry(tmp_path, monkeypatch):
    frames = [chunk({'tool_calls':[{'index':0,'id':'call_a','type':'function','function':{'name':'read','arguments':'{"pa'}}]}),
              chunk({'tool_calls':[{'index':0,'function':{'arguments':'th":"x"}'}}]}),
              chunk(reason='tool_calls'), {'choices':[], 'usage':{'prompt_tokens':12,'completion_tokens':7}}]
    raw = b''.join(sse(f) for f in frames) + sse('[DONE]')
    events = []
    with server([raw[i:i+7] for i in range(0,len(raw),7)]) as (url, requests):
        registry = models(tmp_path,url,monkeypatch)
        result = invoke(registry,on_delta=events.append)
    assert result.message.tool_calls[0].arguments == {'path':'x'}
    assert result.message.tool_calls[0].id == 'call_a'
    assert (result.usage.input_tokens,result.usage.output_tokens) == (12,7)
    assert requests[0]['stream'] is True and requests[0]['stream_options']['include_usage'] is True
    assert events and events[-1]['tool_calls'] == 1
    assert set(events[-1]) == {'type','chunks','text_chars','tool_calls','text'}
    assert registry.usage[-1].id == result.usage.id


def test_ollama_native_stream(tmp_path,monkeypatch):
    frames = [{'message':{'role':'assistant','content':'Working ', 'tool_calls':[]},'done':False},
              {'message':{'content':'', 'tool_calls':[{'function':{'name':'read','arguments':{'path':'x'}}}]},'done':False},
              {'message':{'content':''},'done':True,'done_reason':'stop','prompt_eval_count':4,'eval_count':3}]
    with server([(json.dumps(f)+'\n').encode() for f in frames]) as (url,requests):
        result=invoke(models(tmp_path,url,monkeypatch,ollama=True))
    assert result.message.content == 'Working '
    assert result.message.tool_calls[0].arguments == {'path':'x'}
    assert result.usage.output_tokens == 3
    assert 'stream_options' not in requests[0]


@pytest.mark.parametrize('parts', [
    [sse(chunk({'content':'partial'})),sse('[DONE]')],
    [sse(chunk({'content':'partial'},'stop'))],
])
def test_missing_terminal_evidence_fails(tmp_path,monkeypatch,parts):
    with server(parts) as (url,_):
        registry=models(tmp_path,url,monkeypatch)
        with pytest.raises(NativeModelError) as caught: invoke(registry)
    assert caught.value.code == 'agent_model_truncated'
    assert not caught.value.retryable
    assert caught.value.usage.input_tokens is None


@pytest.mark.parametrize('headers_delay', [0,1.5])
def test_cancel_waiting_closes_without_retry(tmp_path,monkeypatch,headers_delay):
    with server([b': keepalive\n\n'],delay=1.5,headers_delay=headers_delay) as (url,requests):
        registry=models(tmp_path,url,monkeypatch)
        start=time.monotonic()
        with pytest.raises(NativeModelError) as caught:
            invoke(registry,cancel_check=lambda: time.monotonic()-start > .2)
        elapsed=time.monotonic()-start
        assert elapsed < 1
        assert len(requests) == 1
    assert caught.value.code == 'agent_model_cancelled'
    assert caught.value.retryable is False
    assert caught.value.usage.input_tokens is None
    assert registry.usage[-1].error_code == 'agent_model_cancelled'


def test_usage_survives_stream_error(tmp_path,monkeypatch):
    parts=[sse({'choices':[],'usage':{'prompt_tokens':9,'completion_tokens':2}}),b'data: broken\n\n']
    with server(parts) as (url,_):
        registry=models(tmp_path,url,monkeypatch)
        with pytest.raises(NativeModelError) as caught: invoke(registry)
    assert caught.value.usage.input_tokens == 9
    assert caught.value.usage.output_tokens == 2
    assert caught.value.usage.status == 'error'


def test_cancellation_keeps_already_reported_usage(tmp_path,monkeypatch):
    parts=[sse({'choices':[],'usage':{'prompt_tokens':8,'completion_tokens':1}}),b': waiting\n\n']
    with server(parts,delay=1.5) as (url,_):
        start=time.monotonic()
        with pytest.raises(NativeModelError) as caught:
            invoke(models(tmp_path,url,monkeypatch),cancel_check=lambda: time.monotonic()-start > .2)
    assert caught.value.code == 'agent_model_cancelled'
    assert caught.value.usage.input_tokens == 8


@pytest.mark.parametrize('limit,parts', [
    ('MAX_RESPONSE_BYTES',[sse(chunk({'content':'a'*500}))]),
    ('MAX_FRAME_BYTES',[b'data: '+b'x'*500]),
    ('MAX_FRAMES',[sse(chunk({'content':'a'}))]*4),
    ('MAX_ARGUMENT_CHARS',[sse(chunk({'tool_calls':[{'index':0,'id':'c','function':{'name':'read','arguments':'x'*500}}]}))]),
])
def test_stream_limits_are_typed_nonretryable(tmp_path,monkeypatch,limit,parts):
    import homun.models.native_stream as module
    monkeypatch.setattr(module,limit,2 if limit == 'MAX_FRAMES' else 100)
    with server(parts) as (url,_):
        with pytest.raises(NativeModelError) as caught: invoke(models(tmp_path,url,monkeypatch))
    assert caught.value.code == 'agent_model_malformed'
    assert caught.value.retryable is False
    assert caught.value.usage.input_tokens is None


def test_stream_invalid_tool_arguments_not_retried(tmp_path,monkeypatch):
    parts=[sse(chunk({'tool_calls':[{'index':0,'id':'c','function':{'name':'read','arguments':'{'}}]},'tool_calls')),sse('[DONE]')]
    with server(parts) as (url,_):
        with pytest.raises(NativeModelError) as caught: invoke(models(tmp_path,url,monkeypatch))
    assert caught.value.code == 'agent_model_malformed'
    assert caught.value.retryable is False


def test_sync_port_from_running_async_loop(tmp_path,monkeypatch):
    import asyncio
    with server([sse(chunk({'content':'done'},'stop')),sse('[DONE]')]) as (url,_):
        registry=models(tmp_path,url,monkeypatch)
        async def call(): return invoke(registry)
        result=asyncio.run(call())
    assert result.message.content == 'done'


def test_stream_read_timeout_is_typed(tmp_path,monkeypatch):
    with server([b': waiting\n\n'],delay=1) as (url,requests):
        registry=models(tmp_path,url,monkeypatch)
        registry._providers['openai_compatible'].timeout_seconds=.15
        with pytest.raises(NativeModelError) as caught: invoke(registry)
    assert caught.value.code == 'agent_model_timeout'
    assert caught.value.retryable is False
    assert len(requests) == 1


@pytest.mark.parametrize('delta', [
    {'tool_calls':[{'index':0,'function':{'name':'read','arguments':'{}'}}]},
    {'tool_calls':[{'index':8,'id':'x','function':{'name':'read','arguments':'{}'}}]},
    {'tool_calls':[{'index':0,'id':'x','function':{'name':'read','arguments':'{}'}},
                   {'index':1,'id':'x','function':{'name':'read','arguments':'{}'}}]},
])
def test_malformed_tool_identity_rejected(tmp_path,monkeypatch,delta):
    with server([sse(chunk(delta,'tool_calls')),sse('[DONE]')]) as (url,_):
        with pytest.raises(NativeModelError) as caught: invoke(models(tmp_path,url,monkeypatch))
    assert caught.value.code == 'agent_model_malformed'
    assert caught.value.retryable is False


def test_length_finish_keeps_usage_without_success(tmp_path,monkeypatch):
    parts=[sse(chunk({'content':'partial'},'length')),
           sse({'choices':[],'usage':{'prompt_tokens':5,'completion_tokens':2}}),sse('[DONE]')]
    with server(parts) as (url,_):
        with pytest.raises(NativeModelError) as caught: invoke(models(tmp_path,url,monkeypatch))
    assert caught.value.code == 'agent_model_truncated'
    assert caught.value.usage.input_tokens == 5
    assert caught.value.partial_text == 'partial'


def test_ollama_eof_without_done_is_not_success(tmp_path,monkeypatch):
    with server([json.dumps({'message':{'content':'answer'},'done':False}).encode()+b'\n']) as (url,_):
        with pytest.raises(NativeModelError) as caught: invoke(models(tmp_path,url,monkeypatch,ollama=True))
    assert caught.value.code == 'agent_model_truncated'


def test_unsolicited_compression_cannot_bypass_byte_limits(tmp_path,monkeypatch):
    import gzip
    payload=sse(chunk({'content':'answer'},'stop'))+sse('[DONE]')
    with server([gzip.compress(payload)],content_encoding='gzip') as (url,_):
        with pytest.raises(NativeModelError) as caught: invoke(models(tmp_path,url,monkeypatch))
    assert caught.value.code == 'agent_model_malformed'
    assert caught.value.retryable is False


def test_interleaved_tool_indices_keep_provider_order(tmp_path,monkeypatch):
    frames=[chunk({'tool_calls':[
        {'index':1,'id':'second','function':{'name':'re','arguments':'{"path":'}},
        {'index':0,'id':'first','function':{'name':'read','arguments':'{"path":"a"}'}}]}),
        chunk({'tool_calls':[{'index':1,'function':{'name':'ad','arguments':'"b"}'}}]},'tool_calls')]
    with server([sse(f) for f in frames]+[sse('[DONE]')]) as (url,_):
        result=invoke(models(tmp_path,url,monkeypatch))
    assert [(c.id,c.name,c.arguments) for c in result.message.tool_calls] == [
        ('first','read',{'path':'a'}),('second','read',{'path':'b'})]


def test_stream_usage_never_decreases_already_reported_counters():
    from homun.models.native_stream import NativeStream
    parser=NativeStream()
    for usage in ({'prompt_tokens':100,'completion_tokens':20},
                  {'prompt_tokens':0,'completion_tokens':3}):
        parser.feed(('data: '+json.dumps({'choices':[],'usage':usage})+'\n\n').encode())
    assert parser.usage_response()['usage']=={'prompt_tokens':100,'completion_tokens':20}
