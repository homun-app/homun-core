"""Accordi di lavoro: proposta dal turno di ingresso, conferma, revisione.

La proposta arriva dal turno di ingresso (``commit_front_door_proposal``): il
messaggio della persona è già in trascrizione e il brief è ciò che il modello
ha proposto tramite ``propose_work``. Qui si verifica ciò che il motore decide
intorno a quell'accordo: staffing, anchor, revisioni, conferme, permessi.
"""
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
    yield ctx, actor, work['work_id'], brief
    ctx.close()


def front_propose(ctx, actor, work_id, brief, *, command_id, text):
    """La sequenza del turno di ingresso: il messaggio della persona entra in
    trascrizione, poi il brief validato (argomenti di ``propose_work``) diventa
    la proposta di accordo in attesa di conferma."""
    from homun.application.work.intake import commit_front_door_proposal
    from homun.models.intake import IntakeBrief
    conversation_id = ctx.repository.load().works[work_id].primary_conversation_id
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            ctx.service.store = store
            ctx.service.for_store(store).apply(actor, f'{command_id}:message',
                                               'conversation.post_message',
                                               {'conversation_id': conversation_id, 'text': text})
            proposal = commit_front_door_proposal(ctx, actor, command_id=command_id,
                                                  conversation_id=conversation_id,
                                                  work_id=work_id,
                                                  brief=IntakeBrief.model_validate(brief),
                                                  text=text)
    ctx.service.store = ctx.repository.load()
    return proposal


def confirm_proposal(ctx, actor, wid, p, command_id='ok', create_agent=False):
    from homun.application.work.intake import confirm
    return confirm(ctx, actor, wid, p['id'], {'command_id': command_id, 'digest': p['digest'],
                                              'expected_version': p['expected_version'],
                                              'create_agent': create_agent})


def test_proposal_preserves_request_without_assignment_and_confirm_replays(setup):
    from homun.application.work.intake import list_proposals
    ctx, actor, wid, brief = setup
    p = front_propose(ctx, actor, wid, brief, command_id='i', text='Confronta questi listini mensili senza conversioni')
    store = ctx.repository.load()
    assert store.works[wid].owner_id == actor.id
    assert not store.plans and not store.runs
    assert any(m.text == p['original_request'] for m in store.messages.values())
    assert p['status'] == 'pending_confirmation'
    confirmed = confirm_proposal(ctx, actor, wid, p)
    assert confirmed['status'] == 'confirmed'
    assert confirm_proposal(ctx, actor, wid, p, command_id='ok') == confirmed
    store = ctx.repository.load()
    assert store.works[wid].owner_id == brief['suggested_agent_id']
    assert store.works[wid].title == brief['title']
    assert store.works[wid].objective == brief['objective']
    assert not store.plans and not store.runs
    assert list_proposals(ctx,actor,wid)['items'][0]['status'] == 'confirmed'


def test_staffing_preserves_existing_reviewer(setup):
    ctx, actor, wid, brief = setup
    with ctx.repository.transaction() as store:
        store.works[wid].reviewer_id = 'person_reviewer'
    p = front_propose(ctx, actor, wid, brief, command_id='i', text='Confronta listini')
    confirm_proposal(ctx, actor, wid, p)
    assert ctx.repository.load().works[wid].reviewer_id == 'person_reviewer'


def test_stale_agent_and_digest_rejected(setup):
    from homun.domain.errors import ConflictError
    ctx, actor, wid, brief = setup
    p = front_propose(ctx, actor, wid, brief, command_id='i', text='Analizza CSV')
    with pytest.raises(ConflictError):
        from homun.application.work.intake import confirm
        confirm(ctx,actor,wid,p['id'],{'command_id':'bad','digest':'wrong','expected_version':p['expected_version'],'create_agent':False})
    ctx.service.store = ctx.repository.load()
    ctx.service.apply(actor,'update','agent.update',{'agent_id':brief['suggested_agent_id'],'expected_version':1,'role':'Altro'})
    ctx.persist()
    with pytest.raises(ConflictError):
        confirm_proposal(ctx, actor, wid, p)


def test_manual_rename_survives_proposal_confirmation(setup):
    ctx,actor,wid,brief=setup
    ctx.service.apply(actor,'rename','work.rename',{'work_id':wid,'title':'Titolo scelto','expected_version':1})
    ctx.persist()
    p = front_propose(ctx, actor, wid, brief, command_id='i', text='Analizza CSV')
    confirm_proposal(ctx, actor, wid, p)
    assert ctx.repository.load().works[wid].title == 'Titolo scelto'


