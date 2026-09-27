"""One persisted adaptive turn; DBOS drives repetition and recovery."""
import json
from copy import deepcopy
from datetime import datetime, timedelta
from uuid import uuid4
from homun.application import budgets, agent_native, agent_recovery, agent_overflow
from homun.application.agent_run_failures import fail  # re-exported for callers
from homun.application.agent_runs import authority, lookup
from homun.application.agent_control_history import consume_steering
from homun.application.agent_context import prepare as prepare_context, ContextPreparationDeferred, provider_policy
from homun.application.agent_tools import run_tool
from homun.application.agent_tool_registry import registry_for
from homun.application.agent_consultation import consult
from homun.application.agent_usage import charge, reserve as reserve_usage
from homun.application.agent_streaming import complete as complete_native
from homun.domain.errors import DomainError, ValidationError
from homun.domain.models import Actor, BudgetCounters, utc_now
from homun.models.agent_turn import AgentDecision, decide
from homun.models.native_errors import (
    NETWORK,
    RATE_LIMITED,
    SERVER,
    TIMEOUT,
    NativeModelError,
)


from homun.application.agent_run_fencing import LEASE_SECONDS


class _ModelFailure(Exception):
    """A native model call failed after its honest budget charge."""

    def __init__(self, error):
        self.error = error


def _claim(ctx, run_id, epoch=None):
    from homun.application.agent_terminal_sessions import announce
    announce(ctx, run_id)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = lookup(store, run_id)
            if epoch is not None and run['_epoch'] != epoch:
                return 'superseded', None
            if run['status'] not in {'queued', 'running'}:
                return run['status'], None
            if agent_recovery.waiting(run):
                return 'busy', None
            until = run.get('_lease_until')
            if until and datetime.fromisoformat(until) > utc_now():
                return 'busy', None
            from homun.application.delegation_runtime import claim_status
            child_status = claim_status(store, run)
            if child_status:
                return child_status, None
            actor = Actor.model_validate(run['_actor'])
            authority(ctx, store, actor, run, running=True)
            if run['turns'] >= run['limits']['max_turns']:
                raise ValidationError('Adaptive run reached its turn limit')
            if len(json.dumps(run['observations'])) > run['limits']['max_observation_characters']:
                raise ValidationError('Adaptive run reached its observation limit')
            if agent_native.enabled(run):
                agent_recovery.migrate_inflight(run)
                # Import surface steering into the canonical run queue before consume.
                try:
                    from homun.application.surface_gateway_manager import get_surface_gateway_manager

                    surface_items = get_surface_gateway_manager().drain_steering_guidance(run_id)
                    for item in surface_items:
                        run.setdefault("_steering", []).append(
                            {
                                "text": item.guidance,
                                "command_id": f"surface-{uuid4().hex[:10]}",
                                "actor_id": actor.id,
                                "source": "surface_gateway",
                            }
                        )
                except Exception:
                    pass
                consume_steering(run)
            token = uuid4().hex
            run.update(status='running', _lease_token=token,
                       _lease_until=(utc_now() + timedelta(seconds=LEASE_SECONDS)).isoformat())
            snapshot = deepcopy(run)
        ctx.service.store = store
    return 'running', snapshot


