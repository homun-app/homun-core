"""Follow-up of the observed timeline concern, excluded from the original 12 trials."""
import json,subprocess,os,time
from pathlib import Path
from common import BRIEF,NOTES
base=Path(__file__).parent
for engine in ['hermes','openhands']:
 root=base/'timeline-followup'/engine;root.mkdir(parents=True,exist_ok=False)
 (root/'brief.md').write_text(BRIEF+'\nData di avvio del piano: 23 settembre 2026. Tutte e tre le fasi devono concludersi entro il 30 novembre 2026, non solo iniziare.\n');(root/'notes.md').write_text(NOTES)
 start=time.time();print('START followup',engine,flush=True)
 env={k:v for k,v in os.environ.items() if not any(x in k for x in ['API_KEY','TOKEN','SECRET','AUTH'])};env['OPENHANDS_SUPPRESS_BANNER']='1'
 with (root/'delivery.log').open('w') as f:
  try:
   p=subprocess.run([str(base/(engine+'-venv')/'bin/python'),str(base/('run_'+engine+'.py')),str(root),'delivery'],cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=240)
   record={'returncode':p.returncode,'start':start,'end':time.time()}
  except subprocess.TimeoutExpired:record={'timeout':True,'start':start,'end':time.time()}
 (root/'process.json').write_text(json.dumps(record,indent=2));print('END followup',engine,record,flush=True)
