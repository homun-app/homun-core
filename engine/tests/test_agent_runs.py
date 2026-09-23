"""An adaptive run observes real tools, resumes and publishes exactly once."""
import json
from types import SimpleNamespace
import pytest
from homun.context import create_context
from homun.domain.models import Actor
from homun.application.material_ingest import ingest_file
from homun.domain.errors import ConflictError


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path/'ws.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_a', workspace_id=ctx.workspace_id, display_name='A')
    project = ctx.service.apply(actor,'p','project.create',{'name':'Progetto'})['project_id']
    conv = ctx.service.apply(actor,'c','conversation.create',{'title':'Scadenze','project_id':project})['conversation_id']
    work = ctx.service.apply(actor,'w','work.create',{'conversation_id':conv,'title':'Scadenze',
        'objective':'Trova la scadenza e prepara una nota'})['work_id']
    ctx.persist()
    material = ingest_file(ctx,actor,command_id='file',project_id=project,
        filename='accordo.txt',data=b'Consegna entro venerdi.')['material_id']
    yield ctx,actor,work,material
    ctx.close()


def start(ctx,actor,work,material):
    from homun.application.agent_runs import propose, approve
    p=propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[material]})
    approve(ctx,actor,work,p['id'],{'command_id':'approve','digest':p['digest'],'expected_version':p['expected_version']})
    return p


def scripted(ctx,decisions,seen):
    def complete(messages,**kw):
        seen.append(json.loads(messages[1].content))
        return SimpleNamespace(text=json.dumps(decisions[len(seen)-1]))
    ctx.models.complete=complete


def test_adapts_to_read_result_and_survives_reload(setup):
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    p=start(ctx,actor,work,material)
    seen=[]
    scripted(ctx,[{'kind':'tool','tool':'read_material','arguments':{'material_id':material},'message':'Leggo'},
                  {'kind':'finish','message':'# Scadenza\nLa consegna è venerdi (accordo.txt).'}],seen)
    assert advance(ctx,p['id']) == 'running'
    # Durable source state, rather than in-memory model conversation, owns the observation.
    snapshot=ctx.repository.load().commands[p['id']].result
    assert snapshot['observations'][0]['result']['text']=='Consegna entro venerdi.'
    ctx.service=ctx.service.for_store(ctx.repository.load())
    assert advance(ctx,p['id']) == 'completed'
    assert seen[1]['observations'][0]['result']['text']=='Consegna entro venerdi.'
    assert json.loads(seen[0]['objective'])['available_materials'][0]['id'] == material
    assert advance(ctx,p['id']) == 'completed'
    store=ctx.repository.load()
    assert len(store.artifacts)==1
    assert store.works[work].status=='review'
    assert not store.agents
    assert len(seen)==2


def test_ask_waits_for_authorized_contribution_then_resumes(setup):
    from homun.application.agent_run_execution import advance
    from homun.application.agent_runs import resume_waiting
    ctx,actor,work,material=setup
    p=start(ctx,actor,work,material);seen=[]
    scripted(ctx,[{'kind':'ask','message':'A chi è destinata la nota?'},
                  {'kind':'finish','message':'# Nota per Marta'}],seen)
    assert advance(ctx,p['id'])=='waiting_input'
    store=ctx.repository.load();run=store.commands[p['id']].result
    request=store.contributions[run['request_id']]
    ctx.service=ctx.service.for_store(store)
    ctx.service.apply(actor,'reply','work.provide_contribution',{'request_id':request.id,
        'text':'Marta','expected_version':store.works[work].version})
    ctx.persist()
    assert resume_waiting(ctx,p['id'])
    assert advance(ctx,p['id'])=='completed'
    assert seen[1]['observations'][-1]['result']['text']=='Marta'


def test_changed_source_blocks_and_no_artifact(setup):
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    p=start(ctx,actor,work,material)
    with ctx.repository.transaction() as store:store.materials[material].version+=1
    assert advance(ctx,p['id'])=='blocked'
    assert not ctx.repository.load().artifacts


def test_pause_fences_inflight_model_result(setup):
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    p=start(ctx,actor,work,material)
    def complete(*a,**k):
        store=ctx.repository.load();ctx.service=ctx.service.for_store(store)
        ctx.service.apply(actor,'pause','work.pause',{'work_id':work,'expected_version':store.works[work].version})
        ctx.persist()
        return SimpleNamespace(text=json.dumps({'kind':'finish','message':'Late result'}))
    ctx.models.complete=complete
    assert advance(ctx,p['id'])=='blocked'
    assert ctx.repository.load().works[work].status=='paused'
    assert not ctx.repository.load().artifacts