def _decision(ctx, run):
    if agent_native.enabled(run) and agent_native.pending(run):
        return agent_native.decision(run)
    if run.get('_decision'):
        return agent_native.decision_model(run).model_validate(run['_decision'])
    actor = Actor.model_validate(run['_actor'])
    from homun.application.agent_tool_bridge import visible_definitions
    tools = visible_definitions(run, registry_for(run))
    messages = prepare_context(ctx,run,tools) if agent_native.enabled(run) else None
    moa_enabled = agent_native.enabled(run) and run.get('moa', {}).get('policy') == 'mixture-of-agents-v1'
    reservation = None
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            authority(ctx, store, actor, current, running=True)
            if current.get('_lease_token') != run['_lease_token']:
                raise ValidationError('Run lease changed')
            if current['model_attempts'] >= current['limits']['max_model_attempts']:
                raise ValidationError('Adaptive run reached its model attempt limit')
            if agent_native.enabled(current):
                agent_recovery.begin(current, 'decide')
            if not moa_enabled:
                reservation = reserve_usage(ctx, actor, current, purpose='agent_run.decide', store=store)
                current['model_attempts'] += 1
        ctx.service.store = store
    result = None
    from homun.application.runtime_selection import kwargs as runtime_kwargs, for_call

    def reserve_fallback(error, connection_id):
        nonlocal reservation
        charge(ctx, actor, run, reservation, error.usage, reason=error.code)
        reservation = None  # Never reconcile the primary reservation twice.
        from homun.application.agent_model_attempts import reserve_extra
        reservation = reserve_extra(ctx, actor, run, connection_id=connection_id)

    try:
        if agent_native.enabled(run):
            if moa_enabled:
                from homun.application.agent_moa_runtime import execute as execute_moa
                result = execute_moa(ctx, run, messages, tools)
            else:
                conn_id = run['connection_id']
                try:
                    result = complete_native(ctx, run, messages, tools=tools,
                                                       connection_id=conn_id, **provider_policy(run))
                except NativeModelError as exc:
                    fallback_id = run.get('fallback_connection_id')
                    if fallback_id and fallback_id != conn_id and exc.retryable and exc.code in {RATE_LIMITED, SERVER, TIMEOUT, NETWORK}:
                        reserve_fallback(exc, fallback_id)
                        failover_record = {
                            'from_connection': conn_id,
                            'to_connection': fallback_id,
                            'reason': exc.code,
                            'at': utc_now().isoformat(),
                        }
                        run.setdefault('_recovery', {}).setdefault('failovers', []).append(failover_record)
                        run['connection_id'] = fallback_id
                        run['runtime_selection'] = for_call(ctx.models, run, connection_id=fallback_id)
                        run['recovery'] = dict(run.get('recovery') or {})
                        run['recovery']['failover'] = failover_record
                        fallback_conn = ctx.models.get_connection(fallback_id)
                        run['_context_policy'] = {
                            'context_window': fallback_conn.context_window,
                            'max_output_tokens': fallback_conn.max_output_tokens
                        }
                        result = complete_native(ctx, run, messages, tools=tools,
                                                           connection_id=fallback_id, **provider_policy(run))
                    else:
                        raise
            agent_native.append_round(run, result.message)
            decision = agent_native.decision(run)
            from homun.application.agent_continuation_state import complete_decision
            decision = complete_decision(run, decision)
        else:
            conn_id = run['connection_id']
            try:
                decision, result = decide(ctx.models, objective=run['_objective'], tools=tools,
                    observations=run['observations'], **runtime_kwargs(ctx.models, run, connection_id=conn_id),
                    instructions=run['_instructions'])
            except NativeModelError as exc:
                fallback_id = run.get('fallback_connection_id')
                if fallback_id and fallback_id != conn_id and exc.retryable and exc.code in {RATE_LIMITED, SERVER, TIMEOUT, NETWORK}:
                    reserve_fallback(exc, fallback_id)
                    failover_record = {
                        'from_connection': conn_id,
                        'to_connection': fallback_id,
                        'reason': exc.code,
                        'at': utc_now().isoformat(),
                    }
                    run.setdefault('_recovery', {}).setdefault('failovers', []).append(failover_record)
                    run['connection_id'] = fallback_id
                    run['runtime_selection'] = for_call(ctx.models, run, connection_id=fallback_id)
                    run['recovery'] = dict(run.get('recovery') or {})
                    run['recovery']['failover'] = failover_record
                    decision, result = decide(ctx.models, objective=run['_objective'], tools=tools,
                        observations=run['observations'], **runtime_kwargs(ctx.models, run, connection_id=fallback_id),
                        instructions=run['_instructions'])
                else:
                    raise
    except NativeModelError as exc:
        if reservation is not None:
            charge(ctx, actor, run, reservation, exc.usage, reason=exc.code)
        raise _ModelFailure(exc) from exc
    except Exception as exc:
        if reservation is not None:
            charge(ctx, actor, run, reservation, getattr(exc, 'usage', getattr(result, 'usage', None)))
        raise
    charge(ctx, actor, run, reservation, getattr(result, 'usage', None))
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            authority(ctx, store, actor, current, running=True)
            if current.get('_lease_token') != run['_lease_token']:
                raise ValidationError('Run lease changed')
            if '_moa_guidance' in run:
                current['_moa_guidance'] = run['_moa_guidance']
            current['_decision'] = decision.model_dump()
            current['connection_id'] = run['connection_id']
            if run.get('runtime_selection'):
                current['runtime_selection'] = run['runtime_selection']
            if '_context_policy' in run:
                current['_context_policy'] = dict(run['_context_policy'])
            if 'recovery' in run:
                current['recovery'] = run['recovery']
            if '_recovery' in run:
                current['_recovery'] = run['_recovery']
            if agent_native.enabled(run):
                current['_messages'] = run['_messages']
                current.pop('_continuation', None)
            agent_recovery.accept(current, 'decide')
        ctx.service.store = store
    return decision


