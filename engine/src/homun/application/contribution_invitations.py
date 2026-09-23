"""Single-request human invitations. Secrets are shown once and never persisted."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import secrets
from homun.application.price_comparisons import save
from homun.domain.command_identity import request_fingerprint
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError, ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor
from homun.policy.work import require_work_access, work_project_ids
from homun.policy.contribution_scope import invited_contribution

KIND = 'contribution.invitation'

def _owner(store,actor,work_id):
    work = require_work_access(store,actor,work_id)
    if actor.kind != 'person' or actor.id not in (work.owner_id,work.reviewer_id):
        raise PermissionDeniedError('Only the current owner or reviewer may invite a contributor')
    return work

def _projects(store,work):
    return {pid: store.projects[pid].version for pid in work_project_ids(store,work)}

def _public(value):
    return {k:deepcopy(v) for k,v in value.items() if k not in ('secret_hash','response','issuer_id','project_revisions')}

def issue_invitation(ctx,actor,request_id,body):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            request = store.contributions.get(request_id)
            if request is None:
                raise NotFoundError('Contribution request not found')
            work = _owner(store,actor,request.work_id)
            if request.status != 'pending':
                raise ConflictError('Contribution request is no longer pending')
            if request.to_actor_id in store.agents or request.to_actor_id == actor.id:
                raise ValidationError('Invitation requires a different human recipient')
            name = str(body.get('recipient_name','')).strip()
            if not name or len(name)>120:
                raise ValidationError('Recipient name is required (maximum 120 characters)')
            # A replacement explicitly invalidates any old link, including one
            # whose issue response was lost. Raw secrets cannot be recovered.
            for record in store.commands.values():
                if record.type == KIND and record.result['request_id'] == request_id and record.result['status'] == 'active':
                    record.result['status'] = 'revoked'
            identity = new_id('invite')
            secret = secrets.token_urlsafe(32)
            result = {'id':identity,'request_id':request_id,'work_id':work.id,'work_version':work.version,
                      'recipient_id':request.to_actor_id,'recipient_name':name,'issuer_id':actor.id,
                      'project_revisions':_projects(store,work),'status':'active',
                      'expires_at':(datetime.now(timezone.utc)+timedelta(days=7)).isoformat(),
                      'secret_hash':hashlib.sha256(secret.encode()).hexdigest()}
            save(store,actor,identity,KIND,request_fingerprint(actor,KIND,{'request_id':request_id}),result)
        ctx.service.store = store
    return {**_public(result),'token':identity+'.'+secret}

def list_invitations(ctx,actor,work_id):
    store = ctx.repository.load()
    _owner(store,actor,work_id)
    return {'requests':[{'id':r.id,'need':r.need,'recipient_id':r.to_actor_id} for r in store.contributions.values()
                        if r.work_id == work_id and r.status == 'pending'],
            'invitations':[_public(r.result) for r in store.commands.values() if r.type == KIND and r.result['work_id'] == work_id]}

def revoke_invitation(ctx,actor,identity):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            record = store.commands.get(identity)
            if not record or record.type != KIND:
                raise NotFoundError('Invitation not found')
            _owner(store,actor,record.result['work_id'])
            record.result['status'] = 'revoked'
        ctx.service.store = store
    return _public(record.result)

def _authenticate(store,token):
    identity,_,secret = token.partition('.')
    record = store.commands.get(identity)
    if not record or record.type != KIND or not secrets.compare_digest(record.result['secret_hash'],hashlib.sha256(secret.encode()).hexdigest()):
        raise PermissionDeniedError('Invalid invitation')
    invitation = record.result
    if invitation['status'] == 'revoked' or datetime.fromisoformat(invitation['expires_at']) <= datetime.now(timezone.utc):
        raise PermissionDeniedError('Invitation expired or revoked')
    issuer = Actor(id=invitation['issuer_id'],display_name=invitation['issuer_id'],workspace_id=store.workspace_id)
    work = _owner(store,issuer,invitation['work_id'])
    request = store.contributions.get(invitation['request_id'])
    if (not request or request.to_actor_id != invitation['recipient_id'] or request.work_id != work.id
            or _projects(store,work) != invitation['project_revisions']):
        raise ConflictError('Invitation scope changed')
    if invitation['status'] == 'active' and (work.version != invitation['work_version'] or request.status != 'pending'):
        raise ConflictError('Work changed; ask for a new invitation')
    return invitation,request,work

def read_invitation(ctx,token):
    invitation,request,work = _authenticate(ctx.repository.load(),token)
    return {'work_title':work.title,'need':request.need,'recipient_name':invitation['recipient_name'],
            'recipient_id':invitation['recipient_id'],'status':invitation['status'],
            'expires_at':invitation['expires_at'],'response_text':request.response_text if invitation['status']=='used' else None}

def respond(ctx,token,text):
    text = text.strip()
    if not text or len(text)>12000:
        raise ValidationError('Response must contain 1-12000 characters')
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            invitation,request,work = _authenticate(store,token)
            if invitation['status'] == 'used':
                if request.response_text != text:
                    raise ConflictError('This invitation already has a different response')
                return deepcopy(invitation['response'])
            recipient = Actor(id=invitation['recipient_id'],display_name=invitation['recipient_name'],workspace_id=store.workspace_id)
            with invited_contribution(recipient.id,request.id,work.id,work.version):
                result = ctx.service.for_store(store).apply(recipient,invitation['id']+':response','work.provide_contribution',{
                    'request_id':request.id,'expected_version':work.version,'text':text})
            invitation.update(status='used',response=result)
        ctx.service.store = store
    return deepcopy(result)
