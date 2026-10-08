"""Real local model: pause, correction, context restart, resume with two sources."""
import json
from pathlib import Path
import sys
import tempfile
from homun.context import create_context
from homun.domain.models import Actor
from homun.application.material_ingest import ingest_file
from homun.application.agent_runs import propose, approve
from homun.application.agent_control import control
from homun.application.agent_run_execution import advance

root=Path(tempfile.mkdtemp(prefix='homun-controls-live-'))
ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
ctx.models.set_active('openai_compatible')
assert ctx.models.get_connection('openai_compatible').base_url=='http://127.0.0.1:11434/v1'
actor=Actor(id='person_a',workspace_id=ctx.workspace_id,display_name='Fabio')
project=ctx.service.apply(actor,'p','project.create',{'name':'Control parity'})['project_id']
conversation=ctx.service.apply(actor,'c','conversation.create',{'title':'Verifica','project_id':project})['conversation_id']
work=ctx.service.apply(actor,'w','work.create',{'conversation_id':conversation,'title':'Nota operativa',
 'objective':'Leggi entrambi i materiali con read_material e scrivi una nota italiana con destinatario, scadenza e allegato richiesto. Non fare domande.'})['work_id']
ctx.persist()
materials=[]
for i,(name,text) in enumerate([('brief.txt','Destinatario: Marta. Scadenza: 30 settembre 2026.'),('notes.txt','Allegato obbligatorio: modulo B7. Codice commessa HX-73Q9.')]):
    materials.append(ingest_file(ctx,actor,command_id=f'm{i}',project_id=project,filename=name,data=text.encode())['material_id'])
p=propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':materials})
approve(ctx,actor,work,p['id'],{'command_id':'go','digest':p['digest'],'expected_version':p['expected_version']})
statuses=[];usage=[]
def send(action,text=None):
    body={'command_id':action,'expected_version':ctx.repository.load().works[work].version,'action':action}
    if text:body['text']=text
    return control(ctx,actor,work,p['id'],body)
try:
    statuses.append(advance(ctx,p['id'],epoch=0));assert statuses[-1]=='running'
    assert send('pause')['status']=='paused'
    send('redirect','Correzione: il destinatario è Ada e la scadenza è 2 ottobre 2026. Mantieni allegato e codice della commessa: leggi anche notes.txt prima di concludere.')
    usage.extend(u.model_dump(mode='json') for u in ctx.models.usage)
    ctx.close();ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
    assert advance(ctx,p['id'],epoch=0)=='superseded'
    assert send('resume')['status']=='queued'
    for _ in range(8):
        status=advance(ctx,p['id']);statuses.append(status);print(status,flush=True)
        if status in {'completed','failed','blocked','waiting_input'}:break
    store=ctx.repository.load();run=store.commands[p['id']].result
    artifacts=[a.model_dump(mode='json') for a in store.artifacts.values()]
    usage.extend(u.model_dump(mode='json') for u in ctx.models.usage)
    evidence={'model':'qwen3.5:4b','context_restarted':True,'statuses':statuses,'run':run,'artifacts':artifacts,'usage':usage}
    Path(sys.argv[1]).write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
    assert status=='completed',run.get('error_code')
    content=artifacts[0]['content']
    assert all(v in content for v in ['Ada','2 ottobre 2026','B7','HX-73Q9']),content
    assert 'Marta' not in content and '30 settembre 2026' not in content
    read_ids={o['arguments'].get('material_id') for o in run['observations'] if o['tool']=='read_material'}
    assert read_ids==set(materials),read_ids
    assert store.works[work].status=='review'
    print('PASS: pause, correction, context restart, both sources, corrected deliverable in review',flush=True)
finally:ctx.close()
