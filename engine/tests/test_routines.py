"""Routines: the automation repeats the assignment, never the approval."""
import json
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


def _seed_routine_base(actor):
    from homun.context import get_context
    ctx = get_context()
    conv = ctx.service.apply(actor, "rc", "conversation.create", {"title": "Diario routine"})
    agent = ctx.service.apply(actor, "ra", "agent.create",
                              {"name": "Ada", "role": "Analisi", "instructions": "Confronta"})
    ctx.persist()
    return conv["conversation_id"], agent["agent_id"]


def _template(agent_id):
    return {
        "title": "Confronto listini settimanale",
        "objective": "Confrontare i listini aggiornati.",
        "plan_steps": [
            {"title": "Confronto listini", "assignee_id": agent_id, "capability": "compare_csv",
             "output_expected": "Report differenze"},
        ],
    }


def test_routine_create_validates_template_and_cron(client):
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    conv_id, agent_id = _seed_routine_base(actor)
    bad = client.post("/v1/workspaces/ws_local/routines",
                      headers={"X-Homun-Actor-Id": actor.id},
                      json={"command_id": "c1", "cron": "0 9 * * 1", "conversation_id": conv_id,
                            "template": {"title": "T", "objective": "O",
                                         "plan_steps": [{"title": "X", "assignee_id": "missing"}]}})
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "validation_error"
    bad_cron = client.post("/v1/workspaces/ws_local/routines",
                           headers={"X-Homun-Actor-Id": actor.id},
                           json={"command_id": "c2", "cron": "not a cron", "conversation_id": conv_id,
                                 "template": _template(agent_id)})
    assert bad_cron.status_code == 400


def test_run_recurrence_creates_supervised_work_and_is_idempotent(client):
    """Domain recurrence: template → accepted plan; replay of the same instant is a no-op."""
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    conv_id, agent_id = _seed_routine_base(actor)
    from homun.context import get_context
    from homun.application import routine_runs
    ctx = get_context()
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(actor, "cr", "routine.create", {
            "name": "Settimanale", "cron": "0 9 * * 1", "conversation_id": conv_id,
            "template": _template(agent_id),
        })
    routine_id = next(iter(ctx.repository.load().routines))
    first = routine_runs.run_recurrence(ctx, actor, routine_id, "2026-09-28T07:00:00+00:00")
    assert first and first["status"] == "ready"
    store = ctx.repository.load()
    work = store.works[first["work_id"]]
    assert work.origin_routine_id == routine_id
    assert work.scheduled_for == "2026-09-28T07:00:00+00:00"
    plan = store.plans[store.plan_key(work.id, work.current_plan_revision)]
    assert plan.steps[0].title == "Confronto listini"
    assert plan.steps[0].assignee_id == agent_id
    messages = [m.text for m in store.messages.values() if m.conversation_id == conv_id]
    assert any("Ricorrenza pronta" in t and "aspetta il tuo via" in t for t in messages)
    # replay dello stesso istante: nessun duplicato
    again = routine_runs.run_recurrence(ctx, actor, routine_id, "2026-09-28T07:00:00+00:00")
    assert again is None
    assert len([w for w in ctx.repository.load().works.values()
                if w.origin_routine_id == routine_id]) == 1


def test_pause_blocks_recurrence_and_stop_is_terminal(client):
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    conv_id, agent_id = _seed_routine_base(actor)
    from homun.context import get_context
    from homun.application import routine_runs
    ctx = get_context()
    with ctx.repository.transaction() as store:
        service = ctx.service.for_store(store)
        service.apply(actor, "cr", "routine.create", {
            "name": "R", "cron": "0 9 * * 1", "conversation_id": conv_id,
            "template": _template(agent_id),
        })
    routine_id = next(iter(ctx.repository.load().routines))
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(actor, "p", "routine.pause",
                                           {"routine_id": routine_id, "expected_version": 1})
    assert routine_runs.run_recurrence(ctx, actor, routine_id, "2026-10-05T07:00:00+00:00") is None
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(actor, "r", "routine.resume",
                                           {"routine_id": routine_id, "expected_version": 2})
    resumed = routine_runs.run_recurrence(ctx, actor, routine_id, "2026-10-05T07:00:00+00:00")
    assert resumed and resumed["status"] == "ready"
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(actor, "s", "routine.stop",
                                           {"routine_id": routine_id, "expected_version": 3})
    assert routine_runs.run_recurrence(ctx, actor, routine_id, "2026-10-12T07:00:00+00:00") is None
    items = client.get("/v1/workspaces/ws_local/routines",
                       headers={"X-Homun-Actor-Id": actor.id}).json()["items"]
    assert items[0]["status"] == "stopped"


def test_cron_preview_endpoint(client):
    ok = client.get("/v1/workspaces/ws_local/routines/preview",
                    params={"cron": "0 9 * * 1", "tz": "Europe/Rome"})
    assert ok.status_code == 200 and len(ok.json()["next"]) == 3
    bad = client.get("/v1/workspaces/ws_local/routines/preview",
                     params={"cron": "garbage"})
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "validation_error"
