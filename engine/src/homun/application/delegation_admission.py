"""Admit an isolated, scoped canonical child under the parent's approval."""
from copy import deepcopy
from hashlib import sha256
import json
import jsonschema

from homun.domain.errors import ValidationError
from homun.domain.models import CommandRecord
from homun.models.native_prompt import initial_messages


from homun.application.delegation_authority import DelegationError, admitted_parent


def admit(ctx, actor, run, args):
    PROPOSAL_TYPE = "agent_run.propose"
    from homun.application.executor import resolve_executor
    schema = args.get('output_schema')
    if schema is not None:
        try:
            from homun.application.delegation_schema import validate_output_schema
            validate_output_schema(schema)
        except (jsonschema.SchemaError, ValueError, RecursionError) as exc:
            raise DelegationError('delegation_schema_invalid', 'Invalid output schema') from exc
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            parent = admitted_parent(ctx, store, actor, run)
            call = next((c for m in parent.get('_messages', []) for c in m.get('tool_calls', [])
                         if c['id'] == parent.get('_active_call_id')), None)
            if not call or call['name'] != 'delegate_task':
                raise DelegationError('delegation_call_required', 'A persisted delegation tool call is required')
            delegation_id = 'del_' + sha256(f'{parent["id"]}:{call["id"]}'.encode()).hexdigest()[:24]
            child_id = 'child:' + delegation_id
            fingerprint = sha256(json.dumps(args, sort_keys=True).encode()).hexdigest()
            previous = store.commands.get(child_id)
            if previous:
                if previous.request_fingerprint != fingerprint:
                    raise DelegationError('delegation_replay_conflict', 'Delegation call arguments changed')
                handle = deepcopy(parent['_delegations'][delegation_id])
            else:
                if parent.get('delegation', {}).get('worktree_isolation'):
                    raise DelegationError('delegation_isolation_unavailable', 'Worktree isolation requires an approved owned checkout')
                assignee = args.get('agent_id') or parent['assignee_id']
                approved_agents = {parent['assignee_id']} | {m['id'] for m in (parent.get('team') or {}).get('members', [])}
                if assignee not in approved_agents:
                    raise DelegationError('delegation_agent_not_approved', 'Delegate must belong to the approved team')
                agent = resolve_executor(store, assignee, human_owner_id=store.works[parent['work_id']].owner_id)
                manifest = parent['tools']
                from homun.application.surface_toolset_policy import WRITE_TOOL_NAMES
                safe = {item['name'] for item in manifest if item.get('replay') == 'read_only'
                        and item['name'] not in WRITE_TOOL_NAMES
                        and item.get('toolset') not in {'delegation','goals','cron','sessions','session_management',
                            'gateway','code_execution','plugins','human','discovery'}}
                # Discovery can expose only the child's already-restricted registry.
                requested = args.get('tools_include')
                allowed = sorted(safe if requested is None else set(requested))
                if set(allowed) - safe:
                    raise DelegationError('delegation_tool_unavailable', 'Child tools must be read-only members of the approved parent catalog')
                turns = min(int(args.get('max_turns', 3)), 10)
                if turns < 1 or turns > parent['limits']['max_turns'] - parent['turns'] - 2:
                    raise DelegationError('delegation_budget_exhausted', 'Insufficient approved turns for child and parent completion')
                attempts = turns
                if attempts > parent['limits']['max_model_attempts'] - parent['model_attempts'] - 1:
                    raise DelegationError('delegation_budget_exhausted', 'Insufficient approved model attempts for delegation')
                child = deepcopy(parent)
                for key in list(child):
                    if key.startswith('_') and key not in {'_actor','_run_version','_executor_revision','_protocol',
                        '_registry_version','_tool_bridge_version','_mcp_bindings','_workspace_files_version',
                        '_result_storage_version','_context_policy','_cwd','_workspace_root','_step_id',
                        '_liveness_version','_continuation_version'}:
                        child.pop(key)
                for key in ('artifact_id','request_id','automation_wait','recovery','delegation','goals','cron','session_management','gateway','code_execution','plugins'):
                    child.pop(key, None)
                instructions = agent.instructions if agent else parent.get('_instructions', '')
                task = args['task'].strip()
                if schema:
                    instructions += '\nReturn JSON matching: ' + json.dumps(schema)
                child.update(id=child_id, status='queued', turns=0, model_attempts=0, observations=[],
                    assignee_id=assignee, executor_name=agent.name if agent else parent['executor_name'],
                    allowed_tools=allowed, _epoch=0, _executor_revision=agent.revision if agent else None,
                    _workflow_id=f'agent:{actor.workspace_id}:{child_id}:0',
                    _objective=task, _instructions=instructions,
                    _messages=[m.model_dump() for m in initial_messages(task, instructions)],
                    _delegation_parent={'run_id':parent['id'], 'epoch':parent['_epoch'],
                        'work_id':parent['work_id'], 'delegation_id':delegation_id, 'call_id':call['id'],
                        'allocated_turns':turns, 'allocated_attempts':attempts, 'output_schema':schema})
                child['limits']['max_turns'], child['limits']['max_model_attempts'] = turns, attempts
                child.pop('tools', None)
                child['tools'] = [deepcopy(item) for item in manifest if item['name'] in allowed]
                parent['limits']['max_turns'] -= turns
                parent['limits']['max_model_attempts'] -= attempts
                handle = {'delegation_id':delegation_id, 'child_run_id':child_id, 'status':'queued',
                    'task':task, 'agent_id':assignee, 'tools_include':allowed, 'max_turns':turns,
                    'wait_for_child':not bool(args.get('run_in_background')), 'turns_used':0}
                parent.setdefault('_delegations', {})[delegation_id] = handle
                store.commands[child_id] = CommandRecord(command_id=child_id, type=PROPOSAL_TYPE,
                    actor_id=actor.id, workspace_id=actor.workspace_id, request_fingerprint=fingerprint, result=child)
            run.setdefault('_delegations', {})[delegation_id] = deepcopy(handle)
        ctx.service.store = store
    return deepcopy(handle)
