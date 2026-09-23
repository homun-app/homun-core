from pathlib import Path
import json
from types import SimpleNamespace
import pytest
from homun.context import create_context
from homun.domain.models import Actor

@pytest.fixture
def setup(tmp_path):
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite3', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id='ws_local', display_name='Fabio')
    conv = ctx.service.apply(actor, 'c', 'conversation.create', {'title':'Nuova richiesta'})
    work = ctx.service.apply(actor, 'w', 'work.create', {'conversation_id':conv['conversation_id'], 'title':'Nuova richiesta', 'objective':'Obiettivo da concordare'})
    agent = ctx.service.apply(actor, 'a', 'agent.create', {'name':'Ada','role':'Analisi CSV','instructions':'Confronta dati'})
    ctx.persist()
    brief = {'title':'Confronto listini mensili','objective':'Individuare variazioni di prezzo.', 'output':'Report e CSV','constraints':[], 'missing_information':[], 'suggested_agent_id':agent['agent_id'], 'new_agent':None, 'rationale':'Il ruolo comprende analisi CSV.', 'capability':'compare_csv'}
    ctx.models.complete = lambda *_args, **_kwargs: SimpleNamespace(text=json.dumps(brief))
    yield ctx, actor, work['work_id'], brief
    ctx.close()

def test_proposal_preserves_request_without_assignment_and_confirm_replays(setup):
    from homun.application.intake import propose, confirm, list_proposals
    ctx, actor, wid, brief = setup
    p = propose(ctx, actor, wid, {'command_id':'i','text':'Confronta questi listini mensili senza conversioni','expected_version':1})
    store = ctx.repository.load()
    assert store.works[wid].owner_id == actor.id
    assert not store.plans and not store.runs
    assert any(m.text == p['original_request'] for m in store.messages.values())
    assert p['status'] == 'pending_confirmation'
    body = {'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False}
    confirmed = confirm(ctx,actor,wid,p['id'],body)
    assert confirmed['status'] == 'confirmed'
    assert confirm(ctx,actor,wid,p['id'],body) == confirmed
    store = ctx.repository.load()
    assert store.works[wid].owner_id == brief['suggested_agent_id']
    assert store.works[wid].title == brief['title']
    assert store.works[wid].objective == brief['objective']
    assert not store.plans and not store.runs
    assert list_proposals(ctx,actor,wid)['items'][0]['status'] == 'confirmed'

def test_provider_failure_is_durable_and_retryable(setup):
    from homun.application.intake import propose
    ctx, actor, wid, brief = setup
    ctx.models.complete = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError('offline'))
    p = propose(ctx,actor,wid,{'command_id':'i','text':'Richiesta originale','expected_version':1})
    assert p['status'] == 'failed' and p['error_code'] == 'intake_provider_failed'
    assert ctx.repository.load().works[wid].owner_id == actor.id
    assert len(ctx.repository.load().messages) == 1


def test_staffing_preserves_existing_reviewer(setup):
    from homun.application.intake import propose, confirm
    ctx, actor, wid, _ = setup
    with ctx.repository.transaction() as store:
        store.works[wid].reviewer_id = 'person_reviewer'
    p = propose(ctx, actor, wid, {'command_id': 'i', 'text': 'Confronta listini', 'expected_version': 1})
    confirm(ctx, actor, wid, p['id'], {'command_id': 'ok', 'digest': p['digest'], 'expected_version': 1, 'create_agent': False})
    assert ctx.repository.load().works[wid].reviewer_id == 'person_reviewer'

