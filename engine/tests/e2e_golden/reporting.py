"""Registrazione dei passi e rapporti della suite golden (md + json).

Separato dall'harness: qui vive la memoria della misura — ogni passo registra
esito, durata, codice d'errore ed estratto — e a fine sessione si scrive il
rapporto in «reports/».
"""
from __future__ import annotations

import json
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterator

import httpx

from .harness import GOLDEN_DIR, SCENARIOS, GoldenError, now_iso, redact

REPORTS_DIR = GOLDEN_DIR / "reports"

# -- registrazione e rapporti ------------------------------------------------


@dataclass
class StepRecord:
    scenario: str  # prefisso: A1, B2, …
    run: int  # 1..N (0 = fase di sessione, es. M0)
    step: str  # nome completo del passo, es. «B2.conferma»
    status: str  # ok | fail | not_attempted
    duration: float = 0.0
    code: str = ""
    reason: str = ""
    excerpt: str = ""


@dataclass
class Recorder:
    """Raccoglie l'esito di ogni passo e scrive i rapporti (md + json)."""

    active: bool = False
    meta: dict[str, Any] = field(default_factory=dict)
    steps: list[StepRecord] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def start(self, meta: dict[str, Any]) -> None:
        self.active = True
        self.meta = {**meta, "started_at": now_iso()}

    def add(self, record: StepRecord) -> None:
        self.steps.append(record)

    def note(self, text: str) -> None:
        if text not in self.notes:
            self.notes.append(redact(text))

    # -- aggregazioni -------------------------------------------------------

    def _runs(self, scenario: str) -> list[int]:
        return sorted({record.run for record in self.steps if record.scenario == scenario})

    def _scenario_stats(self, scenario: str) -> dict[str, Any]:
        records = [record for record in self.steps if record.scenario == scenario]
        runs = self._runs(scenario)
        # un run è riuscito solo se TUTTI i suoi passi (e sonde) sono ok
        successes = {
            run
            for run in runs
            if records and all(r.status == "ok" for r in records if r.run == run)
        }
        durations: dict[int, float] = {}
        for record in records:
            durations[record.run] = durations.get(record.run, 0.0) + record.duration
        attempted = [run for run in runs if any(r.run == run and r.status in {"ok", "fail"} for r in records)]
        return {
            "title": SCENARIOS.get(scenario, scenario),
            "runs": len(runs),
            "successes": len(successes),
            "attempted": len(attempted),
            "avg_duration": (
                round(sum(durations.get(run, 0.0) for run in attempted) / len(attempted), 1)
                if attempted
                else 0.0
            ),
            "failures": [
                {
                    "run": record.run,
                    "step": record.step,
                    "code": record.code,
                    "reason": record.reason,
                    "excerpt": record.excerpt,
                }
                for record in records
                if record.status == "fail"
            ],
        }

    def scenario_order(self) -> list[str]:
        seen: list[str] = []
        for record in self.steps:
            if record.scenario not in seen:
                seen.append(record.scenario)
        return seen

    # -- scritture ----------------------------------------------------------

    def write_reports(self) -> tuple[Path, Path]:
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d")
        provider = str(self.meta.get("provider", "sconosciuto"))
        md_path = REPORTS_DIR / f"{stamp}-{provider}.md"
        json_path = REPORTS_DIR / f"{stamp}-{provider}.json"
        json_path.write_text(
            json.dumps(self.to_json_payload(), ensure_ascii=False, indent=1) + "\n",
            encoding="utf-8",
        )
        md_path.write_text(self.to_markdown(), encoding="utf-8")
        return md_path, json_path

    def to_json_payload(self) -> dict[str, Any]:
        return {
            "generated_at": now_iso(),
            "meta": self.meta,
            "scenarios": [
                {**self._scenario_stats(scenario), "id": scenario}
                for scenario in self.scenario_order()
            ],
            "notes": self.notes,
        }

    def to_markdown(self) -> str:
        meta = self.meta
        lines = [
            f"# Percorso d'oro — {meta.get('date', '')} · provider {meta.get('provider', '?')}",
            "",
            f"- Modello: **{meta.get('model', '?')}** su `{meta.get('base_url', '?')}`",
            f"- Run per scenario: **{meta.get('runs', '?')}** · avvio reale `python -m homun serve`",
            f"- Commit: `{meta.get('commit', '?')}` · durata totale: {meta.get('duration', '?')}",
            "",
            "| Scenario | Successo | Tentati | Durata media |",
            "|---|---|---|---|",
        ]
        for scenario in self.scenario_order():
            stats = self._scenario_stats(scenario)
            rate = f"{stats['successes']}/{stats['runs']}"
            pct = f" ({stats['successes'] * 100 // stats['runs']}%)" if stats["runs"] else ""
            lines.append(
                f"| {scenario} · {stats['title']} | {rate}{pct} | {stats['attempted']} | {stats['avg_duration']}s |"
            )
        failures = [
            (scenario, failure)
            for scenario in self.scenario_order()
            for failure in self._scenario_stats(scenario)["failures"]
        ]
        if failures:
            lines += ["", "## Fallimenti", ""]
            for scenario, failure in failures:
                lines += [
                    f"### {scenario} · run {failure['run']} — passo «{failure['step']}»",
                    f"- codice: `{failure['code']}`",
                    f"- motivo: {failure['reason']}",
                    f"- estratto: {failure['excerpt'] or '—'}",
                    "",
                ]
        if self.notes:
            lines += ["## Note", ""]
            lines += [f"- {note}" for note in self.notes]
        lines.append("")
        return "\n".join(lines)


