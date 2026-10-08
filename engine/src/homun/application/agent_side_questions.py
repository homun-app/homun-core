from homun.application.runtime_calls import complete_summary
"""Detached side questions with per-invocation accounting and current source authority."""
from homun.application.agent_runs import authority, lookup
from homun.application.agent_model_attempts import reserve_auxiliary
from homun.application.agent_usage import charge
from homun.application.side_question import SideQuestionRunner
from homun.domain.errors import DomainError, ValidationError
from homun.models.native_turn import NativeMessage


def answer_side_question(ctx, actor, work_id, run_id, question, *, model_invoker=None):
    store = ctx.repository.load()
    run = lookup(store, run_id, work_id)
    authority(ctx, store, actor, run)
    if not str(question or '').strip():
        raise ValidationError('A non-empty side question is required')
    receipt = None
    failure = None

    def invoker(messages, max_tokens=1024, tools=None):
        nonlocal receipt, failure
        try:
            reservation = reserve_auxiliary(ctx, actor, run, purpose='agent_run.side_question',
                connection_id=run['connection_id'], detached=True)
        except Exception as exc:
            failure = exc
            raise
        try:
            if model_invoker is None:
                result = complete_summary(ctx, run, [NativeMessage.model_validate(message) for message in messages],
                    connection_id=run['connection_id'], max_output_tokens=max_tokens)
                measured = getattr(result, 'usage', None)
                output = {'text': result.message.content, 'tool_calls': []}
            else:
                output = model_invoker(messages, max_tokens=max_tokens, tools=[])
                measured = {'input_tokens': output.get('prompt_tokens'), 'output_tokens': output.get('completion_tokens'),
                            'estimated_cost': output.get('cost_estimate'), 'currency': output.get('currency')}
        except Exception as exc:
            receipt = charge(ctx, actor, run, reservation, getattr(exc, 'usage', None))
            failure = exc
            raise
        receipt = charge(ctx, actor, run, reservation, measured)
        return output

    runner = SideQuestionRunner(model_invoker=invoker)
    # No parent_run mutation; budget/run counters are already persisted atomically.
    outcome = runner.answer(question, history=run.get('_messages', []))
    current = ctx.repository.load()
    authority(ctx, current, actor, lookup(current, run_id, work_id))
    if failure is not None:
        raise failure
    if outcome.status == 'error':
        raise ValidationError(outcome.error_message or 'Side question failed')
    return {'answer': outcome.answer, 'usage': {
        'prompt_tokens': receipt.input_tokens, 'completion_tokens': receipt.output_tokens,
        'cost_estimate': receipt.cost, 'currency': receipt.currency, 'status': receipt.status,
        'reservation_id': receipt.id}, 'attempted_tools': list(outcome.tool_calls_attempted),
        'run_id': run_id, 'work_id': work_id, 'main_transcript_unchanged': True}
