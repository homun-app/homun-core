"""Durable admission and approval for adaptive work within selected sources."""
import hashlib
import json
from copy import deepcopy
from homun.application import agent_native
from homun.models.native_prompt import initial_messages
from homun.application.agent_prompt_roots import roots_from_propose_body
from homun.application.work_request_context import request_history
from homun.application.agent_team import bind_team, validate_team
from homun.application.contribution_people import _people
from homun.application.agent_tools import MAX_BYTES, validate_sources
from homun.application.organization_context import organization_background
from homun.application.executor import resolve_executor
from homun.application.agent_run_policy import current_step, history_is_readable, revision_context
from homun.application.price_comparisons import cached, save
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError, ValidationError, DomainError
from homun.domain.models import Actor
from homun.materials.source import verify_material
from homun.execution.ssh_jobs import key_fingerprint
from homun.policy.intake import latest_intake
from homun.policy.work import require_work_access

PROPOSAL_TYPE = 'agent_run.propose'
ACTIVE = {'pending_approval', 'queued', 'running', 'waiting_input', 'waiting_external', 'paused'}
from homun.domain.capabilities import AGENT_RUN
LIMITS = AGENT_RUN.limits


def public(run):
    item = deepcopy({k: v for k, v in run.items() if not k.startswith('_')})
    terminal = item.get('terminal')
    if isinstance(terminal, dict):
        terminal.pop('key_path', None)
    return item


def public_for(store, actor, run):
    item = public(run)
    if not history_is_readable(store, actor, run):
        item.update(materials=[], observations=[], history_redacted=True)
    return item


def lookup(store, run_id, work_id=None):
    record = store.commands.get(run_id)
    if (not record or record.type != PROPOSAL_TYPE
            or (work_id is not None and record.result['work_id'] != work_id)):
        raise NotFoundError('Agent run not found')
    return record.result


def _bind_person(store, actor, person_id):
    if person_id is None:
        return None
    person = next((p for p in _people(store, actor) if p['id'] == person_id), None)
    if person is None:
        raise ValidationError('Choose a person defined by the current user')
    return {'id': person['id'], 'name': person['name']}


def authority(ctx, store, actor, run, *, approve=False, running=False):
    work = require_work_access(store, actor, run['work_id'], 'write' if approve or running else 'read')
    if approve or running:
        if actor.kind != 'person' or actor.id not in {work.owner_id, work.reviewer_id}:
            raise PermissionDeniedError('Only the human owner or reviewer can authorize the run')
    from homun.application.agent_tool_registry import registry_for
    registry_for(run)
    from homun.application.agent_mcp import validate_bindings
    validate_bindings(store, run.get("_mcp_bindings", []))
    validate_sources(ctx, store, actor, run['materials'])
    validate_team(store, run.get('team'))
    if run.get('person'):
        try:
            person = _bind_person(store, actor, run['person']['id'])
        except ValidationError as exc:
            raise ConflictError('Human recipient changed; propose again') from exc
        if person != run['person']:
            raise ConflictError('Human recipient changed; propose again')
    agent = resolve_executor(store, run['assignee_id'], human_owner_id=work.owner_id)
    revision = agent.revision if agent else None
    if revision != run['_executor_revision']:
        raise ConflictError('Executor changed; propose again')
    if running and (work.version != run['_run_version'] or work.status != 'running'):
        raise ConflictError('Work changed after approval')
    return work, agent


