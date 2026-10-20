"""Il battito delle routine: Homun decide quando una routine è dovuta, DBOS
fornisce solo il battito durevole (uno schedule al minuto, in UTC).

Invariante: una routine «ogni lunedì alle 9» in Europe/Rome PARTE alle 9:00
locali in ogni stagione, anche se il motore era acceso da prima del cambio
d'ora; anteprima ed esecuzione usano lo stesso calcolo (`next_occurrences`).
L'orologio è simulato: i test fissano `routine_schedule._now_local`.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.automation import routine_runs, routine_schedule, routine_tick
from homun.application.automation import routines as app_routines
from homun.context import create_context, get_context, reset_context_for_tests
from homun.domain.models import Actor

ROME = ZoneInfo("Europe/Rome")
ACTOR = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")


class Clock:
    """Orologio simulato: `now_local` sostituisce `routine_schedule._now_local`."""

    def __init__(self, at: datetime) -> None:
        self.at = at

    def set(self, at: datetime) -> None:
        self.at = at

    def now_local(self, zone):
        return self.at.astimezone(zone)


@pytest.fixture
def clock(monkeypatch) -> Clock:
    clock = Clock(datetime(2026, 10, 20, 12, 0, tzinfo=ROME))  # martedì, prima del cambio d'ora
    monkeypatch.setattr(routine_schedule, "_now_local", clock.now_local)
    return clock


@pytest.fixture
def ctx(tmp_path: Path):
    """Contesto senza motore HTTP né DBOS: il battito si esercita in-process."""
    context = create_context(
        workspace_id="ws_local",
        db_path=tmp_path / "ws_local.sqlite3",
        data_dir=tmp_path,
        for_tests=True,
    )
    reset_context_for_tests(context)
    yield context
    reset_context_for_tests(None)


@pytest.fixture
def client(tmp_path: Path):
    """Motore completo (DBOS avviato): per il cablaggio dello schedule unico."""
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


def _seed(ctx) -> tuple[str, str]:
    conv = ctx.service.apply(ACTOR, "rc", "conversation.create", {"title": "Diario routine"})
    agent = ctx.service.apply(ACTOR, "ra", "agent.create",
                              {"name": "Ada", "role": "Analisi", "instructions": "Confronta"})
    ctx.persist()
    return conv["conversation_id"], agent["agent_id"]


def _template(agent_id: str) -> dict:
    return {
        "title": "Confronto listini settimanale",
        "objective": "Confrontare i listini aggiornati.",
        "plan_steps": [
            {"title": "Confronto listini", "assignee_id": agent_id, "capability": "compare_csv",
             "output_expected": "Report differenze"},
        ],
    }


def _create(ctx, cron: str, *, command_id: str = "cr", tz: str = "Europe/Rome") -> str:
    conv_id, agent_id = _seed(ctx)
    created = app_routines.create_routine(ctx, ACTOR, {
        "command_id": command_id, "name": "R", "cron": cron, "cron_timezone": tz,
        "conversation_id": conv_id, "template": _template(agent_id),
    })
    return created["routine_id"]


def _routine(ctx, routine_id: str):
    return ctx.repository.load().routines[routine_id]


def _inline_launcher(ctx, log: list):
    """Il lanciatore dei test esegue l'occorrenza in-process (niente DBOS) e
    registra (routine, occorrenza) come farebbe la chiave di idempotenza."""
    def launch(routine_id: str, occurrence: str):
        log.append((routine_id, occurrence))
        return routine_runs.run_recurrence(ctx, ACTOR, routine_id, occurrence)
    return launch


def _tick(ctx, clock: Clock, at: datetime, log: list) -> list:
    clock.set(at)
    return routine_tick.fire_due_routines(ctx, launch=_inline_launcher(ctx, log))


def _works_of(ctx, routine_id: str) -> list:
    store = ctx.repository.load()
    return sorted((w for w in store.works.values() if w.origin_routine_id == routine_id),
                  key=lambda w: w.scheduled_for or "")


def _preview_first(cron: str, tz: str = "Europe/Rome") -> datetime:
    return routine_schedule.next_occurrences(cron, tz)[0]


# --- l'ora locale resta quella: autunno -------------------------------------

def test_routine_starts_at_nine_local_across_the_autumn_change(ctx, clock):
    """Motore «acceso» dal 20/10/2026: «0 9 * * 1» parte il 26/10 alle 09:00+01:00
    (non alle 10, come faceva lo scheduler DBOS), poi il 02/11 alle 09:00."""
    routine_id = _create(ctx, "0 9 * * 1")
    assert _routine(ctx, routine_id).next_run_at == "2026-10-26T08:00:00+00:00"
    assert datetime.fromisoformat(_routine(ctx, routine_id).next_run_at) == _preview_first("0 9 * * 1")

    log: list = []
    assert _tick(ctx, clock, datetime(2026, 10, 26, 8, 59, tzinfo=ROME), log) == []
    fired = _tick(ctx, clock, datetime(2026, 10, 26, 9, 0, tzinfo=ROME), log)
    assert len(fired) == 1 and log == [(routine_id, "2026-10-26T08:00:00+00:00")]
    works = _works_of(ctx, routine_id)
    assert len(works) == 1
    assert datetime.fromisoformat(works[0].scheduled_for) == datetime(2026, 10, 26, 9, 0, tzinfo=ROME)
    assert _routine(ctx, routine_id).next_run_at == "2026-11-02T08:00:00+00:00"

    fired = _tick(ctx, clock, datetime(2026, 11, 2, 9, 0, 20, tzinfo=ROME), log)
    assert len(fired) == 1
    works = _works_of(ctx, routine_id)
    assert [datetime.fromisoformat(w.scheduled_for) for w in works] == [
        datetime(2026, 10, 26, 9, 0, tzinfo=ROME), datetime(2026, 11, 2, 9, 0, tzinfo=ROME)]
    assert _routine(ctx, routine_id).next_run_at == "2026-11-09T08:00:00+00:00"


# --- primavera: l'ora inesistente corre una volta sola ------------------------

def test_nonexistent_spring_hour_runs_once_at_the_next_valid_hour(ctx, clock):
    """«30 2 * * *» il 29/03/2026: le 02:30 non esistono; una sola esecuzione,
    alle 03:30+02:00, la stessa che mostra l'anteprima."""
    clock.set(datetime(2026, 3, 28, 12, 0, tzinfo=ROME))
    routine_id = _create(ctx, "30 2 * * *")
    assert _routine(ctx, routine_id).next_run_at == "2026-03-29T01:30:00+00:00"
    assert datetime.fromisoformat(_routine(ctx, routine_id).next_run_at) == _preview_first("30 2 * * *")

    log: list = []
    assert _tick(ctx, clock, datetime(2026, 3, 29, 1, 29, tzinfo=timezone.utc), log) == []
    assert len(_tick(ctx, clock, datetime(2026, 3, 29, 1, 30, tzinfo=timezone.utc), log)) == 1
    assert _tick(ctx, clock, datetime(2026, 3, 29, 1, 31, tzinfo=timezone.utc), log) == []
    assert _tick(ctx, clock, datetime(2026, 3, 29, 2, 30, tzinfo=timezone.utc), log) == []
    works = _works_of(ctx, routine_id)
    assert [w.scheduled_for for w in works] == ["2026-03-29T01:30:00+00:00"]
    assert datetime.fromisoformat(works[0].scheduled_for) == datetime(2026, 3, 29, 3, 30, tzinfo=ROME)
    assert _routine(ctx, routine_id).next_run_at == "2026-03-30T00:30:00+00:00"