def _assertion_reason(exc: AssertionError) -> str:
    """Il messaggio dell'asserzione senza il tracciato d'introspezione pytest."""
    lines = str(exc).splitlines() or ["asserzione fallita"]
    kept = [lines[0]]
    for line in lines[1:]:
        if line.lstrip().startswith(("assert ", "+ ", "E ", "where ")):
            break
        kept.append(line)
    return "\n".join(kept).strip() or "asserzione fallita"


class GoldenRun:
    """Una esecuzione di uno scenario: registra l'esito di ogni passo."""

    def __init__(self, recorder: Recorder, run_index: int):
        self.recorder = recorder
        self.run_index = run_index
        self._current: StepRecord | None = None

    @contextmanager
    def step(self, name: str) -> Iterator[None]:
        scenario = name.split(".", 1)[0]
        record = StepRecord(scenario=scenario, run=self.run_index, step=name, status="ok")
        self._current = record
        started = time.monotonic()
        try:
            yield
        except GoldenError as exc:
            record.status = "fail"
            record.duration = round(time.monotonic() - started, 1)
            record.code, record.reason, record.excerpt = exc.code, exc.reason, exc.excerpt
            self.recorder.add(record)
            raise
        except AssertionError as exc:
            record.status = "fail"
            record.duration = round(time.monotonic() - started, 1)
            record.code, record.reason = "asserzione", _assertion_reason(exc)
            self.recorder.add(record)
            raise
        except httpx.HTTPError as exc:
            record.status = "fail"
            record.duration = round(time.monotonic() - started, 1)
            record.code = "errore_trasporto"
            record.reason, record.excerpt = f"{type(exc).__name__}: {exc}", ""
            self.recorder.add(record)
            raise
        else:
            record.duration = round(time.monotonic() - started, 1)
            self.recorder.add(record)
        finally:
            self._current = None

    def mark_not_attempted(self, scenarios: list[str]) -> None:
        for scenario in scenarios:
            if not any(
                record.scenario == scenario and record.run == self.run_index
                for record in self.recorder.steps
            ):
                self.recorder.add(
                    StepRecord(
                        scenario=scenario,
                        run=self.run_index,
                        step=f"{scenario} (non tentato: storia interrotta prima)",
                        status="not_attempted",
                    )
                )

    @contextmanager
    def probe(self, name: str) -> Iterator[None]:
        """Misura un aspetto senza interrompere la storia: l'esito va nel
        tasso dello scenario, ma il passo dopo si può comunque eseguire."""
        try:
            with self.step(name):
                yield
        except (GoldenError, AssertionError, httpx.HTTPError):
            pass  # già registrato dallo step interno


def run_story(
    recorder: Recorder,
    scenarios: list[str],
    run_index: int,
    story: Callable[[Any, GoldenRun], None],
    session: Any,
) -> list[str]:
    """Esegue la storia di uno scenario; ritorna l'elenco dei passi falliti.

    «session» è la facciata golden (con .client HTTP e .engine per i riavvii).
    """
    run = GoldenRun(recorder, run_index)
    try:
        story(session, run)
    except (GoldenError, httpx.HTTPError, AssertionError):
        pass  # già registrato dallo step che l'ha sollevata
    run.mark_not_attempted(scenarios)
    failed = [
        record
        for record in recorder.steps
        if record.run == run_index
        and record.scenario in scenarios
        and record.status in {"fail", "not_attempted"}
        # «non tentato» conta come mancato successo dello scenario in quel run
    ]
    return [f"{r.step} ({r.code})" for r in failed]
