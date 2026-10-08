"""Saved company context informs work without leaking between people."""
import json
from types import SimpleNamespace
from homun.context import create_context
from homun.domain.models import Actor
from homun.application.organization import update_context


def test_intake_receives_only_current_actors_saved_context(tmp_path):
    from homun.application.intake import propose
    ctx=create_context(db_path=tmp_path/'ws.db',data_dir=tmp_path,for_tests=True)
    actor=Actor(id='person_a',workspace_id=ctx.workspace_id,display_name='A')
    other=Actor(id='person_b',workspace_id=ctx.workspace_id,display_name='B')
    try:
        update_context(ctx,actor,{'command_id':'org-a','expected_revision':0,'company':'Officina A','goals':'Meno ritardi','team_size':2})
        update_context(ctx,other,{'command_id':'org-b','expected_revision':0,'company':'Segreto B'})
        ctx.service=ctx.service.for_store(ctx.repository.load())
        c=ctx.service.apply(actor,'c','conversation.create',{'title':'Test'})['conversation_id']
        w=ctx.service.apply(actor,'w','work.create',{'conversation_id':c,'title':'Test','objective':'Test'})['work_id'];ctx.persist()
        seen=[]
        def complete(messages,**k):
            seen.append(json.loads(messages[1].content))
            return SimpleNamespace(text=json.dumps({'title':'Nota','objective':'Scrivi nota','output':'Markdown',
                'rationale':'Homun prepara la nota','capability':'synthesize'}))
        ctx.models.complete=complete
        assert propose(ctx,actor,w,{'command_id':'intake','expected_version':1,'text':'Scrivi una nota'})['status']=='pending_confirmation'
        assert seen[0]['organization_context']['context']['company']=='Officina A'
        assert 'Segreto B' not in json.dumps(seen)
    finally:ctx.close()
