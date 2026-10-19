"""Harness del banco di prova «percorso d'oro»: provider e motore reale.

Il motore viene avviato come processo reale (`python -m homun serve`) su una
porta effimera di loopback, con data dir temporanea e token di sessione
generato ad hoc. La suite parla con lui solo via HTTP (`client.py`), come fa
la UI web (gli endpoint sono gli stessi dei client in `apps/web/src/lib`).
"""
from __future__ import annotations

import os
import re
import secrets
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from .client import HomunClient
from .common import ENGINE_BOOT_TIMEOUT, GoldenError, excerpt_of, redact


@dataclass(frozen=True)
class ProviderConfig:
    """Connessione modello usata dalla sessione golden (la chiave non finisce mai nei rapporti)."""

    provider: str  # "local" | "cloud"
    connection_id: str
    display_name: str
    base_url: str
    model_id: str
    api_key: str | None = None
    via_local_ollama: bool = False  # cloud «:cloud» instradato dal demone Ollama locale

    @property
    def safe_description(self) -> str:
        return f"provider={self.provider} modello={self.model_id} base_url={self.base_url}"


LOCAL_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"


def _is_loopback(base_url: str) -> bool:
    from urllib.parse import urlsplit

    return urlsplit(base_url).hostname in {"127.0.0.1", "localhost", "::1"}


def build_provider_config() -> tuple[ProviderConfig | None, str]:
    """Risolve il provider da HOMUN_GOLDEN_PROVIDER; (None, motivo) se non configurato."""
    provider = os.environ.get("HOMUN_GOLDEN_PROVIDER", "").strip().lower()
    if provider == "local":
        model = os.environ.get("HOMUN_GOLDEN_LOCAL_MODEL", "").strip() or "qwen3.5:4b"
        return (
            ProviderConfig(
                provider="local",
                connection_id="golden_local",
                display_name="Ollama locale (golden)",
                base_url=LOCAL_OLLAMA_BASE_URL,
                model_id=model,
                via_local_ollama=True,
            ),
            "",
        )
    if provider == "cloud":
        # Senza BASE_URL il cloud passa dal demone Ollama locale (modelli
        # «:cloud», stesso endpoint, nessuna chiave da gestire); con BASE_URL
        # si usa un endpoint OpenAI-compatibile qualsiasi e serve la chiave.
        base_url = os.environ.get("HOMUN_GOLDEN_CLOUD_BASE_URL", "").strip() or LOCAL_OLLAMA_BASE_URL
        model = os.environ.get("HOMUN_GOLDEN_CLOUD_MODEL", "").strip()
        api_key = os.environ.get("HOMUN_GOLDEN_CLOUD_API_KEY", "").strip() or None
        if not model:
            return None, "variabile d'ambiente mancante: HOMUN_GOLDEN_CLOUD_MODEL"
        if not api_key and not _is_loopback(base_url):
            return None, "HOMUN_GOLDEN_CLOUD_API_KEY richiesta per un endpoint remoto"
        return (
            ProviderConfig(
                provider="cloud",
                connection_id="golden_cloud",
                display_name="Cloud (golden)",
                base_url=base_url,
                model_id=model,
                api_key=api_key,
                via_local_ollama=_is_loopback(base_url),
            ),
            "",
        )
    return None, "imposta HOMUN_GOLDEN_PROVIDER=local (Ollama) oppure =cloud (Ollama cloud o OpenAI-compatibile)"


def probe_provider(config: ProviderConfig) -> str:
    """Motivo per cui il provider non è raggiungibile, o stringa vuota se lo è."""
    try:
        if config.via_local_ollama:
            response = httpx.get(config.base_url.rstrip("/") + "/models", timeout=8.0)
            response.raise_for_status()
            ids = [item.get("id") for item in response.json().get("data", [])]
            if config.model_id not in ids:
                return (
                    f"Ollama attivo ma il modello {config.model_id!r} non è presente "
                    f"(ollama pull {config.model_id})"
                )
            return ""
        headers = {"Authorization": f"Bearer {config.api_key}"} if config.api_key else {}
        response = httpx.get(
            config.base_url.rstrip("/") + "/models", headers=headers, timeout=10.0
        )
        if response.status_code in (401, 403):
            return f"il provider {config.base_url} rifiuta la chiave (HTTP {response.status_code})"
        return ""
    except httpx.HTTPError as exc:
        return f"provider non raggiungibile su {config.base_url}: {type(exc).__name__}: {exc}"


