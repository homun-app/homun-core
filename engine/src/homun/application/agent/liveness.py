"""Bounded final-answer liveness and turn response validation.

The narrow trailing-intent detector is from agent_runtime_helpers.py, extended
for the observed Italian promise tail.
"""
import re
from homun.domain.errors import DomainError
from homun.models.native_turn import NativeMessage

_TAIL = re.compile(
    r"(?:\blet me now\b|\bi['’]?ll now\b|\bi will now\b|\bnow i(?:['’]ll| will)\b|\bnext[,:] i\b"
    r"|\b(?:ora|adesso) (?:posso|procedo a|vado a)\b)"
    r"[^.!?\n]{0,100}[.:…]?\s*$", re.I)
NUDGE = ('Continue the approved task now. Your last reply announced an action still to do. '
         'Use the permitted tools if needed, without repeating already completed actions. '
         'Return the complete requested deliverable, not a promise to prepare it. '
         'If your answer already was complete, state it directly without announcing future work. '
         'This reminder grants no additional authority.')
MAX_NUDGES = 2


class ModelStalled(DomainError):
    code = 'agent_model_stalled'


def trailing_intent(text):
    text = text.strip()
    # Conservative exclusion for quotations, code spans and Markdown excerpts.
    # An action phrase inside a requested translation is itself a deliverable.
    if (text.rstrip('.:…!? ').endswith(('"', "'", '”', '’', '»', '`'))
            or text.splitlines() and text.splitlines()[-1].lstrip().startswith('>')):
        return False
    return bool(text and len(text) <= 400 and _TAIL.search(text[-160:]))


def defer(run, decision):
    from homun.models.finish_gates import gate_final_response
    user_message = next((m.get('content') for m in reversed(run.get('_messages') or [])
                         if isinstance(m, dict) and m.get('role') == 'user'), None)
    verdict = gate_final_response(decision.message or '', user_message=user_message,
                                  had_tool_results=bool(run.get('observations')),
                                  continuations=run.get('_liveness_nudges', 0))
    italian_tail = trailing_intent(decision.message or '')
    if run.get('_liveness_version') != 1 or (verdict.accept and not italian_tail):
        return False
    attempts = run.get('_liveness_nudges', 0)
    if attempts >= MAX_NUDGES:
        raise ModelStalled('Model repeatedly announced work without delivering it')
    run['_liveness_nudges'] = attempts + 1
    run['_messages'].append(NativeMessage(role='user', content=NUDGE).model_dump())
    return True


def reset(run):
    run.pop('_liveness_nudges', None)