# --- idempotenza -------------------------------------------------------------

def test_two_ticks_in_the_same_minute_run_the_occurrence_once(ctx, clock):
    routine_id = _create(ctx, "0 9 * * 1")
    log: list = []
    first = _tick(ctx, clock, datetime(2026, 10, 26, 9, 0, 0, tzinfo=ROME), log)
    second = _tick(ctx, clock, datetime(2026, 10, 26, 9, 0, 30, tzinfo=ROME), log)
    assert len(first) == 1 and second == []
    assert len(_works_of(ctx, routine_id)) == 1
    # la chiave di idempotenza del workflow figlio è (routine, occorrenza)
    key = routine_tick.recurrence_workflow_id(routine_id, "2026-10-26T08:00:00+00:00")
    assert key == routine_tick.recurrence_workflow_id(routine_id, "2026-10-26T08:00:00+00:00")
    assert routine_id in key and "2026-10-26T08:00:00+00:00" in key


def test_a_replayed_occurrence_does_not_run_twice_even_if_launched_again(ctx, clock):
    """Se il lanciatore viene richiamato con la stessa occorrenza (replay DBOS),
    l'esecuzione resta una: `run_recurrence` è idempotente per istante."""
    routine_id = _create(ctx, "0 9 * * 1")
    log: list = []
    _tick(ctx, clock, datetime(2026, 10, 26, 9, 0, tzinfo=ROME), log)
    assert routine_runs.run_recurrence(ctx, ACTOR, routine_id, "2026-10-26T08:00:00+00:00") is None
    assert len(_works_of(ctx, routine_id)) == 1


