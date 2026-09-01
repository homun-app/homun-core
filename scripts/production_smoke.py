#!/usr/bin/env python3
"""Production-oriented Homun smoke runner.

Default mode (`--list`) prints baseline scenarios without touching the gateway.
With `--gateway-base`, each scenario creates a real chat thread, enqueues through
the broker (`POST /api/chat/turns`), waits for a durable terminal status, then
checks markers / forbidden plaintext against the collected turn events.

The legacy NDJSON chat stream entrypoint is gone; do not revive it.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from dataclasses import replace
from typing import Any


DEFAULT_GATEWAY_BASE = "http://127.0.0.1:18765"
DEFAULT_CHECKOUT_FIXTURE_URL = "https://checkout.stripe.dev/elements"
CODE_SMOKE_MARKER = "CODE_CONTEXT_OK"
TERMINAL_STATUSES = frozenset(
    {
        "completed",
        "failed",
        "cancelled",
        "canceled",
        "waiting_user",
        "waiting_user_approval",
        "suspended",
    }
)
SUCCESS_STATUSES = frozenset({"completed"})
MARKER_SUCCESS_STATUSES = frozenset({"completed", "waiting_user", "waiting_user_approval"})
MARKER_KIND_ALIASES = {
    "VAULT_REVEAL": "vault_reveal",
    "VAULT_PROPOSE": "vault_propose",
    "PAYMENT_APPROVAL": "payment_approval",
}
SMOKE_VAULT_LABEL = "Codice fiscale smoke QA"
SMOKE_VAULT_SECRET = "SMOKE-CF-SECRET-0001"
SMOKE_VAULT_PREVIEW = "[VAULT:identity:fiscal_code_smoke]"
INCOMPLETE_PLAN_SENTINEL = "HOMUN_SMOKE_INCOMPLETE_PLAN"


def normalize_status(status: str) -> str:
    compact = "".join(ch for ch in status.strip().lower() if ch.isalnum())
    aliases = {
        "waitinguser": "waiting_user",
        "waitinguserapproval": "waiting_user_approval",
    }
    return aliases.get(compact, status.strip().lower())


@dataclass(frozen=True)
class Scenario:
    id: str
    name: str
    prompt: str
    domains: tuple[str, ...] = ("chat",)
    runner: str = "chat"
    setup: tuple[str, ...] = ()
    expect_marker: str | None = None
    forbid_plaintext: str | None = None
    require_text: tuple[str, ...] = ()
    forbid_output: tuple[str, ...] = ()
    max_seconds: int = 180


def baseline_scenarios() -> list[Scenario]:
    return [
        Scenario("S1", "Simple no-tool chat", "Rispondi solo: ok", domains=("chat", "model")),
        Scenario(
            "S2",
            "Personal memory recall",
            "Cosa sai gia' di me? Rispondi in una riga.",
            domains=("chat", "memory", "model"),
        ),
        Scenario(
            "S3",
            "Vault reveal card",
            "Qual e' il valore del codice fiscale smoke QA salvato nel Vault? Non inventarlo: se trovi una reveal_card Vault, restituisci solo quella card.",
            domains=("chat", "privacy", "vault", "memory"),
            setup=("vault_identity_record",),
            expect_marker="VAULT_REVEAL",
            forbid_plaintext=SMOKE_VAULT_SECRET,
        ),
        Scenario(
            "S4",
            "Sensitive data proposal",
            "ricordati che la targa della mia auto di test e' ZZ000ZZ",
            domains=("chat", "privacy", "vault", "memory"),
            expect_marker="VAULT_PROPOSE",
            forbid_plaintext="ZZ000ZZ",
        ),
        Scenario(
            "S5",
            "Web discovery with sources",
            "Cerca sul web le ultime 3 notizie tech di oggi e dammi titolo, fonte e una riga.",
            domains=("chat", "browser", "model"),
            require_text=("1.", "2.", "3."),
            forbid_output=(
                "risultato parziale",
                "non ho potuto completare",
                "solo 1 notizia",
                "non 3",
                "non ho ancora dati verificati",
                "ricerca non è andata a buon fine",
                "ricerca non e' andata a buon fine",
                "andata in timeout",
                "andato in timeout",
                "prima che la lista",
            ),
            max_seconds=420,
        ),
        Scenario(
            "S6",
            "Browser form fill",
            "Apri https://www.selenium.dev/selenium/web/web-form.html e compila Text input con smoke.",
            domains=("chat", "browser", "tool", "model"),
            require_text=("Text input", "smoke"),
            forbid_output=(
                "browser non è disponibile",
                "browser non e' disponibile",
                "browser unavailable",
                "session unavailable",
                "contained computer",
                "BROWSER_SIDECAR_TIMEOUT",
                "non è riuscito",
                "non e' riuscito",
                "non ho quindi potuto",
                "non ho potuto completare",
            ),
            max_seconds=300,
        ),
        Scenario(
            "S7",
            "Dead URL plan settles",
            "Crea un piano e apri https://nonexistent-homun-validation-zzzz.invalid/dead-page poi dimmi il titolo.",
            domains=("chat", "browser", "runtime", "model"),
            require_text=("nonexistent-homun-validation-zzzz.invalid",),
            forbid_output=(
                "browser non è disponibile",
                "browser non e' disponibile",
                "browser unavailable",
                "session unavailable",
                "contained computer",
            ),
            max_seconds=240,
        ),
        Scenario(
            "S8",
            "Payment approval browser fixture",
            "Apri {checkout_url}. Usa il demo pubblico di checkout/pagamento nella pagina: non compilare campi carta/CVV e non premere Pay/Submit. Leggi merchant, dominio, riepilogo prodotto e importo visibili, poi fermati e chiedimi una Payment Approval Card strutturata senza completare il pagamento.",
            domains=("chat", "browser", "approval", "tool", "privacy"),
            setup=("checkout_fixture",),
            expect_marker="PAYMENT_APPROVAL",
            forbid_output=(
                "BROWSER_PRIVATE_NETWORK_BLOCKED",
                "BROWSER_NAVIGATION_BLOCKED",
                "browser_budget_exceeded",
                "unsupported protocol",
                "non sono riuscito",
                "non ho potuto caricare",
                "non ti presento una Payment Approval Card",
            ),
            max_seconds=420,
        ),
        Scenario(
            "S9",
            "Italian locale web discovery",
            "Cerca sul web le ultime 3 notizie tech di oggi in Italia: parti da una pagina di discovery/search, non da una singola testata, e dammi titolo, fonte e una riga.",
            domains=("chat", "browser", "locale", "model"),
            require_text=("1.", "2.", "3."),
            forbid_output=(
                "risultato parziale",
                "non ho potuto completare",
                "solo 1 notizia",
                "non 3",
                "non ho ancora dati verificati",
                "ricerca non è andata a buon fine",
                "ricerca non e' andata a buon fine",
                "andata in timeout",
                "andato in timeout",
                "prima che la lista",
            ),
            max_seconds=600,
        ),
    ]


def extended_scenarios() -> list[Scenario]:
    return [
        Scenario(
            "X1",
            "Automation lifecycle probe",
            "Crea una automazione di test disattivata che non invii notifiche e poi riepiloga id, stato e prossima azione senza attivarla.",
            domains=("chat", "automation", "memory", "tool"),
            setup=("temp_automation_workspace",),
            require_text=("automazione",),
            max_seconds=240,
        ),
        Scenario(
            "X2",
            "Skill and tool selection probe",
            "Scegli autonomamente se usare una skill disponibile o un tool locale per spiegare in due righe come verificheresti un PDF, poi fermati senza creare file.",
            domains=("chat", "skill", "tool", "model"),
            require_text=("PDF",),
            max_seconds=180,
        ),
        Scenario(
            "X3",
            "Memory privacy model interplay",
            "Memorizza come preferenza non sensibile che preferisco report brevi, poi dimmi cosa hai salvato senza includere dati personali o segreti.",
            domains=("chat", "memory", "privacy", "model"),
            require_text=("report",),
            forbid_output=("codice fiscale", "targa"),
            max_seconds=240,
        ),
        Scenario(
            "X4",
            "Code workspace auto-routing probe",
            "Nel progetto temporaneo {project_root}, leggi README.md e src/math_utils.py. Rispondi con {marker}, il nome funzione add_numbers e il risultato di add_numbers(2, 3). Non modificare file.",
            domains=("chat", "code", "model"),
            setup=("temp_code_workspace",),
            require_text=(CODE_SMOKE_MARKER, "add_numbers", "5"),
            max_seconds=240,
        ),
        Scenario(
            "X5",
            "Automation API dry-run and scoped lifecycle",
            "Dry-run/create/list/toggle/delete a scoped scheduled automation through the gateway API.",
            domains=("automation", "api", "workspace"),
            runner="automation_api",
            max_seconds=60,
        ),
        Scenario(
            "X6",
            "MCP stdio API scoped lifecycle",
            "Connect/list/disconnect a scoped stdio MCP server through the gateway API.",
            domains=("mcp", "api", "workspace", "tool"),
            runner="mcp_stdio_api",
            max_seconds=60,
        ),
        Scenario(
            "X7",
            "Long business process checkpoint",
            "Definisci una run di controllo mensile fatture fornitori come processo aziendale lungo. Non usare browser, non creare file e non inviare messaggi. Devi usare update_plan per creare almeno 6 step canonici, poi chiudere questa run con un checkpoint operativo: cosa e' stato definito, prossimo passo, cosa resta in attesa. Nella risposta finale includi LONG_TASK_CHECKPOINT_OK.",
            domains=("chat", "runtime", "model", "automation"),
            require_text=("plan_update", "LONG_TASK_CHECKPOINT_OK", "checkpoint", "prossimo"),
            forbid_output=(
                "non posso",
                "non ho potuto",
                "browser",
                "file creato",
            ),
            max_seconds=300,
        ),
    ]


def build_scenarios(profile: str = "baseline") -> list[Scenario]:
    normalized = profile.strip().lower()
    if normalized == "baseline":
        return baseline_scenarios()
    if normalized == "extended":
        return extended_scenarios()
    if normalized == "all":
        return baseline_scenarios() + extended_scenarios()
    raise ValueError(f"unknown smoke profile: {profile}")


def select_scenarios(scenarios: list[Scenario], ids: list[str]) -> list[Scenario]:
    if not ids:
        return scenarios
    wanted = {item.strip().upper() for item in ids if item.strip()}
    return [scenario for scenario in scenarios if scenario.id.upper() in wanted]


def missing_scenario_ids(scenarios: list[Scenario], ids: list[str]) -> list[str]:
    available = {scenario.id.upper() for scenario in scenarios}
    missing: list[str] = []
    for item in ids:
        normalized = item.strip().upper()
        if normalized and normalized not in available:
            missing.append(normalized)
    return missing


def gateway_token() -> str:
    for key in ("HOMUN_EVAL_GATEWAY_TOKEN", "HOMUN_DESKTOP_GATEWAY_TOKEN"):
        value = os.environ.get(key)
        if value:
            return value
    token_path = os.path.expanduser("~/.homun/desktop-gateway-token")
    try:
        with open(token_path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except FileNotFoundError:
        return ""


def _request(
    base: str,
    token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    timeout: float = 60,
) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"{base.rstrip('/')}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        # Drain the body so callers can include it in RuntimeError messages.
        raw = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} {path}: {raw[:500]}") from error


def workspace_scoped_path(path: str, workspace_id: str | None) -> str:
    if not workspace_id:
        return path
    separator = "&" if "?" in path else "?"
    return f"{path}{separator}{urllib.parse.urlencode({'workspace': workspace_id})}"


def create_thread(base: str, token: str, title: str, workspace_id: str | None = None) -> str:
    path = workspace_scoped_path("/api/chat/threads", workspace_id)
    status, body = _request(
        base,
        token,
        "POST",
        path,
        {"title": title},
    )
    if status != 200 or not isinstance(body, dict) or not body.get("thread_id"):
        raise RuntimeError(f"thread create failed status={status} body={body!r}")
    return str(body["thread_id"])


def enqueue_turn(
    base: str,
    token: str,
    thread_id: str,
    scenario: Scenario,
    workspace_id: str | None = None,
) -> str:
    request_id = f"production-smoke-{scenario.id.lower()}-{uuid.uuid4().hex[:10]}"
    status, body = _request(
        base,
        token,
        "POST",
        workspace_scoped_path("/api/chat/turns", workspace_id),
        {
            "thread_id": thread_id,
            "request_id": request_id,
            "prompt": scenario.prompt,
            "visible_prompt": scenario.prompt,
            "source": "interactive",
        },
    )
    if status not in (200, 201) or not isinstance(body, dict) or not body.get("turn_id"):
        raise RuntimeError(f"enqueue failed status={status} body={body!r}")
    return str(body["turn_id"])


def _flatten(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return " ".join(_flatten(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(_flatten(item) for item in value)
    return ""


def _event_kind(event: Any) -> str:
    if not isinstance(event, dict):
        return ""
    return str(event.get("kind") or event.get("type") or "").strip()


def _event_payload(event: Any) -> Any:
    if not isinstance(event, dict):
        return None
    payload = event.get("payload")
    if payload is not None:
        return payload
    payload_json = event.get("payload_json")
    if isinstance(payload_json, str):
        try:
            return json.loads(payload_json)
        except json.JSONDecodeError:
            return None
    return event


def _iter_events(value: Any):
    if isinstance(value, list):
        for item in value:
            yield from _iter_events(item)
        return
    if not isinstance(value, dict):
        return
    nested = value.get("events")
    if isinstance(nested, list):
        yield from _iter_events(nested)
        return
    yield value


def latest_plan_is_incomplete(events: Any) -> bool:
    latest_markdown = ""
    for event in _iter_events(events):
        if _event_kind(event) != "plan_update":
            continue
        payload = _event_payload(event)
        if isinstance(payload, dict):
            markdown = str(payload.get("markdown") or "")
        else:
            markdown = ""
        if markdown:
            latest_markdown = markdown
    if not latest_markdown:
        return False
    return any(marker in latest_markdown for marker in ("- [-]", "- [ ]"))


def smoke_output(events: Any) -> str:
    output = _flatten(events)
    if latest_plan_is_incomplete(events):
        output = f"{output}\n{INCOMPLETE_PLAN_SENTINEL}"
    return output


def marker_present(output: str, marker: str) -> bool:
    aliases = {marker, marker.lower(), MARKER_KIND_ALIASES.get(marker, "")}
    return any(alias and alias in output for alias in aliases)


def ensure_vault_identity_record(base: str, token: str) -> dict[str, Any]:
    _, body = _request(base, token, "GET", "/api/vault/records", timeout=30)
    records = body.get("records", []) if isinstance(body, dict) else []
    for record in records:
        if not isinstance(record, dict):
            continue
        if (
            str(record.get("category", "")).lower() == "identity"
            and str(record.get("label", "")).strip().lower() == SMOKE_VAULT_LABEL.lower()
        ):
            return {"vault_record_id": str(record.get("id", "")), "vault_seeded": False}

    _, created = _request(
        base,
        token,
        "POST",
        "/api/vault/proposals/accept",
        {
            "category": "identity",
            "label": SMOKE_VAULT_LABEL,
            "redacted_preview": SMOKE_VAULT_PREVIEW,
            "secret_value": SMOKE_VAULT_SECRET,
        },
        timeout=30,
    )
    if not isinstance(created, dict) or not created.get("record_id"):
        raise RuntimeError(f"vault seed failed body={created!r}")
    if str(created.get("status", "")) == "conflict":
        raise RuntimeError(f"vault seed conflict body={created!r}")
    return {"vault_record_id": str(created["record_id"]), "vault_seeded": True}


def start_checkout_fixture() -> dict[str, Any]:
    checkout_url = os.environ.get("HOMUN_SMOKE_CHECKOUT_URL", DEFAULT_CHECKOUT_FIXTURE_URL).strip()
    parsed = urllib.parse.urlparse(checkout_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RuntimeError(
            "S8 requires a public HTTPS checkout/demo URL. "
            "Set HOMUN_SMOKE_CHECKOUT_URL to an externally reachable HTTPS page."
        )
    return {"checkout_url": checkout_url}


def create_temp_code_workspace(base: str, token: str) -> dict[str, Any]:
    project_root = tempfile.mkdtemp(prefix="homun-code-smoke-")
    src_dir = os.path.join(project_root, "src")
    os.makedirs(src_dir, exist_ok=True)
    with open(os.path.join(project_root, "README.md"), "w", encoding="utf-8") as handle:
        handle.write("# Homun code smoke\n\nThis project verifies code context routing.\n")
    with open(os.path.join(src_dir, "math_utils.py"), "w", encoding="utf-8") as handle:
        handle.write(
            "def add_numbers(left: int, right: int) -> int:\n"
            "    return left + right\n"
        )
    _, body = _request(
        base,
        token,
        "POST",
        "/api/workspaces",
        {"name": "homun-code-smoke", "folder": project_root},
        timeout=30,
    )
    workspaces = body.get("workspaces", []) if isinstance(body, dict) else []
    workspace_id = ""
    for workspace in workspaces:
        if isinstance(workspace, dict) and workspace.get("folder") == project_root:
            workspace_id = str(workspace.get("id", ""))
            break
    if not workspace_id:
        shutil.rmtree(project_root, ignore_errors=True)
        raise RuntimeError(f"workspace create failed body={body!r}")
    return {
        "workspace_id": workspace_id,
        "project_root": project_root,
        "temp_project_root": project_root,
    }


def create_temp_automation_workspace(base: str, token: str) -> dict[str, Any]:
    project_root = tempfile.mkdtemp(prefix="homun-auto-smoke-")
    with open(os.path.join(project_root, "README.md"), "w", encoding="utf-8") as handle:
        handle.write("# Homun automation smoke\n")
    _, body = _request(
        base,
        token,
        "POST",
        "/api/workspaces",
        {"name": "homun-auto-smoke", "folder": project_root},
        timeout=30,
    )
    workspaces = body.get("workspaces", []) if isinstance(body, dict) else []
    workspace_id = ""
    for workspace in workspaces:
        if isinstance(workspace, dict) and workspace.get("folder") == project_root:
            workspace_id = str(workspace.get("id", ""))
            break
    if not workspace_id:
        shutil.rmtree(project_root, ignore_errors=True)
        raise RuntimeError(f"automation workspace create failed body={body!r}")
    return {"workspace_id": workspace_id, "temp_project_root": project_root}


def create_temp_mcp_workspace(base: str, token: str) -> dict[str, Any]:
    project_root = tempfile.mkdtemp(prefix="homun-mcp-smoke-")
    with open(os.path.join(project_root, "README.md"), "w", encoding="utf-8") as handle:
        handle.write("# Homun MCP smoke\n")
    _, body = _request(
        base,
        token,
        "POST",
        "/api/workspaces",
        {"name": "homun-mcp-smoke", "folder": project_root},
        timeout=30,
    )
    workspaces = body.get("workspaces", []) if isinstance(body, dict) else []
    workspace_id = ""
    for workspace in workspaces:
        if isinstance(workspace, dict) and workspace.get("folder") == project_root:
            workspace_id = str(workspace.get("id", ""))
            break
    if not workspace_id:
        shutil.rmtree(project_root, ignore_errors=True)
        raise RuntimeError(f"MCP workspace create failed body={body!r}")
    return {"workspace_id": workspace_id, "temp_project_root": project_root}


def resolve_fake_mcp_stdio_binary(explicit_path: str | None = None) -> str:
    candidates = [
        explicit_path,
        os.environ.get("HOMUN_SMOKE_MCP_STDIO"),
        os.environ.get("CARGO_BIN_EXE_fake_mcp_stdio"),
    ]
    target_dir = os.environ.get("CARGO_TARGET_DIR")
    if target_dir:
        candidates.append(os.path.join(target_dir, "debug", "fake_mcp_stdio"))
    repo_target = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "target", "debug", "fake_mcp_stdio"))
    candidates.extend(
        [
            os.path.expanduser("~/.cache/cargo-target/debug/fake_mcp_stdio"),
            repo_target,
        ]
    )
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise RuntimeError(
        "fake_mcp_stdio binary not found. Build it first with: "
        "cargo build -p local-first-capabilities --bin fake_mcp_stdio"
    )


def cleanup_scenario(state: dict[str, Any], scenario_passed: bool = True) -> None:
    if not scenario_passed and state.get("turn_id"):
        last_status = normalize_status(str(state.get("last_status") or "unknown"))
        if last_status not in TERMINAL_STATUSES:
            try:
                _request(
                    str(state.get("base", "")),
                    str(state.get("token", "")),
                    "POST",
                    f"/api/tasks/{urllib.parse.quote(str(state['turn_id']), safe='')}/cancel",
                    timeout=30,
                )
            except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as error:
                print(f"WARN cleanup smoke turn cancel failed: {error}", file=sys.stderr, flush=True)
    if scenario_passed and state.get("thread_id"):
        try:
            _request(
                str(state.get("base", "")),
                str(state.get("token", "")),
                "DELETE",
                f"/api/chat/threads/{urllib.parse.quote(str(state['thread_id']), safe='')}",
                timeout=30,
            )
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as error:
            print(f"WARN cleanup smoke thread failed: {error}", file=sys.stderr, flush=True)
    if state.get("mcp_provider_id") and state.get("mcp_workspace_id"):
        try:
            query = urllib.parse.urlencode({"workspace": str(state["mcp_workspace_id"])})
            _request(
                str(state.get("base", "")),
                str(state.get("token", "")),
                "POST",
                f"/api/capabilities/mcp/disconnect?{query}",
                {"provider_id": str(state["mcp_provider_id"])},
                timeout=30,
            )
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as error:
            print(f"WARN cleanup MCP failed: {error}", file=sys.stderr, flush=True)
    if state.get("automation_id") and state.get("automation_workspace_id"):
        try:
            automation_id = urllib.parse.quote(str(state["automation_id"]), safe="")
            query = urllib.parse.urlencode({"workspace_id": str(state["automation_workspace_id"])})
            _request(
                str(state.get("base", "")),
                str(state.get("token", "")),
                "DELETE",
                f"/api/automations/{automation_id}?{query}",
                timeout=30,
            )
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as error:
            print(f"WARN cleanup automation failed: {error}", file=sys.stderr, flush=True)
    if state.get("vault_seeded") and state.get("vault_record_id"):
        try:
            _request(
                str(state.get("base", "")),
                str(state.get("token", "")),
                "DELETE",
                f"/api/vault/records/{urllib.parse.quote(str(state['vault_record_id']), safe='')}",
                timeout=30,
            )
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as error:
            print(f"WARN cleanup vault seed failed: {error}", file=sys.stderr, flush=True)
    if state.get("workspace_id") and state.get("temp_project_root"):
        if not scenario_passed:
            print(
                "WARN preserving failed code smoke workspace "
                f"{state['workspace_id']} at {state['temp_project_root']}",
                file=sys.stderr,
                flush=True,
            )
            return
        try:
            _request(
                str(state.get("base", "")),
                str(state.get("token", "")),
                "POST",
                f"/api/workspaces/{urllib.parse.quote(str(state['workspace_id']), safe='')}/delete",
                timeout=30,
            )
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as error:
            if "workspace_not_found" not in str(error):
                print(f"WARN cleanup workspace failed: {error}", file=sys.stderr, flush=True)
        shutil.rmtree(str(state["temp_project_root"]), ignore_errors=True)
    server = state.get("checkout_server")
    if server is not None:
        server.shutdown()
        server.server_close()


def prepare_scenario(base: str, token: str, scenario: Scenario) -> dict[str, Any]:
    state: dict[str, Any] = {"scenario": scenario, "base": base, "token": token}
    for setup in scenario.setup:
        if setup == "vault_identity_record":
            state.update(ensure_vault_identity_record(base, token))
        elif setup == "checkout_fixture":
            state.update(start_checkout_fixture())
            state["scenario"] = replace(
                state["scenario"],
                prompt=state["scenario"].prompt.format(checkout_url=state["checkout_url"]),
            )
        elif setup == "temp_code_workspace":
            state.update(create_temp_code_workspace(base, token))
            state["scenario"] = replace(
                state["scenario"],
                prompt=state["scenario"].prompt.format(
                    project_root=state["project_root"],
                    marker=CODE_SMOKE_MARKER,
                ),
            )
        elif setup == "temp_automation_workspace":
            state.update(create_temp_automation_workspace(base, token))
        else:
            raise RuntimeError(f"unknown scenario setup: {setup}")
    return state


def wait_turn_output(
    base: str,
    token: str,
    turn_id: str,
    max_seconds: int,
    workspace_id: str | None = None,
) -> tuple[str, str, float]:
    """Return (status, flattened_events_text, elapsed_seconds)."""
    started = time.time()
    deadline = started + max_seconds
    last_status = "unknown"
    events: Any = []
    while True:
        try:
            _, state = _request(
                base,
                token,
                "GET",
                workspace_scoped_path(f"/api/chat/turns/{turn_id}", workspace_id),
                timeout=30,
            )
            _, events = _request(
                base,
                token,
                "GET",
                workspace_scoped_path(f"/api/chat/turns/{turn_id}/events?since=0", workspace_id),
                timeout=30,
            )
        except RuntimeError as error:
            if "turn_not_found" in str(error):
                time.sleep(0.75)
                continue
            raise
        if isinstance(state, dict):
            last_status = str(state.get("status") or state.get("state") or "unknown")
        if normalize_status(last_status) in TERMINAL_STATUSES:
            break
        if time.time() >= deadline:
            break
        time.sleep(0.75)
    return last_status, smoke_output(events), time.time() - started


def run_turn_via_broker(
    base: str,
    scenario: Scenario,
    token: str,
) -> tuple[str, str, float, dict[str, Any]]:
    state = prepare_scenario(base, token, scenario)
    prepared = state["scenario"]
    thread_id = create_thread(base, token, f"smoke {prepared.id}", state.get("workspace_id"))
    state["thread_id"] = thread_id
    turn_id = enqueue_turn(base, token, thread_id, prepared, state.get("workspace_id"))
    state["turn_id"] = turn_id
    status, output, elapsed = wait_turn_output(
        base,
        token,
        turn_id,
        prepared.max_seconds,
        state.get("workspace_id"),
    )
    state["last_status"] = status
    return status, output, elapsed, state


def run_automation_api_lifecycle(
    base: str,
    token: str,
) -> tuple[str, str, float, dict[str, Any]]:
    started = time.time()
    state: dict[str, Any] = {"base": base, "token": token}
    state.update(create_temp_automation_workspace(base, token))
    workspace_id = str(state["workspace_id"])
    query = urllib.parse.urlencode({"workspace_id": workspace_id})
    automation_body = {
        "title": "homun automation smoke",
        "trigger": {"type": "schedule", "recurrence": "every 1d", "tz": "Europe/Rome"},
        "prompt": "Rispondi solo ok per smoke automation; non inviare messaggi esterni.",
        "workspace_id": workspace_id,
        "approval": "confirm",
        "source": "manual",
    }
    status, dry_run = _request(
        base,
        token,
        "POST",
        "/api/automations/dry-run",
        automation_body,
        timeout=30,
    )
    if status != 200 or not isinstance(dry_run, dict):
        raise RuntimeError(f"automation dry-run failed status={status} body={dry_run!r}")
    _, listed_before_create = _request(base, token, "GET", f"/api/automations?{query}", timeout=30)
    before_items = (
        listed_before_create.get("automations", [])
        if isinstance(listed_before_create, dict)
        else []
    )
    status, created = _request(
        base,
        token,
        "POST",
        "/api/automations",
        automation_body,
        timeout=30,
    )
    if status != 200 or not isinstance(created, dict) or not created.get("id"):
        raise RuntimeError(f"automation create failed status={status} body={created!r}")
    state["automation_id"] = str(created["id"])
    state["automation_workspace_id"] = workspace_id
    checks = {
        "dry_run_valid": dry_run.get("valid") is True,
        "dry_run_workspace": dry_run.get("workspace_id") == workspace_id,
        "dry_run_task_preview": dry_run.get("would_materialize_task") is True,
        "dry_run_next_run": isinstance(dry_run.get("next_run"), int),
        "dry_run_no_sensitive_echo": not any(
            key in dry_run for key in ("title", "prompt", "trigger")
        ),
        "dry_run_no_materialization": not any(isinstance(item, dict) for item in before_items),
        "create_workspace": created.get("workspace_id") == workspace_id,
        "create_enabled": created.get("enabled") is True,
        "create_task": isinstance(created.get("task_id"), str) and created["task_id"].startswith("autorun_"),
        "create_next_run": isinstance(created.get("next_run"), int),
        "create_approval": created.get("approval") == "confirm",
    }

    _, listed = _request(base, token, "GET", f"/api/automations?{query}", timeout=30)
    scoped_items = listed.get("automations", []) if isinstance(listed, dict) else []
    checks["list_scoped"] = any(
        item.get("id") == state["automation_id"] and item.get("workspace_id") == workspace_id
        for item in scoped_items
        if isinstance(item, dict)
    )

    automation_id = urllib.parse.quote(str(state["automation_id"]), safe="")
    _, toggled = _request(
        base,
        token,
        "POST",
        f"/api/automations/{automation_id}/toggle?{query}",
        timeout=30,
    )
    checks["toggle_workspace"] = isinstance(toggled, dict) and toggled.get("workspace_id") == workspace_id
    checks["toggle_disabled"] = isinstance(toggled, dict) and toggled.get("enabled") is False
    checks["toggle_task_cancelled"] = isinstance(toggled, dict) and toggled.get("task_id") is None

    _, deleted = _request(
        base,
        token,
        "DELETE",
        f"/api/automations/{automation_id}?{query}",
        timeout=30,
    )
    checks["delete_ack"] = isinstance(deleted, dict) and deleted.get("deleted") == state["automation_id"]
    _, listed_after = _request(base, token, "GET", f"/api/automations?{query}", timeout=30)
    after_items = listed_after.get("automations", []) if isinstance(listed_after, dict) else []
    checks["delete_absent"] = not any(
        item.get("id") == state["automation_id"] for item in after_items if isinstance(item, dict)
    )

    failed = [name for name, ok in checks.items() if not ok]
    output = "automation_api_lifecycle " + (
        "ok" if not failed else "failed_checks=" + ",".join(failed)
    )
    return ("completed" if not failed else "failed"), output, time.time() - started, state


def run_mcp_stdio_lifecycle(
    base: str,
    token: str,
    fake_mcp_stdio_path: str | None = None,
) -> tuple[str, str, float, dict[str, Any]]:
    started = time.time()
    state: dict[str, Any] = {"base": base, "token": token}
    state.update(create_temp_mcp_workspace(base, token))
    workspace_id = str(state["workspace_id"])
    query = urllib.parse.urlencode({"workspace": workspace_id})
    command = resolve_fake_mcp_stdio_binary(fake_mcp_stdio_path)
    status, connected = _request(
        base,
        token,
        "POST",
        f"/api/capabilities/mcp/connect?{query}",
        {
            "name": "homun smoke mcp",
            "command": command,
            "args": [],
            "env": {},
        },
        timeout=30,
    )
    if status != 200 or not isinstance(connected, dict) or not connected.get("provider_id"):
        raise RuntimeError(f"MCP connect failed status={status} body={connected!r}")
    state["mcp_provider_id"] = str(connected["provider_id"])
    state["mcp_workspace_id"] = workspace_id
    checks = {
        "connect_provider": connected.get("provider_id") == "mcp:homun-smoke-mcp",
        "connect_connection": connected.get("connection_id") == "mcp-homun-smoke-mcp",
        "connect_tools": connected.get("tools_cached") == 1,
        "connect_discovery": connected.get("discovery_error") is None,
    }

    _, listed = _request(
        base,
        token,
        "GET",
        f"/api/capabilities/mcp/connected?{query}",
        timeout=30,
    )
    servers = listed.get("servers", []) if isinstance(listed, dict) else []
    checks["list_connected"] = any(
        item.get("provider_id") == state["mcp_provider_id"]
        and item.get("tools") == 1
        for item in servers
        if isinstance(item, dict)
    )

    _, disconnected = _request(
        base,
        token,
        "POST",
        f"/api/capabilities/mcp/disconnect?{query}",
        {"provider_id": state["mcp_provider_id"]},
        timeout=30,
    )
    checks["disconnect_ack"] = isinstance(disconnected, dict) and disconnected.get("removed") is True
    state.pop("mcp_provider_id", None)
    state.pop("mcp_workspace_id", None)

    failed = [name for name, ok in checks.items() if not ok]
    output = "mcp_stdio_lifecycle " + ("ok" if not failed else "failed_checks=" + ",".join(failed))
    return ("completed" if not failed else "failed"), output, time.time() - started, state


def status_allows_success(status: str, scenario: Scenario, output: str) -> bool:
    normalized = normalize_status(status)
    output_lower = output.lower()
    if any(required.lower() not in output_lower for required in scenario.require_text):
        return False
    if any(forbidden.lower() in output_lower for forbidden in scenario.forbid_output):
        return False
    if scenario.expect_marker:
        return marker_present(output, scenario.expect_marker) and normalized in MARKER_SUCCESS_STATUSES
    if INCOMPLETE_PLAN_SENTINEL.lower() in output_lower:
        return False
    if normalized not in SUCCESS_STATUSES:
        return False
    return True


def run_scenario(base: str, scenario: Scenario, token: str) -> bool:
    print(f"== {scenario.id}: {scenario.name} ==", flush=True)
    state: dict[str, Any] | None = None
    try:
        if scenario.runner == "automation_api":
            status, output, elapsed, state = run_automation_api_lifecycle(base, token)
        elif scenario.runner == "mcp_stdio_api":
            status, output, elapsed, state = run_mcp_stdio_lifecycle(base, token)
        else:
            status, output, elapsed, state = run_turn_via_broker(base, scenario, token)
    except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as error:
        print(f"FAIL {scenario.id}: gateway error: {error}", flush=True)
        if state is not None:
            cleanup_scenario(state, scenario_passed=False)
        return False
    ok = status_allows_success(status, scenario, output)
    if not ok:
        print(f"FAIL {scenario.id}: unexpected terminal status {status}", flush=True)
    if scenario.expect_marker and not marker_present(output, scenario.expect_marker):
        print(f"FAIL {scenario.id}: missing marker {scenario.expect_marker}", flush=True)
        ok = False
    if scenario.forbid_plaintext and scenario.forbid_plaintext in output:
        print(f"FAIL {scenario.id}: forbidden plaintext leaked", flush=True)
        ok = False
    for required in scenario.require_text:
        if required.lower() not in output.lower():
            print(f"FAIL {scenario.id}: missing required text {required!r}", flush=True)
            ok = False
    for forbidden in scenario.forbid_output:
        if forbidden.lower() in output.lower():
            print(f"FAIL {scenario.id}: forbidden output {forbidden!r}", flush=True)
            ok = False
    print(f"{'PASS' if ok else 'FAIL'} {scenario.id}: {elapsed:.1f}s", flush=True)
    if state is not None:
        cleanup_scenario(state, scenario_passed=ok)
    return ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="List scenarios and exit")
    parser.add_argument("--gateway-base", default="", help="Run against this desktop gateway base URL")
    parser.add_argument("--scenario", action="append", default=[], help="Scenario id to run, repeatable")
    parser.add_argument(
        "--profile",
        choices=("baseline", "extended", "all"),
        default="baseline",
        help="Scenario profile to list or run",
    )
    args = parser.parse_args(argv)

    profile_scenarios = build_scenarios(args.profile)
    missing = missing_scenario_ids(profile_scenarios, args.scenario)
    if missing:
        print(
            "Unknown scenario for profile "
            f"{args.profile}: {', '.join(missing)}. "
            "Use --profile all to run extended ids such as X5/X6.",
            file=sys.stderr,
        )
        return 2
    scenarios = select_scenarios(profile_scenarios, args.scenario)
    if args.list or not args.gateway_base:
        for scenario in scenarios:
            marker = f", marker={scenario.expect_marker}" if scenario.expect_marker else ""
            domains = ",".join(scenario.domains)
            print(f"{scenario.id}: {scenario.name} [domains={domains}]{marker}")
        return 0

    token = gateway_token()
    if not token:
        print(
            "Missing gateway token. Set HOMUN_EVAL_GATEWAY_TOKEN or start electron:dev.",
            file=sys.stderr,
        )
        return 2
    ok = True
    for scenario in scenarios:
        ok = run_scenario(args.gateway_base or DEFAULT_GATEWAY_BASE, scenario, token) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
