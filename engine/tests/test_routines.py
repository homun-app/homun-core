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
    from homun.application.automation import routine_runs
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
    from homun.application.automation import routine_runs
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


def test_routine_update_revises_template_and_cron_versioned(client):
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    conv_id, agent_id = _seed_routine_base(actor)
    from homun.context import get_context
    from homun.application.automation import routine_runs
    ctx = get_context()
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(actor, "cr", "routine.create", {
            "name": "R", "cron": "0 9 * * 1", "conversation_id": conv_id,
            "template": _template(agent_id),
        })
    routine_id = next(iter(ctx.repository.load().routines))
    revised_template = _template(agent_id)
    revised_template["title"] = "Confronto listini — edizione rivista"
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(actor, "u", "routine.update", {
            "routine_id": routine_id, "expected_version": 1,
            "name": "Settimanale rivista", "cron": "0 8 * * 2",
            "template": revised_template,
        })
    run = routine_runs.run_recurrence(ctx, actor, routine_id, "2026-09-29T06:00:00+00:00")
    assert run and run["status"] == "ready"
    store = ctx.repository.load()
    work = store.works[run["work_id"]]
    assert work.title == "Confronto listini — edizione rivista"
    assert store.routines[routine_id].cron == "0 8 * * 2"


# --- D1: l'ora locale scelta dalla persona resta quella in ogni stagione ----
# Il calcolo delle occorrenze attraversa i cambi d'ora (25/10 e 29/03 per
# Europe/Rome) senza slittare di un'ora: preview e skip_next condividono la
# stessa funzione, quindi i due percorsi non possono divergere.

from datetime import datetime
from zoneinfo import ZoneInfo

ROME = ZoneInfo("Europe/Rome")


def test_next_occurrence_crosses_autumn_dst_change_at_the_local_hour():
    """«Ogni lunedì alle 9» resta alle 9 anche attraversando il 25/10/2026."""
    from homun.application.automation.routines import next_occurrences
    # lunedì 19/10/2026, prima del cambio d'ora: il lunedì dopo (26/10) è
    # oltre il ritorno all'ora solare
    occurrences = next_occurrences("0 9 * * 1", "Europe/Rome", count=2,
                                   after=datetime(2026, 10, 19, 12, 0, tzinfo=ROME))
    assert [o.isoformat() for o in occurrences] == [
        "2026-10-26T09:00:00+01:00",
        "2026-11-02T09:00:00+01:00",
    ]


def test_next_occurrence_crosses_spring_dst_change_at_the_local_hour():
    from homun.application.automation.routines import next_occurrences
    occurrences = next_occurrences("0 9 * * 1", "Europe/Rome", count=2,
                                   after=datetime(2026, 3, 23, 12, 0, tzinfo=ROME))
    assert [o.isoformat() for o in occurrences] == [
        "2026-03-30T09:00:00+02:00",
        "2026-04-06T09:00:00+02:00",
    ]


def test_next_occurrence_nonexistent_hour_maps_to_next_valid_hour():
    """Le 02:30 della notte di primavera (29/03/2026) non esistono: l'occorrenza
    scivola sulla prima ora valida successiva (le 03:30), come documentato."""
    from homun.application.automation.routines import next_occurrences
    occurrences = next_occurrences("30 2 * * *", "Europe/Rome", count=2,
                                   after=datetime(2026, 3, 28, 12, 0, tzinfo=ROME))
    assert [o.isoformat() for o in occurrences] == [
        "2026-03-29T03:30:00+02:00",
        "2026-03-30T02:30:00+02:00",
    ]


def test_next_occurrence_repeated_hour_runs_once():
    """Le 02:30 della notte d'autunno (25/10/2026) esistono due volte: la
    routine parte una sola volta (la prima delle due)."""
    from homun.application.automation.routines import next_occurrences
    occurrences = next_occurrences("30 2 * * *", "Europe/Rome", count=2,
                                   after=datetime(2026, 10, 24, 12, 0, tzinfo=ROME))
    assert [o.isoformat() for o in occurrences] == [
        "2026-10-25T02:30:00+02:00",
        "2026-10-26T02:30:00+01:00",
    ]