def propose(ctx, actor, work_id, body):
    from homun.application.agent_mcp import discover, validate_bindings
    bindings = discover(ctx, actor, work_id, body)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work = require_work_access(store, actor, work_id)
            record, fingerprint = cached(store, actor, body['command_id'], PROPOSAL_TYPE,
                                         {**body, 'work_id': work_id})
            if record:
                authority(ctx, store, actor, record.result)
                return public(record.result)
            if work.version != body['expected_version']:
                raise ConflictError('Work changed; refresh before proposing')
            brief = latest_intake(store, work_id)
            if brief and (brief['status'] != 'confirmed' or brief['capability'] not in {'general', 'agent_run'}):
                raise ConflictError('Confirm an adaptive work agreement first')
            if work.status not in {'draft', 'ready', 'failed'}:
                raise ConflictError('Work must be ready for a new run')
            for record in store.commands.values():
                if record.type != PROPOSAL_TYPE or record.result['work_id'] != work_id or record.result['status'] not in ACTIVE:
                    continue
                prior = record.result
                stale = work.version != prior['expected_version']
                if prior['status'] == 'pending_approval':
                    try:
                        authority(ctx, store, actor, prior, approve=True)
                    except DomainError:
                        stale = True
                    if stale:
                        prior.update(status='blocked', error_code='agent_run_proposal_obsolete')
                        continue
                raise ConflictError('Work already has an active agent run')
            validate_bindings(store, bindings)
            person = _bind_person(store, actor, body.get('person_id'))
            ids = list(dict.fromkeys(body.get('material_ids') or []))
            if len(ids) > LIMITS['max_materials']:
                raise ValidationError('Select at most 12 materials')
            materials = [verify_material(ctx, store, actor, mid, max_bytes=MAX_BYTES)[0] for mid in ids]
            step = current_step(store, work)
            if step is not None and step.status == 'succeeded':
                from homun.domain.ids import new_id
                prior = next((r.result for r in reversed(list(store.commands.values()))
                              if r.type == PROPOSAL_TYPE and r.result['work_id'] == work_id
                              and r.result.get('_step_id') == step.id and r.result['status'] == 'completed'), None)
                prefix = prior['id'] if prior else body['command_id']
                ctx.service.for_store(store).apply(actor, f'{body["command_id"]}:revise', 'plan.revise', {
                    'work_id': work_id, 'expected_version': work.version, 'insert_after_step_id': step.id,
                    'new_step': {'id': f'{prefix}:revision:{new_id("step")}', 'title': f'Revisione: {step.title}'[:120],
                                 'assignee_id': step.assignee_id, 'capability': 'agent_run',
                                 'output_expected': step.output_expected, 'depends_on': [step.id]}})
                step = current_step(store, work)
            team = bind_team(store, body.get('team_id'))
            assignee_id = step.assignee_id if step else ((team or {}).get('coordinator_id') or work.owner_id)
            agent = resolve_executor(store, assignee_id, human_owner_id=work.owner_id)
            if work.status == 'failed':
                if not any(r.type == PROPOSAL_TYPE and r.result['work_id'] == work_id
                           and r.result['status'] in {'failed', 'blocked'}
                           and r.result.get('_run_version') == work.version - 1
                           for r in store.commands.values()):
                    raise ConflictError('Only the failed adaptive execution may be retried here')
                ctx.service.for_store(store).apply(actor, f'{body["command_id"]}:retry', 'plan.accept',
                    {'work_id': work_id, 'expected_version': work.version})
            from homun.application.phase_execution import propose_pin_version
            pinned = propose_pin_version(ctx.service.for_store(store), store, actor, work,
                'agent_run', body['command_id'], work.version,
                {'title': 'Svolgi la richiesta con gli strumenti disponibili',
                 'assignee_id': assignee_id, 'capability': 'agent_run',
                 'output_expected': 'Risultato da revisionare'})
            connection_id = agent.preferred_connection_id if agent else None
            if not connection_id:
                connection_id = next((c.id for c in ctx.models.list_connections() if c.active), None)
            if connection_id is None:
                raise ValidationError('Choose an active model connection')
            run = {'id': body['command_id'], 'work_id': work_id, 'status': 'pending_approval',
                   'expected_version': pinned, 'materials': materials, 'team': team, 'person': person, 'limits': dict(LIMITS),
                   'tool_version': 'adaptive-materials-v1', 'assignee_id': assignee_id,
                   '_step_id': current_step(store, work).id,
                   'executor_name': agent.name if agent else 'Homun', 'connection_id': connection_id,
                   'observations': [], 'turns': 0, 'model_attempts': 0,
                   '_executor_revision': agent.revision if agent else None,
                   '_instructions': agent.instructions if agent else '',
                   '_objective': json.dumps({'objective': work.objective, 'available_materials': materials, 'request_history': request_history(store, work_id), 'output': (brief or {}).get('output'),
                                             'constraints': (brief or {}).get('constraints', []),
                                             'revision': revision_context(store, work),
                                             'organization_context': organization_background(store, actor)}, ensure_ascii=False), '_epoch': 0}
            # Pin the protocol in the approval scope; never downgrade on provider failure.
            connection = ctx.models.get_connection(connection_id)
            run['_protocol'] = agent_native.PROTOCOL if connection.kind == 'openai_compatible' else 'json-decision-v1'
            if agent_native.enabled(run):
                run['_result_storage_version'] = 1
                run['_tool_bridge_version'] = 1
                run['_continuation_version'] = 1
                run['_liveness_version'] = 1
                run['tool_version'] = 'adaptive-materials-native-v2'
                run['_context_policy'] = {'context_window': connection.context_window,
                                          'max_output_tokens': connection.max_output_tokens}
                cwd_path, workspace_root = roots_from_propose_body(
                    ctx.data_dir, actor.workspace_id, body)
                run['_cwd'] = str(cwd_path)
                run['_workspace_root'] = str(workspace_root)
                run['_messages'] = [m.model_dump() for m in initial_messages(
                    run['_objective'],
                    run['_instructions'],
                    cwd=cwd_path,
                    workspace_root=workspace_root,
                    expand_refs=True,
                )]
            from homun.application.agent_tool_registry import registry_for
            if bindings and not agent_native.enabled(run):
                raise ValidationError('External agent tools require native model support')
            if body.get('terminal_backend') == 'local':
                if body.get('terminal_image'):
                    raise ValidationError('A local terminal does not use a container image')
                if not agent_native.enabled(run):
                    raise ValidationError('Terminal tools require native model support')
                run['_workspace_files_version'] = 2
                run['terminal'] = {'policy': 'local-private-v1', 'version': 1}
            elif body.get('terminal_backend') == 'ssh':
                if body.get('terminal_image'):
                    raise ValidationError('An SSH terminal does not use a container image')
                if not agent_native.enabled(run):
                    raise ValidationError('Terminal tools require native model support')
                key_id = key_fingerprint(body.get('ssh_key_path') or '')
                host, user, host_key = body.get('ssh_host'), body.get('ssh_user'), body.get('ssh_host_key')
                port = body.get('ssh_port') or 22
                if not host or not user or not host_key:
                    raise ValidationError('SSH target is incomplete')
                run['terminal'] = {'policy': 'ssh-v1', 'version': 1, 'host': host, 'user': user, 'port': port,
                                   'host_key': host_key, 'key_fingerprint': key_id, 'key_path': body['ssh_key_path']}
            elif body.get('terminal_image'):
                if body.get('terminal_backend') not in {None, 'docker'}:
                    raise ValidationError('Unknown terminal backend')
                if not agent_native.enabled(run):
                    raise ValidationError('Terminal tools require native model support')
                from homun.execution.contracts import JobSpec
                from pydantic import ValidationError as SchemaError
                try:
                    JobSpec(workspace_id=actor.workspace_id,run_id=run['id'],call_id='validation',image=body['terminal_image'],command='true')
                except SchemaError:
                    raise ValidationError('Terminal image must be a pinned SHA256') from None
                run['_workspace_files_version']=2
                run['terminal']={'image':body['terminal_image'],'policy':'docker-offline-v1','version':5}
            elif body.get('terminal_backend') == 'docker':
                raise ValidationError('Terminal image must be a pinned SHA256')
            elif body.get('terminal_backend') in {
                'modal', 'managed_modal', 'singularity', 'daytona', 'vercel',
            }:
                if not agent_native.enabled(run):
                    raise ValidationError('Terminal tools require native model support')
                from homun.execution.cloud_backends import probe_cloud_backend
                name = body['terminal_backend']
                status = probe_cloud_backend(name)
                # Allow proposing so the operator sees the honest unavailability on execute.
                run['terminal'] = {
                    'policy': f'cloud-{name}-v1',
                    'version': 1,
                    'backend': name,
                    'configured': status.configured,
                    'ready': status.ready,
                    'status_error': status.error,
                }
                run['_workspace_files_version'] = 2
            elif body.get('terminal_backend'):
                raise ValidationError('Unknown terminal backend')
            if body.get('web_pages'):
                if not agent_native.enabled(run):
                    raise ValidationError('Web pages require native model support')
                run['web_pages'] = {'policy': 'public-http-v1', 'version': 3}
            if body.get('browser'):
                if not agent_native.enabled(run):
                    raise ValidationError('The browser requires native model support')
                run['browser'] = {'policy': 'owned-headless-v1', 'version': 5}
            if body.get('memory'):
                if not agent_native.enabled(run):
                    raise ValidationError('Memory tools require native model support')
                run['memory'] = {'policy': 'scoped-workspace-v1', 'version': 1}
            if body.get('skills'):
                if not agent_native.enabled(run):
                    raise ValidationError('Skills tools require native model support')
                run['skills'] = {'policy': 'workspace-catalog-v1', 'version': 1}
            if body.get('delegation'):
                if not agent_native.enabled(run):
                    raise ValidationError('Delegation tools require native model support')
                run['delegation'] = {'policy': 'isolated-subagent-v1', 'version': 1}
            if body.get('clarify'):
                if not agent_native.enabled(run):
                    raise ValidationError('Clarify tools require native model support')
                run['clarify'] = {'policy': 'structured-clarify-v1', 'version': 1}
            if body.get('goals'):
                if not agent_native.enabled(run):
                    raise ValidationError('Goal tools require native model support')
                run['goals'] = {'policy': 'persistent-goals-v1', 'version': 1}
            if body.get('cron'):
                if not agent_native.enabled(run):
                    raise ValidationError('Cron tools require native model support')
                run['cron'] = {'policy': 'durable-cron-v1', 'version': 1}
            if body.get('session_management'):
                if not agent_native.enabled(run):
                    raise ValidationError('Session management tools require native model support')
                run['session_management'] = {'policy': 'durable-sessions-v1', 'version': 1}
            if body.get('gateway'):
                if not agent_native.enabled(run):
                    raise ValidationError('Gateway tools require native model support')
                run['gateway'] = {'policy': 'core-gateway-v1', 'version': 1}
            if body.get('code_execution'):
                if not agent_native.enabled(run):
                    raise ValidationError('Code execution tools require native model support')
                run['code_execution'] = {'policy': 'programmatic-v1', 'version': 1}
            if body.get('moa'):
                if not agent_native.enabled(run):
                    raise ValidationError('Mixture of Agents requires native model support')
                moa_val = body['moa']
                if isinstance(moa_val, dict):
                    preset_name = str(moa_val.get('preset') or 'default')
                    fanout = str(moa_val.get('fanout') or 'user_turn')
                    privacy = str(moa_val.get('privacy_filter') or 'none')
                    ref_models = moa_val.get('reference_models') or []
                    aggregator = moa_val.get('aggregator') or {}
                else:
                    preset_name = 'default'
                    fanout = 'user_turn'
                    privacy = 'none'
                    ref_models = []
                    aggregator = {}
                run['moa'] = {
                    'policy': 'mixture-of-agents-v1',
                    'version': 1,
                    'preset': preset_name,
                    'fanout': fanout,
                    'privacy_filter': privacy,
                    'reference_models': ref_models,
                    'aggregator': aggregator,
                }
            if body.get('plugins'):
                if not agent_native.enabled(run):
                    raise ValidationError('Plugin tools require native model support')
                run['plugins'] = {'policy': 'extensible-plugins-v1', 'version': 1}
            run['_mcp_bindings'] = bindings
            run['external_tools'] = [{k: b[k] for k in ('server_id', 'server_name', 'tool', 'name')} | {'description': b['descriptor'].get('description', '')} for b in bindings]
            run['_registry_version'] = 1
            run['tools'] = registry_for(run).manifest()
            run['digest'] = hashlib.sha256(json.dumps(run, sort_keys=True).encode()).hexdigest()
            save(store, actor, run['id'], PROPOSAL_TYPE, fingerprint, run)
        ctx.service.store = store
    return public(run)


