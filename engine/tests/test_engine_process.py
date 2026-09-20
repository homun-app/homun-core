"""Real loopback HTTP, clean process exit and durable command replay after restart."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from contextlib import contextmanager
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SERVER = '''
import socket,sys
from pathlib import Path
import uvicorn
from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
root=Path(sys.argv[1])
reset_context_for_tests(create_context(db_path=root/'workspace.sqlite',data_dir=root,for_tests=True))
sock=socket.socket()
sock.bind(('127.0.0.1',0))
(root/'port.txt').write_text(str(sock.getsockname()[1]))
try:
 uvicorn.Server(uvicorn.Config(create_app(),log_level='warning')).run(sockets=[sock])
finally:
 reset_context_for_tests(None)
 sock.close()
'''


def request(base, path, body=None):
    req = Request(base+path, data=json.dumps(body).encode() if body is not None else None,
                  headers={'Content-Type':'application/json', 'X-Homun-Actor-Id':'person_fabio'})
    try:
        with urlopen(req, timeout=8) as response:
            return response.status, json.loads(response.read())
    except HTTPError as exc:
        return exc.code, json.loads(exc.read())


@contextmanager
def engine_process(root):
    port_file = root/'port.txt'
    port_file.unlink(missing_ok=True)
    env = dict(os.environ, HOMUN_MEMORY_BACKEND='sqlite', HOMUN_DATA_DIR=str(root),
               PYTHONPATH=str(Path(__file__).resolve().parents[1]/'src'))
    with (root/'server.log').open('a') as log:
        process = subprocess.Popen([sys.executable, '-c', SERVER, str(root)], env=env,
                                   stdout=log, stderr=log)
        try:
            deadline = time.monotonic()+15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError((root/'server.log').read_text())
                if port_file.exists():
                    base = 'http://127.0.0.1:'+port_file.read_text()
                    try:
                        if request(base, '/v1/health')[0] == 200:
                            break
                    except (URLError, TimeoutError, ConnectionError):
                        pass
                time.sleep(0.05)
            else:
                raise AssertionError('Engine did not become ready')
            yield base
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                raise AssertionError('Engine did not shut down cleanly')


def test_http_command_survives_engine_process_restart(tmp_path):
    route = '/v1/workspaces/ws_local/commands'
    with engine_process(tmp_path) as base:
        assert request(base, '/v1/capabilities')[1]['features']['runtime']
        status, created = request(base, route, {'command_id':'conv','type':'conversation.create','payload':{'title':'Durable'}})
        assert status == 200
        command = {'command_id':'message','type':'conversation.post_message',
                   'payload':{'conversation_id':created['result']['conversation_id'],'text':'Ciao'}}
        status, result = request(base, route, command)
        assert status == 200
        assert result['result']['assistant_text']
    with engine_process(tmp_path) as base:
        assert request(base, route, command) == (200, result)
        changed = {**command, 'payload':{**command['payload'],'text':'Different'}}
        assert request(base, route, changed)[0] == 409
        status, conversations = request(base, '/v1/workspaces/ws_local/conversations')
        assert status == 200
        assert [item['title'] for item in conversations['items']] == ['Durable']