def test_budget_and_max_steps_stop_loop(setup):
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    p=start(ctx,actor,work,material);seen=[]
    scripted(ctx,[{'kind':'tool','tool':'list_materials','arguments':{},'message':'Elenco'}]*12,seen)
    for _ in range(10):status=advance(ctx,p['id'])
    assert status=='failed'
    assert len(seen)==8
    assert not ctx.repository.load().artifacts


def test_resume_after_process_context_restart_uses_saved_observation(setup):
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    p=start(ctx,actor,work,material);seen=[]
    scripted(ctx,[{'kind':'tool','tool':'read_material','arguments':{'material_id':material},'message':'Leggo'}],seen)
    assert advance(ctx,p['id'])=='running'
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    try:
        recovered=[]
        scripted(second,[{'kind':'finish','message':'Consegna venerdi'}],recovered)
        assert advance(second,p['id'])=='completed'
        assert recovered[0]['observations'][0]['result']['text']=='Consegna entro venerdi.'
        assert len(second.repository.load().artifacts)==1
    finally:second.close()


def test_wrong_approval_and_concurrent_turn_are_rejected(setup):
    from homun.application.agent_runs import propose,approve
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    p=propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[material]})
    with pytest.raises(ConflictError):
        approve(ctx,actor,work,p['id'],{'command_id':'bad','digest':'wrong','expected_version':p['expected_version']})
    approve(ctx,actor,work,p['id'],{'command_id':'ok','digest':p['digest'],'expected_version':p['expected_version']})
    nested=[]
    def complete(*a,**k):
        nested.append(advance(ctx,p['id']))
        return SimpleNamespace(text=json.dumps({'kind':'finish','message':'Risultato'}))
    ctx.models.complete=complete
    assert advance(ctx,p['id'])=='completed'
    assert nested==['busy']


def test_http_runtime_delivers_adaptive_run(setup):
    import time
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.context import reset_context_for_tests
    ctx,actor,work,material=setup
    seen=[]
    scripted(ctx,[{'kind':'tool','tool':'read_material','arguments':{'material_id':material},'message':'Leggo'},
                  {'kind':'finish','message':'# Risultato\nConsegna venerdi'}],seen)
    reset_context_for_tests(ctx)
    try:
        with TestClient(create_app()) as client:
            url=f'/v1/workspaces/{ctx.workspace_id}/works/{work}/agent-runs'
            headers={'X-Homun-Actor-Id':actor.id}
            response=client.post(url,headers=headers,json={'command_id':'http-run','expected_version':1,'material_ids':[material]})
            assert response.status_code==200,response.text
            p=response.json()
            response=client.post(url+'/http-run/approve',headers=headers,json={
                'command_id':'http-approve','digest':p['digest'],'expected_version':p['expected_version']})
            assert response.status_code==200,response.text
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                view=client.get(url,headers=headers).json()['items'][0]
                if view['status'] in {'completed','failed','blocked'}:break
                time.sleep(.05)
            assert view['status']=='completed',view
            assert len(seen)==2
    finally:reset_context_for_tests(None)


def test_stale_pending_scope_can_be_replaced_and_history_read(setup):
    from homun.application.agent_runs import propose,list_runs
    ctx,actor,work,material=setup
    p=propose(ctx,actor,work,{'command_id':'old','expected_version':1,'material_ids':[material]})
    with ctx.repository.transaction() as store:store.materials[material].version+=1
    new=propose(ctx,actor,work,{'command_id':'new','expected_version':p['expected_version'],'material_ids':[material]})
    assert new['status']=='pending_approval'
    history=list_runs(ctx,actor,work)['items']
    assert history[0]['status']=='blocked'
    assert history[-1]['id']=='new'