@pytest.mark.parametrize('change', ['unknown_agent','unknown_capability','new_profile'])
def test_catalog_and_profile_limits(setup,change):
    from homun.domain.errors import ValidationError
    ctx,actor,wid,brief=setup
    if change=='unknown_agent':
        brief['suggested_agent_id']='invented'
        p = front_propose(ctx,actor,wid,brief,command_id='i',text='Analizza prezzi')
        assert p['status']=='failed' and p['error_code']=='intake_invalid_response'
        return
    if change=='unknown_capability':
        # La capacità inesistente è rifiutata dal TURNO (validate_brief), come
        # correzione che il modello può sistemare, prima di qualunque commit.
        from homun.application.sessions.front_door import outcomes, tools
        work = ctx.repository.load().works[wid]
        arguments = tools.parse_arguments('propose_work', {**brief, 'capability': 'browse_web'})
        outcome, error = outcomes.outcome_from_call('propose_work', arguments,
                                                    work=work, plan=None, agents=[],
                                                    anchor=None, roster_ids=set())
        assert outcome is None and 'capability' in error.lower()
        return
    brief['suggested_agent_id']=None
    brief['new_agent']={'name':'Analista','role':'Analisi prezzi','instructions':'Usa solo strumenti e materiali autorizzati'}
    p = front_propose(ctx,actor,wid,brief,command_id='i',text='Analizza prezzi')
    assert len(ctx.repository.load().agents)==1
    with pytest.raises(ValidationError): confirm_proposal(ctx, actor, wid, p, create_agent=False)
    confirm_proposal(ctx, actor, wid, p, create_agent=True)
    store=ctx.repository.load()
    assert len(store.agents)==2 and not store.grants
    assert store.works[wid].owner_id!=actor.id


def test_superseding_clarification_and_restart(setup):
    from homun.domain.errors import ConflictError
    from homun.storage.sqlite import SqliteWorkspaceRepository
    ctx,actor,wid,brief=setup
    p = front_propose(ctx,actor,wid,brief,command_id='i',text='Analizza prezzi')
    newer = front_propose(ctx,actor,wid,{**brief,'title':'Confronto SKU esatto'},command_id='ii',text='Solo SKU esatto')
    assert newer['original_request']=='Solo SKU esatto'
    with pytest.raises(ConflictError): confirm_proposal(ctx, actor, wid, p)
    from homun.application.work.intake import list_proposals
    path=ctx.repository.path
    ctx.repository.close()
    ctx.repository=SqliteWorkspaceRepository(path,'ws_local')
    assert list_proposals(ctx,actor,wid)['items'][-1]['id']==newer['id']
    assert len(ctx.repository.load().messages)==2


def test_read_write_and_replay_after_revocation(setup):
    from homun.domain.errors import PermissionDeniedError
    from homun.application.work.intake import list_proposals
    ctx,actor,wid,brief=setup
    project=ctx.service.apply(actor,'proj','project.create',{'name':'Private'})['project_id']
    ctx.service.store.works[wid].project_id=project
    ctx.persist()
    other=Actor(id='other',workspace_id='ws_local',display_name='Other')
    with pytest.raises(PermissionDeniedError): list_proposals(ctx,other,wid)
    with pytest.raises(PermissionDeniedError): front_propose(ctx,other,wid,brief,command_id='denied',text='No')
    grant=ctx.service.apply(actor,'grant','grant.issue',{'project_id':project,'subject_id':other.id,'capability':'write'})['grant_id']
    ctx.persist()
    p = front_propose(ctx,other,wid,brief,command_id='i',text='Analizza prezzi')
    ctx.service.apply(actor,'revoke','grant.revoke',{'grant_id':grant});ctx.persist()
    with pytest.raises(PermissionDeniedError): front_propose(ctx,other,wid,brief,command_id='again',text='Ancora')
    with pytest.raises(PermissionDeniedError): confirm_proposal(ctx, other, wid, p)


