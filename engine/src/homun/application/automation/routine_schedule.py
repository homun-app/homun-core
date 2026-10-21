"""Il calcolo condiviso delle occorrenze di una routine.

Anteprima (`/routines/preview`), skip_next, il puntatore `Routine.next_run_at`
e il battito passano tutti da qui: i percorsi non possono divergere. Il modulo
non dipende dal runtime (contesto, workflow) ed è la porta che `context.py`
innesta nel dominio; `_now_local` è l'unico orologio, e i test lo sostituiscono.
"""
from __future__ import annotations

from datetime import datetime, timezone

from homun.domain.errors import ValidationError


def _now_local(zone) -> datetime:
    """L'istante corrente nel fuso dato (i test lo sostituiscono per simulare l'orologio)."""
    return datetime.now(zone)


def now_utc() -> datetime:
    return _now_local(timezone.utc)


def next_occurrences(cron: str, cron_timezone: str, *, count: int = 1, after=None) -> list:
    """Le prossime `count` occorrenze dopo `after` (default: adesso), come
    datetime consapevoli nel fuso della routine — l'unico calcolo condiviso
    fra anteprima, skip, puntatore ed esecuzione.

    L'ora locale indicata dalla persona resta quella in ogni stagione: il
    calcolo avviene in ora locale «da muro» (croniter su datetime ingenuo) e
    solo alla fine l'istante viene ancorato al fuso e rinormalizzato. Il
    croniter venduto da dbos (fork del 2012) con datetime già consapevoli porta
    avanti l'offset di partenza e slitta di un'ora quando l'occorrenza
    attraversa un cambio d'ora.

    Orari locali inesistenti (la notte di primavera) collassano sull'ora
    valida successiva; l'ora ripetuta della notte d'autunno produce una sola
    esecuzione (la prima). Le occorrenze restano strette, distinte, crescenti.
    """
    from dbos._scheduler import croniter
    from zoneinfo import ZoneInfo
    zone = ZoneInfo(cron_timezone)
    start = _now_local(zone) if after is None else after.astimezone(zone)
    iterator = croniter(cron, start.replace(tzinfo=None))
    occurrences: list = []
    previous = start
    while len(occurrences) < count:
        # il passaggio per UTC rinormalizza: astimezone sullo stesso fuso è un
        # no-op e lascerebbe vive le ore locali inesistenti della notte di
        # primavera; per le ore ambigue vale la prima occorrenza (fold=0)
        anchored = iterator.get_next(datetime).replace(tzinfo=zone)
        occurrence = anchored.astimezone(timezone.utc).astimezone(zone)
        if occurrence <= previous:
            # orario locale inesistente già coperto dal salto in avanti
            continue
        occurrences.append(occurrence)
        previous = occurrence
    return occurrences


def next_occurrence(cron: str, cron_timezone: str) -> str:
    """The next ISO occurrence strictly after now, in the routine's timezone."""
    try:
        return next_occurrences(cron, cron_timezone)[0].isoformat()
    except Exception as exc:
        raise ValidationError(f"invalid cron: {exc}", reason="routine.cron.invalid") from exc


def next_run_at(cron: str, cron_timezone: str, *, after=None, skip_until: str | None = None) -> str:
    """Il prossimo istante dovuto, ISO in UTC al secondo: la prima occorrenza
    strettamente dopo `after` (default: adesso) e dopo `skip_until`, se la
    persona ha saltato la prossima. È il valore di `Routine.next_run_at` che il
    battito confronta con l'orologio."""
    floor = now_utc() if after is None else after
    if skip_until:
        skipped = datetime.fromisoformat(skip_until)
        if skipped > floor:
            floor = skipped
    try:
        occurrence = next_occurrences(cron, cron_timezone, after=floor)[0]
    except Exception as exc:
        raise ValidationError(f"invalid cron: {exc}", reason="routine.cron.invalid") from exc
    return occurrence.astimezone(timezone.utc).isoformat(timespec="seconds")


def deep_validate_cron(cron: str) -> str:
    """Full croniter validation; the domain keeps structural checks only."""
    from homun.domain.commands.routines import validate_cron
    validate_cron(cron)
    from dbos._scheduler import croniter  # the same engine DBOS relies on
    try:
        croniter(cron, datetime.now(timezone.utc))
    except Exception as exc:
        raise ValidationError(f"invalid cron: {exc}", reason="routine.cron.invalid") from exc
    return cron
