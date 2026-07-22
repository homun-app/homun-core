#!/usr/bin/env python3
"""Concurrent Homun turn soak with optional real gateway restart.

By default the runner starts the repository gateway in an isolated temporary
data directory. Reports contain identifiers, states, counts and timings only;
fixed prompt contents and assistant text are never written to disk.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BINARY = ROOT / "target" / "debug" / "local-first-desktop-gateway"
TERMINAL_KINDS = {"done", "error", "cancelled"}
TERMINAL_STATUSES = {"completed", "failed", "cancelled", "expired"}
REASONING_MARKERS = ("‹‹reasoning››", "<think", "</think", "raw reasoning")


def evaluate(events: list[dict[str, Any]], expected_selected: str) -> dict[str, Any]:
    """Evaluate UI-safe turn invariants over a normalized event list."""
    violations: set[str] = set()
    terminals: dict[str, int] = {}
    assistants: dict[str, set[str]] = {}

    for event in events:
        if event.get("kind") == "selected" and event.get("thread") != expected_selected:
            violations.add("focus_changed")
        if event.get("kind") in TERMINAL_KINDS:
            turn = str(event.get("turn") or event.get("thread") or "unknown")
            terminals[turn] = terminals.get(turn, 0) + 1
            assistant_id = event.get("assistant_id")
            if assistant_id:
                assistants.setdefault(turn, set()).add(str(assistant_id))
        text = str(event.get("text") or "").lower()
        if any(marker in text for marker in REASONING_MARKERS):
            violations.add("reasoning_leak")

    if any(count > 1 for count in terminals.values()) or any(
        len(ids) > 1 for ids in assistants.values()
    ):
        violations.add("duplicate_terminal")

    return {
        "passed": not violations,
        "violations": sorted(violations),
        "terminal_counts": terminals,
        "assistant_counts": {turn: len(ids) for turn, ids in assistants.items()},
    }


class GatewayClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(self, method: str, path: str, body: Any = None, timeout: float = 10) -> Any:
        data = None
        headers = {"Authorization": f"Bearer {self.token}"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} {path} returned {error.code}: {detail[:300]}") from error

    def wait_ready(self, timeout: float = 30) -> None:
        deadline = time.monotonic() + timeout
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                self.request("GET", "/api/chat/threads", timeout=2)
                return
            except Exception as error:  # bounded readiness polling
                last_error = error
                time.sleep(0.25)
        raise RuntimeError(f"gateway did not become ready: {last_error}")


class IsolatedGateway:
    def __init__(self, binary: Path, port: int, data_dir: Path, token: str, log_path: Path):
        self.binary = binary
        self.port = port
        self.data_dir = data_dir
        self.token = token
        self.log_path = log_path
        self.process: subprocess.Popen[bytes] | None = None
        self._log = None

    def start(self) -> None:
        if not self.binary.exists():
            raise RuntimeError(
                f"gateway binary not found at {self.binary}; run cargo build "
                "-p local-first-desktop-gateway"
            )
        environment = os.environ.copy()
        environment.update(
            {
                "HOMUN_DATA_DIR": str(self.data_dir),
                "HOMUN_DESKTOP_GATEWAY_TOKEN": self.token,
                "HOMUN_DESKTOP_GATEWAY_PORT": str(self.port),
                "HOMUN_TASK_EXECUTOR_WORKER": "on",
                "RUST_LOG": "warn",
            }
        )
        self._log = self.log_path.open("ab")
        self.process = subprocess.Popen(
            [str(self.binary)],
            cwd=ROOT,
            env=environment,
            stdout=self._log,
            stderr=subprocess.STDOUT,
        )

    def stop(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self._log is not None:
            self._log.close()
            self._log = None


def _payload_text(payload: Any) -> str:
    """Flatten only for in-memory leak inspection; callers never persist this value."""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        return " ".join(_payload_text(value) for value in payload.values())
    if isinstance(payload, list):
        return " ".join(_payload_text(value) for value in payload)
    return ""


def _create_thread(client: GatewayClient) -> str:
    body = client.request("POST", "/api/chat/threads", {})
    thread_id = body.get("thread_id") if isinstance(body, dict) else None
    if not thread_id:
        raise RuntimeError(f"thread creation returned no id: {body!r}")
    return str(thread_id)


def _enqueue(client: GatewayClient, thread_id: str, label: str) -> tuple[str, str]:
    request_id = f"stability_{label.lower()}_{uuid.uuid4().hex[:12]}"
    body = client.request(
        "POST",
        "/api/chat/turns",
        {
            "thread_id": thread_id,
            "request_id": request_id,
            "prompt": f"TEST-{label}",
            "visible_prompt": f"TEST-{label}",
            "source": "interactive",
        },
    )
    turn_id = body.get("turn_id") if isinstance(body, dict) else None
    if not turn_id:
        raise RuntimeError(f"turn enqueue returned no id: {body!r}")
    return str(turn_id), f"local_assistant_{request_id}"


def _wait_terminal(
    client: GatewayClient,
    turns: dict[str, dict[str, str]],
    timeout: float,
) -> dict[str, str]:
    deadline = time.monotonic() + timeout
    statuses: dict[str, str] = {}
    while time.monotonic() < deadline:
        for turn_id in turns:
            if statuses.get(turn_id) in TERMINAL_STATUSES:
                continue
            state = client.request("GET", f"/api/chat/turns/{turn_id}")
            statuses[turn_id] = str(state.get("status", "unknown"))
        if all(statuses.get(turn_id) in TERMINAL_STATUSES for turn_id in turns):
            return statuses
        time.sleep(0.5)
    return statuses


def run_soak(
    client: GatewayClient,
    restart: callable | None,
    timeout: float,
) -> dict[str, Any]:
    started = time.monotonic()
    threads = {label: _create_thread(client) for label in ("A", "B", "C")}
    client.request("POST", f"/api/chat/threads/{threads['B']}/select", {})
    normalized: list[dict[str, Any]] = [{"thread": threads["B"], "kind": "selected"}]

    turns: dict[str, dict[str, str]] = {}
    for label in ("A", "B", "C"):
        turn_id, assistant_id = _enqueue(client, threads[label], label)
        turns[turn_id] = {
            "label": label,
            "thread": threads[label],
            "assistant_id": assistant_id,
        }

    restarted = False
    if restart is not None:
        time.sleep(0.75)
        restart()
        client.wait_ready()
        restarted = True

    statuses = _wait_terminal(client, turns, timeout)
    terminal_order: list[str] = []
    for turn_id, metadata in turns.items():
        raw_events = client.request("GET", f"/api/chat/turns/{turn_id}/events?since=0") or []
        for event in raw_events:
            kind = str(event.get("kind", ""))
            normalized.append(
                {
                    "thread": metadata["thread"],
                    "turn": turn_id,
                    "kind": kind,
                    "assistant_id": metadata["assistant_id"] if kind in TERMINAL_KINDS else None,
                    "text": _payload_text(event.get("payload")),
                }
            )
            if kind in TERMINAL_KINDS:
                terminal_order.append(metadata["label"])

        transcript = client.request(
            "GET", f"/api/chat/threads/{metadata['thread']}/messages"
        )
        messages = transcript.get("messages", []) if isinstance(transcript, dict) else []
        for message in messages:
            if message.get("role") == "assistant":
                normalized.append(
                    {
                        "thread": metadata["thread"],
                        "turn": turn_id,
                        "kind": "transcript",
                        "text": message.get("text", ""),
                    }
                )

    snapshot = client.request("GET", "/api/chat/threads")
    active_thread = snapshot.get("active_thread_id") if isinstance(snapshot, dict) else None
    if active_thread != threads["B"]:
        normalized.append({"thread": active_thread, "kind": "selected"})

    evaluation = evaluate(normalized, threads["B"])
    missing_terminal = [
        turn_id for turn_id in turns if evaluation["terminal_counts"].get(turn_id, 0) != 1
    ]
    nonterminal = [
        turn_id for turn_id in turns if statuses.get(turn_id) not in TERMINAL_STATUSES
    ]
    violations = set(evaluation["violations"])
    if missing_terminal:
        violations.add("missing_terminal")
    if nonterminal:
        violations.add("turn_timeout")

    return {
        "schema_version": 1,
        "passed": not violations,
        "violations": sorted(violations),
        "restart_performed": restarted,
        "expected_selected": threads["B"],
        "actual_selected": active_thread,
        "threads": threads,
        "turns": {
            turn_id: {
                "label": metadata["label"],
                "thread": metadata["thread"],
                "status": statuses.get(turn_id, "unknown"),
                "terminal_count": evaluation["terminal_counts"].get(turn_id, 0),
                "assistant_count": evaluation["assistant_counts"].get(turn_id, 0),
            }
            for turn_id, metadata in turns.items()
        },
        "terminal_order": terminal_order,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restart", action="store_true", help="restart the isolated gateway mid-soak")
    parser.add_argument("--output", type=Path, help="write the bounded JSON report here")
    parser.add_argument("--timeout", type=float, default=90, help="terminal wait in seconds")
    parser.add_argument("--port", type=int, default=18798, help="isolated gateway port")
    parser.add_argument("--binary", type=Path, default=DEFAULT_BINARY, help="gateway binary")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    token = f"stability-soak-{uuid.uuid4().hex}"
    with tempfile.TemporaryDirectory(prefix="homun-stability-soak-") as temporary:
        root = Path(temporary)
        gateway = IsolatedGateway(args.binary, args.port, root / "data", token, root / "gateway.log")
        client = GatewayClient(f"http://127.0.0.1:{args.port}", token)
        try:
            gateway.start()
            client.wait_ready()

            def restart_gateway() -> None:
                gateway.stop()
                gateway.start()

            report = run_soak(client, restart_gateway if args.restart else None, args.timeout)
        except Exception as error:
            report = {
                "schema_version": 1,
                "passed": False,
                "violations": ["runner_error"],
                "error": str(error)[:500],
            }
        finally:
            gateway.stop()

    output = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    print(output, end="")
    return 0 if report.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
