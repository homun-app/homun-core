"""Delivery-only approval for an existing receipt; no external transport."""
from copy import deepcopy
import hashlib
import json
from homun.application.external_tools import _lookup, _record_public
from homun.application.external_publication import publish_in_store
from homun.application.price_comparisons import cached, save
from homun.domain.errors import ConflictError, PermissionDeniedError
from homun.domain.models import utc_now
from homun.policy.work import require_work_access

KIND = 'external_tool.deliver'


def _authorized(store, actor, proposal_id):
    record = _lookup(store, proposal_id)
    work = require_work_access(store, actor, record.result['work_id'])
    if actor.kind != 'person' or actor.id not in {work.owner_id, work.reviewer_id}:
        raise PermissionDeniedError('Only the human owner or reviewer can approve delivery')
    return record, work


def _preview(record, work):
    proposal = record.result
    receipt = proposal.get('_receipt')
    if proposal['status'] != 'publication_pending' or not receipt or receipt.get('is_error'):
        raise ConflictError('No successful receipt awaiting publication')
    receipt_hash = hashlib.sha256(json.dumps(receipt,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    bound = {'action':KIND,'proposal_id':proposal['id'],'work_id':work.id,
             'expected_version':work.version,'receipt_hash':receipt_hash,
             'title':work.title,'objective':work.objective,
             'server_name':proposal['server_name'],'tool':proposal['tool']}
    digest = hashlib.sha256(json.dumps(bound,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {**bound,'digest':digest,'text':str(receipt.get('text') or '').strip() or '(nessun testo restituito)'}


def preview(ctx, actor, proposal_id):
    store = ctx.repository.load()
    return _preview(*_authorized(store,actor,proposal_id))


def deliver(ctx, actor, proposal_id, body):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            record, work = _authorized(store,actor,proposal_id)
            prior, fingerprint = cached(store,actor,body['command_id'],KIND,{**body,'proposal_id':proposal_id})
            if prior:
                return deepcopy(prior.result)
            expected = _preview(record,work)
            if body['digest'] != expected['digest'] or body['expected_version'] != work.version:
                raise ConflictError('Delivery preview changed; review the saved result again')
            publish_in_store(ctx,store,actor,proposal_id,delivery_version=work.version)
            record.result['delivery_approval'] = {'actor_id':actor.id,'digest':expected['digest'],
                'expected_version':expected['expected_version'],'receipt_hash':expected['receipt_hash'],
                'approved_at':utc_now().isoformat()}
            result = deepcopy(_record_public(record))
            save(store,actor,body['command_id'],KIND,fingerprint,result)
        ctx.service.store = store
    return result
