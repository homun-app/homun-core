"""Saved company context informs work without leaking between people."""
import json
from types import SimpleNamespace
from homun.context import create_context
from homun.domain.models import Actor
from homun.application.work.organization import update_context


def test_front_door_context_carries_only_current_actors_saved_context(tmp_path):
    """Il turno di ingresso legge il contesto aziendale dal preambolo del
    lavoro: solo quello dichiarato dalla persona che scrive, mai quello di altri."""
    from homun.application.work.organization_context import organization_background
    ctx=create_context(db_path=tmp_path/'ws.db',data_dir=tmp_path,for_tests=True)
    actor=Actor(id='person_a',workspace_id=ctx.workspace_id,display_name='A')
    other=Actor(id='person_b',workspace_id=ctx.workspace_id,display_name='B')
    try:
        update_context(ctx,actor,{'command_id':'org-a','expected_revision':0,'company':'Officina A','goals':'Meno ritardi','team_size':2})
        update_context(ctx,other,{'command_id':'org-b','expected_revision':0,'company':'Segreto B'})
        store=ctx.repository.load()
        background=organization_background(store,actor)
        assert background['context']['company']=='Officina A'
        assert 'Segreto B' not in json.dumps(background)
    finally:ctx.close()