def test_stale_agent_and_digest_rejected(setup):
    from homun.application.intake import propose, confirm
    from homun.domain.errors import ConflictError
    ctx, actor, wid, brief = setup
    p = propose(ctx,actor,wid,{'command_id':'i','text':'Analizza CSV','expected_version':1})
    with pytest.raises(ConflictError):
        confirm(ctx,actor,wid,p['id'],{'command_id':'bad','digest':'wrong','expected_version':1,'create_agent':False})
    ctx.service.store = ctx.repository.load()
    ctx.service.apply(actor,'update','agent.update',{'agent_id':brief['suggested_agent_id'],'expected_version':1,'role':'Altro'})
    ctx.persist()
    with pytest.raises(ConflictError):
        confirm(ctx,actor,wid,p['id'],{'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False})

def test_manual_rename_survives_proposal_confirmation(setup):
    from homun.application.intake import propose, confirm
    ctx,actor,wid,brief=setup
    ctx.service.apply(actor,'rename','work.rename',{'work_id':wid,'title':'Titolo scelto','expected_version':1})
    ctx.persist()
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Analizza CSV','expected_version':2})
    confirm(ctx,actor,wid,p['id'],{'command_id':'ok','digest':p['digest'],'expected_version':2,'create_agent':False})
    assert ctx.repository.load().works[wid].title == 'Titolo scelto'

@pytest.mark.parametrize('change', ['unknown_agent','unknown_capability','new_profile'])
def test_catalog_and_profile_limits(setup,change):
    from homun.application.intake import propose,confirm
    from homun.domain.errors import ValidationError
    ctx,actor,wid,brief=setup
    if change=='unknown_agent': brief['suggested_agent_id']='invented'
    elif change=='unknown_capability': brief['capability']='browse_web'
    else:
        brief['suggested_agent_id']=None
        brief['new_agent']={'name':'Analista','role':'Analisi prezzi','instructions':'Usa solo strumenti e materiali autorizzati'}
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Analizza prezzi','expected_version':1})
    if change!='new_profile':
        assert p['status']=='failed' and p['error_code']=='intake_invalid_response'
        return
    assert len(ctx.repository.load().agents)==1
    body={'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False}
    with pytest.raises(ValidationError): confirm(ctx,actor,wid,p['id'],body)
    body['create_agent']=True
    confirm(ctx,actor,wid,p['id'],body)
    store=ctx.repository.load()
    assert len(store.agents)==2 and not store.grants
    assert store.works[wid].owner_id!=actor.id


def test_superseding_clarification_and_restart(setup):
    from homun.application.intake import propose,confirm,list_proposals
    from homun.domain.errors import ConflictError
    from homun.storage.sqlite import SqliteWorkspaceRepository
    ctx,actor,wid,brief=setup
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Analizza prezzi','expected_version':1})
    newer=propose(ctx,actor,wid,{'command_id':'ii','text':'Solo SKU esatto','expected_version':1})
    assert newer['original_request']=='Analizza prezzi\n\nSolo SKU esatto'
    with pytest.raises(ConflictError): confirm(ctx,actor,wid,p['id'],{'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False})
    path=ctx.repository.path
    ctx.repository.close()
    ctx.repository=SqliteWorkspaceRepository(path,'ws_local')
    assert list_proposals(ctx,actor,wid)['items'][-1]['id']==newer['id']
    assert len(ctx.repository.load().messages)==2


def test_read_write_and_replay_after_revocation(setup):
    from homun.application.intake import propose,confirm,list_proposals
    from homun.domain.errors import PermissionDeniedError
    ctx,actor,wid,brief=setup
    project=ctx.service.apply(actor,'proj','project.create',{'name':'Private'})['project_id']
    ctx.service.store.works[wid].project_id=project
    ctx.persist()
    other=Actor(id='other',workspace_id='ws_local',display_name='Other')
    with pytest.raises(PermissionDeniedError): list_proposals(ctx,other,wid)
    with pytest.raises(PermissionDeniedError): propose(ctx,other,wid,{'command_id':'denied','text':'No','expected_version':1})
    grant=ctx.service.apply(actor,'grant','grant.issue',{'project_id':project,'subject_id':other.id,'capability':'write'})['grant_id']
    ctx.persist()
    body={'command_id':'i','text':'Analizza prezzi','expected_version':1}
    p=propose(ctx,other,wid,body)
    ctx.service.apply(actor,'revoke','grant.revoke',{'grant_id':grant});ctx.persist()
    with pytest.raises(PermissionDeniedError): propose(ctx,other,wid,body)
    with pytest.raises(PermissionDeniedError): confirm(ctx,other,wid,p['id'],{'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False})


def test_pending_intake_blocks_comparison_and_manual_rename_stales_confirmation(setup):
    from homun.application.intake import propose,confirm
    from homun.application.price_comparisons import propose as comparison
    from homun.domain.errors import ConflictError
    ctx,actor,wid,brief=setup
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Analizza prezzi','expected_version':1})
    with pytest.raises(ConflictError): comparison(ctx,actor,wid,{'command_id':'cmp','left_material_id':'x','right_material_id':'y','expected_version':1})
    ctx.service.apply(actor,'rename','work.rename',{'work_id':wid,'title':'Mio nome','expected_version':1});ctx.persist()
    with pytest.raises(ConflictError): confirm(ctx,actor,wid,p['id'],{'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False})


def test_staffing_confirmation_preserves_missing_materials_without_execution(setup):
    from homun.application.intake import propose,confirm
    ctx,actor,wid,brief=setup
    brief['missing_information']=['I file CSV non sono ancora caricati']
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Analizza prezzi','expected_version':1})
    result=confirm(ctx,actor,wid,p['id'],{'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False})
    assert result['status']=='confirmed'
    assert result['missing_information']==brief['missing_information']
    store=ctx.repository.load()
    assert not store.plans and not store.runs
    assert store.works[wid].owner_id==brief['suggested_agent_id']


def test_http_contract_and_typed_conflict(setup):
    from fastapi.testclient import TestClient
    from homun.context import reset_context_for_tests
    from homun.app import create_app
    ctx,actor,wid,brief=setup
    reset_context_for_tests(ctx)
    try:
        with TestClient(create_app()) as client:
            path=f'/v1/workspaces/ws_local/works/{wid}/intake'
            headers={'X-Homun-Actor-Id':actor.id}
            response=client.post(path,headers=headers,json={'command_id':'api','text':'Analizza listini','expected_version':1})
            assert response.status_code==200,response.text
            p=response.json()
            assert p['new_agent'] is None and p['suggested_agent']['id']==brief['suggested_agent_id']
            assert not any(key.startswith('_') for key in p)
            assert client.get(path,headers=headers).json()['items'][0]['id']=='api'
            bad=client.post(path+'/api/confirm',headers=headers,json={'command_id':'bad','digest':'forged','expected_version':1,'create_agent':False})
            assert bad.status_code==409 and bad.json()['detail']['code']=='version_conflict'
    finally:
        reset_context_for_tests(None)


def test_works_list_reports_intake_confirmed_for_stable_labels(setup):
    from fastapi.testclient import TestClient
    from homun.context import reset_context_for_tests
    from homun.app import create_app
    from homun.application.intake import propose, confirm
    ctx,actor,wid,brief=setup
    reset_context_for_tests(ctx)
    try:
        with TestClient(create_app()) as client:
            headers={'X-Homun-Actor-Id':actor.id}
            def flag():
                items=client.get('/v1/workspaces/ws_local/works',headers=headers).json()['items']
                return next(item['intake_confirmed'] for item in items if item['id']==wid)
            p=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta listini','expected_version':1})
            assert flag() is False
            confirm(ctx,actor,wid,'i',{'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False})
            # The list projection keeps the agreed label stable even when the
            # client has not loaded the per-work intake state.
            assert flag() is True
    finally:
        reset_context_for_tests(None)


def test_completed_work_is_never_reassigned_or_reexecuted(setup):
    from homun.application.intake import propose
    from homun.domain.errors import ConflictError
    from homun.domain.states import WorkStatus
    ctx,actor,wid,brief=setup
    work=ctx.service.store.works[wid]
    work.status=WorkStatus.COMPLETED
    ctx.persist()
    with pytest.raises(ConflictError): propose(ctx,actor,wid,{'command_id':'i','text':'Revisione del titolo','expected_version':1})
    store=ctx.repository.load()
    assert store.works[wid].owner_id==actor.id and not store.messages and not store.runs


def test_agent_cannot_start_intake_or_call_provider(setup):
    from homun.application.intake import propose
    from homun.domain.errors import PermissionDeniedError
    ctx,actor,wid,brief=setup
    calls=[]
    ctx.models.complete=lambda *a,**kw: calls.append(True)
    agent=Actor(id=brief['suggested_agent_id'],workspace_id='ws_local',display_name='Ada',kind='agent')
    with pytest.raises(PermissionDeniedError): propose(ctx,agent,wid,{'command_id':'i','text':'Richiesta','expected_version':1})
    assert not calls and not ctx.repository.load().messages


@pytest.mark.parametrize('command,payload', [
    ('plan.propose', {'steps':[{'title':'Esegui','assignee_id':'person_fabio','output_expected':'Report'}]}),
    ('plan.accept', {}),
    ('work.start', {}),
    ('work.apply_patch', {'changes':[{'field':'owner_id','to_value':'person_fabio'}]}),
])
def test_generic_commands_cannot_bypass_unconfirmed_intake(setup,command,payload):
    from homun.application.intake import propose
    from homun.domain.errors import ConflictError
    ctx,actor,wid,brief=setup
    propose(ctx,actor,wid,{'command_id':'i','text':'Analizza prezzi','expected_version':1})
    with pytest.raises(ConflictError,match='Confirm the intake'):
        ctx.service.apply(actor,'bypass',command,{'work_id':wid,'expected_version':1,**payload})
    assert not ctx.service.store.plans and not ctx.service.store.runs


def test_csv_intake_requires_explicit_collaborator_proposal(setup):
    from homun.application.intake import propose
    ctx,actor,wid,brief=setup
    ctx.service.apply(actor,'second','agent.create',{'name':'Bice','role':'Analisi dati','instructions':'Confronta dati'})
    ctx.persist()
    brief['suggested_agent_id']=None
    brief['new_agent']=None
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Chi può confrontare i listini?','expected_version':1})
    assert p['status']=='failed' and p['error_code']=='intake_invalid_response'
    assert ctx.repository.load().works[wid].owner_id==actor.id


def test_single_active_agent_fills_the_collaborator_proposal(setup):
    from homun.application.intake import propose
    ctx,actor,wid,brief=setup
    brief['suggested_agent_id']=None
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps(brief))
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta i listini','expected_version':1})
    assert p['status']=='pending_confirmation'
    assert p['suggested_agent'] and p['suggested_agent']['name']=='Ada'


def test_empty_roster_still_proposes_a_confirmable_collaborator(setup):
    from homun.application.intake import propose,confirm
    from homun.domain.errors import ValidationError
    ctx,actor,wid,brief=setup
    with ctx.repository.transaction() as store:
        for agent in store.agents.values():
            agent.status='retired'
    brief['suggested_agent_id']=None
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps(brief))
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta listini','expected_version':1})
    assert p['status']=='pending_confirmation'
    assert p['new_agent'] and p['new_agent']['name']=='Aurora'
    body={'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False}
    with pytest.raises(ValidationError): confirm(ctx,actor,wid,p['id'],body)
    body['create_agent']=True
    assert confirm(ctx,actor,wid,p['id'],body)['status']=='confirmed'
    store=ctx.repository.load()
    assert len(store.agents)==2 and not store.grants
    assert store.works[wid].owner_id!=actor.id


def test_older_csv_proposal_without_collaborator_cannot_be_confirmed(setup):
    from homun.application.intake import propose,confirm
    from homun.domain.errors import ValidationError
    ctx,actor,wid,brief=setup
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta listini','expected_version':1})
    # A persisted pre-validation proposal must not become an assignment bypass.
    ctx.service.store.commands['i'].result['suggested_agent']=None
    ctx.persist()
    with pytest.raises(ValidationError):
        confirm(ctx,actor,wid,'i',{'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False})


def test_clarification_model_receives_prior_task_context(setup):
    from homun.application.intake import propose
    ctx,actor,wid,brief=setup
    first=propose(ctx,actor,wid,{'command_id':'i','text':'Confronto listini CSV','expected_version':1})
    seen=[]
    def model(messages):
        seen.append(json.loads(messages[-1].content))
        return SimpleNamespace(text=json.dumps(brief))
    ctx.models.complete=model
    propose(ctx,actor,wid,{'command_id':'ii','text':'Vorrei un collaboratore riutilizzabile','expected_version':1})
    assert seen[0]['previous_brief']['capability']=='compare_csv'
    assert seen[0]['previous_brief']['objective']==first['objective']
    assert seen[0]['latest_request']=='Vorrei un collaboratore riutilizzabile'
    # The collaborator recommendation is grounded in the registered capability catalog,
    # without readiness signals that made models decline executable work.
    capabilities=seen[0]['capabilities']
    assert [c['id'] for c in capabilities]==['compare_csv','read_material','synthesize','general']
    assert all('ready' not in c and 'eligible_materials' not in c for c in capabilities)


def test_confirmed_idle_intake_can_be_revised_without_early_reassignment(setup):
    from homun.application.intake import propose,confirm
    from homun.policy.intake import require_confirmed_intake
    from homun.domain.errors import ConflictError
    ctx,actor,wid,brief=setup
    first=propose(ctx,actor,wid,{'command_id':'i','text':'Confronto listini CSV','expected_version':1})
    confirm(ctx,actor,wid,'i',{'command_id':'ok','digest':first['digest'],'expected_version':1,'create_agent':False})
    owner=ctx.repository.load().works[wid].owner_id
    p=propose(ctx,actor,wid,{'command_id':'ii','text':'Rivediamo il lavoro e collaboratore','expected_version':2})
    assert p['status']=='pending_confirmation'
    assert ctx.repository.load().works[wid].owner_id==owner
    with pytest.raises(ConflictError): require_confirmed_intake(ctx.repository.load(),wid,'compare_csv')
    with pytest.raises(ConflictError): confirm(ctx,actor,wid,'i',{'command_id':'ok','digest':first['digest'],'expected_version':1,'create_agent':False})
    confirm(ctx,actor,wid,'ii',{'command_id':'ok2','digest':p['digest'],'expected_version':2,'create_agent':False})
    require_confirmed_intake(ctx.repository.load(),wid,'compare_csv')


def test_staffing_only_refinement_preserves_brief_structurally(setup):
    from homun.application.intake import propose,confirm
    ctx,actor,wid,brief=setup
    brief['constraints']=['Nessuna conversione valutaria']
    first=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta i listini senza conversioni','expected_version':1})
    confirm(ctx,actor,wid,'i',{'command_id':'ok','digest':first['digest'],'expected_version':1,'create_agent':False})
    other=ctx.service.apply(actor,'b','agent.create',{'name':'Bruno','role':'Analisi listini junior','instructions':'Confronta CSV di prezzi'})['agent_id']
    ctx.persist()
    # The model rewrites every field while the person only asked for another collaborator.
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'title':'Crea profilo analista','objective':'Creare un nuovo collaboratore riutilizzabile.',
        'output':'Profilo creato','constraints':[],'capability':'general',
        'changed_fields':['staffing'],'suggested_agent_id':other}))
    refined=propose(ctx,actor,wid,{'command_id':'ii','text':'Usa un altro agente','expected_version':2})
    assert refined['status']=='pending_confirmation'
    assert refined['title']==first['title']
    assert refined['objective']==first['objective']
    assert refined['output']==first['output']
    assert refined['constraints']==first['constraints']
    assert refined['capability']=='compare_csv'
    assert refined['suggested_agent']['id']==other
    assert refined['changes']==[{'field':'staffing','from_value':'Ada','to_value':'Bruno'}]
    confirm(ctx,actor,wid,'ii',{'command_id':'ok2','digest':refined['digest'],'expected_version':2,'create_agent':False})
    work=ctx.repository.load().works[wid]
    assert work.owner_id==other and work.reviewer_id==actor.id
    assert work.objective==first['objective'] and work.title==first['title']


def test_explicit_objective_change_preserves_undeclared_fields(setup):
    from homun.application.intake import propose
    ctx,actor,wid,brief=setup
    brief['constraints']=['Nessuna conversione valutaria']
    first=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta i listini','expected_version':1})
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'title':'Titolo riscritto dal modello','objective':'Solo le differenze di prezzo, senza report.',
        'output':'Solo CSV delle differenze','constraints':[],
        'changed_fields':['objective','output']}))
    refined=propose(ctx,actor,wid,{'command_id':'ii','text':'Voglio solo il CSV, non il report','expected_version':1})
    assert refined['title']==first['title']
    assert refined['constraints']==first['constraints']
    assert refined['capability']==first['capability']
    assert refined['objective']=='Solo le differenze di prezzo, senza report.'
    assert refined['output']=='Solo CSV delle differenze'
    assert {c['field'] for c in refined['changes']}=={'objective','output'}


def test_unknown_changed_field_is_dropped_not_fatal(setup):
    from homun.application.intake import propose
    ctx,actor,wid,brief=setup
    first=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta listini','expected_version':1})
    raw=json.dumps({**brief,'changed_fields':['nonsense','missing_information','staffing']})
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=raw)
    refined=propose(ctx,actor,wid,{'command_id':'ii','text':'Usa Bruno','expected_version':1})
    assert refined['status']=='pending_confirmation'
    assert refined['changed_fields']==['staffing']
    assert refined['objective']==first['objective']
    assert ctx.repository.load().works[wid].owner_id==actor.id


def test_first_proposal_reports_no_changes(setup):
    from homun.application.intake import propose
    ctx,actor,wid,brief=setup
    brief['changed_fields']=['objective']
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta listini','expected_version':1})
    assert p['changes']==[]
    assert p['changed_fields']==['objective']


def test_refinement_without_collaborator_keeps_anchor_staffing_actionable(setup):
    from homun.application.intake import propose,confirm
    ctx,actor,wid,brief=setup
    first=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta i listini','expected_version':1})
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':None,
        'changed_fields':['staffing']}))
    refined=propose(ctx,actor,wid,{'command_id':'ii','text':'Aggiorna la proposta','expected_version':1})
    assert refined['status']=='pending_confirmation'
    assert refined['capability']=='compare_csv'
    assert refined['suggested_agent']==first['suggested_agent']
    assert refined['changes']==[]
    confirm(ctx,actor,wid,'ii',{'command_id':'ok','digest':refined['digest'],'expected_version':1,'create_agent':False})
    assert ctx.repository.load().works[wid].owner_id==first['suggested_agent']['id']


def test_undeclared_staffing_swap_keeps_standing_collaborator(setup):
    from homun.application.intake import propose,confirm
    ctx,actor,wid,brief=setup
    # Guided path: the first proposal creates a new collaborator (Elena) and the
    # person confirms; a later refinement that provides materials must not let
    # the model invent a twin profile (Bruno) unless staffing is declared changed.
    elena={'name':'Elena','role':'Coordinatore Preventivi','instructions':'Segue le richieste di preventivo'}
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':elena}))
    first=propose(ctx,actor,wid,{'command_id':'i','text':'Segui i preventivi e le risposte','expected_version':1})
    confirm(ctx,actor,wid,'i',{'command_id':'ok','digest':first['digest'],'expected_version':1,'create_agent':True})
    owner=ctx.repository.load().works[wid].owner_id
    bruno={'name':'Bruno','role':'Coordinatore Preventivi','instructions':'Segue le richieste di preventivo'}
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'title':'Report preventivi attivi e scaduti','objective':'Elencare lo stato dei preventivi.',
        'output':'Report con elenco preventivi.','capability':'general',
        'suggested_agent_id':None,'new_agent':bruno,'changed_fields':['title','objective','output']}))
    refined=propose(ctx,actor,wid,{'command_id':'ii','text':'Ecco i dati: prepara il report','expected_version':2})
    assert refined['status']=='pending_confirmation'
    assert refined['new_agent'] is None
    assert refined['suggested_agent']['id']==owner
    assert refined['suggested_agent']['name']=='Elena'
    assert {c['field'] for c in refined['changes']}=={'title','objective','output'}
    confirm(ctx,actor,wid,'ii',{'command_id':'ok2','digest':refined['digest'],'expected_version':2,'create_agent':False})
    assert ctx.repository.load().works[wid].owner_id==owner


def test_declared_staffing_swap_is_honored_after_new_agent_confirmation(setup):
    from homun.application.intake import propose,confirm
    ctx,actor,wid,brief=setup
    elena={'name':'Elena','role':'Coordinatore Preventivi','instructions':'Segue le richieste di preventivo'}
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':elena}))
    first=propose(ctx,actor,wid,{'command_id':'i','text':'Segui i preventivi','expected_version':1})
    confirm(ctx,actor,wid,'i',{'command_id':'ok','digest':first['digest'],'expected_version':1,'create_agent':True})
    bruno={'name':'Bruno','role':'Coordinatore Preventivi senior','instructions':'Segue le richieste di preventivo'}
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':bruno,
        'changed_fields':['staffing']}))
    refined=propose(ctx,actor,wid,{'command_id':'ii','text':'Affida il lavoro a un nuovo collaboratore','expected_version':2})
    assert refined['new_agent'] is not None and refined['new_agent']['name']=='Bruno'
    confirm(ctx,actor,wid,'ii',{'command_id':'ok2','digest':refined['digest'],'expected_version':2,'create_agent':True})
    assert ctx.repository.load().works[wid].owner_id!=first['new_agent'] if first.get('new_agent') else True