# --- pausa, ripresa, skip e modifica aggiornano next_run_at come l'anteprima --

def test_pause_resume_skip_and_update_keep_next_run_at_coherent_with_preview(ctx, clock):
    routine_id = _create(ctx, "0 9 * * 1")
    log: list = []

    app_routines.routine_action(ctx, ACTOR, "pause", {
        "command_id": "p", "routine_id": routine_id, "expected_version": 1})
    assert _routine(ctx, routine_id).next_run_at is None
    assert _tick(ctx, clock, datetime(2026, 10, 26, 9, 0, tzinfo=ROME), log) == []

    clock.set(datetime(2026, 10, 27, 12, 0, tzinfo=ROME))
    app_routines.routine_action(ctx, ACTOR, "resume", {
        "command_id": "r", "routine_id": routine_id, "expected_version": 2})
    assert _routine(ctx, routine_id).next_run_at == "2026-11-02T08:00:00+00:00"
    assert datetime.fromisoformat(_routine(ctx, routine_id).next_run_at) == _preview_first("0 9 * * 1")

    app_routines.routine_action(ctx, ACTOR, "skip_next", {
        "command_id": "sk", "routine_id": routine_id, "expected_version": 3})
    routine = _routine(ctx, routine_id)
    assert routine.skip_until == "2026-11-02T09:00:00+01:00"
    assert routine.next_run_at == "2026-11-09T08:00:00+00:00"
    assert datetime.fromisoformat(routine.next_run_at) == routine_schedule.next_occurrences(
        "0 9 * * 1", "Europe/Rome", after=datetime.fromisoformat(routine.skip_until))[0]

    assert _tick(ctx, clock, datetime(2026, 11, 2, 9, 0, tzinfo=ROME), log) == []  # saltata
    assert len(_tick(ctx, clock, datetime(2026, 11, 9, 9, 0, tzinfo=ROME), log)) == 1
    assert [w.scheduled_for for w in _works_of(ctx, routine_id)] == ["2026-11-09T08:00:00+00:00"]
    assert _routine(ctx, routine_id).next_run_at == "2026-11-16T08:00:00+00:00"

    clock.set(datetime(2026, 11, 10, 12, 0, tzinfo=ROME))
    app_routines.routine_action(ctx, ACTOR, "update", {
        "command_id": "u", "routine_id": routine_id, "expected_version": 4, "cron": "0 8 * * 2"})
    assert _routine(ctx, routine_id).next_run_at == "2026-11-17T07:00:00+00:00"
    assert datetime.fromisoformat(_routine(ctx, routine_id).next_run_at) == _preview_first("0 8 * * 2")

    app_routines.routine_action(ctx, ACTOR, "stop", {
        "command_id": "s", "routine_id": routine_id, "expected_version": 5})
    assert _routine(ctx, routine_id).next_run_at is None
    assert _tick(ctx, clock, datetime(2026, 11, 17, 8, 0, tzinfo=ROME), log) == []


def test_timezone_change_recomputes_next_run_at(ctx, clock):
    routine_id = _create(ctx, "0 9 * * 1")
    app_routines.routine_action(ctx, ACTOR, "update", {
        "command_id": "u", "routine_id": routine_id, "expected_version": 1,
        "cron_timezone": "America/New_York"})
    assert _routine(ctx, routine_id).next_run_at == "2026-10-26T13:00:00+00:00"  # 09:00-04:00


