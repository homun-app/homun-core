"""Client HTTP del percorso d'oro: gli stessi endpoint dei client della UI.

Ogni metodo corrisponde a una chiamata che la UI web fa davvero
(`apps/web/src/lib`): comandi di dominio, conversazioni, lavori, materiali,
routine e modelli. Niente scorciatoie nel processo del motore.
"""
from __future__ import annotations

import secrets
import time
from typing import TYPE_CHECKING, Any

import httpx

from .common import (
    CHAT_REPLY_TIMEOUT,
    CHAT_WORK_TITLE,
    HTTP_TIMEOUT,
    POLL_INTERVAL,
    RECOVERY_WINDOW_TIMEOUT,
    UI_ACTOR_ID,
    UI_ACTOR_NAME,
    UI_NEW_REQUEST_OBJECTIVE,
    UI_NEW_REQUEST_TITLE,
    WORK_RUN_TIMEOUT,
    WORKSPACE,
    GoldenError,
    excerpt_of,
)

if TYPE_CHECKING:
    from .harness import ProviderConfig


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

    def create_conversation_and_work(self) -> tuple[str, str, int]:
        """Una conversazione nuova come la apre la UI: conversazione + lavoro «Nuova richiesta».

        È `createEngineConversationAndWork` (conversation-engine-bridge.ts): ogni
        chat del motore nasce con un lavoro in bozza dall'obiettivo da concordare.
        Restituisce (conversation_id, work_id, versione del lavoro).
        """
        conversation_id = self.create_conversation(UI_NEW_REQUEST_TITLE)
        created = self.create_work(conversation_id, UI_NEW_REQUEST_TITLE, UI_NEW_REQUEST_OBJECTIVE)
        return conversation_id, str(created["work_id"]), int(created["version"])

    def ui_roster(self) -> list[dict[str, str]]:
        """Il roster che la UI allega a ogni messaggio (`postEngineConversationMessage`):
        la persona più gli agenti attivi o in bozza."""
        roster = [{"id": UI_ACTOR_ID, "display_name": UI_ACTOR_NAME, "kind": "person"}]
        for agent in self.list_agents():
            if agent.get("status") in {"active", "draft"}:
                roster.append(
                    {"id": str(agent["id"]), "display_name": str(agent.get("name") or agent["id"]), "kind": "agent"}
                )
        return roster

    def post_message(
        self,
        conversation_id: str,
        text: str,
        connection_id: str | None = None,
        roster: list[dict[str, str]] | None = None,
    ) -> tuple[dict[str, Any], GoldenError | None]:
        """Invia un messaggio; restituisce (risultato, errore) senza sollevare.

        È il POST di `conversation.post_message` che la UI fa per ogni messaggio
        di una conversazione esistente (useEngineWorkspace.postMessage →
        postEngineConversationMessage): `roster` e `connection_id` come li manda lei.
        """
        payload: dict[str, Any] = {"conversation_id": conversation_id, "text": text}
        if connection_id:
            payload["connection_id"] = connection_id
        if roster is not None:
            payload["roster"] = roster
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

    def post_message_when_free(
        self,
        conversation_id: str,
        text: str,
        timeout: float = RECOVERY_WINDOW_TIMEOUT,
        roster: list[dict[str, str]] | None = None,
    ) -> tuple[dict[str, Any], GoldenError | None, int]:
        """Invia un messaggio riprovando finché la conversazione è occupata.

        Dopo un turno fallito il motore tiene la conversazione occupata per la
        finestra di retry del followup (`command_in_progress`, ~40-60 s): qui si
        riprova fino a `timeout`. Restituisce (risultato, errore, rifiuti): errore
        è l'ultimo ricevuto se il messaggio non è stato accettato; i rifiuti sono
        i `command_in_progress` incassati prima dell'accettazione.
        """
        deadline = time.monotonic() + timeout
        rejections = 0
        while True:
            result, error = self.post_message(conversation_id, text, roster=roster)
            if error is None:
                return result, None, rejections
            if error.code != "command_in_progress" or time.monotonic() >= deadline:
                return {}, error, rejections
            rejections += 1
            time.sleep(5)

    def message_persisted(self, conversation_id: str, message_id: str, text_part: str) -> bool:
        """Il messaggio della persona è in trascrizione (per id o per testo): per la
        UI è questo che vuol dire «accettato», anche quando la risposta arriva dopo."""
        for _ in range(10):
            messages = self.messages(conversation_id)
            if message_id and any(m.get("id") == message_id for m in messages):
                return True
            if any(text_part in (m.get("text") or "") for m in messages):
                return True
            time.sleep(3)
        return False

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

    def propose_plan(self, work_id: str, expected_version: int, steps: list[dict[str, Any]]) -> dict[str, Any]:
        """Piano esplicito (`plan.propose`): è come il motore apre un lavoro chat o una routine."""
        return self.command(
            "plan.propose", {"work_id": work_id, "expected_version": expected_version, "steps": steps}
        )

    def accept_plan(self, work_id: str, expected_version: int) -> dict[str, Any]:
        return self.command("plan.accept", {"work_id": work_id, "expected_version": expected_version})

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

    def start_work(self, work_id: str, mode: str = "guarded") -> dict[str, Any]:
        """«Conferma accordo e avvia» della UI: il motore sceglie l'esecutore."""
        body = {"command_id": f"golden-{secrets.token_hex(6)}", "mode": mode}
        return self.post(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/start", body)

    def approve_execution(self, work_id: str, view: dict[str, Any]) -> dict[str, Any]:
        """«Avvia» della scheda di esecuzione (modalità Supervisionato)."""
        body = {
            "command_id": f"golden-{secrets.token_hex(6)}",
            "digest": view["digest"],
            "expected_version": view["expected_version"],
        }
        path = f"/v1/workspaces/{WORKSPACE}/works/{work_id}/executions/{view['id']}/approve"
        return self.post(path, body)

    def execution(self, work_id: str) -> dict[str, Any]:
        return self.get(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/execution")

    def wait_execution(
        self, work_id: str, execution_id: str, timeout: float = WORK_RUN_TIMEOUT
    ) -> dict[str, Any]:
        """Rilegge lo stato dell'esecuzione come fa la scheda in chat."""
        deadline = time.monotonic() + timeout
        latest: dict[str, Any] = {}
        while time.monotonic() < deadline:
            latest = self.execution(work_id)
            status = str(latest.get("status") or "")
            if latest.get("id") == execution_id and status == "completed":
                return latest
            if status in {"failed", "cancelled", "blocked"}:
                detail = f" (error_code {latest['error_code']})" if latest.get("error_code") else ""
                raise GoldenError(
                    f"{latest.get('kind') or 'esecuzione'}_{status}",
                    f"esecuzione {execution_id} terminata in stato {status}{detail}",
                    excerpt_of(latest),
                )
            if status == "waiting_input":
                raise GoldenError(
                    "run_waiting_input",
                    f"esecuzione {execution_id} ha chiesto un chiarimento invece di consegnare",
                    excerpt_of(latest),
                )
            time.sleep(POLL_INTERVAL)
        raise GoldenError(
            "timeout", f"esecuzione {execution_id} non completata entro {timeout:g}s", excerpt_of(latest)
        )

    def agent_runs(self, work_id: str) -> list[dict[str, Any]]:
        return self.get(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/agent-runs").get("items") or []

    def wait_agent_run(
        self, work_id: str, run_id: str, timeout: float = WORK_RUN_TIMEOUT
    ) -> dict[str, Any]:
        return self._wait_item(
            f"/v1/workspaces/{WORKSPACE}/works/{work_id}/agent-runs",
            run_id,
            timeout,
            label="run agente",
        )

    def chat_run_work(self, conversation_id: str, run_id: str) -> str | None:
        """Il lavoro «Chat agente» che ospita il run di un turno di chat.

        Il percorso chat-agente (chat_agent.py) nasconde il turno in un lavoro
        interno: per leggere lo stato del run bisogna ritrovarlo da lì.
        """
        for work in self.list_works():
            if work.get("title") != CHAT_WORK_TITLE:
                continue
            if any(run.get("id") == run_id for run in self.agent_runs(str(work["id"]))):
                return str(work["id"])
        return None

    def _wait_item(self, path: str, item_id: str, timeout: float, label: str) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        latest: dict[str, Any] = {}
        slug = label.replace(" ", "_")
        while time.monotonic() < deadline:
            items = self.get(path).get("items") or []
            latest = next((item for item in items if item.get("id") == item_id), latest)
            status = str(latest.get("status") or "")
            if status == "completed":
                return latest
            if status in {"failed", "cancelled", "blocked"}:
                detail = f" (error_code {latest['error_code']})" if latest.get("error_code") else ""
                raise GoldenError(
                    f"{slug}_{status}",
                    f"{label} {item_id} è terminato in stato {status}{detail}",
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
