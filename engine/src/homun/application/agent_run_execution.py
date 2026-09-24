"""One persisted adaptive turn; DBOS drives repetition and recovery."""
import json
from copy import deepcopy
from datetime import datetime, timedelta
from uuid import uuid4
from homun.application import budgets, agent_native, agent_recovery, agent_overflow
from homun.application.agent_run_failures import fail  # re-exported for callers
from homun.application.agent_runs import authority, lookup
from homun.application.agent_control_history import consume_steering
from homun.application.agent_context import prepare as prepare_context, ContextPreparationDeferred
from homun.application.agent_tools import run_tool
from homun.application.agent_tool_registry import registry_for
from homun.application.agent_consultation import consult
from homun.application.agent_usage import charge
from homun.domain.errors import DomainError, ValidationError
from homun.domain.models import Actor, BudgetCounters, utc_now
from homun.models.agent_turn import AgentDecision, decide
from homun.models.native_errors import NativeModelError

LEASE_SECONDS = 180


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
                # Due heartbeat / proactive loop ticks (H26/H27) share the same queue.
                try:
                    from homun.application.automation_dispatch import inject_due_automation

                    inject_due_automation(run, actor_id=actor.id)
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
            current['model_attempts'] += 1
        ctx.service.store = store
    reservation = budgets.reserve(ctx, actor, run['work_id'], BudgetCounters(attempts=1),
        purpose='agent_run.decide', accounting_actor_id=run['assignee_id'])
    result = None
    try:
        if agent_native.enabled(run):
            if run.get('moa') and run['moa'].get('policy') == 'mixture-of-agents-v1':
                from homun.application.moa_contracts import MoAAggregator, MoAPreset, MoAReferenceModel
                from homun.application.moa_coordinator import MoACoordinator
                moa_cfg = run['moa']
                refs = [
                    MoAReferenceModel(**r) for r in moa_cfg.get('reference_models', [])
                ]
                if not refs:
                    refs = [MoAReferenceModel(
                        provider=run.get('connection_id') or 'openai_compatible',
                        model=run.get('_model_id') or 'gpt-4o-mini',
                        label='Advisor-1',
                    )]
                agg_data = moa_cfg.get('aggregator') or {}
                agg = MoAAggregator(
                    provider=agg_data.get('provider') or run.get('connection_id') or 'openai_compatible',
                    model=agg_data.get('model') or run.get('_model_id') or 'gpt-4o',
                    label=agg_data.get('label') or 'Aggregator',
                )
                preset = MoAPreset(
                    name=moa_cfg.get('preset') or 'default',
                    reference_models=refs,
                    aggregator=agg,
                    fanout=moa_cfg.get('fanout') or 'user_turn',
                    privacy_filter=moa_cfg.get('privacy_filter') or 'none',
                )
                coord = run.get('_moa_coordinator')
                if coord is None or coord.preset.name != preset.name:
                    coord = MoACoordinator(
                        preset,
                        session_id=run.get('work_id') or run.get('id'),
                        save_traces=bool(moa_cfg.get('save_traces')),
                    )
                    run['_moa_coordinator'] = coord

                def _adv_exec(prov, mdl, msgs):
                    res = ctx.models.complete_tools(msgs, tools=None, connection_id=prov, model_id=mdl)
                    return res.message.content, res.usage

                def _agg_exec(prov, mdl, msgs, tls):
                    res = ctx.models.complete_tools(msgs, tools=tls, connection_id=prov, model_id=mdl, **run.get('_context_policy', {}))
                    return res.message, res.usage

                iter_idx = len(run.get('observations', []))
                result = coord.execute_turn(
                    messages,
                    tools=tools,
                    iteration_index=iter_idx,
                    advisor_executor=_adv_exec,
                    aggregator_executor=_agg_exec,
                )
            else:
                result = ctx.models.complete_tools(messages, tools=tools,
                                                   connection_id=run['connection_id'], **run.get('_context_policy',{}))
            agent_native.append_round(run, result.message)
            decision = agent_native.decision(run)
            from homun.application.agent_continuation_state import complete_decision
            decision = complete_decision(run, decision)
        else:
            decision, result = decide(ctx.models, objective=run['_objective'], tools=tools,
                observations=run['observations'], connection_id=run['connection_id'],
                instructions=run['_instructions'])
    except NativeModelError as exc:
        charge(ctx, actor, run, reservation, exc.usage)
        raise _ModelFailure(exc) from exc
    except Exception:
        charge(ctx, actor, run, reservation, getattr(result, 'usage', None))
        raise
    charge(ctx, actor, run, reservation, getattr(result, 'usage', None))
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            authority(ctx, store, actor, current, running=True)
            if current.get('_lease_token') != run['_lease_token']:
                raise ValidationError('Run lease changed')
            current['_decision'] = decision.model_dump()
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
        decision = _decision(ctx, run)
        observation = None
        if decision.kind == 'tool':
            if not _dispatch_allowed(ctx, actor, run):
                return 'superseded'
            try:
                if agent_native.enabled(run):
                    from homun.application.agent_tool_bridge import resolve_call
                    call = resolve_call(run, agent_native.pending(run))
                    decision = decision.model_copy(update={'tool': call.name, 'arguments': call.arguments})
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
                if observation is None:
                    from homun.application.workspace_files import execute as file_executor
                    observation = registry_for(run, material_executor=run_tool, collaborator_executor=consult, file_executor=file_executor).dispatch(
                        decision.tool, decision.arguments, ctx=ctx, actor=actor, run=run)
            except ValidationError as exc:
                # Malformed arguments/readability are observations the model can correct.
                observation = {'error_code': exc.code, 'message': exc.message}
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                current = lookup(store, run_id)
                work, _ = authority(ctx, store, actor, current, running=True)
                if current.get('_lease_token') != token:
                    return current['status']
                service = ctx.service.for_store(store)
                # A correction arriving during generation must precede publication.
                deferred = decision.kind == 'finish' and current.get('_steering') and agent_native.enabled(current)
                from homun.application.agent_liveness import defer as defer_stall
                stalled = decision.kind == 'finish' and not deferred and defer_stall(current, decision)
                if not deferred and not stalled:
                    current['turns'] += 1
                if deferred:
                    consume_steering(current)
                elif stalled:
                    pass
                elif decision.kind == 'tool':
                    if '_delegations' in run:
                        current['_delegations'] = run['_delegations']
                    if '_goals' in run:
                        current['_goals'] = run['_goals']
                    if '_cron' in run:
                        current['_cron'] = run['_cron']
                    if '_sessions' in run:
                        current['_sessions'] = run['_sessions']
                    if agent_native.enabled(current):
                        observation = agent_native.append_result(current, observation)
                    current['observations'].append({'tool': decision.tool, 'arguments': decision.arguments,
                                                    'message': decision.message, 'result': observation})
                elif decision.kind == 'ask':
                    result = service.apply(actor, f'{run_id}:ask:{current["turns"]}', 'work.request_contribution',
                        {'work_id': work.id, 'expected_version': work.version,
                         'step_id': f'{run_id}:question:{current["turns"]}',
                         'to_actor_id': (current.get('person') or {}).get('id') or actor.id, 'need': decision.message})
                    current.update(status='waiting_input', request_id=result['request_id'], _wait_version=work.version)
                    service.append_engine_message(actor=actor, command_id=f'{run_id}:question:{current["turns"]}',
                        conversation_id=work.primary_conversation_id, author_id='homun_engine',
                        text=decision.message, event_payload={'work_id': work.id, 'agent_run_id': run_id,
                                                             'request_id': result['request_id']})
                else:
                    sources = '\n'.join(f'- {m["title"]}, v{m["version"]}, SHA256 {m["sha256"]}'
                                        for m in current['materials'])
                    content = decision.message + ('\n\n---\nFonti autorizzate:\n' + sources if sources else '')
                    result = service.apply(actor, f'{run_id}:artifact', 'work.submit_artifact',
                        {'work_id': work.id, 'expected_version': work.version,
                         'title': f'Risultato · {work.title}', 'content': content})
                    current.update(status='completed', artifact_id=result['artifact_id'])
                    # Close proactive loop tick if one was awaiting a response (H27).
                    try:
                        from homun.application.automation_dispatch import automation_session_id
                        from homun.application.loop_manager import LoopManager
                        LoopManager(automation_session_id(current)).complete_tick(decision.message or "")
                    except Exception:
                        pass

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
