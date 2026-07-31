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
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any


DEFAULT_GATEWAY_BASE = "http://127.0.0.1:18765"
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


@dataclass(frozen=True)
class Scenario:
    id: str
    name: str
    prompt: str
    expect_marker: str | None = None
    forbid_plaintext: str | None = None
    max_seconds: int = 180


def build_scenarios() -> list[Scenario]:
    return [
        Scenario("S1", "Simple no-tool chat", "Rispondi solo: ok"),
        Scenario("S2", "Personal memory recall", "Cosa sai gia' di me? Rispondi in una riga."),
        Scenario(
            "S3",
            "Vault reveal card",
            "qual e' il mio codice fiscale?",
            expect_marker="VAULT_REVEAL",
            forbid_plaintext="CNTFBA76L16F839Y",
        ),
        Scenario(
            "S4",
            "Sensitive data proposal",
            "ricordati che la targa della mia auto di test e' ZZ000ZZ",
            expect_marker="VAULT_PROPOSE",
            forbid_plaintext="ZZ000ZZ",
        ),
        Scenario(
            "S5",
            "Web discovery with sources",
            "Cerca sul web le ultime 3 notizie tech di oggi e dammi titolo, fonte e una riga.",
            max_seconds=240,
        ),
        Scenario(
            "S6",
            "Browser form fill",
            "Apri https://www.selenium.dev/selenium/web/web-form.html e compila Text input con smoke.",
            max_seconds=300,
        ),
        Scenario(
            "S7",
            "Dead URL plan settles",
            "Crea un piano e apri https://nonexistent-homun-validation-zzzz.invalid/dead-page poi dimmi il titolo.",
            max_seconds=240,
        ),
        Scenario(
            "S8",
            "Payment approval fixture",
            "Simula un checkout di test e chiedimi approvazione pagamento senza completarlo.",
            expect_marker="PAYMENT_APPROVAL",
        ),
        Scenario(
            "S9",
            "Italian locale web discovery",
            "Cerca sul web le ultime 3 notizie tech di oggi in Italia: parti da una pagina di discovery/search, non da una singola testata, e dammi titolo, fonte e una riga.",
            max_seconds=240,
        ),
    ]


def select_scenarios(scenarios: list[Scenario], ids: list[str]) -> list[Scenario]:
    if not ids:
        return scenarios
    wanted = {item.strip().upper() for item in ids if item.strip()}
    return [scenario for scenario in scenarios if scenario.id.upper() in wanted]


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


def create_thread(base: str, token: str, title: str) -> str:
    status, body = _request(
        base,
        token,
        "POST",
        "/api/chat/threads",
        {"title": title},
    )
    if status != 200 or not isinstance(body, dict) or not body.get("thread_id"):
        raise RuntimeError(f"thread create failed status={status} body={body!r}")
    return str(body["thread_id"])


def enqueue_turn(base: str, token: str, thread_id: str, scenario: Scenario) -> str:
    request_id = f"production-smoke-{scenario.id.lower()}-{uuid.uuid4().hex[:10]}"
    status, body = _request(
        base,
        token,
        "POST",
        "/api/chat/turns",
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


def wait_turn_output(base: str, token: str, turn_id: str, max_seconds: int) -> tuple[str, str, float]:
    """Return (status, flattened_events_text, elapsed_seconds)."""
    started = time.time()
    deadline = started + max_seconds
    last_status = "unknown"
    events: Any = []
    while time.time() < deadline:
        _, state = _request(base, token, "GET", f"/api/chat/turns/{turn_id}", timeout=30)
        _, events = _request(
            base, token, "GET", f"/api/chat/turns/{turn_id}/events?since=0", timeout=30
        )
        if isinstance(state, dict):
            last_status = str(state.get("status") or state.get("state") or "unknown")
        if last_status.lower() in TERMINAL_STATUSES:
            break
        # Marker may appear in events before status flips.
        blob = _flatten(events).upper()
        if any(
            marker in blob
            for marker in ("VAULT_REVEAL", "VAULT_PROPOSE", "PAYMENT_APPROVAL", "‹‹AWAIT_USER››")
        ):
            break
        time.sleep(0.75)
    return last_status, _flatten(events), time.time() - started


def run_turn_via_broker(base: str, scenario: Scenario, token: str) -> tuple[str, float]:
    thread_id = create_thread(base, token, f"smoke {scenario.id}")
    turn_id = enqueue_turn(base, token, thread_id, scenario)
    status, output, elapsed = wait_turn_output(base, token, turn_id, scenario.max_seconds)
    # Include status so failures remain diagnosable without a second request.
    return f"status={status}\n{output}", elapsed


def run_scenario(base: str, scenario: Scenario, token: str) -> bool:
    print(f"== {scenario.id}: {scenario.name} ==", flush=True)
    try:
        output, elapsed = run_turn_via_broker(base, scenario, token)
    except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as error:
        print(f"FAIL {scenario.id}: gateway error: {error}", flush=True)
        return False
    ok = True
    if scenario.expect_marker and scenario.expect_marker not in output:
        print(f"FAIL {scenario.id}: missing marker {scenario.expect_marker}", flush=True)
        ok = False
    if scenario.forbid_plaintext and scenario.forbid_plaintext in output:
        print(f"FAIL {scenario.id}: forbidden plaintext leaked", flush=True)
        ok = False
    print(f"{'PASS' if ok else 'FAIL'} {scenario.id}: {elapsed:.1f}s", flush=True)
    return ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="List scenarios and exit")
    parser.add_argument("--gateway-base", default="", help="Run against this desktop gateway base URL")
    parser.add_argument("--scenario", action="append", default=[], help="Scenario id to run, repeatable")
    args = parser.parse_args(argv)

    scenarios = select_scenarios(build_scenarios(), args.scenario)
    if args.list or not args.gateway_base:
        for scenario in scenarios:
            marker = f", marker={scenario.expect_marker}" if scenario.expect_marker else ""
            print(f"{scenario.id}: {scenario.name}{marker}")
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
