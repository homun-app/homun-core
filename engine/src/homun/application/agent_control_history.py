"""Provider-safe control boundaries and interrupt/redirect logic.

interrupted calls always get explicit results, never fabricated successful ones.
"""
import json
from homun.application import agent_native
from homun.application.agent_continuation_state import clear as clear_continuation
from homun.models.native_turn import NativeMessage
from homun.application.agent_liveness import reset as reset_liveness


def consume_steering(run):
    if not run.get('_steering') or agent_native.pending(run):
        return False
    clear_continuation(run)
    reset_liveness(run)
    from homun.models.prompt_blocks import STEER_MARKER_OPEN, STEER_MARKER_CLOSE
    for item in run.pop('_steering'):
        # marker fidato pre-insegnato nel prompt di sistema (come Hermes):
        # il modello distingue lo steer della persona da eventuali lookalike
        run['_messages'].append(NativeMessage(role='user', content=(
            f"{STEER_MARKER_OPEN}\n{item['text']}\n{STEER_MARKER_CLOSE}")).model_dump())
    run.pop('_decision',None)
    return True


def close_pending(run):
    unfinished=[]
    while call := agent_native.pending(run):
        outcome='unknown' if (call.id == run.get('_active_call_id') or call.id in run.get('_active_call_ids', [])) else 'not_executed'
        if call.name in {agent_native.QUESTION.name, 'clarify'} and run['status']=='waiting_input':
            outcome='awaiting_response_cancelled'
        unfinished.append({'tool':call.name,'arguments':call.arguments,'outcome':outcome})
        agent_native.append_result(run,{'error_code':'agent_run_interrupted','outcome':outcome,
            'message':'Interrupted by the user. This is not a successful tool result.'})
    return unfinished


def redirect_history(run,text):
    clear_continuation(run)
    reset_liveness(run)
    unfinished=close_pending(run)
    consume_steering(run)
    reminder=''
    if unfinished:
        reminder='\nInterrupted calls requiring reconsideration before completing the task:\n'+json.dumps(unfinished,ensure_ascii=False)
        reminder+='\nRe-read still relevant sources. Do not infer their contents from cancelled calls.'
    run['_messages'].append(NativeMessage(role='user',content=text+reminder).model_dump())
    run.pop('_decision',None)