# --- riavvio: nessuna esecuzione doppia, next_run_at conservato --------------

def test_restart_keeps_next_run_at_and_does_not_run_twice(ctx, clock):
    routine_id = _create(ctx, "0 9 * * 1")
    log: list = []
    assert len(_tick(ctx, clock, datetime(2026, 10, 26, 9, 0, tzinfo=ROME), log)) == 1
    before = _routine(ctx, routine_id).next_run_at
    # il riavvio ripete la convergenza d'avvio e il battito successivo
    app_routines.reconcile_routines(ctx)
    assert _routine(ctx, routine_id).next_run_at == before == "2026-11-02T08:00:00+00:00"
    assert _tick(ctx, clock, datetime(2026, 10, 26, 9, 1, tzinfo=ROME), log) == []
    assert len(_works_of(ctx, routine_id)) == 1


# --- occorrenze perse a motore spento ----------------------------------------

def test_engine_off_for_weeks_runs_only_the_most_recent_missed_occurrence(ctx, clock):
    """Spento dal 20/10, riacceso il 18/11: delle quattro occorrenze perse
    (26/10, 02/11, 09/11, 16/11) corre una sola volta la più recente (16/11)."""
    routine_id = _create(ctx, "0 9 * * 1")
    log: list = []
    fired = _tick(ctx, clock, datetime(2026, 11, 18, 10, 0, tzinfo=ROME), log)
    assert len(fired) == 1
    assert [w.scheduled_for for w in _works_of(ctx, routine_id)] == ["2026-11-16T08:00:00+00:00"]
    assert _routine(ctx, routine_id).next_run_at == "2026-11-23T08:00:00+00:00"
    assert _tick(ctx, clock, datetime(2026, 11, 18, 10, 1, tzinfo=ROME), log) == []


# --- migrazione: le routine esistenti ricevono next_run_at -------------------

def test_reconcile_fills_next_run_at_for_legacy_routines(ctx, clock):
    routine_id = _create(ctx, "0 9 * * 1")
    with ctx.repository.transaction() as store:
        store.routines[routine_id].next_run_at = None  # routine salvata prima di D1
    ctx.service.store = store
    assert app_routines.reconcile_routines(ctx) == [routine_id]
    assert _routine(ctx, routine_id).next_run_at == "2026-10-26T08:00:00+00:00"
    assert app_routines.reconcile_routines(ctx) == []  # già coerente


def test_reconcile_clears_next_run_at_of_paused_and_stopped_routines(ctx, clock):
    routine_id = _create(ctx, "0 9 * * 1")
    app_routines.routine_action(ctx, ACTOR, "pause", {
        "command_id": "p", "routine_id": routine_id, "expected_version": 1})
    with ctx.repository.transaction() as store:
        store.routines[routine_id].next_run_at = "2026-10-26T08:00:00+00:00"  # valore stantio
    ctx.service.store = store
    assert app_routines.reconcile_routines(ctx) == [routine_id]
    assert _routine(ctx, routine_id).next_run_at is None


# --- il percorso generico della UI (/commands routine.create) ----------------

def test_generic_command_route_sets_next_run_at_like_the_dedicated_one(client, clock):
    """La UI crea la routine con `routine.create` sull'endpoint generico: il
    dominio calcola next_run_at attraverso la porta, non solo in /routines."""
    conv_id, agent_id = _seed(get_context())
    created = client.post("/v1/workspaces/ws_local/commands",
                          headers={"X-Homun-Actor-Id": ACTOR.id},
                          json={"command_id": "g1", "type": "routine.create", "payload": {
                              "name": "Dalla UI", "cron": "0 9 * * 1", "cron_timezone": "Europe/Rome",
                              "conversation_id": conv_id, "template": _template(agent_id)}})
    assert created.status_code == 200, created.text
    routine_id = created.json()["result"]["routine_id"]
    items = client.get("/v1/workspaces/ws_local/routines",
                       headers={"X-Homun-Actor-Id": ACTOR.id}).json()["items"]
    item = next(r for r in items if r["id"] == routine_id)
    assert item["next_run_at"] == "2026-10-26T08:00:00+00:00"
    bad = client.post("/v1/workspaces/ws_local/commands",
                      headers={"X-Homun-Actor-Id": ACTOR.id},
                      json={"command_id": "g2", "type": "routine.create", "payload": {
                          "name": "Rotta", "cron": "99 99 * * *", "cron_timezone": "Europe/Rome",
                          "conversation_id": conv_id, "template": _template(agent_id)}})
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "validation_error"


