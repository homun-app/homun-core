"""Hybrid fixture: real authorized file reads, then real Ollama compaction/final.

Earlier tool choices are fixture-generated, not chosen by the model. No provider
mock is used for compaction or final. Run from repo with PYTHONPATH=engine/src.
"""
import json
from pathlib import Path
import tempfile
import sys
from homun.context import create_context
from homun.domain.models import Actor
from homun.application.material_ingest import ingest_file
from homun.application.agent_runs import propose,approve
from homun.application.agent_tools import run_tool
from homun.application.agent_native import append_round,append_result
from homun.application.agent_run_execution import advance
from homun.models.native_turn import NativeMessage,ToolCall

root=Path(tempfile.mkdtemp(prefix='homun-context-live-'))
ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
ctx.models.upsert_connection(connection_id='openai_compatible',kind='openai_compatible',display_name='Ollama',
    model_id='qwen3.5:4b',base_url='http://127.0.0.1:11434/v1',context_window=12288,max_output_tokens=1536)
ctx.models.set_active('openai_compatible')
# Observe genuine HTTP replies, including rejected/truncated output, without replacing the model.
provider=ctx.models._providers['openai_compatible']
post=provider._post_ollama_chat
provider_replies=[]
def observed_post(payload):
    response=post(payload)
    message=response.get('message',{})
    provider_replies.append({'options':payload.get('options'),'tools_present':'tools' in payload,
        'done_reason':response.get('done_reason'),'prompt_eval_count':response.get('prompt_eval_count'),
        'eval_count':response.get('eval_count'),'content':message.get('content'),
        'thinking_characters':len(message.get('thinking','')),
        'tool_call_names':[c.get('function',{}).get('name') for c in message.get('tool_calls',[])]})
    return response
provider._post_ollama_chat=observed_post
actor=Actor(id='person_a',workspace_id=ctx.workspace_id,display_name='Fabio')
project=ctx.service.apply(actor,'p','project.create',{'name':'Context parity'})['project_id']
conversation=ctx.service.apply(actor,'c','conversation.create',{'title':'Contesto','project_id':project})['conversation_id']
work=ctx.service.apply(actor,'w','work.create',{'conversation_id':conversation,'title':'Tabella commesse',
 'objective':'Prepara una tabella italiana con i sei codici commessa, responsabili e scadenze ricavati dai documenti letti. Usa tutti e sei i risultati già disponibili; non ripetere le letture e non fare domande.'})['work_id']
ctx.persist()
materials=[];codes=[]
for i,name in enumerate(['Ada','Marta','Luca','Elena','Paolo','Sara'],1):
    code=f'HX-{i}Q9';codes.append(code)
    text=f'Codice: {code}. Responsabile: {name}. Scadenza: {i+1} ottobre 2026.\n'+('Descrizione operativa: nota informativa ripetuta senza ulteriori vincoli. '*80)
    materials.append(ingest_file(ctx,actor,command_id=f'm{i}',project_id=project,filename=f'nota-{i}.txt',data=text.encode())['material_id'])
p=propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':materials})
approve(ctx,actor,work,p['id'],{'command_id':'go','digest':p['digest'],'expected_version':p['expected_version']})
# Establish factual history with real authorized reads; only the choice of reads is scripted.
for i,material in enumerate(materials):
    run=ctx.repository.load().commands['run'].result
    args={'material_id':material,'limit':6000}
    observation=run_tool(ctx,actor,run['materials'],'read_material',args)
    with ctx.repository.transaction() as store:
        run=store.commands['run'].result
        append_round(run,NativeMessage(role='assistant',tool_calls=[ToolCall(id=f'read{i}',name='read_material',arguments=args)]))
        append_result(run,observation)
        run['observations'].append({'tool':'read_material','arguments':args,'message':'Fixture read','result':observation})
    ctx.service.store=store
try:
    original=ctx.repository.load().commands['run'].result['_messages']
    statuses=[]
    for _ in range(3):
        status=advance(ctx,'run');statuses.append(status);print(status,flush=True)
        if status in {'completed','failed','blocked','waiting_input'}:break
    store=ctx.repository.load();run=store.commands['run'].result
    artifacts=[a.model_dump(mode='json') for a in store.artifacts.values()]
    evidence={'fixture':'real source reads with scripted choices; real local summary/final model',
      'model':'qwen3.5:4b','statuses':statuses,'run':run,'artifacts':artifacts,
      'usage':[u.model_dump(mode='json') for u in ctx.models.usage],'provider_replies':provider_replies}
    Path(sys.argv[1]).write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
    assert status=='completed',run.get('error_code')
    assert run['_context_checkpoint']['estimated_after']<run['_context_checkpoint']['estimated_before']
    assert run['_messages'][:len(original)]==original
    assert all(code in artifacts[0]['content'] for code in codes),artifacts[0]['content']
    assert store.works[work].status=='review'
    print('PASS: historical checkpoint, canonical history retained, all six codes in reviewed artifact',flush=True)
finally:ctx.close()
