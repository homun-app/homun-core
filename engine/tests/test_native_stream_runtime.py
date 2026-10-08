"""Canonical runs against a real local streaming HTTP provider."""
import json
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread
from test_agent_runs import setup
from homun.application.agent_runs import propose, approve
from homun.application.agent_run_execution import advance
from homun.application.agent_control import control
from homun.context import create_context


@contextmanager
def provider_server(reply):
    seen=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):
            pass
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            seen.append(body)
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream')
            self.end_headers()
            try:
                reply(self,body,len(seen))
            except (BrokenPipeError,ConnectionResetError):
                pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    worker=Thread(target=server.serve_forever,daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/v1',seen
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def send(handler,event):
    data=event if isinstance(event,str) else json.dumps(event)
    handler.wfile.write(('data: '+data+'\n\n').encode())
    handler.wfile.flush()


def start(setup,url):
    ctx,actor,work,material=setup
    ctx.models.upsert_connection(connection_id='openai_compatible',kind='openai_compatible',
        display_name='Local streaming fixture',model_id='fixture',base_url=url)
    ctx.models.set_active('openai_compatible')
    run=propose(ctx,actor,work,{'command_id':'stream','expected_version':1,
        'material_ids':[material],'native_stream':True,'parallel_read_tools':True})
    approve(ctx,actor,work,run['id'],{'command_id':'approve','digest':run['digest'],'expected_version':run['expected_version']})
    return ctx,actor,work,material,run


def test_streamed_native_calls_execute_and_survive_restart(setup):
    material=setup[3]
    def reply(handler,body,index):
        assert body['stream'] is True
        if index==1:
            for i in range(2):
                send(handler,{'choices':[{'index':0,'delta':{'tool_calls':[{'index':i,'id':f'call-{i}',
                    'type':'function','function':{'name':'read_material','arguments':'{"material_id":'}}]},'finish_reason':None}]})
                send(handler,{'choices':[{'index':0,'delta':{'tool_calls':[{'index':i,'function':{'arguments':json.dumps(material)+'}'}}]},'finish_reason':None}]})
            send(handler,{'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls'}]})
        else:
            assert [m['tool_call_id'] for m in body['messages'] if m['role']=='tool']==['call-0','call-1']
            send(handler,{'choices':[{'index':0,'delta':{'content':'Verified answer'},'finish_reason':None}]})
            send(handler,{'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]})
        send(handler,{'choices':[],'usage':{'prompt_tokens':23,'completion_tokens':9}})
        send(handler,'[DONE]')
    with provider_server(reply) as (url,seen):
        ctx,actor,work,material,run=start(setup,url)
        assert advance(ctx,run['id'])=='running'
        current=ctx.repository.load().commands[run['id']].result
        assert current['turns']==2
        assert ctx.models.usage[-1].input_tokens==23
        reopened=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
        try:
            assert advance(reopened,run['id'])=='completed'
            assert len(reopened.repository.load().artifacts)==1
            assert len(seen)==2
        finally:
            reopened.close()


def test_human_pause_interrupts_real_stream_stalled_after_partial_text(setup):
    started,release=Event(),Event()
    def reply(handler,body,index):
        send(handler,{'choices':[{'index':0,'delta':{'content':'Unfinished text'},'finish_reason':None}]})
        started.set()
        release.wait(5)
    with provider_server(reply) as (url,seen):
        ctx,actor,work,material,run=start(setup,url)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                future=pool.submit(advance,ctx,run['id'])
                assert started.wait(3)
                control(ctx,actor,work,run['id'],{'command_id':'pause','action':'pause',
                    'expected_version':ctx.repository.load().works[work].version})
                assert future.result(timeout=3)=='paused'
            current=ctx.repository.load().commands[run['id']].result
            assert not any(m['role']=='assistant' for m in current['_messages'])
            assert not ctx.repository.load().artifacts
            assert len(seen)==1
        finally:
            release.set()
