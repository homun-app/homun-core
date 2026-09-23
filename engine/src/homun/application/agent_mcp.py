"""Selected MCP surfaces; discovery grants availability, never execution."""
from copy import deepcopy
import hashlib
import re
from typing import Any
from pydantic import RootModel, model_validator
from homun.application import mcp_client
from homun.application.mcp_contracts import select_descriptor, validate_arguments, server_hash
from homun.domain.errors import ConflictError, ValidationError
from homun.models.agent_turn import ToolDefinition
from homun.policy.work import require_work_access
from homun.tools.registry import ToolEntry


def wire_name(server_id, tool):
    raw=f'{server_id}:{tool}'
    prefix=re.sub(r'[^A-Za-z0-9_]', '_', f'mcp__{server_id}__{tool}')
    return prefix[:51]+'_'+hashlib.sha256(raw.encode()).hexdigest()[:12]


def discover(ctx,actor,work_id,body):
    store=ctx.repository.load()
    require_work_access(store,actor,work_id)
    existing=store.commands.get(body['command_id'])
    if existing:
        return deepcopy(existing.result.get('_mcp_bindings',[]))
    ids=list(dict.fromkeys(body.get('server_ids') or []))
    if len(ids)>4:
        raise ValidationError('Select at most four external servers')
    bindings=[]
    for server_id in ids:
        server=store.external_servers.get(server_id)
        if server is None or server.status!='enabled':
            raise ConflictError('Selected external server unavailable')
        try:
            descriptors=mcp_client.probe_server(server)['tool_descriptors']
        except Exception as exc:
            raise ValidationError('Cannot discover selected external server') from exc
        for descriptor in descriptors:
            descriptor=select_descriptor(descriptors,descriptor['name'])
            bindings.append({'server_id':server.id,'server_name':server.name,'server_hash':server_hash(server),
                'tool':descriptor['name'],'name':wire_name(server.id,descriptor['name']),'descriptor':descriptor})
            if len(bindings)>32:
                raise ValidationError('Select servers exposing at most 32 tools')
    return bindings


def validate_bindings(store,bindings):
    for binding in bindings:
        server=store.external_servers.get(binding['server_id'])
        if server is None or server.status!='enabled' or server_hash(server)!=binding['server_hash']:
            raise ConflictError('Selected external server changed')


def entries(bindings):
    for binding in bindings:
        descriptor=deepcopy(binding['descriptor'])
        def make_arguments(pinned):
            class Arguments(RootModel[dict[str,Any]]):
                @model_validator(mode='after')
                def validate_contract(self):
                    validate_arguments(pinned,self.root)
                    return self
            return Arguments
        yield ToolEntry(ToolDefinition(name=binding['name'],
            description=f"{descriptor.get('description') or binding['tool']} Human approval is required before this external action.",
            input_schema=descriptor['inputSchema']), 'mcp', '1', make_arguments(descriptor), replay='never')