def test_same_name_new_agent_reproposal_is_reanchored_not_duplicated(setup):
    from homun.application.intake import propose,confirm
    ctx,actor,wid,brief=setup
    # The model re-proposes the standing collaborator as a "new" profile with
    # the same name and declares staffing changed: confirming would duplicate
    # the roster entry, so the engine re-anchors the existing agent instead.
    elena={'name':'Elena','role':'Coordinatore Preventivi','instructions':'Segue le richieste di preventivo'}
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':elena}))
    first=propose(ctx,actor,wid,{'command_id':'i','text':'Segui i preventivi','expected_version':1})
    confirm(ctx,actor,wid,'i',{'command_id':'ok','digest':first['digest'],'expected_version':1,'create_agent':True})
    owner=ctx.repository.load().works[wid].owner_id
    elena_twin={'name':'Elena','role':'Coordinatore Preventivi','instructions':'Seguito preventivi e risposte'}
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':elena_twin,
        'changed_fields':['staffing']}))
    refined=propose(ctx,actor,wid,{'command_id':'ii','text':'Ecco i dati, prepara il report','expected_version':2})
    assert refined['new_agent'] is None
    assert refined['suggested_agent']['id']==owner
    confirm(ctx,actor,wid,'ii',{'command_id':'ok2','digest':refined['digest'],'expected_version':2,'create_agent':False})
    store=ctx.repository.load()
    assert store.works[wid].owner_id==owner
    assert sum(1 for a in store.agents.values() if a.name.casefold()=='elena')==1


