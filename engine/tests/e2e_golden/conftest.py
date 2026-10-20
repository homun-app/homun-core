"""Fixture della suite golden: provider, motori reali, facciata «golden».

Regola della suite: si misura, non si corregge. Ogni passo registra l'esito
nel recorder; a fine sessione si scrive il rapporto in «reports/».
"""
from __future__ import annotations

import subprocess
from datetime import datetime, timezone

import pytest

from . import harness
from .client import HomunClient
from .common import GOLDEN_DIR, run_count
from .harness import Engine, ProviderConfig
from .reporting import GoldenRun, Recorder, run_story

_RECORDER: Recorder = Recorder()


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "golden: banco di prova end-to-end con modelli veri (escluso da suite e CI)",
    )


@pytest.fixture(scope="session")
def golden_provider() -> ProviderConfig:
    """Il provider scelto; se non è raggiungibile la sessione si salta, non fallisce."""
    config, reason = harness.build_provider_config()
    if config is None:
        pytest.skip(f"Provider golden non configurato: {reason}")
    unreachable = harness.probe_provider(config)
    if unreachable:
        pytest.skip(f"Provider golden non raggiungibile: {unreachable}")
    return config


@pytest.fixture(scope="session")
def golden_recorder(golden_provider) -> Recorder:
    commit = ""
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=GOLDEN_DIR,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        commit = "sconosciuto"
    _RECORDER.start(
        {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "provider": golden_provider.provider,
            "model": golden_provider.model_id,
            "base_url": golden_provider.base_url,
            "runs": run_count(),
            "commit": commit,
            "suite": "engine/tests/e2e_golden",
        }
    )
    _RECORDER.note(
        "D2: non esiste un endpoint «esegui ora» per le routine; l'esecuzione forzata "
        "usa una routine con cadenza al minuto e attende l'occorrenza reale del battito del "
        "motore (schedule unico «homun-routine-tick», ogni minuto in UTC)."
    )
    return _RECORDER


def configure_provider(client: HomunClient, config: ProviderConfig) -> None:
    """Configura la connessione modello come farebbe la persona nella UI.

    Via demone Ollama (locale o modelli «:cloud»): «Applica preset Ollama»
    aggiorna la connessione predefinita (`openai_compatible`) mantenendo
    coincidenti id e kind. Endpoint remoto OpenAI-compatibile: nuova
    connessione più attivazione, come il modale Modelli.
    """
    if config.via_local_ollama:
        client.post(
            "/v1/models/providers/openai_compatible/ollama_preset",
            {"model": config.model_id},
        )
    else:
        client.upsert_connection(config)
        client.set_active_connection(config.connection_id)


@pytest.fixture(scope="session")
def golden_engines(golden_provider, golden_recorder, tmp_path_factory):
    """Fabbrica di motori reali: data dir temporanea nuova, porta effimera, token generato."""
    started: list[Engine] = []
    engine_dirs: list[str] = []

    def factory() -> Engine:
        engine = Engine(tmp_path_factory.mktemp("homun-golden-"))
        engine.start()
        configure_provider(engine.client(), golden_provider)
        started.append(engine)
        engine_dirs.append(str(engine.data_dir))
        golden_recorder.meta["data_dirs"] = engine_dirs
        return engine

    yield factory
    for engine in started:
        engine.stop()


@pytest.fixture(scope="session")
def golden_engine(golden_engines, golden_recorder) -> Engine:
    """Motore condiviso dagli scenari senza riavvii, con la connessione verificata (M0)."""
    engine = golden_engines()
    run = GoldenRun(golden_recorder, 0)
    try:
        with run.step("M0.connessione"):
            connections = engine.client().get("/v1/models/connections")
            active = str(connections.get("active_connection_id") or "")
            assert active, "nessuna connessione modello attiva dopo la configurazione"
            engine.client().verify_connection(active)
    except Exception:  # noqa: BLE001 — l'esito resta nel rapporto, la sessione prosegue
        pass  # gli scenari falliranno a cascata con il loro codice d'errore
    return engine


class Golden:
    """Facciata per gli scenari: client HTTP, motore, provider e registrazione dei passi."""

    def __init__(self, engine: Engine, recorder: Recorder, provider: ProviderConfig):
        self.engine = engine
        self.recorder = recorder
        self.provider = provider

    @property
    def client(self) -> HomunClient:
        return self.engine.client()

    def run(self, scenarios: list[str], run_index: int, story) -> None:
        failed = run_story(self.recorder, scenarios, run_index, story, self)
        if failed:
            pytest.fail(f"run {run_index} fallito: " + "; ".join(failed), pytrace=False)


@pytest.fixture
def golden(golden_engine, golden_recorder, golden_provider) -> Golden:
    """Scenari sul motore condiviso della sessione."""
    return Golden(golden_engine, golden_recorder, golden_provider)


@pytest.fixture
def golden_solo(golden_engines, golden_recorder, golden_provider):
    """Scenari con un motore proprio (riavvii: A4, D3; connessione propria: B7), fermato a fine test."""
    engine = golden_engines()
    facade = Golden(engine, golden_recorder, golden_provider)
    yield facade
    engine.stop()


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    if not _RECORDER.active:
        return
    started = _RECORDER.meta.get("started_at")
    if isinstance(started, str):
        began = datetime.fromisoformat(started)
        minutes = (datetime.now(timezone.utc) - began).total_seconds() / 60
        _RECORDER.meta["duration"] = f"{minutes:.0f} min"
    report_md, report_json = _RECORDER.write_reports()
    print(f"\nRapporto golden: {report_md}\nRapporto json:   {report_json}")