def test_adaptive_phase_honors_assignee_and_order(setup):
    from homun.application.agent_runs import propose
    ctx,actor,work,material=setup
    store=ctx.repository.load();ctx.service=ctx.service.for_store(store)
    agent=ctx.service.apply(actor,'ada','agent.create',{'name':'Ada','role':'Analista','instructions':'Verifica le fonti','preferred_connection_id':'fake'})['agent_id']
    plan=ctx.service.apply(actor,'plan','plan.propose',{'work_id':work,'expected_version':1,'steps':[
        {'id':'phase','title':'Analizza','capability':'agent_run','assignee_id':agent,'output_expected':'Nota'}]})
    ctx.service.apply(actor,'accept','plan.accept',{'work_id':work,'expected_version':plan['version']})
    ctx.persist()
    version=ctx.repository.load().works[work].version
    p=propose(ctx,actor,work,{'command_id':'run','expected_version':version,'material_ids':[material]})
    assert p['assignee_id']==agent
    assert p['executor_name']=='Ada'


def test_cannot_start_adaptive_phase_ahead_of_pending_human_phase(setup):
    from homun.application.agent_runs import propose
    ctx,actor,work,material=setup
    store=ctx.repository.load();ctx.service=ctx.service.for_store(store)
    plan=ctx.service.apply(actor,'plan','plan.propose',{'work_id':work,'expected_version':1,'steps':[
        {'id':'human','title':'Raccogli','capability':'general','assignee_id':actor.id,'output_expected':'Input'},
        {'id':'agent','title':'Analizza','capability':'agent_run','assignee_id':actor.id,'depends_on':['human'],'output_expected':'Nota'}]})
    ctx.service.apply(actor,'accept','plan.accept',{'work_id':work,'expected_version':plan['version']})
    ctx.persist()
    with pytest.raises(ConflictError):
        propose(ctx,actor,work,{'command_id':'run','expected_version':ctx.repository.load().works[work].version,'material_ids':[material]})


def test_request_changes_allows_new_scoped_delivery(setup):
    from homun.application.agent_runs import propose,approve
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    p=start(ctx,actor,work,material);seen=[]
    scripted(ctx,[{'kind':'finish','message':'Prima bozza'}, {'kind':'finish','message':'Bozza corretta'}],seen)
    assert advance(ctx,p['id'])=='completed'
    store=ctx.repository.load();ctx.service=ctx.service.for_store(store)
    artifact=next(iter(store.artifacts.values()))
    ctx.service.apply(actor,'review','work.review',{'work_id':work,'expected_version':store.works[work].version,
        'artifact_version_id':artifact.id,'decision':'request_changes','comment':'Aggiungi dettaglio'})
    ctx.persist()
    new=propose(ctx,actor,work,{'command_id':'revision','expected_version':ctx.repository.load().works[work].version,'material_ids':[material]})
    approve(ctx,actor,work,new['id'],{'command_id':'rev-go','digest':new['digest'],'expected_version':new['expected_version']})
    assert advance(ctx,new['id'])=='completed'
    assert len(ctx.repository.load().artifacts)==2
    objective=json.loads(seen[-1]['objective'])
    assert objective['revision']['comment']=='Aggiungi dettaglio'
    assert 'Prima bozza' in objective['revision']['previous_content']


def test_clarification_does_not_start_or_complete_the_following_phase(setup):
    from homun.application.agent_runs import propose,approve,resume_waiting
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    store=ctx.repository.load();ctx.service=ctx.service.for_store(store)
    plan=ctx.service.apply(actor,'plan','plan.propose',{'work_id':work,'expected_version':1,'steps':[
        {'id':'agent','title':'Indaga','capability':'agent_run','assignee_id':actor.id,'output_expected':'Risultato'},
        {'id':'later','title':'Sintetizza','capability':'synthesize','assignee_id':actor.id,'depends_on':['agent'],'output_expected':'Nota'}]})
    ctx.service.apply(actor,'accept','plan.accept',{'work_id':work,'expected_version':plan['version']})
    ctx.persist()
    p=propose(ctx,actor,work,{'command_id':'run','expected_version':ctx.repository.load().works[work].version,'material_ids':[material]})
    approve(ctx,actor,work,p['id'],{'command_id':'approve','digest':p['digest'],'expected_version':p['expected_version']})
    seen=[];scripted(ctx,[{'kind':'ask','message':'Destinatario?'},{'kind':'finish','message':'Nota'}],seen)
    assert advance(ctx,p['id'])=='waiting_input'
    store=ctx.repository.load();ctx.service=ctx.service.for_store(store)
    ctx.service.apply(actor,'reply','work.provide_contribution',{'request_id':store.commands[p['id']].result['request_id'],
        'text':'Marta','expected_version':store.works[work].version})
    ctx.persist();resume_waiting(ctx,p['id'])
    assert advance(ctx,p['id'])=='completed'
    store=ctx.repository.load();work_obj=store.works[work]
    phases=store.plans[store.plan_key(work,work_obj.current_plan_revision)].steps
    assert phases[0].status=='succeeded'
    assert phases[1].status=='pending'


