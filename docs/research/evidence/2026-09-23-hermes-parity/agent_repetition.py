"""Injected repetitive HTTP response + normal real Ollama generation."""
import http.server
import json
from pathlib import Path
import sys
import threading
from homun.models.openai_compat import OpenAICompatibleProvider
from homun.models.secrets import MemorySecretStore
from homun.models.native_transport import complete_tools
from homun.models.native_turn import NativeMessage
from homun.models.native_errors import NativeModelError

calls=[]
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        calls.append(self.path)
        self.rfile.read(int(self.headers.get('Content-Length',0)))
        body={'choices':[{'finish_reason':'stop','message':{'content':
            'An identical long sentence repeated without any progress or useful new information.\n'*40}}],
            'usage':{'prompt_tokens':17,'completion_tokens':600}}
        payload=json.dumps(body).encode()
        self.send_response(200);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
    def log_message(self,*args):pass

server=http.server.HTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    provider=OpenAICompatibleProvider(secrets=MemorySecretStore(),base_url=f'http://127.0.0.1:{server.server_port}/v1')
    try:
        complete_tools(provider,[NativeMessage(role='user',content='Produce a report')],tools=[])
        raise AssertionError('Repetition accepted')
    except NativeModelError as exc:
        assert exc.code=='agent_model_repetition' and not exc.retryable
        injected={'code':exc.code,'usage':exc.usage.model_dump(mode='json'),'requests':len(calls)}
finally:
    server.shutdown();server.server_close()

local=OpenAICompatibleProvider(secrets=MemorySecretStore(),base_url='http://127.0.0.1:11434/v1',default_model='qwen3.5:4b')
normal=complete_tools(local,[NativeMessage(role='user',content='Scrivi in italiano otto punti distinti su come organizzare una riunione di lavoro. Ogni punto deve avere almeno venti parole e un contenuto diverso.')],tools=[],max_output_tokens=1536,context_window=32768)
assert len(normal.message.content)>400
Path(sys.argv[1]).write_text(json.dumps({'injected_http_repetition':injected,
    'real_ollama_normal':{'content':normal.message.content,'usage':normal.usage.model_dump(mode='json')}},ensure_ascii=False,indent=2))
print('Injected HTTP rejected; normal real Ollama output accepted.')
