"""Real Ollama chooses discovery, selected material read, and final output."""
import json
from pathlib import Path
import tempfile
import sys
from homun.context import create_context
from homun.domain.models import Actor
from homun.application.material_ingest import ingest_file
from homun.application.agent_runs import propose, approve
from homun.application.agent_run_execution import advance

root = Path(tempfile.mkdtemp(prefix='homun-registry-live-'))
ctx = create_context(db_path=root/'ws.db', data_dir=root, for_tests=True)
ctx.models.upsert_connection(connection_id='openai_compatible', kind='openai_compatible',
    display_name='Ollama', model_id='qwen3.5:4b', base_url='http://127.0.0.1:11434/v1',
    context_window=32768, max_output_tokens=1536)
ctx.models.set_active('openai_compatible')
actor = Actor(id='person_a', workspace_id=ctx.workspace_id, display_name='Fabio')
project = ctx.service.apply(actor,'p','project.create',{'name':'Registry parity'})['project_id']
conversation = ctx.service.apply(actor,'c','conversation.create',{'title':'Registro','project_id':project})['conversation_id']
work = ctx.service.apply(actor,'w','work.create',{'conversation_id':conversation,'title':'Nota commessa',
    'objective':'Prima usa tool_search con query read_material per trovare lo strumento di lettura. Poi usa quello strumento per leggere il documento selezionato. Infine riporta codice, responsabile e scadenza, senza domande.'})['work_id']
ctx.persist()
material = ingest_file(ctx,actor,command_id='m',project_id=project,filename='commessa.txt',
    data=b'Codice: HX-73Q. Responsabile: Marta. Scadenza: 8 ottobre 2026.')['material_id']
p = propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[material]})
approve(ctx,actor,work,p['id'],{'command_id':'go','digest':p['digest'],'expected_version':p['expected_version']})
statuses = []
for _ in range(8):
    status = advance(ctx,'run'); statuses.append(status); print(status,flush=True)
    if status != 'running': break
store = ctx.repository.load(); run = store.commands['run'].result
artifacts = [a.model_dump(mode='json') for a in store.artifacts.values()]
Path(sys.argv[1]).write_text(json.dumps({'fixture':'real model choices and tool IO',
    'model':'qwen3.5:4b','statuses':statuses,'run':run,'artifacts':artifacts,
    'usage':[u.model_dump(mode='json') for u in ctx.models.usage]},ensure_ascii=False,indent=2))
assert status == 'completed', run.get('error_code')
names = [o['tool'] for o in run['observations']]
assert 'tool_search' in names and 'read_material' in names, names
assert names.index('tool_search') < names.index('read_material'), names
content = artifacts[0]['content']
assert all(value in content for value in ['HX-73Q','Marta','8 ottobre 2026']), content
