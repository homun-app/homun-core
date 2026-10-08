"""Bounded parallel execution of audited local reads, with ordered admission."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from homun.application import agent_native
from homun.application.agent_runs import authority, lookup
from homun.application.agent_tool_registry import registry_for
from homun.application.workspace_files import execute as file_executor
from homun.domain.errors import ValidationError

# Read-only metadata is necessary but insufficient: plugins and remote tools may
# own mutable sessions. Only these bounded, local, stateless handlers are audited.
PARALLEL_SAFE = frozenset({'list_materials','read_material','search_materials',
                          'list_workspace_files','read_workspace_file','search_workspace_files'})
MAX_WORKERS = 4


def select(run):
    if not run.get('parallel_read_tools') or not agent_native.enabled(run):
        return []
    manifest = {item['name']:item for item in registry_for(run).manifest()}
    answered = {m.get('tool_call_id') for m in run['_messages'] if m['role']=='tool'}
    calls = []
    remaining = run['limits']['max_turns'] - run['turns']
    for message in agent_native.history(run):
        for call in message.tool_calls:
            if call.id in answered:
                continue
            metadata = manifest.get(call.name,{})
            if (call.name not in PARALLEL_SAFE or metadata.get('replay') != 'read_only'
                    or metadata.get('kind') != 'tool'):
                return calls if len(calls)>1 else []
            calls.append(call)
            if len(calls) >= min(MAX_WORKERS,remaining):
                return calls if len(calls)>1 else []
    return calls if len(calls)>1 else []


def execute(ctx, actor, snapshot, calls, *, material_executor):
    token = snapshot['_lease_token']
    with ctx.repository.locked(), ctx.repository.transaction() as store:
        current = lookup(store,snapshot['id'])
        if current.get('_lease_token') != token:
            return current['status']
        authority(ctx,store,actor,current,running=True)
        if [c.id for c in select(current)] != [c.id for c in calls]:
            raise ValidationError('Read batch changed before dispatch')
        current['_active_call_ids'] = [call.id for call in calls]
    registry = registry_for(snapshot,material_executor=material_executor,file_executor=file_executor)

    def read(call):
        with ctx.repository.locked():
            store = ctx.repository.load()
            current = lookup(store,snapshot['id'])
            if current.get('_lease_token') != token:
                return {'error_code':'agent_run_interrupted','outcome':'not_executed'}
            authority(ctx,store,actor,current,running=True)
        try:
            return registry.dispatch(call.name,call.arguments,ctx=ctx,actor=actor,run=deepcopy(snapshot))
        except ValidationError as exc:
            return {'error_code':exc.code,'message':exc.message}

    with ThreadPoolExecutor(max_workers=MAX_WORKERS,thread_name_prefix='homun-read') as pool:
        futures = [pool.submit(read,call) for call in calls]
        results = [future.result() for future in futures]
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store,snapshot['id'])
            if current.get('_lease_token') != token:
                return current['status']
            authority(ctx,store,actor,current,running=True)
            for call,result in zip(calls,results):
                pending = agent_native.pending(current)
                if pending is None or pending.id != call.id:
                    raise ValidationError('Read batch changed before result admission')
                from homun.application.subdirectory_hints import track_and_attach_hints
                wd = current.get('_workspace_root') or current.get('_cwd')
                result, _ = track_and_attach_hints(current, call.name, call.arguments or {}, result, working_dir=wd)
                projected = agent_native.append_result(current,result)
                current['observations'].append({'tool':call.name,'arguments':call.arguments,
                    'message':f'Use {call.name}','result':projected})
                current['turns'] += 1
            for key in ('_active_call_ids','_active_call_id','_decision','_lease_token','_lease_until'):
                current.pop(key,None)
            status = current['status']
        ctx.service.store = store
    return status