class Engine:
    """Il motore come processo reale: `python -m homun serve`, porta effimera."""

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.token = secrets.token_hex(32)
        self.port: int | None = None
        self._proc: subprocess.Popen | None = None
        self._client: HomunClient | None = None
        self._log = None

    @property
    def base_url(self) -> str:
        if self.port is None:
            raise GoldenError("engine_not_started", "il motore non è stato avviato")
        return f"http://127.0.0.1:{self.port}"

    @property
    def log_path(self) -> Path:
        return self.data_dir / "engine.log"

    def client(self) -> HomunClient:
        if self._client is None:
            self._client = HomunClient(self.base_url, self.token)
        return self._client

    def start(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return
        self.port = None
        env = dict(os.environ)
        env["HOMUN_DATA_DIR"] = str(self.data_dir)
        env["HOMUN_SESSION_TOKEN"] = self.token
        env.setdefault("HOMUN_LOG_LEVEL", "INFO")
        log = self.log_path.open("a", encoding="utf-8")
        self._log = log
        self._proc = subprocess.Popen(
            [sys.executable, "-m", "homun", "serve", "--host", "127.0.0.1", "--port", "0"],
            stdout=subprocess.PIPE,
            stderr=log,
            env=env,
            text=True,
            bufsize=1,
        )
        socket_line: list[str] = []

        def read_stdout() -> None:
            assert self._proc is not None and self._proc.stdout is not None
            for line in self._proc.stdout:
                log.write(line)
                log.flush()
                if line.startswith("HOMUN_SOCKET") and not socket_line:
                    socket_line.append(line.strip())

        threading.Thread(target=read_stdout, daemon=True).start()
        deadline = time.monotonic() + ENGINE_BOOT_TIMEOUT
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                raise GoldenError(
                    "engine_boot_failed",
                    f"il motore è terminato all'avvio (codice {self._proc.returncode})",
                    excerpt_of(self.log_path.read_text(errors="replace")[-800:]),
                )
            if socket_line:
                match = re.search(r'"port"\s*:\s*(\d+)', socket_line[0])
                if match:
                    self.port = int(match.group(1))
                    break
            time.sleep(0.1)
        if self.port is None:
            self.stop()
            raise GoldenError(
                "engine_boot_timeout",
                f"nessun HOMUN_SOCKET entro {ENGINE_BOOT_TIMEOUT}s",
                excerpt_of(self.log_path.read_text(errors="replace")[-800:]),
            )
        # Socket riservato ≠ pronto: si aspetta la salute autenticata, come il desktop.
        deadline = time.monotonic() + ENGINE_BOOT_TIMEOUT
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                self.client().get("/v1/health")
                return
            except (GoldenError, httpx.HTTPError) as exc:
                last_error = exc
                time.sleep(0.3)
        self.stop()
        raise GoldenError(
            "engine_health_timeout",
            f"/v1/health non ha risposto entro {ENGINE_BOOT_TIMEOUT}s: {last_error}",
        )

    def stop(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None
        if self._proc is not None:
            if self._proc.poll() is None:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
                    self._proc.wait(timeout=10)
            self._proc = None
        if self._log is not None:
            self._log.close()
            self._log = None

    def restart(self) -> None:
        self.stop()
        time.sleep(1.0)
        self.start()

    def last_exception(self) -> str:
        """L'ultima riga d'eccezione nel log del motore: spiega un run bloccato
        quando l'API espone solo l'`error_code`."""
        try:
            lines = self.log_path.read_text(errors="replace").splitlines()
        except OSError:
            return ""
        for line in reversed(lines[-400:]):
            if re.match(r"^[\w.]+(Error|Exception): ", line):
                return redact(line.strip())
        return ""
