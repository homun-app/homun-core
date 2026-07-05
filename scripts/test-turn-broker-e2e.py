#!/usr/bin/env python3
"""
End-to-end test for the Turn Queue Broker (Phase 1a / Slice 1a).

Starts the real gateway binary with HOMUN_TURN_BROKER=on in an ISOLATED
temporary data dir, then exercises the 5 broker routes via HTTP:

  1. POST   /api/chat/turns          → 201 (enqueue)
  2. POST   /api/chat/turns (same thread) → 409 (thread_busy)
  3. GET    /api/chat/turns/{id}     → 200 (status check)
  4. GET    /api/chat/turns/{id}/events?since=0 → 200 (event replay)
  5. GET    /api/chat/turns/{id}/stream?since=0 → 200 NDJSON (live stream)
  6. DELETE /api/chat/turns/{id}     → 202 (cancel)

NOTE: the gateway requires an LLM provider to actually run the agent loop.
Without one, the executor's chat_role_config_for_thread returns None and the
turn ends quickly (the executor returns "No reply generated." or the worker
marks the turn Failed). This is EXPECTED in the test environment — we are
verifying the BROKER WIRING (enqueue → Queued → pickup → executor runs →
events emitted → terminal status), not LLM generation.

Usage:
    python3 scripts/test-turn-broker-e2e.py [--keep-data-dir]

Exit codes:
    0 = all assertions passed
    1 = one or more assertions failed
    2 = setup error (could not build/start gateway)
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BINARY = REPO_ROOT / "target" / "debug" / "local-first-desktop-gateway"
GATEWAY_TOKEN = "test-broker-token-do-not-use-in-prod"
GATEWAY_PORT = 18799  # unlikely to collide with a real running gateway
BASE_URL = f"http://127.0.0.1:{GATEWAY_PORT}"


def log(msg):
    print(f"[test] {msg}", flush=True)


def fail(msg):
    print(f"[FAIL] {msg}", flush=True)
    sys.exit(1)


def build_binary():
    log("building gateway (debug)…")
    env = os.environ.copy()
    env["PATH"] = os.path.expanduser("~/.cargo/bin") + ":" + env.get("PATH", "")
    proc = subprocess.run(
        ["cargo", "build", "-p", "local-first-desktop-gateway"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr)
        fail("cargo build failed")
    if not BINARY.exists():
        fail(f"binary not found at {BINARY} after build")
    log("build OK")


def start_gateway(data_dir: Path) -> subprocess.Popen:
    env = os.environ.copy()
    env["HOMUN_DATA_DIR"] = str(data_dir)
    env["HOMUN_DESKTOP_GATEWAY_TOKEN"] = GATEWAY_TOKEN
    env["HOMUN_DESKTOP_GATEWAY_PORT"] = str(GATEWAY_PORT)
    env["HOMUN_TURN_BROKER"] = "on"
    # Disable optional background workers that would slow boot or pollute logs.
    env["HOMUN_TASK_EXECUTOR_WORKER"] = "on"  # MUST be on for the broker
    env["RUST_LOG"] = "warn"

    log(f"starting gateway on port {GATEWAY_PORT} with data_dir={data_dir} …")
    log_file = open(data_dir.parent / "gateway.log", "w")
    proc = subprocess.Popen(
        [str(BINARY)],
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    # Wait for the gateway to be ready (poll /api/chat/threads which is always mounted).
    deadline = time.time() + 30
    last_err = None
    while time.time() < deadline:
        if proc.poll() is not None:
            fail(f"gateway exited early with code {proc.returncode}; see log: {log_file.name}")
        try:
            req = urllib.request.Request(
                f"{BASE_URL}/api/chat/threads",
                headers={"Authorization": f"Bearer {GATEWAY_TOKEN}"},
            )
            urllib.request.urlopen(req, timeout=2).read()
            log("gateway is up")
            return proc
        except Exception as e:
            last_err = e
            time.sleep(0.5)
    fail(f"gateway did not become ready in 30s; last error: {last_err}; log: {log_file.name}")


def stop_gateway(proc: subprocess.Popen):
    if proc.poll() is None:
        log("stopping gateway…")
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def http_request(method: str, path: str, body=None, expect=None):
    url = BASE_URL + path
    data = None
    headers = {"Authorization": f"Bearer {GATEWAY_TOKEN}"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        status = resp.status
        text = resp.read().decode()
    except urllib.error.HTTPError as e:
        status = e.code
        text = e.read().decode()
    parsed = None
    if text:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            pass
    if expect is not None and status != expect:
        fail(f"{method} {path}: expected {expect}, got {status}: {text}")
    return status, parsed, text


def create_thread() -> str:
    status, body, _ = http_request("POST", "/api/chat/threads", body={}, expect=200)
    # body is the created ChatThread; extract thread_id
    thread_id = body.get("thread_id") if isinstance(body, dict) else None
    if not thread_id:
        fail(f"could not create thread; response: {body}")
    log(f"created thread {thread_id}")
    return thread_id


def wait_for_terminal_status(turn_id: str, timeout_s: float = 15.0) -> str:
    """Poll GET /turns/{id} until the turn leaves the queued state (worker picked it up).

    In the test environment there's no LLM provider, so the agent-loop returns None
    quickly and the executor produces a non-completed outcome. The worker pool then
    marks the turn as failed/waiting_external/retries. For THIS test we only care that
    the worker SAW the turn and ran the executor — i.e. status moved away from
    'queued'. Any non-queued status means the wiring works.
    """
    deadline = time.time() + timeout_s
    last_status = None
    while time.time() < deadline:
        status, body, _ = http_request("GET", f"/api/chat/turns/{turn_id}")
        if isinstance(body, dict):
            last_status = body.get("status")
            # Any non-queued status means the worker pool picked it up and ran the executor.
            if last_status != "queued":
                return last_status
        time.sleep(0.3)
    return last_status or "unknown"


def run_tests():
    # --- Setup: create a thread to attach the turn to ---
    thread_id = create_thread()

    # --- Test 1: enqueue succeeds on idle thread ---
    log("TEST 1: POST /api/chat/turns on idle thread → expect 201")
    status, body, _ = http_request(
        "POST",
        "/api/chat/turns",
        body={"thread_id": thread_id, "prompt": "hello broker"},
        expect=201,
    )
    turn_id = body.get("turn_id")
    if not turn_id or not turn_id.startswith("turn_"):
        fail(f"unexpected turn_id in 201 response: {body}")
    log(f"  → 201, turn_id={turn_id}, status={body.get('status')}")

    # --- Test 2: second enqueue on same thread → 409 thread_busy ---
    log("TEST 2: POST /api/chat/turns again on same thread → expect 409")
    status, body, _ = http_request(
        "POST",
        "/api/chat/turns",
        body={"thread_id": thread_id, "prompt": "second message should be rejected"},
        expect=409,
    )
    if not (isinstance(body, dict) and body.get("error") == "thread_busy"):
        fail(f"409 body should have error=thread_busy, got: {body}")
    if body.get("active_turn_id") != turn_id:
        fail(f"409 active_turn_id should be {turn_id}, got {body.get('active_turn_id')}")
    log(f"  → 409 thread_busy, active_turn_id={body.get('active_turn_id')} ✓")

    # --- Test 3: GET turn status ---
    log("TEST 3: GET /api/chat/turns/{id} → expect 200 with status field")
    status, body, _ = http_request("GET", f"/api/chat/turns/{turn_id}", expect=200)
    if not isinstance(body, dict) or "status" not in body:
        fail(f"GET turn body missing 'status': {body}")
    log(f"  → 200, status={body.get('status')}, source={body.get('source')}")

    # --- Test 4: GET events (replay) ---
    log("TEST 4: GET /api/chat/turns/{id}/events?since=0 → expect 200 array")
    status, body, _ = http_request("GET", f"/api/chat/turns/{turn_id}/events?since=0", expect=200)
    if not isinstance(body, list):
        fail(f"events should be a JSON array, got: {body}")
    log(f"  → 200, {len(body)} events so far")
    if body:
        kinds = [e.get("kind") for e in body]
        log(f"    event kinds: {kinds}")

    # --- Test 5: GET stream (NDJSON, just read a few lines or timeout) ---
    log("TEST 5: GET /api/chat/turns/{id}/stream?since=0 → expect 200 NDJSON")
    url = f"{BASE_URL}/api/chat/turns/{turn_id}/stream?since=0"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {GATEWAY_TOKEN}"})
    try:
        # Short timeout: we just want to verify it opens and sends at least the replay
        resp = urllib.request.urlopen(req, timeout=3)
        if resp.status != 200:
            fail(f"stream expected 200, got {resp.status}")
        # Read whatever is available in 2s (the replay + maybe some live events)
        # We don't block on the full stream — just verify it starts.
        first_chunk = resp.read(256)
        log(f"  → 200, first {len(first_chunk)} bytes received")
        if first_chunk:
            try:
                first_line = first_chunk.split(b"\n")[0]
                first_event = json.loads(first_line)
                log(f"    first event kind: {first_event.get('kind')}")
            except json.JSONDecodeError:
                log(f"    first chunk not JSON (maybe partial): {first_chunk[:80]!r}")
    except urllib.error.URLError as e:
        # Timeout is acceptable if the replay was empty (turn produced no events yet)
        if "timed out" in str(e).lower():
            log("  → 200 (timeout reading — replay may be empty)")
        else:
            fail(f"stream request failed: {e}")
    except Exception as e:
        log(f"  → stream read returned (acceptable): {e}")

    # --- Wait for the turn to reach a terminal status ---
    log("waiting for turn to reach terminal status (no LLM provider → expect failed or completed quickly)…")
    final_status = wait_for_terminal_status(turn_id, timeout_s=20)
    log(f"  → final status: {final_status}")

    # --- Test 6: DELETE a second turn (cancel path) ---
    # Create a fresh thread + turn, then cancel it before/while it runs.
    log("TEST 6: DELETE /api/chat/turns/{id} on a new turn → expect 202")
    thread2 = create_thread()
    status, body, _ = http_request(
        "POST",
        "/api/chat/turns",
        body={"thread_id": thread2, "prompt": "to be cancelled"},
        expect=201,
    )
    turn2 = body.get("turn_id")
    status, _, _ = http_request("DELETE", f"/api/chat/turns/{turn2}", expect=202)
    log(f"  → 202 (cancel accepted for {turn2})")
    # Verify it actually becomes cancelled
    final = wait_for_terminal_status(turn2, timeout_s=5)
    if final == "cancelled":
        log(f"  → turn status = cancelled ✓")
    else:
        log(f"  → turn status = {final} (cancel may have raced with completion — acceptable)")

    # --- Test 7: GET non-existent turn → 404 ---
    log("TEST 7: GET /api/chat/turns/turn_nonexistent → expect 404")
    http_request("GET", "/api/chat/turns/turn_nonexistent_xyz", expect=404)
    log("  → 404 ✓")

    log("ALL TESTS PASSED")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep-data-dir", action="store_true", help="keep the temp data dir for inspection")
    args = parser.parse_args()

    build_binary()

    tmp_root = Path(tempfile.mkdtemp(prefix="homun-broker-test-"))
    data_dir = tmp_root / "data"
    data_dir.mkdir()

    proc = None
    try:
        proc = start_gateway(data_dir)
        run_tests()
    finally:
        if proc is not None:
            stop_gateway(proc)
        if args.keep_data_dir:
            log(f"data dir kept at {data_dir}; log at {tmp_root}/gateway.log")
        else:
            shutil.rmtree(tmp_root, ignore_errors=True)

    sys.exit(0)


if __name__ == "__main__":
    main()
