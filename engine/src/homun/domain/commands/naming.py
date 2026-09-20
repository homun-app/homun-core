"""Versioned manual naming, recorded so synthesized names never replace it."""
from homun.domain.models import utc_now
from homun.domain.errors import ValidationError

def rename(ctx,actor,command_id,payload,conversation=False):
    entity=ctx.get_conversation(str(payload.get('conversation_id',''))) if conversation else ctx.get_work(str(payload.get('work_id','')))
    ctx._require_expected_version(entity.version,payload.get('expected_version'))
    title=str(payload.get('title','')).strip()
    if not title or len(title)>160:
        raise ValidationError('Title must contain 1-160 characters')
    entity.title=title; entity.version+=1; entity.updated_at=utc_now()
    kind='conversation' if conversation else 'work'
    if not conversation:
        conv=ctx.store.conversations[entity.primary_conversation_id]
        if not any(r.type=='conversation.rename' and r.result.get('conversation_id')==conv.id for r in ctx.store.commands.values()):
            conv.title=title; conv.version+=1; conv.updated_at=utc_now()
    ctx._emit(actor=actor,command_id=command_id,aggregate_id=entity.id,aggregate_type=kind,aggregate_version=entity.version,event_type=kind+'.renamed',payload={'title':title})
    return {kind+'_id':entity.id,'title':title,'version':entity.version}

def work_rename(ctx,actor,command_id,payload):
    return rename(ctx,actor,command_id,payload)

def conversation_rename(ctx,actor,command_id,payload):
    return rename(ctx,actor,command_id,payload,True)
