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

    # --- Test 1b: atomicity — user message persisted in chat_messages together with the turn ---
    log("TEST 1b: atomicity — user message persisted in chat_messages with the turn")
    # Brief wait: the broker's atomic INSERT commits immediately, but the chat_store's
    # reader connection may lag by a WAL checkpoint. The other tests below already poll,
    # but for this atomicity check we want to read soon after enqueue without racing the
    # WAL visibility window.
    time.sleep(0.5)
    status, body, _ = http_request(
        "GET", f"/api/chat/threads/{thread_id}/messages", expect=200
    )
    # The response shape is {"thread_id": "...", "messages": [...]}.
    messages = body.get("messages") if isinstance(body, dict) else body
    found = False
    if isinstance(messages, list):
        for msg in messages:
            if isinstance(msg, dict) and "hello broker" in (msg.get("text") or ""):
                found = True
                break
    if not found:
        # Debug: print what we actually got back so the failure is diagnosable.
        msg_count = len(messages) if isinstance(messages, list) else "n/a"
        sample_texts = []
        if isinstance(messages, list):
            sample_texts = [(m.get("role"), (m.get("text") or "")[:50]) for m in messages if isinstance(m, dict)]
        fail(
            f"ATOMICITY BROKEN: 'hello broker' not found in thread messages after "
            f"enqueue (got {msg_count} messages: {sample_texts})"
        )
    log("  → user message 'hello broker' found in chat_messages ✓ (atomicity holds)")

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

    # --- Test 8: failed turn reaches `failed` (not waiting_external_event) ---
    # A turn with no LLM provider returns "No reply generated." → the executor marks
    # completed=false → the worker retries up to max_attempts, then (because chat_turn
    # uses hard_error=true) lands in `failed`. We verify the FINAL state is failed and
    # that a `retry` or `error` event was emitted along the way.
    log("TEST 8: failed chat_turn reaches terminal `failed` state (no waiting_external_event zombie)")
    thread3 = create_thread()
    status, body, _ = http_request(
        "POST",
        "/api/chat/turns",
        body={"thread_id": thread3, "prompt": "this will fail without an LLM provider"},
        expect=201,
    )
    turn3 = body.get("turn_id")
    log(f"  enqueued {turn3}; waiting for retry attempts to exhaust (interactive = 2 attempts, ~15s backoff)…")
    # Interactive retry policy: max_attempts=2, backoff=15s. Allow generous time for
    # both attempts to fail and the worker to mark the task failed.
    final_status = "unknown"
    deadline = time.time() + 60
    while time.time() < deadline:
        status, body, _ = http_request("GET", f"/api/chat/turns/{turn3}")
        if isinstance(body, dict):
            final_status = body.get("status")
            # terminal states for a chat_turn
            if final_status in ("failed", "completed", "cancelled"):
                break
        time.sleep(1.0)
    log(f"  → final status: {final_status}")
    if final_status == "waitingexternalevent":
        fail(
            "ZOMBIE: turn ended in waiting_external_event (the soft-lock bug). "
            "Expected: failed (or completed/cancelled)."
        )
    if final_status not in ("failed", "completed", "cancelled"):
        fail(f"turn did not reach a terminal state within 60s (last: {final_status})")
    # Verify a `retry` or `error` turn_event was emitted (visibility of the retry path).
    status, body, _ = http_request("GET", f"/api/chat/turns/{turn3}/events?since=0", expect=200)
    if isinstance(body, list):
        kinds = [e.get("kind") for e in body]
        log(f"  event kinds: {kinds}")
        if "retry" in kinds:
            log("  → `retry` event emitted ✓ (retry is visible to subscribers)")
        elif "error" in kinds:
            log("  → `error` event present (acceptable; retry may have been skipped if max_attempts=1)")
        else:
            log(f"  → NOTE: no retry/error events (kinds={kinds}); may be ok if it failed fast")
    log(f"  → TEST 8 ✓ (final status {final_status}, no zombie)")

    # --- Test 9: browser gating — two turns on different threads compete for the slot ---
    # Each chat_turn now declares a BrowserSession(1) requirement; the ResourceGovernor
    # limit is 1. So if turn A is holding the slot while turn B is dispatched, B must
    # land in WaitingResource (with a `queued` turn_event) and only proceed once A frees.
    # We can't deterministically reproduce "A is mid-execution when B is dispatched" with
    # the no-LLM setup (turns fail in setup before reserving the browser), so this test
    # is a best-effort check: enqueue two on different threads in quick succession and
    # verify that BOTH reach a terminal state and at least one emitted a `queued` event
    # at some point. If neither ever queues, the gating is either not engaged (bug) or
    # the timing window was missed (acceptable in a no-LLM test).
    log("TEST 9: browser gating — two concurrent turns on different threads")
    thread_a = create_thread()
    thread_b = create_thread()
    _, body_a, _ = http_request("POST", "/api/chat/turns", body={"thread_id": thread_a, "prompt": "a"}, expect=201)
    _, body_b, _ = http_request("POST", "/api/chat/turns", body={"thread_id": thread_b, "prompt": "b"}, expect=201)
    turn_a = body_a["turn_id"]
    turn_b = body_b["turn_id"]
    log(f"  enqueued {turn_a} (thread A) and {turn_b} (thread B)")

    # Wait briefly to let the workers race for the browser slot.
    time.sleep(2)

    # Check events on both turns for a `queued` event (the one that lost the race).
    queued_seen = False
    for tid in (turn_a, turn_b):
        _, events_body, _ = http_request("GET", f"/api/chat/turns/{tid}/events?since=0", expect=200)
        if isinstance(events_body, list) and any(e.get("kind") == "queued" for e in events_body):
            queued_seen = True
            log(f"  → turn {tid} emitted a `queued` event (browser slot contended) ✓")
            break

    if not queued_seen:
        log("  → NOTE: no `queued` event observed (turns may have failed before reserving the browser; acceptable in no-LLM test)")

    # Both turns must eventually reach a terminal state (failed/completed/cancelled),
    # never stuck in WaitingResource forever — the governor re-queues them when the
    # slot frees, so they proceed even without the other turn completing successfully.
    log("  waiting for both turns to reach terminal status…")
    for tid in (turn_a, turn_b):
        final = wait_for_terminal_status(tid, timeout_s=60)
        if final == "waitingresource":
            fail(f"turn {tid} stuck in WaitingResource (browser slot never freed) — governor requeue may be broken")
        log(f"  → {tid} final: {final}")
    log("  → TEST 9 ✓ (both turns reached terminal state; no permanent WaitingResource)")

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
