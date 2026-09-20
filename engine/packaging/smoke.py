#!/usr/bin/env python3
"""Frozen engine auth and durable restart, without Python PATH or source cwd."""
import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import secrets
import signal
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


@contextmanager
def running(binary, root, principal='synthetic-smoke'):
    token = secrets.token_hex(32)
    env = {'PATH': '/nonexistent', 'HOME': str(root), 'TMPDIR': str(root),
           'HOMUN_DATA_DIR': str(root / 'data'), 'HOMUN_SESSION_TOKEN': token,
           'HOMUN_SESSION_ACTOR_ID': principal}
    log_path = root / 'engine.log'
    with log_path.open('w') as log:
        process = subprocess.Popen([str(binary), 'serve', '--port', '0'], cwd=root,
                                   env=env, stdout=log, stderr=log)
    try:
        base = None
        for _ in range(300):
            if process.poll() is not None:
                raise RuntimeError(log_path.read_text())
            for line in log_path.read_text().splitlines():
                if line.startswith('HOMUN_SOCKET '):
                    base = 'http://127.0.0.1:' + str(json.loads(line[13:])['port'])
            if base:
                try:
                    req = urllib.request.Request(base + '/v1/health', headers={'Authorization': 'Bearer ' + token})
                    with urllib.request.urlopen(req, timeout=1) as response:
                        assert json.load(response)['status'] == 'ok'
                    break
                except (OSError, urllib.error.URLError):
                    pass
            time.sleep(0.1)
        else:
            raise RuntimeError('Frozen startup timed out: ' + log_path.read_text())
        try:
            urllib.request.urlopen(base + '/v1/health', timeout=2)
            raise AssertionError('Unauthenticated health was accepted')
        except urllib.error.HTTPError as exc:
            assert exc.code == 401
        def request(path, payload=None, *, actor_id=None, expected_status=200):
            data = json.dumps(payload).encode() if payload is not None else None
            req = urllib.request.Request(base + path, data=data, headers={
                'Authorization': 'Bearer ' + token, 'X-Homun-Actor-Id': actor_id if actor_id is not None else principal,
                'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=15) as response:
                    assert response.status == expected_status
                    return json.load(response)
            except urllib.error.HTTPError as exc:
                body = json.load(exc)
                if exc.code == expected_status:
                    return body
                raise AssertionError(body) from exc
        assert request('/v1/capabilities')['features']['runtime'] is True
        yield request
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise AssertionError('Frozen engine did not stop gracefully')
        assert process.returncode in (0, -signal.SIGTERM), log_path.read_text()
        assert 'DBOS successfully shut down' in log_path.read_text(), log_path.read_text()


def command(request, identity, kind, payload):
    return request('/v1/workspaces/ws_local/commands', {
        'command_id': identity, 'type': kind, 'payload': payload})['result']


def smoke(binary):
    with tempfile.TemporaryDirectory(prefix='homun-frozen-smoke-') as directory:
        root = Path(directory)
        with running(binary, root) as request:
            assert request('/v1/models/providers')['items']
            request('/v1/models/providers/active', {'provider_id':'fake'})
            project = command(request, 'project', 'project.create', {'name': 'Synthetic private project'})
            context_conversation = command(request, 'context-conversation', 'conversation.create',
                {'title':'Synthetic context', 'project_id':project['project_id']})
            first_message = command(request, 'context-first', 'conversation.post_message',
                {'conversation_id':context_conversation['conversation_id'], 'text':'Il colore scelto è blu.'})
            assert first_message['context_manifest']['sources'] == []
            conversation = command(request, 'conversation', 'conversation.create',
                {'title': 'Synthetic frozen smoke', 'project_id': project['project_id']})
            assert request('/v1/workspaces/ws_local/conversations')['items']
            work = command(request, 'work', 'work.create', {'conversation_id': conversation['conversation_id'],
                           'title': 'Synthetic', 'objective': 'Synthetic durable smoke'})
            spoofed = request('/v1/health', actor_id='synthetic-other', expected_status=403)
            assert spoofed['detail']['code'] == 'session_actor_mismatch'
            grant = command(request, 'grant', 'grant.issue', {'project_id':project['project_id'],
                'subject_id':'synthetic-other', 'capability':'write'})
            plan = command(request, 'plan', 'plan.propose', {'work_id': work['work_id'], 'expected_version': work['version'],
                'steps': [{'title': 'Synthetic input', 'assignee_id': 'synthetic-smoke', 'output_expected': 'Text', 'depends_on': []}]})
            accepted = command(request, 'accept', 'plan.accept', {'work_id': work['work_id'],
                'expected_version': plan['version'], 'plan_revision': plan['plan_revision']})
            started = command(request, 'start', 'work.start', {'work_id': work['work_id'],
                'expected_version': accepted['version'], 'durable': True, 'to_actor_id': 'synthetic-smoke'})
            assert started['status'] == 'waiting_input' and started['durable'] is True
        # A different principal requires a new launcher-created session, never a header switch.
        other_body = {'command_id':'other-work', 'type':'work.create', 'payload':{
            'conversation_id':conversation['conversation_id'], 'title':'Allowed', 'objective':'Allowed'}}
        with running(binary, root, 'synthetic-other') as request:
            assert request('/v1/workspaces/ws_local/commands', other_body)['result']['work_id']
        with running(binary, root) as request:
            command(request, 'revoke', 'grant.revoke', {'grant_id':grant['grant_id']})
            remembered = command(request, 'context-after-restart', 'conversation.post_message',
                {'conversation_id':context_conversation['conversation_id'], 'text':'Il colore precedente resta valido.'})
            assert any(source['message_id'] == first_message['message_id']
                       for source in remembered['context_manifest']['sources'])
            payload = {'request_id': started['request_id'], 'expected_version': started['version'], 'text': 'Synthetic contribution'}
            completed = command(request, 'contribution', 'work.provide_contribution', payload)
            assert completed['status'] == 'completed', completed
            assert completed['effect_status'] in ('applied', 'reconciled')
            assert command(request, 'contribution', 'work.provide_contribution', payload) == completed
        with running(binary, root, 'synthetic-other') as request:
            denied = request('/v1/workspaces/ws_local/commands', other_body, expected_status=403)
            assert denied['detail']['code'] == 'permission_denied'
            assert request('/v1/workspaces/ws_local/works')['items'] == []
            denied = request('/v1/workspaces/ws_local/works/'+work['work_id'], expected_status=403)
            assert denied['detail']['code'] == 'permission_denied'
            events = request('/v1/workspaces/ws_local/events')['items']
            assert all(event['aggregate_type'] == 'grant' and event['aggregate_id'] == grant['grant_id']
                       for event in events), events
        assert len(list((root / 'data/receipts').glob('*.json'))) == 1
        dbos = sqlite3.connect(root / 'data/dbos.sqlite')
        try:
            migration = dbos.execute('SELECT max(version) FROM dbos_migrations').fetchone()[0]
        finally:
            dbos.close()
        result = {'authenticated_health': True, 'unauthenticated_status': 401, 'runtime_capability': True,
                  'session_actor_bound': True, 'authorized_reads': True,
                  'context_after_restart': True, 'context_provider': 'fake',
                  'provider_registry': True, 'project_authorization': True, 'revoked_replay_denied': True, 'durable_restart': True, 'idempotent_receipts': 1,
                  'dbos_migration': migration, 'graceful_shutdown': True,
                  'runtime_path': '/nonexistent', 'pythonpath': None, 'cwd': 'temporary'}
        print(json.dumps(result, indent=2))
        return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    smoke(parser.parse_args().binary.resolve())