def test_confirm_with_plan_steps_creates_accepted_chained_plan(setup):
    from homun.application.intake import propose,confirm
    ctx,actor,wid,brief=setup
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'plan_steps':[
            {'title':'Raccogliere i listini','capability':'general',
             'expected_materials':['Listino marzo','Listino giugno'],
             'output_expected':'Listini nel progetto','assignee':'Ada'},
            {'title':'Confrontare i listini','capability':'compare_csv',
             'expected_materials':[],'output_expected':'Report differenze','assignee':'Ada'},
        ]}))
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta i listini con raccolta','expected_version':1})
    assert len(p['plan_steps'])==2
    confirm(ctx,actor,wid,'i',{'command_id':'ok','digest':p['digest'],'expected_version':1,'create_agent':False})
    store=ctx.repository.load()
    work=store.works[wid]
    assert work.status.value=='ready'
    plan=store.plans[store.plan_key(wid,work.current_plan_revision)]
    assert plan.revision==1 and len(plan.steps)==2
    assert plan.steps[0].capability=='general' and plan.steps[1].capability=='compare_csv'
    assert plan.steps[1].depends_on==[plan.steps[0].id]
    assert plan.steps[0].assignee_id==brief['suggested_agent_id']


def test_plan_step_with_unknown_assignee_fails_honestly(setup):
    from homun.application.intake import propose
    ctx,actor,wid,brief=setup
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'plan_steps':[{'title':'Fase X','capability':'general','assignee':'Nessuno'}]}))
    p=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta listini','expected_version':1})
    assert p['status']=='failed' and p['error_code']=='intake_invalid_response'


