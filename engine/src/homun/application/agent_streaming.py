"""Transient native stream callbacks fenced by the durable run lease."""
from time import monotonic
from datetime import timedelta
from homun.application.agent_runs import lookup, authority
from homun.application.agent_run_fencing import LEASE_SECONDS
from homun.domain.errors import DomainError
from homun.domain.models import Actor, utc_now


def complete(ctx,run,messages,**kwargs):
    from homun.application.runtime_selection import kwargs as runtime_kwargs
    kwargs.update(runtime_kwargs(ctx.models, run, connection_id=kwargs.get('connection_id'), model_id=kwargs.get('model_id')))
    if not run.get('native_stream'):
        return ctx.models.complete_tools(messages,**kwargs)
    token=run['_lease_token']
    last_progress=0.0
    last_renewal=0.0
    last_partial_chars=0
    last_reasoning_chars=0
    actor=Actor.model_validate(run['_actor'])

    def current_run(store):
        current=lookup(store,run['id'])
        work=store.works[current['work_id']]
        valid=(current.get('_lease_token')==token and current['status']=='running'
               and current.get('_steering',[])==run.get('_steering',[])
               and work.status=='running' and work.version==run['_run_version'])
        return current,valid

    def cancelled():
        nonlocal last_renewal
        now=monotonic()
        with ctx.repository.locked():
            if now-last_renewal < 30:
                _,valid=current_run(ctx.repository.load())
                return not valid
            with ctx.repository.transaction() as store:
                current,valid=current_run(store)
                if not valid:
                    return True
                try:
                    authority(ctx,store,actor,current,running=True)
                except DomainError:
                    return True
                current['_lease_until']=(utc_now()+timedelta(seconds=LEASE_SECONDS)).isoformat()
                last_renewal=now
                return False

    def progress(event):
        # Throttle progress counts at ~4 Hz, but always flush stream_partial when
        # commentary grows or tool_calls arrive — otherwise the tool-call boundary
        # keeps a stale prefix and the UI loses the commentary tail.
        nonlocal last_progress, last_partial_chars, last_reasoning_chars
        now=monotonic()
        text=event.get('text')
        reasoning=event.get('reasoning')
        tool_calls=event.get('tool_calls')
        text_chars=len(text) if isinstance(text,str) else 0
        reasoning_chars=len(reasoning) if isinstance(reasoning,str) else 0
        grew=text_chars>last_partial_chars or reasoning_chars>last_reasoning_chars
        tools_arrived=type(tool_calls) is int and tool_calls>0
        due=now-last_progress>=0.25
        if not due and not grew and not tools_arrived:
            return
        counts={key:event[key] for key in ('chunks','text_chars','tool_calls')
                if type(event.get(key)) is int and event[key]>=0}
        with ctx.repository.locked(),ctx.repository.transaction() as store:
            current,valid=current_run(store)
            if valid:
                current['stream_progress']=counts
                if isinstance(text,str) or isinstance(reasoning,str):
                    partial={}
                    if isinstance(text,str):
                        partial['text']=text[-200_000:]
                        last_partial_chars=text_chars
                    if isinstance(reasoning,str) and reasoning:
                        partial['reasoning']=reasoning[-200_000:]
                        last_reasoning_chars=reasoning_chars
                    current['stream_partial']=partial
        last_progress=now

    try:
        return ctx.models.complete_tools(messages,**kwargs,stream=True,cancel_check=cancelled,on_delta=progress)
    finally:
        with ctx.repository.locked(),ctx.repository.transaction() as store:
            current=lookup(store,run['id'])
            if current.get('_lease_token')==token:
                current.pop('stream_progress',None)
