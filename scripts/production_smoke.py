#!/usr/bin/env python3
"""Production-oriented Homun smoke runner.

The default mode is intentionally explicit: `--list` prints the baseline scenarios
without touching the live gateway. Passing `--gateway-base` runs selected scenarios
against the local desktop gateway stream endpoint.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass


DEFAULT_GATEWAY_BASE = "http://127.0.0.1:18765"


@dataclass(frozen=True)
class Scenario:
    id: str
    name: str
    prompt: str
    expect_marker: str | None = None
    forbid_plaintext: str | None = None
    max_seconds: int = 120


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
        ),
        Scenario(
            "S6",
            "Browser form fill",
            "Apri https://www.selenium.dev/selenium/web/web-form.html e compila Text input con smoke.",
        ),
        Scenario(
            "S7",
            "Dead URL plan settles",
            "Crea un piano e apri https://nonexistent-homun-validation-zzzz.invalid/dead-page poi dimmi il titolo.",
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


def stream_gateway(base: str, scenario: Scenario, token: str) -> tuple[str, float]:
    payload = {
        "request_id": f"production-smoke-{scenario.id.lower()}-{int(time.time())}",
        "thread_id": f"thread_production_smoke_{scenario.id.lower()}_{int(time.time())}",
        "prompt": scenario.prompt,
        "context": [],
        "max_tokens": 900,
        "temperature": 0,
        "wait_if_busy": True,
    }
    request = urllib.request.Request(
        f"{base.rstrip('/')}/api/chat/generate_stream",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    start = time.time()
    collected: list[str] = []
    with urllib.request.urlopen(request, timeout=scenario.max_seconds) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            collected.append(line)
    return "\n".join(collected), time.time() - start


def run_scenario(base: str, scenario: Scenario, token: str) -> bool:
    print(f"== {scenario.id}: {scenario.name} ==", flush=True)
    try:
        output, elapsed = stream_gateway(base, scenario, token)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
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
        print("Missing gateway token. Set HOMUN_EVAL_GATEWAY_TOKEN or start electron:dev.", file=sys.stderr)
        return 2
    ok = True
    for scenario in scenarios:
        ok = run_scenario(args.gateway_base or DEFAULT_GATEWAY_BASE, scenario, token) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
