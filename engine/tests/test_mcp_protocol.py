"""Strict offline MCP wire fixtures, independent of application mocks."""
import json
import sys
import time

import pytest

from homun.application import mcp_client
from homun.domain.models import ExternalServer


def server(tmp_path, mode='normal'):
    script = tmp_path / 'strict_mcp.py'
    script.write_text('''import json, sys
mode = sys.argv[1]
initialized = False
for line in sys.stdin:
    req = json.loads(line)
    method = req['method']
    if method == 'notifications/initialized':
        initialized = True
        continue
    if 'id' not in req:
        continue
    if method == 'initialize':
        if mode == 'init_missing':
            continue
        if mode == 'init_error':
            result = {'error': {'code': -32000, 'message': 'refused'}}
        else:
            result = {'result': {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'strict', 'version': '1'}}}
    elif not initialized:
        result = {'error': {'code': -32000, 'message': 'not initialized'}}
    elif method == 'tools/list':
        if mode == 'list_missing':
            continue
        page = req.get('params', {}).get('cursor')
        result = {'result': {'tools': [{'name': 'second' if page else 'first', 'description': 'example', 'inputSchema': {'type': 'object', 'properties': {'q': {'type': 'string'}}}}]}}
        if not page:
            result['result']['nextCursor'] = 'page2'
    elif method == 'tools/call':
        if mode == 'call_missing':
            continue
        if mode == 'call_error':
            result = {'error': {'code': -32000, 'message': 'call refused'}}
        else:
            result = {'result': {'content': [{'type': 'text', 'text': 'done'}], 'structuredContent': {'count': 3}, 'isError': mode == 'tool_error'}}
    else:
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': req['id'] if mode != 'wrong_id' else 999, **result}), flush=True)
''')
    return ExternalServer(id='mcp_test', workspace_id='ws_test', name='strict', transport='stdio', command=sys.executable, args=[str(script), mode])


def test_real_handshake_discovers_complete_paginated_descriptors(tmp_path):
    result = mcp_client.probe_server(server(tmp_path))
    assert result['tools'] == ['first', 'second']
    assert result['tool_count_total'] == 2
    assert result['tool_descriptors'][0]['inputSchema']['properties']['q']['type'] == 'string'


@pytest.mark.parametrize('mode', ['init_error', 'init_missing', 'call_missing', 'call_error', 'wrong_id'])
def test_invalid_or_missing_correlated_response_fails_closed(tmp_path, monkeypatch, mode):
    monkeypatch.setattr(mcp_client, 'PROBE_TIMEOUT_SECONDS', .25)
    started = time.monotonic()
    with pytest.raises(Exception):
        mcp_client.call_tool(server(tmp_path, mode), 'first', {})
    assert time.monotonic() - started < 5


def test_missing_discovery_response_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(mcp_client, 'PROBE_TIMEOUT_SECONDS', .25)
    with pytest.raises(Exception):
        mcp_client.probe_server(server(tmp_path, 'list_missing'))


@pytest.mark.parametrize('mode,is_error', [('normal', False), ('tool_error', True)])
def test_call_preserves_result_content_and_error(tmp_path, mode, is_error):
    result = mcp_client.call_tool(server(tmp_path, mode), 'first', {})
    assert result['text'] == 'done'
    assert result['is_error'] is is_error
    assert result['structured_content'] == {'count': 3}
    assert result['content'] == [{'type': 'text', 'text': 'done'}]


@pytest.mark.parametrize('sse', [False, True])
def test_http_session_headers_initialized_and_json_or_sse(sse):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading

    observed = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(405)
            self.end_headers()

        def do_DELETE(self):
            self.send_response(200)
            self.end_headers()

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            observed.append((req['method'], dict(self.headers)))
            method = req['method']
            if method == 'notifications/initialized':
                self.send_response(202)
                self.end_headers()
                return
            if method == 'initialize':
                result = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}},
                          'serverInfo': {'name': 'http-test', 'version': '1'}}
            elif method == 'tools/list':
                result = {'tools': [{'name': 'first', 'inputSchema': {'type': 'object'}}]}
            else:
                result = {'content': [{'type': 'text', 'text': 'http done'}]}
            raw = json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': result})
            self.send_response(200)
            self.send_header('Mcp-Session-Id', 'session-test')
            self.send_header('Content-Type', 'text/event-stream' if sse else 'application/json')
            body = ('event: message\ndata: ' + raw + '\n\n' if sse else raw).encode()
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=http.serve_forever, daemon=True)
    worker.start()
    try:
        declaration = ExternalServer(id='http', workspace_id='ws', name='http', transport='http',
                                     url=f'http://127.0.0.1:{http.server_port}/mcp', headers={'X-Declared': 'allowed'})
        assert mcp_client.probe_server(declaration)['tools'] == ['first']
        assert mcp_client.call_tool(declaration, 'first', {})['text'] == 'http done'
        methods = [entry[0] for entry in observed]
        assert methods[:6] == ['initialize', 'notifications/initialized', 'tools/list',
                               'initialize', 'notifications/initialized', 'tools/call']
        # SDK may read the descriptor to validate outputSchema after the result.
        assert methods.count('tools/call') == 1
        for method, headers in observed:
            normalized = {k.lower(): v for k, v in headers.items()}
            assert normalized['x-declared'] == 'allowed'
            if method != 'initialize':
                assert normalized['mcp-session-id'] == 'session-test'
                assert normalized['mcp-protocol-version'] == '2025-06-18'
    finally:
        http.shutdown()
        http.server_close()
        worker.join(timeout=2)
