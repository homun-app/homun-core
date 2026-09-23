"""Real Ollama + local MCP action; fixture human approves the generated proposal."""
import json
from pathlib import Path
import sys
import tempfile
from homun.context import create_context
from homun.domain.models import Actor, ExternalServer
from homun.application import agent_runs, external_tools
from homun.application.agent_run_execution import advance
from homun.application.agent_external import resume_external

large='--large' in sys.argv[2:]
bridge='--bridge' in sys.argv[2:]
root=Path(tempfile.mkdtemp(prefix='homun-agent-mcp-'))
counter=root/'calls.txt';script=root/'mcp.py'
server_source='''import json,sys
from pathlib import Path
counter=Path(sys.argv[1])
for line in sys.stdin:
    req=json.loads(line)
    if 'id' not in req:continue
    method=req['method']
    if method=='initialize':
        result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'orders','version':'1'}}
    elif method=='tools/list':
        result={'tools':[{'name':'lookup_order','description':'Retrieve the actual delivery date and owner of an order by its exact code.',
            'inputSchema':{'type':'object','properties':{'code':{'type':'string'}},'required':['code'],'additionalProperties':False}}]}
    elif method=='tools/call':
        counter.write_text(str(int(counter.read_text())+1 if counter.exists() else 1))
        code=req['params']['arguments']['code']
        result={'content':[{'type':'text','text':json.dumps({'code':code,'owner':'Marta','delivery':'8 ottobre 2026'})}],'isError':False}
    else:continue
    print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
'''
if large:
    server_source=server_source.replace("json.dumps({'code':code,'owner':'Marta','delivery':'8 ottobre 2026'})", "'x'*20000 + json.dumps({'code':code,'owner':'Marta','delivery':'8 ottobre 2026'}) + 'z'*20000")
script.write_text(server_source)
ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
ctx.models.upsert_connection(connection_id='openai_compatible',kind='openai_compatible',display_name='Ollama',model_id='qwen3.5:4b',base_url='http://127.0.0.1:11434/v1',context_window=32768,max_output_tokens=1536)
ctx.models.set_active('openai_compatible')
actor=Actor(id='person_a',workspace_id=ctx.workspace_id,display_name='Fixture reviewer')
c=ctx.service.apply(actor,'c','conversation.create',{'title':'Ordine'})
work=ctx.service.apply(actor,'w','work.create',{'conversation_id':c['conversation_id'],'title':'Ordine OR-93','objective':'Consulta il server ordini per OR-93 e prepara una nota italiana con codice, responsabile e data di consegna. Usa il risultato reale dello strumento; non chiedere informazioni gia recuperabili. Se il risultato e salvato e incompleto, usa read_tool_result e cerca la stringa owner per recuperare i dati centrali.' + (' Per questa verifica cerca lo strumento con tool_search, consulta il suo schema con tool_describe e poi usa tool_call.' if bridge else '')})['work_id']
ctx.persist()
with ctx.repository.transaction() as store:
    store.external_servers['orders']=ExternalServer(id='orders',workspace_id=ctx.workspace_id,name='Ordini',command=sys.executable,args=[str(script),str(counter)])
ctx.service.store=store
p=agent_runs.propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[],'server_ids':['orders']})
agent_runs.approve(ctx,actor,work,'run',{'command_id':'go','digest':p['digest'],'expected_version':p['expected_version']})
statuses=[];approvals=[];restarted=False
for _ in range(8):
    status=advance(ctx,'run');statuses.append(status);print(status,flush=True)
    if status=='waiting_external':
        run=ctx.repository.load().commands['run'].result
        proposal=ctx.repository.load().commands[run['external_request_id']].result
        assert not counter.exists(), 'Effect happened before explicit approval'
        approvals.append({'id':proposal['id'],'tool':proposal['tool'],'arguments':proposal['arguments']})
        result=external_tools.approve(ctx,actor,proposal['id'],{'digest':proposal['digest']})
        assert result['status']=='result_ready'
        ctx.close()
        ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
        restarted=True
        assert resume_external(ctx,'run')
    elif status!='running':break
store=ctx.repository.load()
evidence={'fixture':'real Ollama tool choice + real stdio; scripted explicit human approval; restart before receipt consumption',
    'statuses':statuses,'approvals':approvals,'restarted':restarted,'external_calls':int(counter.read_text()) if counter.exists() else 0,
    'run':store.commands['run'].result,'artifacts':[a.model_dump(mode='json') for a in store.artifacts.values()]}
Path(sys.argv[1]).write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
assert status=='completed' and evidence['external_calls']==1 and restarted
assert len(evidence['artifacts'])==1
assert all(v in evidence['artifacts'][0]['content'] for v in ['OR-93','Marta','8 ottobre 2026'])
ctx.close()

if large:
    assert any(o['tool']=='read_tool_result' for o in evidence['run']['observations'])

if bridge:
    observed=[o['tool'] for o in evidence['run']['observations']]
    assert all(name in observed for name in ['tool_search','tool_describe','tool_call']), observed
