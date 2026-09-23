"""One persisted adaptive turn; DBOS drives repetition and recovery."""
import json
from copy import deepcopy
from datetime import datetime, timedelta
from uuid import uuid4
from homun.application import budgets, agent_native, agent_recovery
from homun.application.agent_run_failures import fail  # re-exported for callers
from homun.application.agent_runs import authority, lookup
from homun.application.agent_control_history import consume_steering
from homun.application.agent_context import prepare as prepare_context, ContextPreparationDeferred
from homun.application.agent_tools import catalog, run_tool
from homun.application.agent_team import tool_definition
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
        return AgentDecision.model_validate(run['_decision'])
    actor = Actor.model_validate(run['_actor'])
    tools = catalog() + tool_definition(run.get('team'), run['assignee_id'])
    messages = prepare_context(ctx,run,tools+[agent_native.QUESTION]) if agent_native.enabled(run) else None
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            authority(ctx, store, actor, current, running=True)
            if current.get('_lease_token') != run['_lease_token']:
                raise ValidationError('Run lease changed')
            if current['model_attempts'] >= current['limits']['max_model_attempts']:
                raise ValidationError('Adaptive run reached its model attempt limit')
            current['model_attempts'] += 1
        ctx.service.store = store
    reservation = budgets.reserve(ctx, actor, run['work_id'], BudgetCounters(attempts=1),
        purpose='agent_run.decide', accounting_actor_id=run['assignee_id'])
    try:
        if agent_native.enabled(run):
            result = ctx.models.complete_tools(messages, tools=tools + [agent_native.QUESTION],
                                               connection_id=run['connection_id'], **run.get('_context_policy',{}))
            agent_native.append_round(run, result.message)
            decision = agent_native.decision(run)
        else:
            decision, result = decide(ctx.models, objective=run['_objective'], tools=tools,
                observations=run['observations'], connection_id=run['connection_id'],
                instructions=run['_instructions'])
    except NativeModelError as exc:
        charge(ctx, actor, run, reservation, exc.usage)
        raise _ModelFailure(exc) from exc
    except Exception:
        budgets.reconcile_unknown(ctx, actor, run['work_id'], reservation)
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
                observation = (consult(ctx, actor, run, decision.arguments) if decision.tool == 'consult_collaborator'
                               else run_tool(ctx, actor, run['materials'], decision.tool, decision.arguments))
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
                if not deferred:
                    current['turns'] += 1
                if deferred:
                    consume_steering(current)
                elif decision.kind == 'tool':
                    if agent_native.enabled(current):
                        agent_native.append_result(current, observation)
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
        return status
    except ContextPreparationDeferred:
        return ctx.repository.load().commands[run_id].result['status']
    except _ModelFailure as held:
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
