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


def test_documents_library_lists_reviewed_artifacts_actor_scoped(client):
    tc, = client,
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    from homun.context import get_context
    ctx = get_context()
    conv = ctx.service.apply(actor, "dc", "conversation.create", {"title": "D"})
    work = ctx.service.apply(actor, "dw", "work.create",
                             {"conversation_id": conv["conversation_id"], "title": "Lavoro documento", "objective": "O"})
    wid = work["work_id"]
    ctx.persist()
    ctx.service.apply(actor, "dp", "plan.propose", {"work_id": wid, "expected_version": 1, "steps": [
        {"title": "Consegna", "assignee_id": actor.id}]})
    ctx.service.apply(actor, "dpa", "plan.accept", {"work_id": wid, "expected_version": 2})
    started = ctx.service.apply(actor, "da", "work.start", {"work_id": wid, "expected_version": 3})
    ctx.service.apply(actor, "ds", "work.submit_artifact",
                      {"work_id": wid, "expected_version": started["version"],
                       "title": "Esito verificato", "content": "contenuto del documento"})
    ctx.persist()
    items = tc.get("/v1/workspaces/ws_local/artifacts",
                   headers={"X-Homun-Actor-Id": actor.id}).json()["items"]
    entry = next(a for a in items if a["work_id"] == wid)
    assert entry["title"] == "Esito verificato"
    assert entry["work_title"] == "Lavoro documento"
    assert entry["content"] == "contenuto del documento"


def test_work_set_due_persists_and_validates(client):
    tc, = client,
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    from homun.context import get_context
    from homun.domain.errors import DomainError
    ctx = get_context()
    conv = ctx.service.apply(actor, "sc", "conversation.create", {"title": "S"})
    work = ctx.service.apply(actor, "sw", "work.create",
                             {"conversation_id": conv["conversation_id"], "title": "Con scadenza", "objective": "O"})
    wid = work["work_id"]
    ctx.persist()
    ctx.service.apply(actor, "sd", "work.set_due", {"work_id": wid, "expected_version": 1, "due_date": "2026-09-30"})
    ctx.persist()
    items = tc.get("/v1/workspaces/ws_local/works",
                   headers={"X-Homun-Actor-Id": actor.id}).json()["items"]
    entry = next(w for w in items if w["id"] == wid)
    assert entry["due_date"] == "2026-09-30"
    try:
        ctx.service.apply(actor, "sdx", "work.set_due", {"work_id": wid, "expected_version": 2, "due_date": "31/09/2026"})
        raise AssertionError("data invalida accettata")
    except Exception as exc:
        assert isinstance(exc, DomainError)
    ctx.service.apply(actor, "sdc", "work.set_due", {"work_id": wid, "expected_version": 2, "due_date": None})
    ctx.persist()
    items = tc.get("/v1/workspaces/ws_local/works",
                   headers={"X-Homun-Actor-Id": actor.id}).json()["items"]
    entry = next(w for w in items if w["id"] == wid)
    assert entry["due_date"] is None
