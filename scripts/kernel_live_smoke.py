#!/usr/bin/env python3
"""Live gateway smoke for the Homun kernel regression gate.

Creates a fresh chat thread, asks the agent to use the browser on a stable page,
waits for the durable run to complete, then checks that the final assistant text
contains the expected page title without reasoning/tool markers.
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
from typing import Any


DEFAULT_GATEWAY_BASE = "http://127.0.0.1:18765"
TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled", "canceled"})
REASONING_MARKERS = ("<THINK", "REASONING", "TOOL_CALL", "ACTIVITY:")


def default_prompt() -> str:
    return (
        "SMOKE_KERNEL_BROWSER_20260803: usa il browser per aprire "
        "https://www.selenium.dev e dimmi solo il titolo della pagina."
    )


def gateway_token() -> str:
    for key in ("HOMUN_DESKTOP_GATEWAY_TOKEN", "HOMUN_EVAL_GATEWAY_TOKEN"):
        value = os.environ.get(key)
        if value:
            return value.strip()
    token_path = os.path.expanduser("~/.homun/desktop-gateway-token")
    try:
        with open(token_path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except FileNotFoundError:
        return ""


def auth_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _request(
    base: str,
    token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    timeout: float = 60,
) -> Any:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"{base.rstrip('/')}{path}",
        data=data,
        method=method,
        headers=auth_headers(token),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} {path}: {raw[:500]}") from error


def create_thread(base: str, token: str) -> str:
    body = _request(
        base,
        token,
        "POST",
        "/api/chat/threads?workspace=local-workspace",
        {"title": "Kernel browser smoke"},
    )
    thread_id = body.get("thread_id") if isinstance(body, dict) else None
    if not thread_id:
        raise RuntimeError(f"thread create did not return thread_id: {body!r}")
    return str(thread_id)


def enqueue_turn(base: str, token: str, thread_id: str, prompt: str) -> str:
    request_id = f"chat_stream_{int(time.time() * 1000)}_kernel_browser_smoke_{uuid.uuid4().hex[:8]}"
    body = _request(
        base,
        token,
        "POST",
        "/api/chat/turns",
        {
            "thread_id": thread_id,
            "request_id": request_id,
            "prompt": prompt,
            "visible_prompt": prompt,
            "source": "interactive",
            "workspace": "local-workspace",
        },
    )
    turn_id = body.get("turn_id") if isinstance(body, dict) else None
    if not turn_id:
        raise RuntimeError(f"turn enqueue did not return turn_id: {body!r}")
    return str(turn_id)


def latest_run_status(base: str, token: str, thread_id: str) -> tuple[str, str | None]:
    body = _request(base, token, "GET", f"/api/chat/threads/{thread_id}/runs", timeout=30)
    runs = body if isinstance(body, list) else body.get("runs", []) if isinstance(body, dict) else []
    run = runs[0] if runs else {}
    if not isinstance(run, dict):
        return "pending", None
    status = str(run.get("status") or run.get("state") or "pending")
    terminal_reason = run.get("terminal_reason")
    return status, str(terminal_reason) if terminal_reason else None


def latest_assistant_text(payload: Any) -> str:
    messages = payload.get("messages", payload) if isinstance(payload, dict) else payload
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        value = message.get("content") or message.get("text") or ""
        if isinstance(value, str):
            return value
    return ""


def fetch_latest_assistant_text(base: str, token: str, thread_id: str) -> str:
    body = _request(base, token, "GET", f"/api/chat/threads/{thread_id}/messages", timeout=30)
    return latest_assistant_text(body)


def answer_is_clean(text: str) -> bool:
    upper_text = text.upper()
    return "SELENIUM" in upper_text and not any(marker in upper_text for marker in REASONING_MARKERS)


def run_smoke(base: str, token: str, timeout_seconds: int) -> tuple[bool, str]:
    thread_id = create_thread(base, token)
    turn_id = enqueue_turn(base, token, thread_id, default_prompt())
    deadline = time.time() + timeout_seconds
    status = "pending"
    terminal_reason: str | None = None
    while time.time() < deadline:
        status, terminal_reason = latest_run_status(base, token, thread_id)
        if status.lower() in TERMINAL_STATUSES:
            break
        time.sleep(2)
    text = fetch_latest_assistant_text(base, token, thread_id)
    ok = status.lower() == "completed" and answer_is_clean(text)
    detail = (
        f"thread_id={thread_id}\n"
        f"turn_id={turn_id}\n"
        f"status={status}\n"
        f"terminal_reason={terminal_reason or ''}\n"
        f"assistant_text={text}"
    )
    return ok, detail


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-base", default=DEFAULT_GATEWAY_BASE)
    parser.add_argument("--timeout-seconds", type=int, default=180)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    token = gateway_token()
    if not token:
        print(
            "Missing gateway token. Set HOMUN_DESKTOP_GATEWAY_TOKEN or HOMUN_EVAL_GATEWAY_TOKEN.",
            file=sys.stderr,
        )
        return 2
    try:
        ok, detail = run_smoke(args.gateway_base, token, args.timeout_seconds)
    except (OSError, RuntimeError, TimeoutError, urllib.error.URLError) as error:
        print(f"FAIL live gateway browser smoke: {error}", file=sys.stderr)
        return 1
    print(detail)
    print("PASS live gateway browser smoke" if ok else "FAIL live gateway browser smoke")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
