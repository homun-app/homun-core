"""Bounded local smoke: run from repo with PYTHONPATH=engine/src, pass output JSON path."""
import json
import sys
import tempfile
from pathlib import Path
from homun.context import create_context
from homun.domain.models import Actor
from homun.application.material_ingest import ingest_file
from homun.application.agent_runs import propose, approve
from homun.application.agent_run_execution import advance

root=Path(tempfile.mkdtemp(prefix='homun-native-smoke-'))
ctx=create_context(db_path=root/'ws.db', data_dir=root, for_tests=True)
ctx.models.set_active('openai_compatible')
assert ctx.models.get_connection('openai_compatible').base_url=='http://127.0.0.1:11434/v1'
actor=Actor(id='person_a',workspace_id=ctx.workspace_id,display_name='Fabio')
p=ctx.service.apply(actor,'p','project.create',{'name':'Native smoke'})['project_id']
c=ctx.service.apply(actor,'c','conversation.create',{'title':'Verifica','project_id':p})['conversation_id']
w=ctx.service.apply(actor,'w','work.create',{'conversation_id':c,'title':'Nota operativa',
    'objective':'Leggi il materiale allegato usando read_material. Scrivi una nota in italiano con destinatario, scadenza e codice esatti presenti nel materiale. Non chiedere conferme.'})['work_id']
ctx.persist()
m=ingest_file(ctx,actor,command_id='m',project_id=p,filename='brief.txt',data='Destinatario: Marta. Scadenza: 30 settembre 2026. Codice commessa: HX-73Q9. Preparare una nota di tre righe.'.encode())['material_id']
run=propose(ctx,actor,w,{'command_id':'run','expected_version':1,'material_ids':[m]})
approve(ctx,actor,w,run['id'],{'command_id':'go','digest':run['digest'],'expected_version':run['expected_version']})
statuses=[];restarted=False;usage=[]
try:
    for _ in range(8):
        status=advance(ctx,run['id']);statuses.append(status)
        print(status,flush=True)
        if status in {'failed','blocked','completed','waiting_input'}:break
        if not restarted:
            usage.extend(u.model_dump(mode='json') for u in ctx.models.usage)
            ctx.close()
            ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
            restarted=True
    store=ctx.repository.load();record=store.commands['run'].result
    artifacts=[a.model_dump(mode='json') for a in store.artifacts.values()]
    usage.extend(u.model_dump(mode='json') for u in ctx.models.usage)
    result={'model':'qwen3.5:4b','endpoint':'http://127.0.0.1:11434','context_restarted':restarted,
            'statuses':statuses,'run':record,'artifacts':artifacts,'usage':usage}
    Path(sys.argv[1]).write_text(json.dumps(result,ensure_ascii=False,indent=2))
    assert status=='completed',record.get('error_code')
    assert restarted
    assert any(o['tool']=='read_material' for o in record['observations'])
    content=json.dumps(artifacts,ensure_ascii=False)
    assert all(value in content for value in ('Marta','HX-73Q9','30 settembre 2026'))
    assert store.works[w].status=='review'
    print('PASS: native read, context restart, exact facts, artifact in review',flush=True)
finally:ctx.close()