def test_pending_intake_blocks_comparison_and_manual_rename_stales_confirmation(setup):
    from homun.application.work.price_comparisons import propose as comparison
    from homun.domain.errors import ConflictError
    ctx,actor,wid,brief=setup
    p = front_propose(ctx,actor,wid,brief,command_id='i',text='Analizza prezzi')
    with pytest.raises(ConflictError): comparison(ctx,actor,wid,{'command_id':'cmp','left_material_id':'x','right_material_id':'y','expected_version':1})
    ctx.service.apply(actor,'rename','work.rename',{'work_id':wid,'title':'Mio nome','expected_version':1});ctx.persist()
    with pytest.raises(ConflictError): confirm_proposal(ctx, actor, wid, p)


def test_staffing_confirmation_preserves_missing_materials_without_execution(setup):
    ctx,actor,wid,brief=setup
    brief['missing_information']=['I file CSV non sono ancora caricati']
    p = front_propose(ctx,actor,wid,brief,command_id='i',text='Analizza prezzi')
    result = confirm_proposal(ctx, actor, wid, p)
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
        p = front_propose(ctx, actor, wid, brief, command_id='api', text='Analizza listini')
        with TestClient(create_app()) as client:
            path=f'/v1/workspaces/ws_local/works/{wid}/intake'
            headers={'X-Homun-Actor-Id':actor.id}
            items=client.get(path,headers=headers).json()['items']
            assert items[0]['id']=='api'
            assert p['new_agent'] is None and items[0]['suggested_agent']['id']==brief['suggested_agent_id']
            assert not any(key.startswith('_') for key in items[0])
            bad=client.post(path+'/api/confirm',headers=headers,json={'command_id':'bad','digest':'forged','expected_version':p['expected_version'],'create_agent':False})
            assert bad.status_code==409 and bad.json()['detail']['code']=='version_conflict'
    finally:
        reset_context_for_tests(None)


def test_works_list_reports_intake_confirmed_for_stable_labels(setup):
    from fastapi.testclient import TestClient
    from homun.context import reset_context_for_tests
    from homun.app import create_app
    ctx,actor,wid,brief=setup
    reset_context_for_tests(ctx)
    try:
        with TestClient(create_app()) as client:
            headers={'X-Homun-Actor-Id':actor.id}
            def flag():
                items=client.get('/v1/workspaces/ws_local/works',headers=headers).json()['items']
                return next(item['intake_confirmed'] for item in items if item['id']==wid)
            p = front_propose(ctx,actor,wid,brief,command_id='i',text='Confronta listini')
            assert flag() is False
            confirm_proposal(ctx, actor, wid, p)
            # The list projection keeps the agreed label stable even when the
            # client has not loaded the per-work intake state.
            assert flag() is True
    finally:
        reset_context_for_tests(None)


def test_completed_work_is_never_reassigned_or_reexecuted(setup):
    from homun.domain.states import WorkStatus
    from homun.application.sessions.front_door.outcomes import work_accepts_proposal
    ctx,actor,wid,brief=setup
    work=ctx.service.store.works[wid]
    work.status=WorkStatus.COMPLETED
    ctx.persist()
    # Il turno di ingresso rifiuta propose_work su un lavoro non più in bozza.
    assert work_accepts_proposal(ctx.repository.load().works[wid]) is not None
    # E il commit, se mai raggiunto, non riassegna nulla: proposta fallita.
    p = front_propose(ctx,actor,wid,brief,command_id='i',text='Revisione del titolo')
    assert p['status']=='failed' and p['error_code']=='intake_invalid_response'
    store=ctx.repository.load()
    assert store.works[wid].owner_id==actor.id and not store.runs


def test_agent_cannot_start_intake(setup):
    from homun.domain.errors import PermissionDeniedError
    ctx,actor,wid,brief=setup
    agent=Actor(id=brief['suggested_agent_id'],workspace_id='ws_local',display_name='Ada',kind='agent')
    with pytest.raises(PermissionDeniedError): front_propose(ctx,agent,wid,brief,command_id='i',text='Richiesta')
    assert not any(r.type=='intake.propose' for r in ctx.repository.load().commands.values())


@pytest.mark.parametrize('command,payload', [
    ('plan.propose', {'steps':[{'title':'Esegui','assignee_id':'person_fabio','output_expected':'Report'}]}),
    ('plan.accept', {}),
    ('work.start', {}),
    ('work.apply_patch', {'changes':[{'field':'owner_id','to_value':'person_fabio'}]}),
])
def test_generic_commands_cannot_bypass_unconfirmed_intake(setup,command,payload):
    from homun.domain.errors import ConflictError
    ctx,actor,wid,brief=setup
    front_propose(ctx,actor,wid,brief,command_id='i',text='Analizza prezzi')
    with pytest.raises(ConflictError,match='Confirm the intake'):
        ctx.service.apply(actor,'bypass',command,{'work_id':wid,'expected_version':1,**payload})
    assert not ctx.service.store.plans and not ctx.service.store.runs