# --- cablaggio DBOS: un solo schedule, nessuna schedule per routine ----------

def test_dbos_has_a_single_tick_schedule_and_no_per_routine_schedules(client, clock):
    from dbos import DBOS
    schedules = {s["schedule_name"]: s for s in DBOS.list_schedules()}
    assert set(schedules) == {routine_tick.TICK_SCHEDULE_NAME}
    tick = schedules[routine_tick.TICK_SCHEDULE_NAME]
    assert tick["schedule"] == "* * * * *" and (tick.get("cron_timezone") or "UTC") == "UTC"
    assert tick.get("status", "ACTIVE") == "ACTIVE"

    conv_id, agent_id = _seed(get_context())
    created = client.post("/v1/workspaces/ws_local/routines",
                          headers={"X-Homun-Actor-Id": ACTOR.id},
                          json={"command_id": "c1", "name": "R", "cron": "0 9 * * 1",
                                "conversation_id": conv_id, "template": _template(agent_id)})
    assert created.status_code == 200, created.text
    assert {s["schedule_name"] for s in DBOS.list_schedules()} == {routine_tick.TICK_SCHEDULE_NAME}


def test_reconcile_removes_legacy_per_routine_schedules(client, clock):
    from dbos import DBOS
    from homun.runtime.workflows.routine_recurrence import routine_recurrence_workflow
    DBOS.create_schedule(schedule_name="routine:legacy", workflow_fn=routine_recurrence_workflow,
                         schedule="0 9 * * 1", context={"routine_id": "legacy"},
                         cron_timezone="Europe/Rome")
    assert "routine:legacy" in {s["schedule_name"] for s in DBOS.list_schedules()}
    app_routines.reconcile_routines(get_context())
    assert {s["schedule_name"] for s in DBOS.list_schedules()} == {routine_tick.TICK_SCHEDULE_NAME}


def test_dbos_tick_runs_a_due_routine_through_the_child_workflow(client):
    """Battito vero: lo schedule unico avvia il workflow figlio con chiave
    (routine, occorrenza); la routine dovuta produce il suo lavoro e il
    puntatore avanza alla prossima occorrenza futura."""
    import time
    from dbos import DBOS
    ctx = get_context()
    conv_id, agent_id = _seed(ctx)
    created = app_routines.create_routine(ctx, ACTOR, {
        "command_id": "c1", "name": "R", "cron": "0 9 * * 1", "cron_timezone": "Europe/Rome",
        "conversation_id": conv_id, "template": _template(agent_id)})
    routine_id = created["routine_id"]
    now = datetime.now(timezone.utc)
    overdue = routine_schedule.next_occurrences("0 9 * * 1", "Europe/Rome",
                                                after=now - timedelta(days=8))[0]
    with ctx.repository.transaction() as store:
        store.routines[routine_id].next_run_at = overdue.astimezone(timezone.utc).isoformat()
    ctx.service.store = store

    DBOS.trigger_schedule(routine_tick.TICK_SCHEDULE_NAME).get_result()
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not _routine(ctx, routine_id).last_run_work_id:
        time.sleep(0.2)
    routine = _routine(ctx, routine_id)
    assert routine.last_run_work_id, "il battito non ha avviato l'occorrenza dovuta"
    works = _works_of(ctx, routine_id)
    assert len(works) == 1
    assert datetime.fromisoformat(works[0].scheduled_for) <= now
    assert datetime.fromisoformat(routine.next_run_at) > now
    # un secondo battito nello stesso minuto non raddoppia l'esecuzione
    DBOS.trigger_schedule(routine_tick.TICK_SCHEDULE_NAME).get_result()
    time.sleep(1.0)
    assert len(_works_of(ctx, routine_id)) == 1
