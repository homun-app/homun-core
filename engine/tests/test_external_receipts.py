"""External effects survive publication failures without being redispatched."""
import pytest
from homun.context import create_context
from homun.domain.models import Actor, ExternalServer
from homun.domain.errors import ConflictError
from homun.application import external_tools, mcp_client

@pytest.fixture
def setup(tmp_path, monkeypatch):
    ctx=create_context(db_path=tmp_path/'ws.db', data_dir=tmp_path, for_tests=True)
    actor=Actor(id='person_a',workspace_id=ctx.workspace_id,display_name='A')
    c=ctx.service.apply(actor,'c','conversation.create',{'title':'T'})
    w=ctx.service.apply(actor,'w','work.create',{'conversation_id':c['conversation_id'],'title':'T','objective':'O'})
    ctx.persist()
    with ctx.repository.transaction() as store:
        store.external_servers['srv']=ExternalServer(id='srv',workspace_id=ctx.workspace_id,name='S',command='fixture')
    ctx.service.store=store
    calls=[]
    def call(*args):calls.append(args);return {'text':'done','is_error':False,'structured_content':{'count':1}}
    monkeypatch.setattr(mcp_client,'call_tool',call)
    body={'command_id':'p','work_id':w['work_id'],'server_id':'srv','tool':'write','arguments':{'x':1}}
    p=external_tools.propose(ctx,actor,body)
    return ctx,actor,body,p,calls

def approve(s):
    ctx,actor,body,p,calls=s
    return external_tools.approve(ctx,actor,p['id'],{'digest':p['digest'],'command_id':'approve'})

def test_repeat_approval_returns_receipt_without_io(setup):
    first=approve(setup)
    assert first['status']=='completed'
    assert approve(setup)['artifact_id']==first['artifact_id']
    assert len(setup[-1])==1

def test_changed_server_blocks_before_io(setup):
    ctx,actor,body,p,calls=setup
    with ctx.repository.transaction() as store:store.external_servers['srv'].command='different'
    with pytest.raises(ConflictError):approve(setup)
    assert calls==[]

def test_command_collision_and_changed_arguments_rejected(setup):
    ctx,actor,body,p,calls=setup
    with pytest.raises(ConflictError):external_tools.propose(ctx,actor,{**body,'command_id':'w'})
    with pytest.raises(ConflictError):external_tools.propose(ctx,actor,{**body,'arguments':{'x':2}})
    assert ctx.repository.load().commands['w'].type=='work.create'

def test_transport_failure_is_unknown_and_not_retried(setup,monkeypatch):
    def failure(*args):raise RuntimeError('private endpoint secret')
    monkeypatch.setattr(mcp_client,'call_tool',failure)
    result=approve(setup)
    assert result['status']=='outcome_unknown'
    assert 'private endpoint secret' not in str(result)
    monkeypatch.setattr(mcp_client,'call_tool',lambda *a:pytest.fail('redispatched'))
    assert approve(setup)['status']=='outcome_unknown'

def test_receipt_survives_publication_failure(setup,monkeypatch):
    from homun.application import external_publication
    original=external_publication.publish
    monkeypatch.setattr(external_publication,'publish',lambda *a:(_ for _ in ()).throw(RuntimeError('publication unavailable')))
    result=approve(setup)
    assert result['status']=='publication_pending'
    ctx=setup[0]
    assert ctx.repository.load().commands['p'].result['_receipt']['structured_content']=={'count':1}
    monkeypatch.setattr(external_publication,'publish',original)
    assert approve(setup)['status']=='completed'
    assert len(setup[-1])==1

def test_expired_inflight_is_unknown_not_resent(setup):
    ctx=setup[0]
    with ctx.repository.transaction() as store:
        store.commands['p'].result.update(status='running',_dispatch_deadline='2000-01-01T00:00:00+00:00')
    assert approve(setup)['status']=='outcome_unknown'
    assert setup[-1]==[]

def test_crash_after_dispatch_persists_intent_without_catching_process_exit(setup,monkeypatch):
    ctx,actor,body,p,calls=setup
    def crash(*args):raise SystemExit('process stopped')
    monkeypatch.setattr(mcp_client,'call_tool',crash)
    with pytest.raises(SystemExit):approve(setup)
    assert ctx.repository.load().commands['p'].result['status']=='running'
    assert approve(setup)['status']=='running'