def test_next_occurrence_quarter_hours_stay_distinct_around_dst_changes():
    """`*/15` attorno ai cambi: sequenza stretta, crescente, senza duplicati —
    i quarti d'ora inesistenti collassano nel salto, quelli ripetuti valgono
    una volta sola."""
    from homun.application.automation.routines import next_occurrences
    # primavera: 02:00–02:45 del 29/03 non esistono
    spring = next_occurrences("*/15 * * * *", "Europe/Rome", count=5,
                              after=datetime(2026, 3, 29, 1, 40, tzinfo=ROME))
    assert [o.isoformat() for o in spring] == [
        "2026-03-29T01:45:00+01:00",
        "2026-03-29T03:00:00+02:00",
        "2026-03-29T03:15:00+02:00",
        "2026-03-29T03:30:00+02:00",
        "2026-03-29T03:45:00+02:00",
    ]
    # autunno: l'ora 02:00–02:59 del 25/10 esiste due volte
    autumn = next_occurrences("*/15 * * * *", "Europe/Rome", count=6,
                              after=datetime(2026, 10, 25, 1, 40, tzinfo=ROME))
    assert [o.isoformat() for o in autumn] == [
        "2026-10-25T01:45:00+02:00",
        "2026-10-25T02:00:00+02:00",
        "2026-10-25T02:15:00+02:00",
        "2026-10-25T02:30:00+02:00",
        "2026-10-25T02:45:00+02:00",
        "2026-10-25T03:00:00+01:00",
    ]


def test_next_occurrence_honors_a_foreign_timezone():
    from homun.application.automation.routines import next_occurrences
    occurrences = next_occurrences("0 9 * * 1", "America/New_York", count=1,
                                   after=datetime(2026, 10, 26, 12, 0,
                                                  tzinfo=ZoneInfo("America/New_York")))
    assert [o.isoformat() for o in occurrences] == ["2026-11-02T09:00:00-05:00"]


def test_cron_preview_endpoint_renormalizes_dst_offset(client, monkeypatch):
    """L'anteprima passa dallo stesso calcolo dell'esecuzione: attraversando il
    cambio d'ora del 25/10/2026 la prossima esecuzione resta alle 9 locali."""
    from homun.application.automation import routine_schedule
    monkeypatch.setattr(routine_schedule, "_now_local",
                        lambda zone: datetime(2026, 10, 19, 12, 0, tzinfo=zone))
    ok = client.get("/v1/workspaces/ws_local/routines/preview",
                    params={"cron": "0 9 * * 1", "tz": "Europe/Rome"})
    assert ok.status_code == 200
    assert ok.json()["next"][0] == "2026-10-26T09:00:00+01:00"


def test_skip_next_consumes_occurrence_without_running(client):
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    conv_id, agent_id = _seed_routine_base(actor)
    from homun.context import get_context
    from homun.application.automation import routine_runs
    ctx = get_context()
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(actor, "cr", "routine.create", {
            "name": "R", "cron": "0 9 * * 1", "conversation_id": conv_id,
            "template": _template(agent_id),
        })
    routine_id = next(iter(ctx.repository.load().routines))
    from homun.application.automation.routines import next_occurrence as app_next
    skip_until = app_next("0 9 * * 1", "Europe/Rome")
    from homun.application.automation import routines as app_routines
    app_routines.routine_action(ctx, actor, "skip_next", {
        "command_id": "sk", "routine_id": routine_id, "expected_version": 1})
    store = ctx.repository.load()
    assert store.routines[routine_id].skip_until == skip_until
    # un'occorrenza prima del skip_until non crea lavoro
    assert routine_runs.run_recurrence(ctx, actor, routine_id, skip_until) is None
    # l'occorrenza successiva (dopo skip_until) corre
    from datetime import datetime
    from dbos._scheduler import croniter
    after = datetime.fromisoformat(skip_until)
    nxt = croniter("0 9 * * 1", after).get_next(datetime).astimezone(after.tzinfo).isoformat()
    run = routine_runs.run_recurrence(ctx, actor, routine_id, nxt)
    assert run and run["status"] == "ready"