def _dispatch_allowed(ctx, actor, run):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current=lookup(store,run['id'])
            if current.get('_lease_token') != run['_lease_token']:
                return False
            authority(ctx,store,actor,current,running=True)
            if agent_native.enabled(current):
                current['_active_call_id']=agent_native.pending(current).id
        ctx.service.store=store
    return True


def advance(ctx, run_id, *, epoch=None):
    """Execute at most one decision. Reads may replay; publication is transactional."""
    token = None
    expected_steering = None
    run = None
    try:
        status, run = _claim(ctx, run_id, epoch)
        if run is None:
            return status
        token = run['_lease_token']
        if agent_native.enabled(run):
            expected_steering = deepcopy(run.get('_steering',[]))
        actor = Actor.model_validate(run['_actor'])
        from homun.application.session_workspace import materialize
        materialize(ctx, actor, run)
        decision = _decision(ctx, run)
        observation = None
        if decision.kind == 'tool':
            from homun.application.agent_parallel_reads import select, execute as execute_reads
            batch = select(run)
            if batch:
                return execute_reads(ctx, actor, run, batch, material_executor=run_tool)
            if not _dispatch_allowed(ctx, actor, run):
                return 'superseded'
            try:
                if agent_native.enabled(run):
                    from homun.application.agent_tool_bridge import resolve_call
                    call = resolve_call(run, agent_native.pending(run))
                    decision = decision.model_copy(update={'tool': call.name, 'arguments': call.arguments})
                plugins_policy = run.get('plugins') if isinstance(run, dict) else None
                if isinstance(plugins_policy, dict) and plugins_policy.get('policy') == 'extensible-plugins-v1':
                    from homun.application.plugin_manager import get_plugin_manager
                    hook_res = get_plugin_manager().dispatch_hook(
                        "pre_tool_call",
                        tool_name=decision.tool,
                        arguments=decision.arguments,
                        context={"ctx": ctx, "actor": actor, "run": run},
                    )
                    for hr in hook_res:
                        if isinstance(hr, dict) and hr.get("action") == "block":
                            observation = {
                                "error_code": "tool_blocked_by_plugin",
                                "message": hr.get("message") or f"Tool execution blocked by plugin hook for '{decision.tool}'",
                            }
                            break
                if observation is None:
                    if decision.tool == 'terminal_execute' and run.get('terminal'):
                        registry_for(run).validate(decision.tool,decision.arguments)
                        from homun.application.agent_terminal import stage as stage_terminal
                        return stage_terminal(ctx,actor,run,decision)
                    if decision.tool == 'terminal_write' and run.get('terminal',{}).get('version',1) >= 4:
                        registry_for(run).validate(decision.tool,decision.arguments)
                        from homun.application.agent_terminal_sessions import write_stdin
                        observation = write_stdin(ctx,actor,run,decision.arguments)
                    if decision.tool in {'terminal_poll','terminal_wait','terminal_stop'} and run.get('terminal',{}).get('version',1) >= 3:
                        registry_for(run).validate(decision.tool,decision.arguments)
                        from homun.application import agent_terminal_sessions as terminal_sessions
                        if decision.tool == 'terminal_wait':
                            staged = terminal_sessions.stage_wait(ctx,actor,run,decision)
                            if staged == 'waiting_external':return staged
                            observation = staged
                        elif decision.tool == 'terminal_poll':
                            observation = terminal_sessions.poll(ctx,actor,run,decision.arguments)
                        else:
                            observation = terminal_sessions.stop(ctx,actor,run,decision.arguments)
                    if decision.tool in {'write_workspace_file','patch_workspace_file'} and run.get('_workspace_files_version')==2:
                        registry_for(run).validate(decision.tool,decision.arguments)
                        from homun.application.workspace_file_edits import stage as stage_edit
                        staged=stage_edit(ctx,actor,run,decision)
                        if staged=='waiting_external':return staged
                        observation=staged
                    if any(b['name'] == decision.tool for b in run.get('_mcp_bindings', [])):
                        registry_for(run).validate(decision.tool, decision.arguments)
                        from homun.application.agent_external import stage
                        return stage(ctx, actor, run, decision)
                    if decision.tool == 'cronjob_manage':
                        from homun.application.cron_tools import execute as cron_execute
                        from homun.application.cron_agent_runner import make_cron_runner
                        registry_for(run).validate(decision.tool, decision.arguments)
                        observation = cron_execute(ctx, actor, run, decision.tool, decision.arguments, runner_factory=make_cron_runner)
                if observation is None:
                    from homun.application.workspace_files import execute as file_executor
                    def dispatch():
                        return registry_for(run, material_executor=run_tool, collaborator_executor=consult, file_executor=file_executor).dispatch(
                            decision.tool, decision.arguments, ctx=ctx, actor=actor, run=run)
                    if decision.tool == "execute_code":
                        from homun.application.code_execution_receipts import run_once
                        observation = run_once(ctx, actor, run, dispatch)
                    else:
                        observation = dispatch()
            except ValidationError as exc:
                # Malformed arguments/readability are observations the model can correct.
                observation = {'error_code': exc.code, 'message': exc.message}
        automation_evaluation = None
        if decision.kind == 'finish' and not run.get('_delegation_parent'):
            from homun.application.agent_automation import evaluate_finish
            from homun.application.delegation_runtime import has_pending
            automation_evaluation = ({'action':'wait','reason':'delegation_children'} if has_pending(ctx, run)
                                     else evaluate_finish(ctx, run, decision.message))
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                current = lookup(store, run_id)
                work, _ = authority(ctx, store, actor, current, running=True)
                if current.get('_lease_token') != token:
                    return current['status']
                service = ctx.service.for_store(store)
                # A correction arriving during generation must precede publication.
                config_changed = current.get('_automation_revision', 0) != run.get('_automation_revision', 0)
                deferred = decision.kind == 'finish' and (config_changed or (current.get('_steering') and agent_native.enabled(current)))
                from homun.application.agent_liveness import defer as defer_stall
                stalled = decision.kind == 'finish' and not deferred and defer_stall(current, decision)
                if not deferred and not stalled:
                    if automation_evaluation:
                        from homun.application.agent_automation import _project
                        if not _project(current, automation_evaluation):
                            automation_evaluation = {'action':'wait', 'reason':'automation_state_changed'}
                    current['turns'] += 1
                if deferred:
                    consume_steering(current)
                elif stalled:
                    pass
                elif decision.kind == 'tool':
                    if '_delegations' in run:
                        from homun.application.delegation_runtime import merge_snapshot
                        merge_snapshot(current, run)
                    if '_goals' in run:
                        current['_goals'] = run['_goals']
                    if '_cron' in run:
                        current['_cron'] = run['_cron']
                    if '_sessions' in run:
                        current['_sessions'] = run['_sessions']
                    if '_subdirectory_hints' in run:
                        current['_subdirectory_hints'] = run['_subdirectory_hints']
                    from homun.application.subdirectory_hints import track_and_attach_hints
                    wd = current.get('_workspace_root') or current.get('_cwd')
                    observation, _ = track_and_attach_hints(current, decision.tool, decision.arguments or {}, observation, working_dir=wd)
                    if agent_native.enabled(current):
                        observation = agent_native.append_result(current, observation)
                    current['observations'].append({'tool': decision.tool, 'arguments': decision.arguments,
                                                    'message': decision.message, 'result': observation})
                    delegated = current.get('_delegations', {}).get(observation.get('delegation_id'), {})
                    if observation.get('wait_for_child') and delegated.get('status') in {'queued','running'}:
                        current.update(status='waiting_automation', automation_wait={'reason':'delegation_wait'})
                elif decision.kind == 'ask':
                    call = agent_native.pending(current) if agent_native.enabled(current) else None
                    if call and call.name == 'clarify':
                        from homun.application.agent_clarification import questions
                        current['clarify_request'] = questions(call.arguments)
                    result = service.apply(actor, f'{run_id}:ask:{current["turns"]}', 'work.request_contribution',
                        {'work_id': work.id, 'expected_version': work.version,
                         'step_id': f'{run_id}:question:{current["turns"]}',
                         'to_actor_id': (current.get('person') or {}).get('id') or actor.id, 'need': decision.message,
                         'questions': current.get('clarify_request')})
                    current.update(status='waiting_input', request_id=result['request_id'], _wait_version=work.version)
                    if call and call.name == 'clarify':
                        from homun.application.clarification_deadlines import bind
                        bind(current, call)
                    service.append_engine_message(actor=actor, command_id=f'{run_id}:question:{current["turns"]}',
                        conversation_id=work.primary_conversation_id, author_id='homun_engine',
                        text=decision.message, event_payload={'work_id': work.id, 'agent_run_id': run_id,
                                                             'request_id': result['request_id'],
                                                             'questions': current.get('clarify_request')})
                elif current.get('_delegation_parent'):
                    from homun.application.delegation_runtime import finish_child
                    finish_child(current, decision.message)
                elif automation_evaluation and automation_evaluation['action'] != 'finish':
                    from homun.application.agent_automation import apply_finish
                    apply_finish(service, actor, work, current, automation_evaluation, decision.message)
                else:
                    sources = '\n'.join(f'- {m["title"]}, v{m["version"]}, SHA256 {m["sha256"]}'
                                        for m in current['materials'])
                    content = decision.message + ('\n\n---\nFonti autorizzate:\n' + sources if sources else '')
                    result = service.apply(actor, f'{run_id}:artifact', 'work.submit_artifact',
                        {'work_id': work.id, 'expected_version': work.version,
                         'title': f'Risultato · {work.title}', 'content': content})
                    current.update(status='completed', artifact_id=result['artifact_id'])
                    service.append_engine_message(actor=actor, command_id=f'{run_id}:report',
                        conversation_id=work.primary_conversation_id, author_id='homun_engine',
                        text=f'{current["executor_name"]} ha preparato il risultato. Puoi verificarlo e chiedere modifiche.',
                        event_payload={'work_id': work.id, 'agent_run_id': run_id, 'artifact_id': result['artifact_id']})
                current.pop('_active_call_id', None)
                current.pop('_decision', None)
                current.pop('_lease_token', None)
                current.pop('_lease_until', None)
                status = current['status']
            ctx.service.store = store
        if status in {'completed', 'failed', 'blocked'}:
            from homun.execution.browser_sessions import close_browser
            close_browser(run_id)
        return status
    except ContextPreparationDeferred:
        return ctx.repository.load().commands[run_id].result['status']
    except _ModelFailure as held:
        if held.error.code == 'agent_model_truncated':
            from homun.application.agent_continuation import request
            if request(ctx, run, held.error, expected_steering=expected_steering):
                return ctx.repository.load().commands[run_id].result['status']
        if held.error.code == 'agent_model_overflow' and agent_overflow.request_compaction(
                ctx, run, expected_steering=expected_steering):
            return ctx.repository.load().commands[run_id].result['status']
        if not held.error.retryable:
            return fail(ctx, run_id, held.error.code, token=token, epoch=epoch,
                        expected_steering=expected_steering)
        outcome = agent_recovery.schedule(ctx, Actor.model_validate(run['_actor']), run, held.error,
                                          phase='decide', expected_steering=expected_steering)
        if outcome in {'waiting', 'fenced'}:
            return ctx.repository.load().commands[run_id].result['status']
        return outcome
    except DomainError as exc:
        return fail(ctx, run_id, exc.code, token=token,
                    blocked=exc.code in {'permission_denied', 'version_conflict', 'not_found'}, epoch=epoch,
                    expected_steering=expected_steering)
    except NativeModelError as exc:
        return fail(ctx, run_id, exc.code, token=token, epoch=epoch, expected_steering=expected_steering)
    except (ValueError, TypeError):
        return fail(ctx, run_id, 'agent_run_invalid_decision', token=token, epoch=epoch, expected_steering=expected_steering)
    except RuntimeError:
        return fail(ctx, run_id, 'agent_run_model_error', token=token, epoch=epoch, expected_steering=expected_steering)