def test_publication_rechecks_work_version_and_keeps_receipt(setup,monkeypatch):
    ctx,actor,body,p,calls=setup
    def changed_work(*args):
        with ctx.repository.transaction() as store:store.works[body['work_id']].version+=1
        return {'text':'done','is_error':False}
    monkeypatch.setattr(mcp_client,'call_tool',changed_work)
    assert approve(setup)['status']=='publication_pending'
    assert not ctx.repository.load().artifacts


def test_tool_error_receipt_is_not_redispatched(setup,monkeypatch):
    monkeypatch.setattr(mcp_client,'call_tool',lambda *a:{'text':'failed','is_error':True})
    assert approve(setup)['status']=='tool_error'
    monkeypatch.setattr(mcp_client,'call_tool',lambda *a:pytest.fail('redispatched'))
    assert approve(setup)['status']=='tool_error'

@pytest.mark.parametrize('changed_work', [False, True])
def test_real_stdio_receipt_survives_context_restart(tmp_path,monkeypatch,changed_work):
    import json
    import sys
    from homun.application import external_publication
    counter=tmp_path/'effects.json'
    script=tmp_path/'server.py'
    script.write_text('''import json,sys
from pathlib import Path
counter=Path(sys.argv[1])
for line in sys.stdin:
    req=json.loads(line)
    if 'id' not in req: continue
    method=req['method']
    if method=='initialize':
        result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'effects','version':'1'}}
    elif method=='tools/list':
        result={'tools':[{'name':'write','inputSchema':{'type':'object'}}]}
    elif method=='tools/call':
        count=json.loads(counter.read_text()) if counter.exists() else 0
        counter.write_text(json.dumps(count+1))
        result={'content':[{'type':'text','text':'effect saved'}],'structuredContent':{'count':count+1}}
    else: continue
    print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
''')
    path=tmp_path/'real.db'
    ctx=create_context(db_path=path,data_dir=tmp_path,for_tests=True)
    actor=Actor(id='person_a',workspace_id=ctx.workspace_id,display_name='A')
    conv=ctx.service.apply(actor,'c','conversation.create',{'title':'T'})
    work=ctx.service.apply(actor,'w','work.create',{'conversation_id':conv['conversation_id'],'title':'T','objective':'O'})
    ctx.persist()
    with ctx.repository.transaction() as store:
        store.external_servers['srv']=ExternalServer(id='srv',workspace_id=ctx.workspace_id,name='fixture',command=sys.executable,args=[str(script),str(counter)])
    ctx.service.store=store
    p=external_tools.propose(ctx,actor,{'command_id':'p','work_id':work['work_id'],'server_id':'srv','tool':'write','arguments':{}})
    original=external_publication.publish
    monkeypatch.setattr(external_publication,'publish',lambda *a:(_ for _ in ()).throw(RuntimeError('offline publication')))
    assert external_tools.approve(ctx,actor,'p',{'digest':p['digest']})['status']=='publication_pending'
    assert json.loads(counter.read_text())==1
    restarted=create_context(db_path=path,data_dir=tmp_path,for_tests=True)
    monkeypatch.setattr(external_publication,'publish',original)
    if changed_work:
        from homun.application import external_delivery
        with restarted.repository.transaction() as store:
            store.works[work['work_id']].version+=1
            store.external_servers.pop('srv')
        preview=external_delivery.preview(restarted,actor,'p')
        outcome=external_delivery.deliver(restarted,actor,'p',{'command_id':'delivery',
            'digest':preview['digest'],'expected_version':preview['expected_version']})
    else:
        outcome=external_tools.approve(restarted,actor,'p',{'digest':p['digest']})
    assert outcome['status']=='completed'
    assert json.loads(counter.read_text())==1
    assert len(restarted.repository.load().artifacts)==1

@pytest.mark.parametrize('changed',['work','server'])
def test_new_proposal_supersedes_stale_unexecuted_approval(setup,changed):
    ctx,actor,body,p,calls=setup
    with ctx.repository.transaction() as store:
        if changed=='work':store.works[body['work_id']].version+=1
        else:store.external_servers['srv'].command='new configuration'
    new=external_tools.propose(ctx,actor,{**body,'command_id':'fresh'})
    assert new['id']=='fresh'
    assert ctx.repository.load().commands['p'].result['status']=='blocked'
    assert calls==[]
