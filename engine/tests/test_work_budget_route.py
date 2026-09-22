"""The works list carries the per-work budget (Fonte=motore)."""
import json
from types import SimpleNamespace
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import Actor


@pytest.fixture
def client(tmp_path: Path):
    reset_context_for_tests(
        create_context(
            workspace_id="ws_local",
            db_path=tmp_path / "ws_local.sqlite3",
            data_dir=tmp_path,
            for_tests=True,
        )
    )
    app = create_app()
    with TestClient(app) as tc:
        yield tc
    reset_context_for_tests(None)


def test_works_list_reports_budget_and_set_budget_updates_caps(client):
    tc, = client,
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    ctx = __import__("homun.context", fromlist=["get_context"]).get_context()
    conv = ctx.service.apply(actor, "c", "conversation.create", {"title": "B"})
    work = ctx.service.apply(actor, "w", "work.create",
                             {"conversation_id": conv["conversation_id"], "title": "B", "objective": "O"})
    wid = work["work_id"]
    ctx.persist()
    brief = {"title": "T", "objective": "O", "output": "R", "constraints": [], "missing_information": [],
             "suggested_agent_id": None, "new_agent": None, "rationale": "r", "capability": "general"}
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    from homun.application.intake import propose, confirm
    p = propose(ctx, actor, wid, {"command_id": "i", "text": "un lavoro", "expected_version": 1})
    confirm(ctx, actor, wid, "i", {"command_id": "ok", "digest": p["digest"], "expected_version": 1,
                                   "create_agent": False})
    ctx.service.apply(actor, "sb", "work.set_budget", {"work_id": wid, "caps": {"model_attempts": 12}})
    ctx.persist()
    items = tc.get("/v1/workspaces/ws_local/works",
                   headers={"X-Homun-Actor-Id": actor.id}).json()["items"]
    entry = next(w for w in items if w["id"] == wid)
    assert entry["budget"]["caps"]["model_attempts"] == 12
    assert entry["budget"]["spent"]["attempts"] >= 0
