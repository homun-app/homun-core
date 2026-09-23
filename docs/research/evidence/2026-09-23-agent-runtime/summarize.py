"""Mechanical checks; semantic review is recorded separately, never inferred from PASS."""
import json,re
from pathlib import Path
base=Path(__file__).parent
requests=[json.loads(l) for l in (base/'requests.jsonl').read_text().splitlines()]
rows=[]
for root in sorted((base/'runs').glob('*')):
 if not (root/'processes.json').exists():continue
 stages=json.loads((root/'processes.json').read_text());text=(root/'piano.md').read_text() if (root/'piano.md').exists() else ''
 audit=[json.loads(l) for l in (root/'tool-audit.jsonl').read_text().splitlines()] if (root/'tool-audit.jsonl').exists() else []
 calls=[d for d in requests if stages[0]['start']<=d['time']<=stages[-1]['end'] and 'messages' in d['request']]
 corrected=root.name.startswith('correct'); flat=text.lower().replace('.','').replace(',','')
 want=['sara','8000','15 dicembre 2026'] if corrected else ['giulia','12000','30 novembre 2026']
 checks={'both_materials_read':all(any(a['operation']=='read' and a['path']==name and 'error' not in a['result'] for a in audit) for name in ['brief.md','notes.md']),'no_stale_values':not corrected or not any(x in flat for x in ['giulia','12000','30 novembre 2026']),'artifact':bool(text),'facts':all(x in flat for x in want),'word_limit':bool(text) and len(text.split())<=180,'human_approval': 'approvazione' in flat and ('umana' in flat or 'umano' in flat),'three_steps':all(re.search(rf'(?m)^\s*{i}[.)]',text) for i in [1,2,3]),'public_fetch':any(a['operation']=='fetch' and 'error' not in a['result'] for a in audit),'verified_written_file':any(a['operation']=='read' and a['path']=='piano.md' for a in audit)}
 stopdata=[json.loads(p.read_text()).get('stopped') for p in root.glob('*start-result.json')]
 result_files=list(root.glob('*finish-result.json')) if not root.name.startswith('delivery') else list(root.glob('delivery-result.json'))
 final=json.loads(result_files[0].read_text()) if result_files else {}
 checks['runtime_finished']=final.get('result',{}).get('completed',False) if root.name.endswith('hermes') else final.get('status')=='ConversationExecutionStatus.FINISHED'
 checks['native_pause']=root.name.startswith('delivery') or any(stopdata)
 row={'case':root.name,'stages':stages,'checks':checks,'mechanical_pass':all(checks.values()),'words':len(text.split()),'pause_triggered':any(stopdata),'llm_calls':len(calls),'input_tokens':sum(d['response'].get('usage',{}).get('prompt_tokens',0) for d in calls),'cached_input_tokens':sum(d['response'].get('usage',{}).get('prompt_tokens_details',{}).get('cached_tokens',0) for d in calls),'output_tokens':sum(d['response'].get('usage',{}).get('completion_tokens',0) for d in calls),'llm_seconds':round(sum(d['seconds'] for d in calls),2),'process_seconds':round(sum(d['seconds'] for d in stages),2),'tool_errors':sum('error' in a['result'] for a in audit),'tool_actions':[(a['operation'],a['path']) for a in audit]}
 rows.append(row)
(base/'summary.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print(json.dumps(rows,ensure_ascii=False,indent=2))
