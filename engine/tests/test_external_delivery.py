"""A separate consent publishes a saved receipt; original effect stays fixed."""
import pytest
from test_external_receipts import setup, approve
from homun.application import external_tools
from homun.domain.errors import ConflictError, PermissionDeniedError
from homun.domain.models import Actor


def prepared(setup,monkeypatch):
    from homun.application import external_publication
    original=external_publication.publish
    monkeypatch.setattr(external_publication,'publish',lambda *a:(_ for _ in ()).throw(RuntimeError('paused delivery')))
    assert approve(setup)['status']=='publication_pending'
    monkeypatch.setattr(external_publication,'publish',original)
    ctx,actor,body,p,calls=setup
    with ctx.repository.transaction() as store:store.works[body['work_id']].version+=1
    return ctx,actor,p,calls


def test_reapprove_delivery_does_not_reexecute_or_mutate_original_consent(setup,monkeypatch):
    from homun.application import external_delivery
    ctx,actor,p,calls=prepared(setup,monkeypatch)
    preview=external_delivery.preview(ctx,actor,p['id'])
    assert preview['text']=='done'
    assert preview['expected_version']==p['expected_version']+1
    body={'command_id':'deliver','digest':preview['digest'],'expected_version':preview['expected_version']}
    result=external_delivery.deliver(ctx,actor,p['id'],body)
    assert result['status']=='completed'
    assert external_delivery.deliver(ctx,actor,p['id'],body)['artifact_id']==result['artifact_id']
    saved=ctx.repository.load().commands[p['id']].result
    assert saved['digest']==p['digest'] and saved['expected_version']==p['expected_version']
    assert len(calls)==1


@pytest.mark.parametrize('change',['work','receipt'])
def test_stale_delivery_preview_is_rejected(setup,monkeypatch,change):
    from homun.application import external_delivery
    ctx,actor,p,calls=prepared(setup,monkeypatch)
    preview=external_delivery.preview(ctx,actor,p['id'])
    with ctx.repository.transaction() as store:
        if change=='work':store.works[p['work_id']].version+=1
        else:store.commands[p['id']].result['_receipt']['text']='different'
    with pytest.raises(ConflictError):
        external_delivery.deliver(ctx,actor,p['id'],{'command_id':'deliver','digest':preview['digest'],'expected_version':preview['expected_version']})
    assert not ctx.repository.load().artifacts and len(calls)==1


def test_delivery_requires_owner_or_reviewer_and_receipt(setup,monkeypatch):
    from homun.application import external_delivery
    ctx,actor,p,calls=prepared(setup,monkeypatch)
    other=Actor(id='person_other',workspace_id=ctx.workspace_id,display_name='Other')
    with pytest.raises(PermissionDeniedError):external_delivery.preview(ctx,other,p['id'])
    with ctx.repository.transaction() as store:store.commands[p['id']].result.pop('_receipt')
    with pytest.raises(ConflictError):external_delivery.preview(ctx,actor,p['id'])

def test_replay_rechecks_authority_and_rejects_command_collision(setup,monkeypatch):
    from homun.application import external_delivery
    ctx,actor,p,calls=prepared(setup,monkeypatch)
    preview=external_delivery.preview(ctx,actor,p['id'])
    body={'command_id':'deliver','digest':preview['digest'],'expected_version':preview['expected_version']}
    with pytest.raises(ConflictError):external_delivery.deliver(ctx,actor,p['id'],{**body,'command_id':'w'})
    external_delivery.deliver(ctx,actor,p['id'],body)
    with ctx.repository.transaction() as store:
        work=store.works[p['work_id']];work.owner_id='someone_else';work.reviewer_id='someone_else'
    with pytest.raises(PermissionDeniedError):external_delivery.deliver(ctx,actor,p['id'],body)
    assert len(calls)==1


def test_delivery_http_routes_require_explicit_preview_digest(setup,monkeypatch):
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.context import reset_context_for_tests
    ctx,actor,p,calls=prepared(setup,monkeypatch)
    reset_context_for_tests(ctx)
    try:
        with TestClient(create_app()) as client:
            url=f'/v1/workspaces/{ctx.workspace_id}/mcp/tools/{p["id"]}/delivery'
            headers={'X-Homun-Actor-Id':actor.id}
            response=client.get(url,headers=headers)
            assert response.status_code==200,response.text
            preview=response.json()
            body={'command_id':'delivery-http','digest':'wrong','expected_version':preview['expected_version']}
            assert client.post(url,headers=headers,json=body).status_code==409
            body['digest']=preview['digest']
            delivered=client.post(url,headers=headers,json=body)
            assert delivered.status_code==200,delivered.text
            assert delivered.json()['status']=='completed'
            assert client.post(url,headers=headers,json=body).json()['artifact_id']==delivered.json()['artifact_id']
            assert len(calls)==1
    finally:reset_context_for_tests(None)
