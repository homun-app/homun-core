import pytest
from homun.domain.errors import ConflictError, ValidationError


def descriptor():
    return {'name':'write','description':'Write one record','inputSchema':{'type':'object','properties':{'count':{'type':'integer'}},'required':['count'],'additionalProperties':False}}


def test_descriptor_arguments_are_validated_without_coercion_or_value_leaks():
    from homun.application.mcp_contracts import validate_arguments
    validate_arguments(descriptor(),{'count':1})
    for args in [{'count':'private-value'},{'count':True},{'count':1,'extra':2},{}]:
        with pytest.raises(ValidationError) as exc:validate_arguments(descriptor(),args)
        assert 'private-value' not in str(exc.value)


def test_missing_duplicate_and_invalid_descriptors_fail_closed():
    from homun.application.mcp_contracts import select_descriptor
    for descriptors in [[],[descriptor(),descriptor()],[{'name':'write','inputSchema':{'type':'wrong'}}]]:
        with pytest.raises(ValidationError):select_descriptor(descriptors,'write')


def test_remote_schema_reference_is_not_fetched():
    from homun.application.mcp_contracts import validate_arguments
    tool=descriptor();tool['inputSchema']={'$ref':'https://invalid.example/private'}
    with pytest.raises(ValidationError):validate_arguments(tool,{})


def test_descriptor_comparison_includes_description_and_schema():
    from homun.application.mcp_contracts import require_same_descriptor
    require_same_descriptor(descriptor(),descriptor())
    changed=descriptor();changed['description']='Different behavior'
    with pytest.raises(ConflictError):require_same_descriptor(descriptor(),changed)

from test_external_receipts import setup, approve
from homun.application import external_tools, mcp_client


def test_proposal_pins_descriptor_and_replay_does_not_probe(setup,monkeypatch):
    ctx,actor,body,p,calls=setup
    saved=ctx.repository.load().commands[p['id']].result
    assert saved['_tool_descriptor']['name']=='write'
    monkeypatch.setattr(mcp_client,'probe_server',lambda *a:pytest.fail('rediscovery on replay'))
    assert external_tools.propose(ctx,actor,body)['digest']==p['digest']


def test_changed_descriptor_creates_fresh_approval(setup,monkeypatch):
    ctx,actor,body,p,calls=setup
    monkeypatch.setattr(mcp_client,'probe_server',lambda *a:{'tool_descriptors':[descriptor()]})
    fresh=external_tools.propose(ctx,actor,{**body,'command_id':'fresh','arguments':{'count':1}})
    assert fresh['id']=='fresh' and fresh['digest']!=p['digest']
    assert ctx.repository.load().commands[p['id']].result['status']=='blocked'


def test_server_change_during_discovery_rejects_proposal(setup,monkeypatch):
    ctx,actor,body,p,calls=setup
    def probe(server):
        with ctx.repository.transaction() as store:store.external_servers['srv'].command='changed'
        return {'tool_descriptors':[descriptor()]}
    monkeypatch.setattr(mcp_client,'probe_server',probe)
    with pytest.raises(ConflictError):external_tools.propose(ctx,actor,{**body,'command_id':'fresh','arguments':{'count':1}})
    assert 'fresh' not in ctx.repository.load().commands


def test_preflight_rejection_is_blocked_not_unknown(setup,monkeypatch):
    def reject(*args):raise mcp_client.MCPPreflightError('no call sent')
    monkeypatch.setattr(mcp_client,'call_tool',reject)
    assert approve(setup)['status']=='blocked'
    assert '_receipt' not in setup[0].repository.load().commands['p'].result


@pytest.mark.parametrize('changed',[False,True])
def test_real_session_checks_descriptor_before_call(tmp_path,changed):
    import json
    from test_mcp_protocol import server
    declared=server(tmp_path)
    script=tmp_path/'strict_mcp.py';log=tmp_path/'wire.jsonl'
    source=script.read_text().replace('    method = req[\'method\']',
        f"    with open({str(log)!r}, 'a') as log: log.write(json.dumps(req) + '\\n')\n    method = req['method']")
    script.write_text(source)
    pinned=mcp_client.probe_server(declared)['tool_descriptors'][0]
    log.write_text('')
    if changed:
        pinned['description']='Changed'
        with pytest.raises(mcp_client.MCPPreflightError):mcp_client.call_tool(declared,'first',{},pinned)
    else:
        assert mcp_client.call_tool(declared,'first',{},pinned)['text']=='done'
    methods=[json.loads(line)['method'] for line in log.read_text().splitlines()]
    assert 'tools/list' in methods
    assert methods.count('tools/call')==(0 if changed else 1)
    if not changed:assert methods.index('tools/list')<methods.index('tools/call')

@pytest.mark.parametrize('mode,preflight',[('init_missing',True),('list_missing',True),('call_missing',False)])
def test_timeout_classification_tracks_actual_dispatch_boundary(tmp_path,monkeypatch,mode,preflight):
    from test_mcp_protocol import server
    declared=server(tmp_path,mode)
    monkeypatch.setattr(mcp_client,'PROBE_TIMEOUT_SECONDS',.2)
    pinned={'name':'first','description':'example','inputSchema':{'type':'object','properties':{'q':{'type':'string'}}}}
    with pytest.raises(RuntimeError) as caught:mcp_client.call_tool(declared,'first',{},pinned)
    assert isinstance(caught.value,mcp_client.MCPPreflightError) is preflight