def test_provider_failure_can_be_retried_with_fresh_approval(setup):
    from homun.application.agent_runs import propose,approve
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    p=start(ctx,actor,work,material)
    def broken(*a,**k):raise RuntimeError('down')
    ctx.models.complete=broken
    assert advance(ctx,p['id'])=='failed'
    new=propose(ctx,actor,work,{'command_id':'retry','expected_version':ctx.repository.load().works[work].version,'material_ids':[material]})
    assert new['status']=='pending_approval'
    approve(ctx,actor,work,new['id'],{'command_id':'retry-go','digest':new['digest'],'expected_version':new['expected_version']})
    scripted(ctx,[{'kind':'finish','message':'Risultato'}],[])
    assert advance(ctx,new['id'])=='completed'


def test_selected_team_coordinates_a_real_model_contribution(setup):
    from homun.application.agent_runs import propose,approve
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    store=ctx.repository.load();ctx.service=ctx.service.for_store(store)
    coordinator=ctx.service.apply(actor,'lead','agent.create',{'name':'Marta','role':'Coordinatrice','instructions':'Coordina le verifiche'})['agent_id']
    analyst=ctx.service.apply(actor,'analyst','agent.create',{'name':'Ada','role':'Analista','instructions':'Verifica scadenze','preferred_connection_id':'fake'})['agent_id']
    team=ctx.service.apply(actor,'team','team.create',{'name':'Ufficio','member_ids':[coordinator,analyst],'coordinator_id':coordinator})['team_id'];ctx.persist()
    p=propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[material],'team_id':team})
    assert p['executor_name']=='Marta'
    approve(ctx,actor,work,p['id'],{'command_id':'approve','digest':p['digest'],'expected_version':p['expected_version']})
    coordinator_calls=[];delegated=[]
    def complete(messages,**kwargs):
        if 'delegated_task' in messages[0].content:
            delegated.append((messages,kwargs))
            return SimpleNamespace(text='Occorre confermare il destinatario.',model_id='fake-model')
        payload=json.loads(messages[1].content);coordinator_calls.append(payload)
        if len(coordinator_calls)==1:
            return SimpleNamespace(text=json.dumps({'kind':'tool','tool':'consult_collaborator',
                'arguments':{'agent_id':analyst,'task':'Valuta quali informazioni mancano'},'message':'Chiedo una verifica ad Ada'}))
        return SimpleNamespace(text=json.dumps({'kind':'finish','message':'Serve confermare il destinatario.'}))
    ctx.models.complete=complete
    assert advance(ctx,p['id'])=='running'
    assert advance(ctx,p['id'])=='completed'
    assert len(delegated)==1 and delegated[0][1]['connection_id']=='fake'
    assert coordinator_calls[1]['observations'][0]['result']['agent_name']=='Ada'
    assert ctx.repository.load().commands[p['id']].result['model_attempts']==3


def test_modified_teammate_invalidates_approved_scope(setup):
    from homun.application.agent_runs import propose,approve
    from homun.application.agent_run_execution import advance
    ctx,actor,work,material=setup
    store=ctx.repository.load();ctx.service=ctx.service.for_store(store)
    member=ctx.service.apply(actor,'m','agent.create',{'name':'Ada','role':'Analista','instructions':'Verifica'})['agent_id']
    team=ctx.service.apply(actor,'t','team.create',{'name':'Team','member_ids':[member]})['team_id'];ctx.persist()
    p=propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[material],'team_id':team})
    approve(ctx,actor,work,p['id'],{'command_id':'go','digest':p['digest'],'expected_version':p['expected_version']})
    store=ctx.repository.load();ctx.service=ctx.service.for_store(store)
    ctx.service.apply(actor,'change','agent.update',{'agent_id':member,'expected_version':1,'instructions':'Cambia metodo'})
    ctx.persist()
    assert advance(ctx,p['id'])=='blocked'
    assert not ctx.repository.load().artifacts