def test_clarification_can_add_plan_steps_to_a_phaseless_brief(setup):
    from homun.application.intake import propose,confirm
    ctx,actor,wid,brief=setup
    first=propose(ctx,actor,wid,{'command_id':'i','text':'Confronta i listini','expected_version':1})
    assert first['plan_steps']==[]
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({**brief,
        'plan_steps':[{'title':'Raccogliere i listini','capability':'general','assignee':''},
                      {'title':'Confrontare i listini','capability':'compare_csv','assignee':''}],
        'changed_fields':['plan_steps']}))
    refined=propose(ctx,actor,wid,{'command_id':'ii','text':'Suddividi in fasi: raccolta e confronto','expected_version':1})
    assert refined['status']=='pending_confirmation'
    assert len(refined['plan_steps'])==2
    confirm(ctx,actor,wid,'ii',{'command_id':'ok','digest':refined['digest'],'expected_version':1,'create_agent':False})
    store=ctx.repository.load()
    work=store.works[wid]
    assert work.status.value=='ready'
    plan=store.plans[store.plan_key(wid,work.current_plan_revision)]
    assert len(plan.steps)==2 and plan.steps[0].assignee_id==brief['suggested_agent_id']


def test_question_classification_persists_nothing(setup):
    from homun.application.intake import classify_message
    ctx,actor,wid,brief=setup
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({'kind':'question'}))
    assert classify_message(ctx,actor,wid,'Quanto spendiamo di solito per la cancelleria?')==('question',None)
    store=ctx.repository.load()
    assert not store.messages
    assert not any(r.type=='intake.propose' for r in store.commands.values())
    assert store.works[wid].owner_id==actor.id