@pytest.mark.parametrize('roster', ['empty', 'single', 'multiple'])
def test_direct_intake_preserves_human_owner_without_creating_agent(setup, roster):
    ctx, actor, wid, brief = setup
    if roster == 'empty':
        with ctx.repository.transaction() as store:
            for agent in store.agents.values():
                agent.status = 'retired'
    elif roster == 'multiple':
        ctx.service.apply(actor, 'second', 'agent.create', {'name':'Bice', 'role':'Analisi', 'instructions':'Analizza'})
        ctx.persist()
    before = set(ctx.repository.load().agents)
    brief.update(suggested_agent_id=None, new_agent=None)
    p = front_propose(ctx, actor, wid, brief, command_id='i', text='Confronto i listini')
    assert p['status'] == 'pending_confirmation'
    assert p['suggested_agent'] is None and p['new_agent'] is None
    assert confirm_proposal(ctx, actor, wid, p)['status'] == 'confirmed'
    store = ctx.repository.load()
    assert set(store.agents) == before
    assert store.works[wid].owner_id == actor.id


def test_confirmed_idle_intake_can_be_revised_without_early_reassignment(setup):
    from homun.policy.intake import require_confirmed_intake
    from homun.domain.errors import ConflictError
    ctx,actor,wid,brief=setup
    first = front_propose(ctx,actor,wid,brief,command_id='i',text='Confronto listini CSV')
    confirm_proposal(ctx, actor, wid, first)
    owner=ctx.repository.load().works[wid].owner_id
    p = front_propose(ctx,actor,wid,{**brief,'title':'Rivediamo il lavoro'},command_id='ii',text='Rivediamo il lavoro e collaboratore')
    assert p['status']=='pending_confirmation'
    assert ctx.repository.load().works[wid].owner_id==owner
    with pytest.raises(ConflictError): require_confirmed_intake(ctx.repository.load(),wid,'compare_csv')
    with pytest.raises(ConflictError): confirm_proposal(ctx, actor, wid, first, command_id='ok-old')
    confirm_proposal(ctx, actor, wid, p, command_id='ok2')
    require_confirmed_intake(ctx.repository.load(),wid,'compare_csv')


def test_staffing_only_refinement_preserves_brief_structurally(setup):
    ctx,actor,wid,brief=setup
    brief['constraints']=['Nessuna conversione valutaria']
    first = front_propose(ctx,actor,wid,brief,command_id='i',text='Confronto i listini senza conversioni')
    confirm_proposal(ctx, actor, wid, first)
    other=ctx.service.apply(actor,'b','agent.create',{'name':'Bruno','role':'Analisi listini junior','instructions':'Confronta CSV di prezzi'})['agent_id']
    ctx.persist()
    # Il modello riscrive ogni campo mentre la persona chiedeva solo un altro collaboratore.
    refined = front_propose(ctx,actor,wid,{**brief,
        'title':'Crea profilo analista','objective':'Creare un nuovo collaboratore riutilizzabile.',
        'output':'Profilo creato','constraints':[],'capability':'general',
        'changed_fields':['staffing'],'suggested_agent_id':other},
        command_id='ii',text='Usa un altro agente')
    assert refined['status']=='pending_confirmation'
    assert refined['title']==first['title']
    assert refined['objective']==first['objective']
    assert refined['output']==first['output']
    assert refined['constraints']==first['constraints']
    assert refined['capability']=='compare_csv'
    assert refined['suggested_agent']['id']==other
    assert refined['changes']==[{'field':'staffing','from_value':'Ada','to_value':'Bruno'}]
    confirm_proposal(ctx, actor, wid, refined, command_id='ok2')
    work=ctx.repository.load().works[wid]
    assert work.owner_id==other and work.reviewer_id==actor.id
    assert work.objective==first['objective'] and work.title==first['title']


