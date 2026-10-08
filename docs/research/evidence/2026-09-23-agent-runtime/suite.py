"""Run sequential paired trials; preserve each process exit and raw evidence."""
import json,subprocess,os,time
from pathlib import Path
from common import BRIEF,NOTES
base=Path(__file__).parent
for repeat in (1,2):
 for scenario in ('delivery','correct','resume'):
  for engine in (('hermes','openhands') if repeat==1 else ('openhands','hermes')):
   root=base/'runs'/f'{scenario}-{repeat}-{engine}';root.mkdir(parents=True,exist_ok=False)
   (root/'brief.md').write_text(BRIEF);(root/'notes.md').write_text(NOTES)
   stages=['delivery'] if scenario=='delivery' else [scenario+'_start',scenario+'_finish']
   records=[]
   for mode in stages:
    start=time.time();print('START',root.name,mode,flush=True)
    env={k:v for k,v in os.environ.items() if not any(x in k for x in ['API_KEY','TOKEN','SECRET','AUTH'])}
    env.update(OPENHANDS_SUPPRESS_BANNER='1',HERMES_HOME=str(root/'state'))
    with (root/(mode+'.log')).open('w') as log:
     try:
      p=subprocess.run([str(base/(engine+'-venv')/'bin/python'),str(base/('run_'+engine+'.py')),str(root),mode],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=240)
      result={'stage':mode,'returncode':p.returncode,'seconds':time.time()-start,'start':start,'end':time.time()}
     except subprocess.TimeoutExpired:
      result={'stage':mode,'timeout':True,'seconds':time.time()-start,'start':start,'end':time.time()}
    records.append(result);(root/'processes.json').write_text(json.dumps(records,indent=2));print('END',root.name,mode,result,flush=True)
    if result.get('returncode',1)!=0:break
