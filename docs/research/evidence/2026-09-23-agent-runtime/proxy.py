"""Transparent loopback capture; same sampling parameters for both candidates."""
import http.server,urllib.request,urllib.error,json,time,os
from pathlib import Path
ROOT=Path(__file__).parent
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  raw=self.rfile.read(int(self.headers['Content-Length']));body=json.loads(raw)
  body.update(temperature=0,reasoning_effort='none',max_tokens=2048,stream=False)
  for k in ['max_completion_tokens','stream_options']:body.pop(k,None)
  t=time.time();status=200
  try:
   req=urllib.request.Request('http://127.0.0.1:11434'+self.path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
   with urllib.request.urlopen(req,timeout=150) as r:data=r.read()
  except urllib.error.HTTPError as e:status=e.code;data=e.read()
  except Exception as e:status=502;data=json.dumps({'error':str(e)}).encode()
  with (ROOT/'requests.jsonl').open('a') as f:f.write(json.dumps({'time':t,'seconds':time.time()-t,'status':status,'request':body,'response':json.loads(data)})+'\n')
  self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
http.server.ThreadingHTTPServer(('127.0.0.1',11435),Handler).serve_forever()
