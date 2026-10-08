import hashlib
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from homun.application import agent_runs,work_outputs,workspace_files
from homun.application.agent_run_execution import advance
from homun.models.native_turn import NativeMessage,ToolCall


def start(s):
    ctx,actor,work,_=s;ctx.models.set_active('openai_compatible')
    p=agent_runs.propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[],'terminal_image':'sha256:'+'a'*64})
    agent_runs.approve(ctx,actor,work,p['id'],{'command_id':'go','digest':p['digest'],'expected_version':p['expected_version']})
    run=ctx.repository.load().commands[p['id']].result
    root=workspace_files.root_for(ctx,run);data=b'actual output\n';(root/'result.txt').write_bytes(data)
    return p,root,data


def model(ctx,name,args,call_id='file1'):
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id=call_id,name=name,arguments=args)]),usage=None)


def test_delivered_file_survives_workspace_change_and_recovery(setup):
    from homun.application.material_ingest import recover_materials
    ctx,actor,work,_=setup;p,root,data=start(setup)
    model(ctx,'deliver_workspace_file',{'path':'result.txt','sha256':hashlib.sha256(data).hexdigest()})
    assert advance(ctx,p['id'])=='running'
    output=work_outputs.list_for_work(ctx,actor,work)['items'][0]
    (root/'result.txt').write_text('changed')
    recover_materials(ctx)
    metadata,actual=work_outputs.download(ctx,actor,work,output['id'])
    assert actual==data and metadata['review_status']=='unreviewed'
    assert '_storage_relpath' not in metadata


def test_native_read_and_list_use_relative_paths(setup):
    ctx,actor,work,_=setup;p,root,data=start(setup)
    model(ctx,'list_workspace_files',{})
    assert advance(ctx,p['id'])=='running'
    assert ctx.repository.load().commands[p['id']].result['observations'][-1]['result']['items'][0]['name']=='result.txt'
    model(ctx,'read_workspace_file',{'path':'result.txt','offset':0,'limit':6},'read')
    assert advance(ctx,p['id'])=='running'
    result=ctx.repository.load().commands[p['id']].result['observations'][-1]['result']
    assert result['text']=='actual' and result['next_offset']==6 and result['sha256']==hashlib.sha256(data).hexdigest()


def test_changed_file_is_recoverable_tool_error_without_delivery(setup):
    ctx,actor,work,_=setup;p,root,data=start(setup)
    model(ctx,'deliver_workspace_file',{'path':'result.txt','sha256':'a'*64})
    assert advance(ctx,p['id'])=='running'
    result=ctx.repository.load().commands[p['id']].result['observations'][-1]['result']
    assert result['error_code']=='workspace_file_changed' and not work_outputs.list_for_work(ctx,actor,work)['items']


def test_authenticated_download_is_attachment_and_integrity_checked(setup,monkeypatch):
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.routes import price_comparisons
    ctx,actor,work,_=setup;p,root,data=start(setup)
    model(ctx,'deliver_workspace_file',{'path':'result.txt','sha256':hashlib.sha256(data).hexdigest()});advance(ctx,p['id'])
    output=work_outputs.list_for_work(ctx,actor,work)['items'][0]
    monkeypatch.setattr(price_comparisons,'get_context',lambda:ctx)
    client=TestClient(create_app(session_token='a'*32,session_actor_id=actor.id))
    url=f'/v1/workspaces/{ctx.workspace_id}/works/{work}/outputs/{output["id"]}/download'
    assert client.get(url).status_code==401
    response=client.get(url,headers={'Authorization':'Bearer '+'a'*32})
    assert response.status_code==200 and response.content==data
    assert response.headers['content-disposition'].startswith('attachment;') and response.headers['x-content-type-options']=='nosniff'
    blob=ctx.repository.load().commands[output['id']].result['_storage_relpath'];(ctx.data_dir/blob).write_bytes(b'corrupt')
    assert client.get(url,headers={'Authorization':'Bearer '+'a'*32}).status_code==409


def test_crash_after_blob_receipt_replays_same_snapshot(setup,monkeypatch):
    from homun.application import agent_native
    ctx,actor,work,_=setup;p,root,data=start(setup)
    model(ctx,'deliver_workspace_file',{'path':'result.txt','sha256':hashlib.sha256(data).hexdigest()})
    original=agent_native.append_result
    def crash(*a,**k):raise SystemExit('crash before canonical result')
    monkeypatch.setattr(agent_native,'append_result',crash)
    with pytest.raises(SystemExit):advance(ctx,p['id'])
    output=work_outputs.list_for_work(ctx,actor,work)['items'][0]
    (root/'result.txt').write_text('changed after snapshot')
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['_lease_until']='2000-01-01T00:00:00+00:00'
    monkeypatch.setattr(agent_native,'append_result',original)
    ctx.models.complete_tools=lambda *a,**k:pytest.fail('Model should not regenerate pending tool')
    assert advance(ctx,p['id'])=='running'
    assert len(work_outputs.list_for_work(ctx,actor,work)['items'])==1
    assert work_outputs.download(ctx,actor,work,output['id'])[1]==data


def test_binary_file_returns_hash_without_fake_text(setup):
    ctx,actor,work,_=setup;p,root,data=start(setup);binary=b'\x00\xff\x80';(root/'binary.dat').write_bytes(binary)
    model(ctx,'read_workspace_file',{'path':'binary.dat'})
    assert advance(ctx,p['id'])=='running'
    result=ctx.repository.load().commands[p['id']].result['observations'][-1]['result']
    assert result['binary'] and 'text' not in result and result['sha256']==hashlib.sha256(binary).hexdigest()


def test_revocation_after_snapshot_read_prevents_publication(setup,monkeypatch):
    from homun.domain.errors import PermissionDeniedError
    ctx,actor,work,_=setup;p,root,data=start(setup)
    model(ctx,'deliver_workspace_file',{'path':'result.txt','sha256':hashlib.sha256(data).hexdigest()})
    original=workspace_files.WorkspaceFiles.read
    def revoke(*a,**k):
        value=original(*a,**k)
        def denied(*a,**k):raise PermissionDeniedError('revoked')
        monkeypatch.setattr(workspace_files,'authority',denied)
        return value
    monkeypatch.setattr(workspace_files.WorkspaceFiles,'read',revoke)
    assert advance(ctx,p['id'])=='blocked'
    assert not work_outputs.list_for_work(ctx,actor,work)['items']
