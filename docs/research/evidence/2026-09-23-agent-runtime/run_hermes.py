import os,json,sys,time
from pathlib import Path
from common import Workspace,DESC,PROPS,PROMPT,CORRECTION
root=Path(sys.argv[1]);mode=sys.argv[2]; ws=Workspace(root,mode in ('correct_start','resume_start'))
os.environ['HERMES_HOME']=str(root/'state');os.environ['TERMINAL_CWD']=str(root)
(root/'state').mkdir(exist_ok=True)
(root/'state'/'config.yaml').write_text('model:\n  streaming: false\n  context_length: 65536\ndisplay:\n  streaming: false\ntools:\n  tool_search:\n    enabled: off\n')
from run_agent import AIAgent
from tools.registry import registry
from hermes_state import SessionDB
registry.register(name='workspace',toolset='bench',schema={'name':'workspace','description':DESC,'parameters':{'type':'object','properties':PROPS,'required':['operation','path']}},handler=lambda args,**kw:ws.call(**args),check_fn=lambda:True)
db=SessionDB(root/'state'/'state.db');sid='bench-session'
agent=AIAgent(model='homun-bench-qwen3.5-4b:20260923',base_url='http://127.0.0.1:11435/v1',api_key='local-ollama',api_mode='chat_completions',enabled_toolsets=['bench'],max_iterations=10,max_tokens=2048,request_overrides={'temperature':0,'reasoning_effort':'none'},quiet_mode=True,skip_context_files=True,skip_memory=True,skip_background_review=True,session_db=db,session_id=sid,cwd=str(root),run_budget_seconds=180)
ws.stop=lambda:agent.interrupt()
history=db.get_messages_as_conversation(sid)
t=time.time();result=agent.run_conversation(CORRECTION if mode=='correct_finish' else ('Riprendi il lavoro richiesto e completa piano.md verificandolo.' if mode=='resume_finish' else PROMPT),conversation_history=history or None)
(root/(mode+'-result.json')).write_text(json.dumps({'seconds':time.time()-t,'stopped':ws.stopped,'result':result},ensure_ascii=False,indent=2,default=str));db.close()
