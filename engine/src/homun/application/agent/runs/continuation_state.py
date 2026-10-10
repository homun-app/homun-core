"""Pure assembly state; canonical fragment messages are retained as evidence."""
from homun.models.truncation import join_parts


def clear(run):
    run.pop('_continuation', None)


def complete_decision(run, decision):
    state = run.get('_continuation')
    if state and decision.kind == 'finish':
        decision = type(decision).model_validate({**decision.model_dump(),
            'message': join_parts([*state['parts'], decision.message])})
    # A tool/question round starts fresh work instead of appending its eventual
    # deliverable to the earlier partial answer. The fragments stay in history.
    clear(run)
    return decision