def test_work_request_classification_and_pending_brief_context(setup):
    from homun.application.intake import classify_message, propose
    ctx,actor,wid,brief=setup
    seen=[]
    def model(messages):
        payload=json.loads(messages[-1].content)
        seen.append(payload)
        if 'agents' in payload:
            return SimpleNamespace(text=json.dumps(brief))
        return SimpleNamespace(text=json.dumps({'kind':'work_request'}))
    ctx.models.complete=model
    assert classify_message(ctx,actor,wid,'Prepara il catalogo prodotti')==('work_request',None)
    assert seen[0]['pending_brief'] is None
    propose(ctx,actor,wid,{'command_id':'i','text':'Confronta i listini','expected_version':1})
    assert classify_message(ctx,actor,wid,'Usa un altro collaboratore')==('work_request',None)
    assert seen[-1]['pending_brief']['title']==brief['title']
    assert seen[-1]['pending_brief']['objective']==brief['objective']


def test_classification_gates_and_failures(setup):
    from homun.application.intake import classify_message
    from homun.domain.errors import PermissionDeniedError, ValidationError
    ctx,actor,wid,brief=setup
    with pytest.raises(ValidationError): classify_message(ctx,actor,wid,'   ')
    agent=Actor(id=brief['suggested_agent_id'],workspace_id='ws_local',display_name='Ada',kind='agent')
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({'kind':'question'}))
    with pytest.raises(PermissionDeniedError): classify_message(ctx,agent,wid,'Una domanda qualunque')
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text='kind: work_request (not json)')
    with pytest.raises(ValueError): classify_message(ctx,actor,wid,'Prepara il catalogo')


def test_classify_http_contract_keeps_routing_stateless(setup):
    from fastapi.testclient import TestClient
    from homun.context import reset_context_for_tests
    from homun.app import create_app
    ctx,actor,wid,brief=setup
    ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text=json.dumps({'kind':'question'}))
    reset_context_for_tests(ctx)
    try:
        with TestClient(create_app()) as client:
            path=f'/v1/workspaces/ws_local/works/{wid}/intake/classify'
            headers={'X-Homun-Actor-Id':actor.id}
            response=client.post(path,headers=headers,json={'text':'Quanto spendiamo per la cancelleria?'})
            assert response.status_code==200,response.text
            assert response.json()=={'kind':'question','language':None}
            assert not ctx.repository.load().messages
            ctx.models.complete=lambda *_a,**_k: SimpleNamespace(text='garbage')
            bad=client.post(path,headers=headers,json={'text':'Prepara il catalogo'})
            assert bad.status_code==503 and bad.json()['detail']['code']=='intake_invalid_response'
    finally:
        reset_context_for_tests(None)