def test_explicit_objective_change_preserves_undeclared_fields(setup):
    ctx,actor,wid,brief=setup
    brief['constraints']=['Nessuna conversione valutaria']
    first = front_propose(ctx,actor,wid,brief,command_id='i',text='Confronto i listini')
    refined = front_propose(ctx,actor,wid,{**brief,
        'title':'Titolo riscritto dal modello','objective':'Solo le differenze di prezzo, senza report.',
        'output':'Solo CSV delle differenze','constraints':[],
        'changed_fields':['objective','output']}, command_id='ii', text='Voglio solo il CSV, non il report')
    assert refined['title']==first['title']
    assert refined['constraints']==first['constraints']
    assert refined['capability']==first['capability']
    assert refined['objective']=='Solo le differenze di prezzo, senza report.'
    assert refined['output']=='Solo CSV delle differenze'
    assert {c['field'] for c in refined['changes']}=={'objective','output'}


def test_unknown_changed_field_is_dropped_not_fatal(setup):
    ctx,actor,wid,brief=setup
    first = front_propose(ctx,actor,wid,brief,command_id='i',text='Confronto listini')
    refined = front_propose(ctx,actor,wid,{**brief,'changed_fields':['nonsense','missing_information','staffing']},
                            command_id='ii',text='Usa Bruno')
    assert refined['status']=='pending_confirmation'
    assert refined['changed_fields']==['staffing']
    assert refined['objective']==first['objective']
    assert ctx.repository.load().works[wid].owner_id==actor.id


def test_first_proposal_reports_no_changes(setup):
    ctx,actor,wid,brief=setup
    p = front_propose(ctx,actor,wid,{**brief,'changed_fields':['objective']},command_id='i',text='Confronto listini')
    assert p['changes']==[]
    assert p['changed_fields']==['objective']


def test_refinement_without_collaborator_keeps_anchor_staffing_actionable(setup):
    ctx,actor,wid,brief=setup
    first = front_propose(ctx,actor,wid,brief,command_id='i',text='Confronto i listini')
    refined = front_propose(ctx,actor,wid,{**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':None,
        'changed_fields':[]}, command_id='ii', text='Aggiorna la proposta')
    assert refined['status']=='pending_confirmation'
    assert refined['capability']=='compare_csv'
    assert refined['suggested_agent']==first['suggested_agent']
    assert refined['changes']==[]
    confirm_proposal(ctx, actor, wid, refined)
    assert ctx.repository.load().works[wid].owner_id==first['suggested_agent']['id']