def approve(ctx, actor, work_id, run_id, body):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = lookup(store, run_id, work_id)
            work, _ = authority(ctx, store, actor, run, approve=True)
            record, fingerprint = cached(store, actor, body['command_id'], 'agent_run.approve',
                                         {**body, 'work_id': work_id, 'run_id': run_id})
            if body['digest'] != run['digest'] or body['expected_version'] != run['expected_version']:
                raise ConflictError('Approval does not match the proposal')
            if record:
                return public(run)
            if run['status'] != 'pending_approval' or work.version != run['expected_version']:
                raise ConflictError('Run or work changed')
            from homun.application.phase_execution import approve_starts_phase
            service = ctx.service.for_store(store)
            step = current_step(store, work)
            if step is None or step.assignee_id != run['assignee_id']:
                raise ConflictError('Phase assignment changed')
            if work.status == 'draft':
                service.apply(actor, f'{run_id}:accept', 'plan.accept',
                              {'work_id': work_id, 'expected_version': work.version})
            approve_starts_phase(service, store, actor, work, 'agent_run', body['command_id'])
            run.update(status='queued', _actor=actor.model_dump(mode='json'), _run_version=work.version,
                       _workflow_id=f'agent:{actor.workspace_id}:{run_id}:0')
            save(store, actor, body['command_id'], 'agent_run.approve', fingerprint, {'run_id': run_id})
        ctx.service.store = store
    return public(run)


