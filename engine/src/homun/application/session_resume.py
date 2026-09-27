"""Prepare fresh consent from historical context without dispatching historical actions."""
from copy import deepcopy
from homun.application import session_history
from homun.application.price_comparisons import cached, save
from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError
from homun.policy.work import require_work_access


def prepare(ctx, actor, work_id, args, *, allow_run_control=True):
    from homun.application.agent_run_request import RunRequest
    operations = ctx.session_operations
    from pydantic import ValidationError as SchemaError
    command_id = args.get('command_id')
    if not isinstance(command_id, str) or not 1 <= len(command_id) <= 140:
        raise ValidationError('A command_id of 1 to 140 characters is required')
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            source_work = require_work_access(store, actor, work_id, 'write')
            if actor.kind != 'person' or actor.id not in {source_work.owner_id, source_work.reviewer_id}:
                raise PermissionDeniedError('Only the human owner or reviewer can prepare a continuation')
            source = session_history.lookup(store, actor, work_id, args['session_id'])
            record, fingerprint = cached(store, actor, command_id, 'session.resume', {**args, 'work_id': work_id})
            if not allow_run_control and (source['status'] == 'paused' or (record and 'control_result' in record.result)):
                raise PermissionDeniedError('Resuming a paused run requires a direct human control request')
            if record and 'control_result' in record.result:
                operations.authorize(ctx, store, actor, work_id, args['session_id'])
                return deepcopy(record.result['control_result'])
            if record:
                body = deepcopy(record.result['proposal_body'])
                target_id = record.result['target_work_id']
                session_history.validate_context(store, actor, record.result['binding'])
            else:
                if source['status'] == 'paused':
                    control_result = {'status': 'resumed', 'proposal': operations.control(ctx, store, actor, work_id, source['id'], {
                        'command_id': command_id + ':control', 'expected_version': args.get('expected_version'), 'action': 'resume'})}
                    save(store, actor, command_id, 'session.resume', fingerprint, {
                        'work_id': work_id, 'control_result': control_result})
                    ctx.service.store = store
                    return control_result
                if source['status'] in {'queued', 'running', 'pending_approval', 'waiting_input', 'waiting_external', 'waiting_automation'}:
                    raise ConflictError('An active run must use its existing human controls')
                instruction = args.get('instruction')
                if not isinstance(instruction, str) or not 1 <= len(instruction.strip()) <= 16000:
                    raise ValidationError('A new instruction of 1 to 16000 characters is required')
                binding = session_history.context_binding(store, actor, work_id, source['id'], expected_revision=args.get('expected_revision'))
                # Validate fresh proposal inputs before creating any linked work. Historical settings are never inherited.
                try:
                    options = RunRequest.model_validate({**(args.get('proposal') or {}), 'command_id': command_id + ':proposal', 'expected_version': 1}).model_dump()
                except (SchemaError, TypeError) as exc:
                    raise ValidationError('Invalid continuation proposal options') from exc
                from homun.application.session_workspace import prepare as prepare_workspace
                transfer = prepare_workspace(ctx, store, actor, work_id, source, args)
                from homun.application.session_runtime_preferences import continuation
                options = continuation(ctx, store, source, options)
                created = ctx.service.for_store(store).apply(actor, command_id + ':work', 'work.create', {
                    'conversation_id': source_work.primary_conversation_id,
                    'title': str(args.get('title') or f'Continua: {source_work.title}')[:200],
                    'objective': instruction.strip(), 'owner_id': source_work.owner_id,
                    'reviewer_id': source_work.reviewer_id})
                target_id = created['work_id']
                body = {**options, 'session_context': {
                    'session_id': source['id'], 'work_id': work_id, 'revision': binding['revision'], 'instruction': instruction.strip()}}
                if transfer:
                    body['workspace_transfer'] = {'command_id': command_id, 'digest': transfer['digest']}
                save(store, actor, command_id, 'session.resume', fingerprint, {
                    'work_id': work_id, 'target_work_id': target_id, 'proposal_body': body, 'binding': binding, 'workspace_transfer': transfer})
        ctx.service.store = store
    # Separate admission from durable preparation: retries after a crash recover the same work and proposal ID.
    proposal = operations.propose(ctx, actor, target_id, body)
    return {'status': proposal['status'], 'proposal': proposal, 'source_session_id': args['session_id']}
