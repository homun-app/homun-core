"""HTTP injected truncation, SQLite restart, genuine Ollama continuation."""
import http.server
import json
from pathlib import Path
import sys
import tempfile
import threading
import urllib.request
from homun.context import create_context
from homun.domain.models import Actor
from homun.application import agent_runs
from homun.application.agent_run_execution import advance

requests=[]
fragment='1. La riunione è fissata per martedì alle 10.\n'
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(payload)
        if len(requests)==1:
            body={'choices':[{'finish_reason':'length','message':{'content':fragment}}],
                  'usage':{'prompt_tokens':100,'completion_tokens':20}}
        else:
            actual={'model':'qwen3.5:4b','messages':payload['messages'],'tools':payload.get('tools',[]),
                    'stream':False,'think':False,'options':{'temperature':0,'num_ctx':32768,'num_predict':1536}}
            req=urllib.request.Request('http://127.0.0.1:11434/api/chat',data=json.dumps(actual).encode(),headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=120) as response:raw=json.load(response)
            body={'choices':[{'finish_reason':raw['done_reason'],'message':raw['message']}],
                  'usage':{'prompt_tokens':raw.get('prompt_eval_count'),'completion_tokens':raw.get('eval_count')}}
        output=json.dumps(body).encode()
        self.send_response(200);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(output)));self.end_headers();self.wfile.write(output)
    def log_message(self,*args):pass

server=http.server.HTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
root=Path(tempfile.mkdtemp(prefix='homun-continuation-'))
ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
try:
    ctx.models.upsert_connection(connection_id='openai_compatible',kind='openai_compatible',display_name='Fixture relay',
        model_id='qwen3.5:4b',base_url=f'http://127.0.0.1:{server.server_port}/v1',context_window=32768,max_output_tokens=1536)
    ctx.models.set_active('openai_compatible')
    actor=Actor(id='person_a',workspace_id=ctx.workspace_id,display_name='Fixture owner')
    conv=ctx.service.apply(actor,'conversation','conversation.create',{'title':'Nota riunione'})
    work=ctx.service.apply(actor,'work','work.create',{'conversation_id':conv['conversation_id'],
        'title':'Nota riunione','objective':'Scrivi solo una nota in due punti numerati: 1. riunione martedì alle 10; 2. ogni partecipante deve portare il report vendite. Non servono strumenti.'})['work_id']
    ctx.persist()
    proposal=agent_runs.propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[]})
    agent_runs.approve(ctx,actor,work,'run',{'command_id':'approve','digest':proposal['digest'],'expected_version':proposal['expected_version']})
    first=advance(ctx,'run');assert first=='running' and not ctx.repository.load().artifacts
    ctx.close();ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
    statuses=[first]
    for _ in range(5):
        status=advance(ctx,'run');statuses.append(status)
        if status!='running':break
    store=ctx.repository.load();artifacts=[a.model_dump(mode='json') for a in store.artifacts.values()]
    evidence={'fixture':'first HTTP reply intentionally truncated; subsequent replies from real Ollama; context restarted before continuation',
        'statuses':statuses,'http_requests':len(requests),'run':store.commands['run'].result,
        'artifacts':artifacts,'budget':store.work_budgets[work].model_dump(mode='json')}
    Path(sys.argv[1]).write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
    assert status=='completed' and len(artifacts)==1
    content=artifacts[0]['content']
    assert content.startswith(fragment) and content.count(fragment)==1 and 'report vendite' in content.lower()
    assert requests[1]['messages'][-2]['content']==fragment
    print(statuses,content,sep='\n')
finally:
    ctx.close();server.shutdown();server.server_close()