def list_runs(ctx, actor, work_id):
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'read')
    items = []
    for record in store.commands.values():
        if record.type == PROPOSAL_TYPE and record.result['work_id'] == work_id:
            items.append(public_for(store, actor, record.result))
    return {'items': items}


def resume_waiting(ctx, run_id):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = lookup(store, run_id)
            if run['status'] != 'waiting_input':
                return False
            request = store.contributions[run['request_id']]
            if request.status != 'resolved':
                return False
            actor = Actor.model_validate(run['_actor'])
            work, _ = authority(ctx, store, actor, run, approve=True)
            if work.status != 'ready' or work.version != run['_wait_version'] + 1:
                raise ConflictError('Work changed while awaiting input')
            service = ctx.service.for_store(store)
            service.apply(actor, f'{run_id}:resume:{run["_epoch"]}', 'work.start',
                          {'work_id': work.id, 'expected_version': work.version, 'durable': False})
            result = {'question': request.need, 'text': request.response_text}
            if agent_native.enabled(run):
                result = agent_native.append_result(run, result)
            run['observations'].append({'tool': 'human_input', 'result': result})
            run['_epoch'] += 1
            run.update(status='queued', _run_version=work.version,
                       _workflow_id=f'agent:{actor.workspace_id}:{run_id}:{run["_epoch"]}')
        ctx.service.store = store
    return True
