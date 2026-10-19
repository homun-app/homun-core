"""Area D — automazioni e routine: creazione, esecuzione forzata, persistenza.

Percorso della UI: `engine-routines-client.ts` crea la routine via API dopo
aver tradotto la cadenza («ogni lunedì alle 9» → `0 9 * * 1`, vedi
`cadence-language.ts`); l'assegnatario del modello di piano è un agente
attivo, creato qui con lo stesso comando del costruttore squadra
(`engine-agents-client.ts`).
"""
from __future__ import annotations

from datetime import datetime

import pytest

from .common import ROUTINE_TICK_TIMEOUT, run_indices, wait_until
from .reporting import GoldenRun

pytestmark = pytest.mark.golden

CRON_LUNEDI_ALLE_9 = "0 9 * * 1"  # «ogni lunedì alle 9» secondo cadence-language.ts
CRON_OGNI_MINUTO = "* * * * *"

TEMPLATE = {
    "title": "Riepilogo scadenze della settimana",
    "objective": "Preparare il riepilogo delle scadenze in arrivo.",
    "plan_steps": [
        {
            "title": "Riepilogo scadenze",
            "capability": "general",
            "output_expected": "Nota breve con le scadenze della settimana",
        }
    ],
}


def _story_d(golden, run: GoldenRun) -> None:
    client = golden.client
    with run.step("D1.agente"):
        conversation_id = client.create_conversation("Routine di prova")
        agent_id = client.create_agent("Homun di prova", "Operatore del percorso d'oro")
        template = {
            **TEMPLATE,
            "plan_steps": [{**TEMPLATE["plan_steps"][0], "assignee_id": agent_id}],
        }
    with run.step("D1.creazione"):
        created = client.create_routine(
            "Scadenze del lunedì", CRON_LUNEDI_ALLE_9, conversation_id, template
        )
        routine_id = str(created["routine_id"])
        assert created.get("status") == "active", str(created)
    with run.step("D1.pianificazione"):
        item = next(
            (r for r in client.list_routines() if r.get("id") == routine_id), None
        )
        assert item is not None, "la routine non è nell'elenco"
        assert item.get("cron") == CRON_LUNEDI_ALLE_9, f"cron salvato: {item.get('cron')!r}"
        assert item.get("cron_timezone") == "Europe/Rome", str(item.get("cron_timezone"))
        assert item.get("status") == "active", f"stato: {item.get('status')!r}"
        preview = client.routine_preview(CRON_LUNEDI_ALLE_9)
        first_next = datetime.fromisoformat((preview.get("next") or [""])[0])
        if not (first_next.weekday() == 0 and first_next.hour == 9):
            run.recorder.note(
                "D1: /routines/preview per «0 9 * * 1» (Europe/Rome) ha dato "
                f"{first_next.isoformat()}: croniter slitta di un'ora quando la prossima "
                "occorrenza attraversa il cambio d'ora (25/10/2026); dopo il cambio "
                "l'ora torna corretta (verificato direttamente con croniter)."
            )
        # sonda: il preview è ciò che la UI mostra come prossime esecuzioni;
        # un'esistenza sbagliata non deve impedire di misurare il resto dell'area
        with run.probe("D1.prossima-esecuzione"):
            assert first_next.weekday() == 0 and first_next.hour == 9, (
                f"prossima occorrenza non è lunedì alle 9: {first_next.isoformat()}"
            )
    with run.step("D2.occorrenza"):
        forced = client.create_routine(
            "Routine al minuto (golden)", CRON_OGNI_MINUTO, conversation_id, template
        )
        forced_id = str(forced["routine_id"])

        def occurrence() -> dict | None:
            item = next((r for r in client.list_routines() if r.get("id") == forced_id), None)
            return item if item and item.get("last_run_work_id") else None

        fired = wait_until(
            occurrence,
            ROUTINE_TICK_TIMEOUT,
            "l'occorrenza della routine al minuto",
        )
        assert fired is not None
    with run.step("D2.lavoro"):
        work_id = str(fired["last_run_work_id"])
        detail = client.work_detail(work_id)
        work = detail["work"]
        assert work.get("origin_routine_id") == forced_id, "il lavoro non nasce dalla routine"
        assert work.get("status") in {"ready", "running", "review", "completed"}, (
            f"stato del lavoro ricorrente: {work.get('status')!r}"
        )
        plan = detail.get("plan") or {}
        titles = [step.get("title") for step in plan.get("steps") or []]
        assert TEMPLATE["plan_steps"][0]["title"] in titles, f"fasi del modello non rispettate: {titles}"
    with run.step("D3.riavvio"):
        golden.engine.restart()
    with run.step("D3.persistenza"):
        routines = golden.client.list_routines()
        by_id = {item.get("id"): item for item in routines}
        for expected_id, cron in [(routine_id, CRON_LUNEDI_ALLE_9), (forced_id, CRON_OGNI_MINUTO)]:
            item = by_id.get(expected_id)
            assert item is not None, f"la routine {expected_id} non esiste dopo il riavvio"
            assert item.get("status") == "active", f"stato dopo il riavvio: {item.get('status')!r}"
            assert item.get("cron") == cron, f"cron cambiato dopo il riavvio: {item.get('cron')!r}"


@pytest.mark.parametrize("run_index", run_indices())
def test_d_routine(golden_solo, run_index: int) -> None:
    golden_solo.run(["D1", "D2", "D3"], run_index, _story_d)
