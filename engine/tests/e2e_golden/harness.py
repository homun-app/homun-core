"""Harness del banco di prova «percorso d'oro»: motore reale + client HTTP.

Il motore viene avviato come processo reale (`python -m homun serve`) su una
porta effimera di loopback, con data dir temporanea e token di sessione
generato ad hoc. La suite parla con lui solo via HTTP, come fa la UI web
(gli endpoint sono gli stessi che usano i client in `apps/web/src/lib`).
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import httpx

GOLDEN_DIR = Path(__file__).resolve().parent
WORKSPACE = "ws_local"

# Tempi massimi di attesa in secondi: con modelli veri il percorso è lento
# e la suite misura, non corre.
ENGINE_BOOT_TIMEOUT = 40
CHAT_REPLY_TIMEOUT = 300
RECOVERY_WINDOW_TIMEOUT = 180  # A3: finestra di sblocco dopo l'errore provocato
WORK_RUN_TIMEOUT = 600  # esecuzione di un lavoro (sintesi o run agente)
ROUTINE_TICK_TIMEOUT = 150  # D2: prima occorrenza di una routine al minuto
POLL_INTERVAL = 3.0

HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=320.0, write=60.0, pool=360.0)

# Titoli degli scenari come appaiono nel rapporto. Le chiavi sono i prefissi
# dei passi registrati («A1», «B2.conferma» → «B2»).
SCENARIOS: dict[str, str] = {
    "M0": "Connessione modello verificata (Impostazioni → Modelli)",
    "A1": "Domanda semplice: risposta in chat, nessun lavoro creato",
    "A2": "Tre messaggi di fila accettati, nell'ordine giusto",
    "A3": "Dopo un errore provocato il messaggio successivo è accettato",
    "A4": "La conversazione si ritrova e riprende dopo il riavvio",
    "B1": "Richiesta operativa → proposta di lavoro (intake)",
    "B2": "Conferma → esecuzione → risultato prodotto",
    "B3": "Il risultato contiene i fatti dati (Rossi, 30 novembre, 12.000)",
    "B4": "Correzione motivata → nuova versione del risultato",
    "B5": "Il lavoro sta in Compiti, il risultato approvato in Documenti",
    "C1": "Progetto con 2 file caricati (.md e .pdf) leggibili",
    "C2": "Ricerca nei materiali: il risultato cita i contenuti veri dei file",
    "C3": "Riassunto di un file: il risultato ne presenta i punti chiave",
    "D1": "Routine creata con la pianificazione giusta (lunedì alle 9)",
    "D2": "Esecuzione forzata della routine → lavoro ricorrente prodotto",
    "D3": "La routine sopravvive al riavvio del motore ed è ancora attiva",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def redact(text: Any) -> str:
    """Rende sicuro per il rapporto un testo: via token di sessione e chiavi."""
    raw = str(text)
    for name in ("HOMUN_GOLDEN_CLOUD_API_KEY", "HOMUN_SESSION_TOKEN"):
        value = os.environ.get(name)
        if value:
            raw = raw.replace(value, "«rimosso»")
    return raw


def run_count() -> int:
    """Quante volte gira ogni scenario (HOMUN_GOLDEN_RUNS, predefinito 3)."""
    raw = os.environ.get("HOMUN_GOLDEN_RUNS", "3").strip() or "3"
    try:
        count = int(raw)
    except ValueError:
        raise SystemExit(f"HOMUN_GOLDEN_RUNS non è un numero intero: {raw!r}")
    if count < 1:
        raise SystemExit(f"HOMUN_GOLDEN_RUNS deve essere >= 1: {count}")
    return count


def run_indices() -> list[int]:
    return list(range(1, run_count() + 1))


def excerpt_of(text: Any, limit: int = 400) -> str:
    raw = redact(text).replace("\n", " ⏎ ")
    return raw[:limit] + ("…" if len(raw) > limit else "")


def describe(error: GoldenError | None) -> str:
    """Rappresentazione compatta di un errore golden per le asserzioni."""
    return f"{error.code}: {error.reason}" if error else "nessun errore"


def normalize_for_match(text: str) -> str:
    """Versione normalizzata per controlli robusti sui fatti (12.000 → 12000)."""
    return re.sub(r"[.\s\u00a0,]", "", text.lower())


class GoldenError(Exception):
    """Fallimento misurato di un passo: codice, motivo ed estratto."""

    def __init__(self, code: str, reason: str, excerpt: str = ""):
        super().__init__(f"{code}: {reason}")
        self.code = code
        self.reason = reason
        self.excerpt = excerpt


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


class HomunClient:
    """Client HTTP del percorso d'oro: gli stessi endpoint dei client della UI."""

    def __init__(self, base_url: str, token: str):
        self._http = httpx.Client(
            base_url=base_url,
            timeout=HTTP_TIMEOUT,
            headers={"Authorization": f"Bearer {token}"},
        )

    def close(self) -> None:
        self._http.close()

    # -- trasporto ---------------------------------------------------------

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return self._checked(self._http.get(path, params=params))

    def post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        return self._checked(self._http.post(path, json=body or {}))

    def _checked(self, response: httpx.Response) -> Any:
        if response.status_code >= 400:
            raise self._http_error(response)
        try:
            return response.json()
        except ValueError:
            return response.text

    @staticmethod
    def _http_error(response: httpx.Response) -> GoldenError:
        try:
            body = response.json()
        except ValueError:
            body = {}
        detail = body.get("detail") if isinstance(body, dict) else {}
        if isinstance(detail, str):
            detail = {"message": detail}
        detail = detail or {}
        code = str(detail.get("code") or f"http_{response.status_code}")
        reason = str(detail.get("reason") or detail.get("message") or body or "")
        return GoldenError(code, reason, excerpt_of(body))

    # -- comandi di dominio (POST /commands, come engine-domain-client.ts) --

    def command(self, type_: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = {"command_id": f"golden-{secrets.token_hex(6)}", "type": type_, "payload": payload}
        result = self.post(f"/v1/workspaces/{WORKSPACE}/commands", body)
        return dict(result.get("result") or {})

    # -- conversazioni e chat ----------------------------------------------

    def create_conversation(self, title: str, project_id: str | None = None) -> str:
        payload: dict[str, Any] = {"title": title}
        if project_id:
            payload["project_id"] = project_id
        result = self.command("conversation.create", payload)
        return str(result["conversation_id"])

    def post_message(
        self, conversation_id: str, text: str, connection_id: str | None = None
    ) -> tuple[dict[str, Any], GoldenError | None]:
        """Invia un messaggio; restituisce (risultato, errore) senza sollevare."""
        payload: dict[str, Any] = {"conversation_id": conversation_id, "text": text}
        if connection_id:
            payload["connection_id"] = connection_id
        body = {
            "command_id": f"golden-{secrets.token_hex(6)}",
            "type": "conversation.post_message",
            "payload": payload,
        }
        response = self._http.post(f"/v1/workspaces/{WORKSPACE}/commands", json=body)
        if response.status_code >= 400:
            return {}, self._http_error(response)
        result = (response.json() or {}).get("result") or {}
        result["command_id"] = body["command_id"]
        return dict(result), None

    def messages(self, conversation_id: str, after: int = 0) -> list[dict[str, Any]]:
        path = f"/v1/workspaces/{WORKSPACE}/conversations/{conversation_id}/messages"
        items: list[dict[str, Any]] = []
        cursor = after
        while True:
            page = self.get(path, params={"after": cursor, "limit": 200})
            items.extend(page.get("items") or [])
            cursor = int(page.get("cursor") or 0)
            if not page.get("has_more") or not page.get("items"):
                return items

    def conversation(self, conversation_id: str) -> dict[str, Any] | None:
        items = self.get(f"/v1/workspaces/{WORKSPACE}/conversations").get("items") or []
        return next((item for item in items if item.get("id") == conversation_id), None)

    def wait_chat_reply(
        self,
        conversation_id: str,
        after_sequence: int,
        timeout: float = CHAT_REPLY_TIMEOUT,
        expect_command: str | None = None,
    ) -> dict[str, Any]:
        """Attende il messaggio dell'assistente (percorso agente-chat asincrono).

        I followup falliti contano solo se appartengono al comando atteso: i
        tentativi esauriti di un messaggio precedente non devono mascherare
        la risposta nuova.
        """

        def latest_assistant() -> dict[str, Any] | None:
            for message in reversed(self.messages(conversation_id, after=after_sequence)):
                if message.get("author_id") == "homun_engine" and (message.get("text") or "").strip():
                    return message
            return None

        def failed_followup() -> str | None:
            item = self.conversation(conversation_id) or {}
            for followup in item.get("followups") or []:
                if followup.get("status") != "failed":
                    continue
                if expect_command is None or followup.get("command_id") == expect_command:
                    return str(followup.get("error_code") or "followup_failed")
            return None

        deadline = time.monotonic() + timeout
        last_tail = ""
        while time.monotonic() < deadline:
            reply = latest_assistant()
            if reply is not None:
                return reply
            failure = failed_followup()
            if failure:
                raise GoldenError(
                    failure,
                    f"il turno di chat è fallito (followup) su {conversation_id}",
                    excerpt_of(last_tail),
                )
            time.sleep(POLL_INTERVAL)
        tail = self.messages(conversation_id)[-3:]
        last_tail = " | ".join(str(m.get("text") or "")[:120] for m in tail)
        raise GoldenError(
            "timeout",
            f"nessuna risposta del motore entro {timeout:g}s",
            excerpt_of(last_tail),
        )

    def resolve_reply(
        self, conversation_id: str, result: dict[str, Any], user_message_id: str | None = None
    ) -> str:
        """La risposta della chat: sincrona nel POST (interpret) o da attendere (agente)."""
        text = result.get("assistant_text")
        if isinstance(text, str) and text.strip():
            return text
        after = 0
        if user_message_id:
            for message in self.messages(conversation_id):
                if message.get("id") == user_message_id:
                    after = int(message.get("sequence") or 0)
        reply = self.wait_chat_reply(
            conversation_id, after, expect_command=result.get("command_id")
        )
        return str(reply.get("text") or "")

    # -- lavori: intake, esecuzione, revisione ------------------------------

    def list_works(self) -> list[dict[str, Any]]:
        return self.get(f"/v1/workspaces/{WORKSPACE}/works").get("items") or []

    def work_row(self, work_id: str) -> dict[str, Any] | None:
        return next((item for item in self.list_works() if item.get("id") == work_id), None)

    def work_detail(self, work_id: str) -> dict[str, Any]:
        return self.get(f"/v1/workspaces/{WORKSPACE}/works/{work_id}")

    def create_work(self, conversation_id: str, title: str, objective: str) -> dict[str, Any]:
        return self.command(
            "work.create", {"conversation_id": conversation_id, "title": title, "objective": objective}
        )

    def classify_intake(self, work_id: str, text: str) -> dict[str, Any]:
        return self.post(
            f"/v1/workspaces/{WORKSPACE}/works/{work_id}/intake/classify", {"text": text}
        )

    def propose_intake(self, work_id: str, text: str, expected_version: int) -> dict[str, Any]:
        body = {
            "command_id": f"golden-{secrets.token_hex(6)}",
            "text": text,
            "expected_version": expected_version,
        }
        return self.post(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/intake", body)

    def confirm_intake(
        self, work_id: str, proposal: dict[str, Any], create_agent: bool = False
    ) -> dict[str, Any]:
        body = {
            "command_id": f"golden-{secrets.token_hex(6)}",
            "digest": proposal["digest"],
            "expected_version": proposal["expected_version"],
            "create_agent": create_agent,
        }
        path = f"/v1/workspaces/{WORKSPACE}/works/{work_id}/intake/{proposal['id']}/confirm"
        return self.post(path, body)

    def prepare_synthesis(
        self, work_id: str, expected_version: int, material_ids: list[str]
    ) -> dict[str, Any]:
        body = {
            "command_id": f"golden-{secrets.token_hex(6)}",
            "expected_version": expected_version,
            "material_ids": material_ids,
            "skill_ids": [],
        }
        return self.post(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/syntheses", body)

    def approve_synthesis(self, work_id: str, proposal: dict[str, Any]) -> dict[str, Any]:
        body = {
            "command_id": f"golden-{secrets.token_hex(6)}",
            "digest": proposal["digest"],
            "expected_version": proposal["expected_version"],
        }
        path = f"/v1/workspaces/{WORKSPACE}/works/{work_id}/syntheses/{proposal['id']}/approve"
        return self.post(path, body)

    def wait_synthesis(
        self, work_id: str, proposal_id: str, timeout: float = WORK_RUN_TIMEOUT
    ) -> dict[str, Any]:
        return self._wait_item(
            f"/v1/workspaces/{WORKSPACE}/works/{work_id}/syntheses",
            proposal_id,
            timeout,
            label="sintesi",
        )

    def prepare_agent_run(
        self, work_id: str, expected_version: int, material_ids: list[str]
    ) -> dict[str, Any]:
        body = {
            "command_id": f"golden-{secrets.token_hex(6)}",
            "expected_version": expected_version,
            "material_ids": material_ids,
        }
        return self.post(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/agent-runs", body)

    def approve_agent_run(self, work_id: str, run: dict[str, Any]) -> dict[str, Any]:
        body = {
            "command_id": f"golden-{secrets.token_hex(6)}",
            "expected_version": run["expected_version"],
            "digest": run["digest"],
        }
        return self.post(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/agent-runs/{run['id']}/approve", body)

    def wait_agent_run(
        self, work_id: str, run_id: str, timeout: float = WORK_RUN_TIMEOUT
    ) -> dict[str, Any]:
        return self._wait_item(
            f"/v1/workspaces/{WORKSPACE}/works/{work_id}/agent-runs",
            run_id,
            timeout,
            label="run agente",
        )

    def _wait_item(self, path: str, item_id: str, timeout: float, label: str) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        latest: dict[str, Any] = {}
        while time.monotonic() < deadline:
            items = self.get(path).get("items") or []
            latest = next((item for item in items if item.get("id") == item_id), latest)
            status = str(latest.get("status") or "")
            if status == "completed":
                return latest
            if status in {"failed", "cancelled", "blocked"}:
                raise GoldenError(
                    f"{label}_{status}",
                    f"{label} {item_id} è terminato in stato {status}",
                    excerpt_of(latest),
                )
            if status == "waiting_input":
                raise GoldenError(
                    "run_waiting_input",
                    f"{label} {item_id} ha chiesto un chiarimento invece di consegnare",
                    excerpt_of(latest),
                )
            time.sleep(POLL_INTERVAL)
        raise GoldenError("timeout", f"{label} {item_id} non completato entro {timeout:g}s", excerpt_of(latest))

    def review_work(
        self,
        work_id: str,
        expected_version: int,
        artifact_version_id: str,
        decision: str,
        comment: str = "",
    ) -> dict[str, Any]:
        return self.command(
            "work.review",
            {
                "work_id": work_id,
                "expected_version": expected_version,
                "artifact_version_id": artifact_version_id,
                "decision": decision,
                "comment": comment,
            },
        )

    def list_artifacts(self) -> list[dict[str, Any]]:
        return self.get(f"/v1/workspaces/{WORKSPACE}/artifacts").get("items") or []

    # -- progetti e materiali ----------------------------------------------

    def create_project(self, name: str, description: str = "") -> dict[str, Any]:
        return self.command("project.create", {"name": name, "description": description})

    def upload_material(
        self, project_id: str, filename: str, content: bytes, mime_type: str, title: str | None = None
    ) -> dict[str, Any]:
        response = self._http.post(
            f"/v1/workspaces/{WORKSPACE}/projects/{project_id}/materials/ingest",
            headers={"X-Homun-Command-Id": f"golden-up-{secrets.token_hex(6)}"},
            files={"file": (filename, content, mime_type)},
            data={"title": title or filename},
        )
        return self._checked(response)

    def list_materials(self, project_id: str) -> list[dict[str, Any]]:
        return self.get(f"/v1/workspaces/{WORKSPACE}/projects/{project_id}/materials").get("items") or []

    def material_content(self, material_id: str) -> dict[str, Any]:
        return self.get(f"/v1/workspaces/{WORKSPACE}/materials/{material_id}/content")

    # -- agenti e routine ---------------------------------------------------

    def list_agents(self) -> list[dict[str, Any]]:
        return self.get(f"/v1/workspaces/{WORKSPACE}/agents").get("items") or []

    def create_agent(self, name: str, role: str) -> str:
        result = self.command("agent.create", {"name": name, "role": role})
        return str(result["agent_id"])

    def create_routine(
        self, name: str, cron: str, conversation_id: str, template: dict[str, Any]
    ) -> dict[str, Any]:
        body = {
            "command_id": f"golden-{secrets.token_hex(6)}",
            "name": name,
            "cron": cron,
            "cron_timezone": "Europe/Rome",
            "conversation_id": conversation_id,
            "template": template,
        }
        return self.post(f"/v1/workspaces/{WORKSPACE}/routines", body)

    def list_routines(self) -> list[dict[str, Any]]:
        return self.get(f"/v1/workspaces/{WORKSPACE}/routines").get("items") or []

    def routine_preview(self, cron: str, timezone: str = "Europe/Rome") -> dict[str, Any]:
        return self.get(
            f"/v1/workspaces/{WORKSPACE}/routines/preview", params={"cron": cron, "tz": timezone}
        )

    # -- modelli -------------------------------------------------------------

    def upsert_connection(self, config: ProviderConfig) -> dict[str, Any]:
        body: dict[str, Any] = {
            "connection_id": config.connection_id,
            "kind": "openai_compatible",
            "display_name": config.display_name,
            "model_id": config.model_id,
            "base_url": config.base_url,
            "context_window": 16384,
            "max_output_tokens": 8192,
        }
        if config.api_key:
            body["api_key"] = config.api_key
        return self.post("/v1/models/connections", body)

    def set_active_connection(self, connection_id: str) -> dict[str, Any]:
        return self.post("/v1/models/providers/active", {"provider_id": connection_id})

    def verify_connection(self, connection_id: str) -> dict[str, Any]:
        return self.post(f"/v1/models/providers/{connection_id}/verify", {})


def wait_until(
    predicate: Callable[[], Any], timeout: float, what: str, interval: float = POLL_INTERVAL
) -> Any:
    """Attende che predicate() restituisca verità; solleva GoldenError a timeout."""
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval)
    raise GoldenError("timeout", f"{what} non riuscito entro {timeout:g}s (ultimo stato: {last!r})")
