"""Il battito delle routine: Homun decide quando una routine è dovuta.

Ogni minuto il battito legge le routine attive con `next_run_at <= adesso`,
avvia l'esecuzione di una occorrenza con chiave di idempotenza
(routine, occorrenza) e porta avanti `next_run_at` con lo stesso calcolo
dell'anteprima. DBOS fornisce solo il battito durevole (uno schedule unico,
`TICK_SCHEDULE_NAME`, in UTC) e i workflow figli: vedi
`runtime/workflows/routine_recurrence.py`, che compone le stesse tre funzioni.

Occorrenze perse a motore spento: corre una sola volta la più recente fra
quelle non eseguite; le precedenti non si recuperano (docs/USO-HOMUN.md).
Il battito è leggero: una query sull'indice (kind, id) e nessuna chiamata al
modello; il lavoro vero lo fa il workflow figlio (`routine_runs`).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable

from homun.application.automation.routine_schedule import next_occurrences, next_run_at, now_utc
from homun.domain.models import Routine, utc_now

TICK_SCHEDULE_NAME = "homun-routine-tick"
TICK_CRON = "* * * * *"
LEGACY_SCHEDULE_PREFIX = "routine:"  # le schedule DBOS per singola routine, prima del battito
# Con il motore spento a lungo e un cron denso la ricerca della più recente
# occorrenza persa si ferma qui: il battito esegue quella trovata e il
# successivo riprende da lì.
MAX_MISSED_SCAN = 50_000

Launcher = Callable[[str, str], Any]
logger = logging.getLogger(__name__)


def recurrence_workflow_id(routine_id: str, occurrence: str) -> str:
    """La chiave di idempotenza del workflow figlio: stessa occorrenza, stessa esecuzione."""
    return f"routine:{routine_id}:{occurrence}"


def due_routines(ctx, now: datetime) -> list[Routine]:
    """Le routine attive dovute adesso, in ordine di scadenza: una sola query
    sull'indice (kind, id), senza caricare lo store intero."""
    with ctx.repository.locked() as conn:
        rows = conn.execute("SELECT payload FROM entities WHERE kind = 'routine'").fetchall()
    due = []
    for (payload,) in rows:
        routine = Routine.model_validate_json(payload)
        if routine.status != "active" or not routine.next_run_at:
            continue
        if datetime.fromisoformat(routine.next_run_at) <= now:
            due.append(routine)
    return sorted(due, key=lambda routine: routine.next_run_at or "")


def occurrence_to_run(routine: Routine, now: datetime) -> datetime:
    """L'occorrenza da eseguire: `next_run_at` quando è l'unica dovuta; con il
    motore spento a lungo, la più recente fra quelle perse (una sola)."""
    latest = datetime.fromisoformat(routine.next_run_at or "")
    for _ in range(MAX_MISSED_SCAN):
        following = next_occurrences(routine.cron, routine.cron_timezone, after=latest)[0]
        if following > now:
            break
        latest = following
    return latest.astimezone(timezone.utc)


def due_occurrences(ctx, now: datetime | None = None) -> list[dict[str, str]]:
    """Cosa avviare in questo battito: coppie (routine, occorrenza ISO UTC)."""
    now = now or now_utc()
    return [{"routine_id": routine.id,
             "occurrence": occurrence_to_run(routine, now).isoformat(timespec="seconds")}
            for routine in due_routines(ctx, now)]


def launch_all(due: list[dict[str, str]], launch: Launcher) -> list[dict[str, str]]:
    """Avvia ogni occorrenza dovuta; un avvio fallito resta dovuto (il battito
    seguente lo ritenta) e non ferma gli altri."""
    launched: list[dict[str, str]] = []
    for item in due:
        try:
            launch(item["routine_id"], item["occurrence"])
        except Exception:
            logger.exception("Routine %s: avvio dell'occorrenza %s fallito",
                             item["routine_id"], item["occurrence"])
            continue
        launched.append(item)
    return launched


def advance_after_launch(ctx, launched: list[dict[str, str]]) -> None:
    """Porta `next_run_at` alla prima occorrenza dopo quella avviata (e dopo
    `skip_until`). La guardia lascia stare i puntatori già oltre: un battito
    concorrente o una modifica della persona hanno già deciso."""
    if not launched:
        return
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            for item in launched:
                routine = store.routines.get(item["routine_id"])
                if routine is None or routine.status != "active" or not routine.next_run_at:
                    continue
                occurrence = datetime.fromisoformat(item["occurrence"])
                if datetime.fromisoformat(routine.next_run_at) > occurrence:
                    continue
                routine.next_run_at = next_run_at(routine.cron, routine.cron_timezone,
                                                  after=occurrence, skip_until=routine.skip_until)
                routine.updated_at = utc_now()
        ctx.service.store = store


def fire_due_routines(ctx, *, launch: Launcher, now: datetime | None = None) -> list[dict[str, str]]:
    """Un battito completo, in-process: prima gli avvii (idempotenti per chiave),
    poi l'avanzamento dei puntatori — in quest'ordine un arresto fra i due
    passi ripete l'avvio (deduplicato) invece di perdere l'occorrenza."""
    launched = launch_all(due_occurrences(ctx, now), launch)
    advance_after_launch(ctx, launched)
    return launched
