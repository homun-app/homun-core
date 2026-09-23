"""MCP declarations and skills: staging invariants and a real offline probe."""
import json
import sys
import textwrap
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import Actor

# A tiny MCP-ish server: reads newline JSON-RPC, replies initialize + tools/list.
ECHO_SERVER = textwrap.dedent("""
    import json, sys
    tools = [
        {"name": "list_issues", "description": "elenco"},
        {"name": "create_issue", "description": "crea"},
        {"name": "delete_customer", "description": "distruttivo"},
    ]
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        if req.get("method") == "initialize":
            reply = {"jsonrpc": "2.0", "id": req["id"], "result": {
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "echo-test", "version": "1.0"}}}
        elif req.get("method") == "tools/list":
            reply = {"jsonrpc": "2.0", "id": req["id"], "result": {"tools": tools}}
        else:
            reply = {"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": "no"}}
        sys.stdout.write(json.dumps(reply) + "\\n")
        sys.stdout.flush()
""")


@pytest.fixture
def client(tmp_path: Path):
    (tmp_path / "echo_mcp.py").write_text(ECHO_SERVER, encoding="utf-8")
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=tmp_path / "ws.sqlite3",
                       data_dir=tmp_path, for_tests=True)
    )
    app = create_app()
    with TestClient(app) as tc:
        yield tc, str(tmp_path / "echo_mcp.py")
    reset_context_for_tests(None)


H = {"X-Homun-Actor-Id": "person_fabio"}


_server_seq = [0]


def _create_server(tc, script, **overrides):
    _server_seq[0] += 1
    body = {
        "command_id": f"cmd-srv-{_server_seq[0]}", "name": "echo",
        "transport": "stdio", "command": sys.executable, "args": [script],
    }
    body.update(overrides)
    response = tc.post("/v1/workspaces/ws_local/mcp/servers", headers=H, json=body)
    assert response.status_code == 200, response.text
    return response.json()["server_id"]


def test_server_declaration_validation(client):
    tc, script = client
    bad = tc.post("/v1/workspaces/ws_local/mcp/servers", headers=H,
                  json={"command_id": "x", "name": "nope", "transport": "stdio", "command": ""})
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "validation_error"
    bad_url = tc.post("/v1/workspaces/ws_local/mcp/servers", headers=H,
                      json={"command_id": "y", "name": "u", "transport": "http", "url": "ftp://x"})
    assert bad_url.status_code == 400


def test_probe_discovers_real_tools_and_applies_allowlist(client):
    tc, script = client
    server_id = _create_server(tc, script, tools_include=["list_issues", "create_issue"])
    response = tc.post(f"/v1/workspaces/ws_local/mcp/servers/{server_id}/test", headers=H)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["server_info"]["name"] == "echo-test"
    assert body["tools"] == ["list_issues", "create_issue"]  # allowlist vince
    assert body["tool_count_total"] == 3


def test_probe_exclude_and_failure_are_honest(client):
    tc, script = client
    server_id = _create_server(tc, script, tools_exclude=["delete_customer"])
    body = tc.post(f"/v1/workspaces/ws_local/mcp/servers/{server_id}/test", headers=H).json()
    assert "delete_customer" not in body["tools"]
    broken = _create_server(tc, script, command="/nonexistent/binary")
    failed = tc.post(f"/v1/workspaces/ws_local/mcp/servers/{broken}/test", headers=H)
    assert failed.status_code == 503 and failed.json()["detail"]["code"] == "mcp_probe_failed"


def test_agent_skill_is_always_staged_and_never_self_approves(client):
    tc, _ = client
    staged = tc.post("/v1/workspaces/ws_local/skills", headers=H, json={
        "command_id": "s1", "name": "Confronto listini", "description": "Procedura di confronto.",
        "body": "Passi...", "author_type": "agent", "status": "approved",
    }).json()
    assert staged["status"] == "staged"  # l'agente non si auto-approva
    approved = tc.post("/v1/workspaces/ws_local/skills", headers=H, json={
        "command_id": "s2", "name": "Manuale fornitori", "description": "Regole fornitore.",
        "body": "...", "author_type": "person", "status": "approved",
    }).json()
    assert approved["status"] == "approved"
    ok = tc.post(f"/v1/workspaces/ws_local/skills/{staged['skill_id']}/approve", headers=H,
                  json={"command_id": "a1", "expected_version": staged["revision"]})
    assert ok.status_code == 200 and ok.json()["status"] == "approved"
    items = tc.get("/v1/workspaces/ws_local/skills", headers=H).json()["items"]
    by_name = {i["name"]: i["status"] for i in items}
    assert by_name == {"Confronto listini": "approved", "Manuale fornitori": "approved"}


def test_skill_description_cap_and_archived_immutable(client):
    tc, _ = client
    too_long = tc.post("/v1/workspaces/ws_local/skills", headers=H, json={
        "command_id": "s3", "name": "X", "description": "d" * 61, "body": "",
    })
    assert too_long.status_code == 400
    created = tc.post("/v1/workspaces/ws_local/skills", headers=H, json={
        "command_id": "s4", "name": "Vecchia", "description": "da archiviare.", "body": "",
    }).json()
    archived = tc.post(f"/v1/workspaces/ws_local/skills/{created['skill_id']}/archive", headers=H,
                       json={"command_id": "ar", "expected_version": created["revision"]}).json()
    assert archived["status"] == "archived"
    again = tc.post(f"/v1/workspaces/ws_local/skills/{created['skill_id']}/approve", headers=H,
                    json={"command_id": "aa", "expected_version": archived["revision"]})
    assert again.status_code == 400


