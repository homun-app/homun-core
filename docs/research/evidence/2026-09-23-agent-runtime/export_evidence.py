"""Export synthetic observations without vendoring upstream system prompts or state DBs."""
import json,hashlib,shutil,sys
from pathlib import Path
source=Path(__file__).parent;dest=Path(sys.argv[1]);dest.mkdir(parents=True,exist_ok=True)
def compact_reference(value):
 if isinstance(value,dict):return {k:compact_reference(v) for k,v in value.items()}
 if isinstance(value,list):return [compact_reference(v) for v in value]
 if isinstance(value,str) and '<html>' in value and 'IANA' in value:
  return {'omitted':'public IANA HTML payload; original retained in local raw trace','field_sha256':hashlib.sha256(value.encode()).hexdigest(),'field_chars':len(value)}
 return value
rows=json.loads((source/'summary.json').read_text());calls=[json.loads(l) for l in (source/'requests.jsonl').read_text().splitlines()]
def package(root,stages):
 a=root/'tool-audit.jsonl';tool_calls=[json.loads(l) for l in a.read_text().splitlines()] if a.exists() else []
 requests=[]
 for call in calls:
  if stages[0]['start']<=call['time']<=stages[-1]['end'] and 'messages' in call['request']:
   request=dict(call['request']);messages=[]
   for m in request['messages']:
    if m['role'] in ('system','developer'):
     s=json.dumps(m['content'],ensure_ascii=False);messages.append({'role':m['role'],'content_sha256':hashlib.sha256(s.encode()).hexdigest(),'serialized_content_chars':len(s),'omitted':'upstream system prompt; see pinned source/version'})
    else:messages.append(m)
   request['messages']=messages;requests.append({**call,'request':request})
 result={'processes':stages,'inputs':{f:(root/f).read_text() for f in ('brief.md','notes.md')},'artifact':(root/'piano.md').read_text() if (root/'piano.md').exists() else None,'tool_audit':tool_calls,'model_calls':requests,'native_results':{p.name:json.loads(p.read_text()) for p in root.glob('*result.json')}}
 events=root/'events.jsonl'
 if events.exists():result['native_events']=[json.loads(l) for l in events.read_text().splitlines()]
 return compact_reference(result)
for row in rows:
 root=source/'runs'/row['case'];payload=package(root,row['stages']);(dest/(row['case']+'.json')).write_text(json.dumps(payload,ensure_ascii=False,indent=2))
for root in (source/'timeline-followup').glob('*'):
 stages=[json.loads((root/'process.json').read_text())];(dest/('timeline-'+root.name+'.json')).write_text(json.dumps(package(root,stages),ensure_ascii=False,indent=2))
shutil.copy2(source/'summary.json',dest/'summary.json')
for name in ['common.py','run_hermes.py','run_openhands.py','proxy.py','suite.py','summarize.py','followup.py','export_evidence.py','Modelfile','hermes-requirements.txt','openhands-requirements.txt']:
 shutil.copy2(source/name,dest/name)
print('Exported',len(rows),'paired trial records and available timeline follow-ups')
