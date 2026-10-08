import os,json,sys,time,uuid
from pathlib import Path
from typing import Literal
from pydantic import Field
from openhands.sdk import LLM,Agent,Conversation,Action,Observation,TextContent,ToolDefinition,Tool
from openhands.sdk.tool import register_tool,ToolExecutor
from common import Workspace,DESC,PROMPT,CORRECTION
root=Path(sys.argv[1]);mode=sys.argv[2]; ws=Workspace(root,mode in ('correct_start','resume_start'))
class WorkspaceAction(Action):
 operation:Literal['read','write','fetch']
 path:str
 content:str=Field(default='',description='Content for write; empty string otherwise.')
class WorkspaceObservation(Observation):
 payload:str
 @property
 def to_llm_content(self):return [TextContent(text=self.payload)]
class Executor(ToolExecutor):
 def __call__(self,action,conversation=None):return WorkspaceObservation(payload=ws.call(action.operation,action.path,action.content))
class WorkspaceTool(ToolDefinition):
 name='workspace'
 @classmethod
 def create(cls,conv_state=None,**kwargs):return [cls(description=DESC,action_type=WorkspaceAction,observation_type=WorkspaceObservation,executor=Executor())]
register_tool('workspace',WorkspaceTool)
llm=LLM(model='openai/homun-bench-qwen3.5-4b:20260923',base_url='http://127.0.0.1:11435/v1',api_key='local-ollama',temperature=0,max_input_tokens=65536,max_output_tokens=2048,reasoning_effort='none',num_retries=0,timeout=120,api_mode='chat',caching_prompt=False,log_completions=True,log_completions_folder=str(root/'completions'))
agent=Agent(llm=llm,tools=[Tool(name='workspace')])
idfile=root/'conversation-id.txt'
cid=uuid.UUID(idfile.read_text()) if idfile.exists() else uuid.uuid4();idfile.write_text(str(cid))
def event(e):
 with (root/'events.jsonl').open('a') as f:f.write(e.model_dump_json()+'\n')
conv=Conversation(agent=agent,workspace=root,persistence_dir=root/'state',conversation_id=cid,callbacks=[event],max_iteration_per_run=10,visualizer=None,delete_on_close=False)
ws.stop=conv.pause
t=time.time();conv.send_message(CORRECTION if mode=='correct_finish' else ('Riprendi il lavoro richiesto e completa piano.md verificandolo.' if mode=='resume_finish' else PROMPT));conv.run()
(root/(mode+'-result.json')).write_text(json.dumps({'seconds':time.time()-t,'status':str(conv.state.execution_status),'stopped':ws.stopped},indent=2));conv.close()