def test_external_tool_proposal_flow_e2e(client, tmp_path):
    """propose → approve (person) → execution → artifact ready for review."""
    from pathlib import Path as _Path
    echo_call = _Path(tmp_path) / "echo_call_mcp.py"
    echo_call.write_text(textwrap.dedent("""
        import json, sys
        for line in sys.stdin:
            req = json.loads(line.strip())
            if req.get("method") == "initialize":
                reply = {"jsonrpc": "2.0", "id": req["id"], "result": {
                    "protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                    "serverInfo": {"name": "echo-call", "version": "1.0"}}}
            elif req.get("method") == "tools/list":
                reply = {"jsonrpc": "2.0", "id": req["id"], "result": {"tools": [
                    {"name": "list_issues", "description": "elenco"}]}}
            elif req.get("method") == "tools/call":
                args = req["params"]["arguments"]
                reply = {"jsonrpc": "2.0", "id": req["id"], "result": {
                    "content": [{"type": "text", "text": f"3 aperte, filtro={args.get('stato')}"}], "isError": False}}
            else:
                reply = {"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": "no"}}
            sys.stdout.write(json.dumps(reply) + "\\n"); sys.stdout.flush()
    """), encoding="utf-8")
    tc, _ = client
    # lavoro su cui registrare la chiamata
    from homun.context import get_context
    ctx = get_context()
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    conv = ctx.service.apply(actor, "cc", "conversation.create", {"title": "T"})
    work = ctx.service.apply(actor, "ww", "work.create",
                             {"conversation_id": conv["conversation_id"], "title": "T", "objective": "O"})
    wid = work["work_id"]
    ctx.persist()
    server_id = _create_server(tc, str(echo_call), tools_include=["list_issues"])
    proposal = tc.post("/v1/workspaces/ws_local/mcp/tools/propose", headers=H, json={
        "command_id": "p1", "work_id": wid, "server_id": server_id,
        "tool": "list_issues", "arguments": {"stato": "aperto"},
    }).json()
    assert proposal["status"] == "pending_approval"
    digest_value = proposal["digest"]
    approved = tc.post(f"/v1/workspaces/ws_local/mcp/tools/{proposal['id']}/approve", headers=H,
                       json={"command_id": "a1", "digest": digest_value}).json()
    assert approved["status"] == "completed", approved
    assert approved.get("artifact_id")
    store = ctx.repository.load()
    from homun.domain.states import WorkStatus
    assert store.works[wid].status == WorkStatus.REVIEW
    artifacts = [a for a in store.artifacts.values() if a.work_id == wid]
    assert any("3 aperte" in a.content for a in artifacts)
    messages = [m.text for m in store.messages.values() if m.conversation_id == conv["conversation_id"]]
    assert any("Strumento esterno completato" in t for t in messages)


def test_external_tool_rejects_non_matching_digest_and_disabled_tool(client, tmp_path):
    from pathlib import Path as _Path
    tc, script = client
    from homun.context import get_context
    ctx = get_context()
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    conv = ctx.service.apply(actor, "cc2", "conversation.create", {"title": "T"})
    work = ctx.service.apply(actor, "ww2", "work.create",
                             {"conversation_id": conv["conversation_id"], "title": "T", "objective": "O"})
    ctx.persist()
    server_id = _create_server(tc, script)
    bad_digest = tc.post("/v1/workspaces/ws_local/mcp/tools/propose", headers=H, json={
        "command_id": "p2", "work_id": work["work_id"], "server_id": server_id,
        "tool": "list_issues", "arguments": {},
    }).json()
    rejected = tc.post(f"/v1/workspaces/ws_local/mcp/tools/{bad_digest['id']}/approve", headers=H,
                       json={"command_id": "a2", "digest": "forged"})
    assert rejected.status_code == 400
    # strumento fuori allowlist
    outside = tc.post("/v1/workspaces/ws_local/mcp/tools/propose", headers=H, json={
        "command_id": "p3", "work_id": work["work_id"], "server_id": server_id,
        "tool": "delete_customer", "arguments": {},
    })
    assert outside.status_code == 400


def test_catalog_lists_vetted_entries_with_visible_source(client):
    tc, _ = client
    items = tc.get("/v1/workspaces/ws_local/mcp/catalog", headers=H).json()["items"]
    assert len(items) >= 4
    for entry in items:
        assert entry["name"] and entry["source"]
        assert entry["command"] or entry["transport"] == "http"
        assert isinstance(entry["tools_include"], list)
    fs = next(e for e in items if e["id"] == "filesystem")
    assert fs["needs_path"] and "server-filesystem" in fs["command"] + " ".join(fs["args_prefix"])


def test_declaring_from_catalog_creates_inert_declaration(client, tmp_path):
    """Catalog -> declaration path: the person's click, not an install side-effect."""
    tc, _ = client
    from homun.context import get_context
    ctx = get_context()
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    entry = next(e for e in tc.get("/v1/workspaces/ws_local/mcp/catalog", headers=H).json()["items"]
                 if e["id"] == "git")
    args = [*entry["args_prefix"], "/tmp/repo-di-prova"]
    created = tc.post("/v1/workspaces/ws_local/mcp/servers", headers=H, json={
        "command_id": "cat1", "name": entry["name"], "transport": entry["transport"],
        "command": entry["command"], "args": args,
        "tools_include": entry["tools_include"],
    }).json()
    assert created["status"] == "enabled"
    store = ctx.repository.load()
    server = store.external_servers[created["server_id"]]
    assert server.args[-1] == "/tmp/repo-di-prova"
    assert "write_query" not in server.tools_include