def test_undeclared_staffing_swap_keeps_standing_collaborator(setup):
    ctx,actor,wid,brief=setup
    # Il primo accordo crea una nuova collaboratrice (Elena) e la persona conferma;
    # una revisione che porta i dati non può far inventare un profilo gemello (Bruno)
    # a meno che staffing non sia dichiarato modificato.
    elena={'name':'Elena','role':'Coordinatore Preventivi','instructions':'Segue le richieste di preventivo'}
    first = front_propose(ctx,actor,wid,{**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':elena},
        command_id='i',text='Segui i preventivi e le risposte')
    confirm_proposal(ctx, actor, wid, first, create_agent=True)
    owner=ctx.repository.load().works[wid].owner_id
    bruno={'name':'Bruno','role':'Coordinatore Preventivi','instructions':'Segue le richieste di preventivo'}
    refined = front_propose(ctx,actor,wid,{**brief,
        'title':'Report preventivi attivi e scaduti','objective':'Elencare lo stato dei preventivi.',
        'output':'Report con elenco preventivi.','capability':'general',
        'suggested_agent_id':None,'new_agent':bruno,'changed_fields':['title','objective','output']},
        command_id='ii',text='Ecco i dati: prepara il report')
    assert refined['status']=='pending_confirmation'
    assert refined['new_agent'] is None
    assert refined['suggested_agent']['id']==owner
    assert refined['suggested_agent']['name']=='Elena'
    assert {c['field'] for c in refined['changes']}=={'title','objective','output'}
    confirm_proposal(ctx, actor, wid, refined, command_id='ok2')
    assert ctx.repository.load().works[wid].owner_id==owner


def test_declared_staffing_swap_is_honored_after_new_agent_confirmation(setup):
    ctx,actor,wid,brief=setup
    elena={'name':'Elena','role':'Coordinatore Preventivi','instructions':'Segue le richieste di preventivo'}
    first = front_propose(ctx,actor,wid,{**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':elena},
        command_id='i',text='Segui i preventivi')
    confirm_proposal(ctx, actor, wid, first, create_agent=True)
    bruno={'name':'Bruno','role':'Coordinatore Preventivi senior','instructions':'Segue le richieste di preventivo'}
    refined = front_propose(ctx,actor,wid,{**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':bruno,
        'changed_fields':['staffing']}, command_id='ii', text='Affida il lavoro a un nuovo collaboratore')
    assert refined['new_agent'] is not None and refined['new_agent']['name']=='Bruno'
    confirm_proposal(ctx, actor, wid, refined, command_id='ok2', create_agent=True)
    owner = ctx.repository.load().works[wid].owner_id
    bruno_agent = next(a for a in ctx.repository.load().agents.values() if a.name == 'Bruno')
    assert owner == bruno_agent.id


def test_same_name_new_agent_reproposal_is_reanchored_not_duplicated(setup):
    ctx,actor,wid,brief=setup
    # Il modello ripropone la collaboratrice in carica come profilo «nuovo» con
    # lo stesso nome dichiarando staffing modificato: confermarla duplicherebbe
    # la voce del roster, quindi il motore riancora l'agente esistente.
    elena={'name':'Elena','role':'Coordinatore Preventivi','instructions':'Segue le richieste di preventivo'}
    first = front_propose(ctx,actor,wid,{**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':elena},
        command_id='i',text='Segui i preventivi')
    confirm_proposal(ctx, actor, wid, first, create_agent=True)
    owner=ctx.repository.load().works[wid].owner_id
    elena_twin={'name':'Elena','role':'Coordinatore Preventivi','instructions':'Seguito preventivi e risposte'}
    refined = front_propose(ctx,actor,wid,{**brief,
        'capability':'general','suggested_agent_id':None,'new_agent':elena_twin,
        'changed_fields':['staffing']}, command_id='ii', text='Ecco i dati, prepara il report')
    assert refined['new_agent'] is None
    assert refined['suggested_agent']['id']==owner
    confirm_proposal(ctx, actor, wid, refined, command_id='ok2')
    store=ctx.repository.load()
    assert store.works[wid].owner_id==owner
    assert sum(1 for a in store.agents.values() if a.name.casefold()=='elena')==1


def test_confirm_with_plan_steps_creates_accepted_chained_plan(setup):
    ctx,actor,wid,brief=setup
    p = front_propose(ctx,actor,wid,{**brief,
        'plan_steps':[
            {'title':'Raccogliere i listini','capability':'general',
             'expected_materials':['Listino marzo','Listino giugno'],
             'output_expected':'Listini nel progetto','assignee':'Ada'},
            {'title':'Confrontare i listini','capability':'compare_csv',
             'expected_materials':[],'output_expected':'Report differenze','assignee':'Ada'},
        ]}, command_id='i', text='Confronta i listini con raccolta')
    assert len(p['plan_steps'])==2
    confirm_proposal(ctx, actor, wid, p)
    store=ctx.repository.load()
    work=store.works[wid]
    assert work.status.value=='ready'
    plan=store.plans[store.plan_key(wid,work.current_plan_revision)]
    assert plan.revision==1 and len(plan.steps)==2
    assert plan.steps[0].capability=='general' and plan.steps[1].capability=='compare_csv'
    assert plan.steps[1].depends_on==[plan.steps[0].id]
    assert plan.steps[0].assignee_id==brief['suggested_agent_id']


def test_plan_step_with_unknown_assignee_fails_honestly(setup):
    ctx,actor,wid,brief=setup
    p = front_propose(ctx,actor,wid,{**brief,
        'plan_steps':[{'title':'Fase X','capability':'general','assignee':'Nessuno'}]},
        command_id='i',text='Confronta listini')
    assert p['status']=='failed' and p['error_code']=='intake_invalid_response'


def test_clarification_can_add_plan_steps_to_a_phaseless_brief(setup):
    ctx,actor,wid,brief=setup
    first = front_propose(ctx,actor,wid,brief,command_id='i',text='Confronto i listini')
    assert first['plan_steps']==[]
    refined = front_propose(ctx,actor,wid,{**brief,
        'plan_steps':[{'title':'Raccogliere i listini','capability':'general','assignee':''},
                      {'title':'Confrontare i listini','capability':'compare_csv','assignee':''}],
        'changed_fields':['plan_steps']}, command_id='ii', text='Suddividi in fasi: raccolta e confronto')
    assert refined['status']=='pending_confirmation'
    assert len(refined['plan_steps'])==2
    confirm_proposal(ctx, actor, wid, refined)
    store=ctx.repository.load()
    work=store.works[wid]
    assert work.status.value=='ready'
    plan=store.plans[store.plan_key(wid,work.current_plan_revision)]
    assert len(plan.steps)==2 and plan.steps[0].assignee_id==brief['suggested_agent_id']


def test_direct_agreement_refinement_does_not_invent_a_collaborator(setup):
    ctx, actor, wid, brief = setup
    brief.update(suggested_agent_id=None, new_agent=None)
    p = front_propose(ctx, actor, wid, brief, command_id='direct', text='Confronto listini')
    confirm_proposal(ctx, actor, wid, p)
    p = front_propose(ctx, actor, wid, {**brief,
        'suggested_agent_id': next(iter(ctx.repository.load().agents)),
        'changed_fields':['output'], 'output':'Report breve'},
        command_id='refine', text='Report breve')
    assert p['suggested_agent'] is None and p['new_agent'] is None


def test_explicit_return_to_homun_keeps_confirming_human_owner(setup):
    ctx, actor, wid, brief = setup
    p = front_propose(ctx, actor, wid, brief, command_id='delegated', text='Confronto listini')
    confirm_proposal(ctx, actor, wid, p)
    p = front_propose(ctx, actor, wid, {**brief,
        'suggested_agent_id': None, 'new_agent': None, 'changed_fields':['staffing']},
        command_id='direct', text='Occupatene direttamente Homun')
    assert p['suggested_agent'] is None and p['new_agent'] is None
    confirm_proposal(ctx, actor, wid, p, command_id='confirm-direct')
    assert ctx.repository.load().works[wid].owner_id == actor.id


@pytest.mark.parametrize('staffing', ['existing', 'proposed'])
@pytest.mark.parametrize('echo_phases', [False, True])
def test_return_to_homun_reassigns_inherited_phases_before_confirmation(setup, staffing, echo_phases):
    ctx, actor, wid, brief = setup
    previous_name = 'Ada' if staffing == 'existing' else 'Elena'
    if staffing == 'proposed':
        brief.update(suggested_agent_id=None, new_agent={
            'name':previous_name, 'role':'Analisi', 'instructions':'Confronta i dati'})
    brief['plan_steps'] = [
        {'title':'Prepara dati', 'capability':'general', 'assignee':previous_name},
        {'title':'Confronta dati', 'capability':'compare_csv', 'assignee':previous_name},
    ]
    first = front_propose(ctx, actor, wid, brief, command_id='delegated-phases', text='Confronto i listini')
    assert first['status'] == 'pending_confirmation'
    direct = front_propose(ctx, actor, wid, {**brief,
        'suggested_agent_id':None, 'new_agent':None, 'changed_fields':['staffing'],
        'plan_steps': brief['plan_steps'] if echo_phases else []},
        command_id='homun-phases', text='Occupatene direttamente Homun')
    assert direct['status'] == 'pending_confirmation'
    assert [step['assignee'] for step in direct['plan_steps']] == ['', '']
    assert [step['title'] for step in direct['plan_steps']] == ['Prepara dati', 'Confronta dati']
    assert ctx.repository.load().commands[first['id']].result['plan_steps'][0]['assignee'] == previous_name
    before = set(ctx.repository.load().agents)
    confirm_proposal(ctx, actor, wid, direct, command_id='confirm-phases')
    store = ctx.repository.load()
    work = store.works[wid]
    assert work.owner_id == actor.id and set(store.agents) == before
    plan = store.plans[store.plan_key(wid, work.current_plan_revision)]
    assert [step.assignee_id for step in plan.steps] == [actor.id, actor.id]


def test_return_to_homun_rejects_fresh_invalid_phase_assignment(setup):
    ctx, actor, wid, brief = setup
    brief.update(suggested_agent_id=None, new_agent={
        'name':'Elena', 'role':'Analisi', 'instructions':'Confronta i dati'},
        plan_steps=[{'title':'Confronto dati', 'capability':'compare_csv', 'assignee':'Elena'}])
    first = front_propose(ctx, actor, wid, brief, command_id='phase-first', text='Confronto listini')
    assert first['status'] == 'pending_confirmation'
    direct = front_propose(ctx, actor, wid, {**brief,
        'new_agent': None, 'changed_fields':['staffing', 'plan_steps']},
        command_id='phase-invalid', text='Homun, cambia anche la fase')
    assert direct['status'] == 'failed'
    assert direct['error_code'] == 'intake_invalid_response'
    assert not ctx.repository.load().plans
