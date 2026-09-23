"""Provider-safe control boundaries, derived from Hermes interrupt/redirect logic.

See homun/notices/hermes-agent.txt. User corrections remain user messages;
interrupted calls always get explicit results, never fabricated successful ones.
"""
import json
from homun.application import agent_native
from homun.models.native_turn import NativeMessage


def consume_steering(run):
    if not run.get('_steering') or agent_native.pending(run):
        return False
    for item in run.pop('_steering'):
        run['_messages'].append(NativeMessage(role='user',content=item['text']).model_dump())
    run.pop('_decision',None)
    return True


def close_pending(run):
    unfinished=[]
    while call := agent_native.pending(run):
        outcome='unknown' if call.id == run.get('_active_call_id') else 'not_executed'
        if call.name==agent_native.QUESTION.name and run['status']=='waiting_input':
            outcome='awaiting_response_cancelled'
        unfinished.append({'tool':call.name,'arguments':call.arguments,'outcome':outcome})
        agent_native.append_result(run,{'error_code':'agent_run_interrupted','outcome':outcome,
            'message':'Interrupted by the user. This is not a successful tool result.'})
    return unfinished


def redirect_history(run,text):
    unfinished=close_pending(run)
    consume_steering(run)
    reminder=''
    if unfinished:
        reminder='\nInterrupted calls requiring reconsideration before completing the task:\n'+json.dumps(unfinished,ensure_ascii=False)
        reminder+='\nRe-read still relevant sources. Do not infer their contents from cancelled calls.'
    run['_messages'].append(NativeMessage(role='user',content=text+reminder).model_dump())
    run.pop('_decision',None)
