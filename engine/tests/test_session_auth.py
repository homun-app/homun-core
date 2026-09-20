"""A desktop session protects reads, writes and health before route execution."""
from fastapi.testclient import TestClient
from homun.app import create_app

TOKEN = 'a' * 64


def test_session_protects_all_routes_and_rejects_untrusted_origins():
    client = TestClient(create_app(session_token=TOKEN, allowed_origins=['homun://app']))
    for route in ['/v1/health', '/v1/capabilities', '/v1/workspaces/ws_local/works']:
        assert client.get(route).status_code == 401
        assert client.get(route, headers={'Authorization': 'Bearer wrong'}).status_code == 401
    assert client.get('/v1/health', headers={'Authorization': 'Bearer '+TOKEN}).status_code == 200
    assert client.get('/v1/health', headers={'Authorization': 'Bearer '+TOKEN, 'Origin': 'https://evil.test'}).status_code == 403
    assert client.post('/v1/workspaces/ws_local/commands', json={}).status_code == 401
    assert client.get('/v1/health', headers={'Authorization': 'Bearer '+TOKEN, 'Origin': 'homun://app'}).status_code == 200


def test_browser_preflight_has_no_data_and_requires_exact_origin():
    client = TestClient(create_app(session_token=TOKEN, allowed_origins=['homun://app']))
    headers = {'Origin': 'homun://app', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization'}
    assert client.options('/v1/health', headers=headers).status_code == 200
    headers['Origin'] = 'https://evil.test'
    assert client.options('/v1/health', headers=headers).status_code == 403


def actor_client(actor_id='person_fabio'):
    from fastapi import Request
    app = create_app(session_token=TOKEN, session_actor_id=actor_id)
    @app.get('/_test/actor')
    def inspect_actor(request: Request):
        return {'id': request.headers.get('x-homun-actor-id'),
                'name': request.headers.get('x-homun-actor-name')}
    return TestClient(app)


def test_session_injects_bound_actor_without_trusting_renderer_name():
    client = actor_client()
    response = client.get('/_test/actor', headers={'Authorization':'Bearer '+TOKEN})
    assert response.status_code == 200
    assert response.json()['id'] == 'person_fabio'
    response = client.get('/_test/actor', headers={'Authorization':'Bearer '+TOKEN,
        'X-Homun-Actor-Id':'person_fabio', 'X-Homun-Actor-Name':'Pretend admin'})
    assert response.json()['name'] == 'person_fabio'


def test_session_rejects_actor_impersonation_and_ambiguous_duplicates():
    client = actor_client('local-owner')
    for headers in [
        [('Authorization','Bearer '+TOKEN),('X-Homun-Actor-Id','other')],
        [('Authorization','Bearer '+TOKEN),('X-Homun-Actor-Id','local-owner'),('X-Homun-Actor-Id','other')],
        [('Authorization','Bearer '+TOKEN),('X-Homun-Actor-Id','')],
    ]:
        response = client.get('/_test/actor', headers=headers)
        assert response.status_code == 403
        assert response.json()['detail']['code'] == 'session_actor_mismatch'


def test_bound_identity_does_not_leak_between_apps():
    for actor in ['first', 'second']:
        response = actor_client(actor).get('/_test/actor', headers={'Authorization':'Bearer '+TOKEN})
        assert response.json()['id'] == actor
