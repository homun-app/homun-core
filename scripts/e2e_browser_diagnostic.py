#!/usr/bin/env python3
"""
E2E Browser Diagnostic — submits a browser-requiring turn, monitors all
phases (health -> plan -> steps -> activity -> terminal), prints PASS/FAIL
per phase and a summary table.

Usage:
    python3 scripts/e2e_browser_diagnostic.py [--thread-id ID] [--prompt "text"] [--timeout 480]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ── constants ────────────────────────────────────────────────────────────
GATEWAY = "http://127.0.0.1:18765"
TOKEN_FILE = Path.home() / ".homun" / "desktop-gateway-token"
DB_PATH = Path.home() / ".homun" / "homun.sqlite"
DEFAULT_PROMPT = (
    "Cerca i voli diretti Roma-Tokyo il 15 ottobre 2026 confrontando "
    "almeno due compagnie e riporta prezzo e durata."
)
POLL_INTERVAL = 3  # seconds between polls
TERMINAL_STATES = {"completed", "cancelled", "failed", "error"}

# ── helpers ──────────────────────────────────────────────────────────────

def load_token() -> str:
    if not TOKEN_FILE.exists():
        print(f"[FATAL] Token file not found: {TOKEN_FILE}")
        print("        Make sure the desktop gateway is running.")
        sys.exit(2)
    return TOKEN_FILE.read_text().strip()

def request_headers(has_body: bool) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {load_token()}"}
    if has_body:
        headers["Content-Type"] = "application/json"
    return headers


class Phase:
    """Result of a single diagnostic phase."""
    def __init__(self, name: str, passed: bool, duration: float, sample: str = ""):
        self.name = name
        self.passed = passed
        self.duration = round(duration, 2)
        self.sample = sample[:120] if sample else ""


def http(method: str, path: str, body: dict | None = None, timeout: int = 10):
    """Fire an HTTP request; return (status, parsed_json_or_None)."""
    url = GATEWAY + path
    data = json.dumps(body).encode() if body is not None else None
    hdrs = request_headers(body is not None)
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        raw = resp.read().decode()
        return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode() if exc.fp else ""
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, {"_raw": raw[:300]}
    except Exception as exc:
        return 0, {"_error": str(exc)}


def db_query(sql: str, params: tuple = ()) -> list[dict]:
    """Run a read-only query against the unified homun DB."""
    if not DB_PATH.exists():
        return []
    uri = f"file:{DB_PATH}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── phase helpers (quick, non-blocking) ──────────────────────────────────

def check_health() -> tuple[bool, str]:
    """Return (ok, sample)."""
    status, body = http("GET", "/api/health")
    if status != 200 or not body:
        return False, f"HTTP {status}"
    ok = body.get("ok", False)
    sidecars = body.get("sidecars", {})
    cc = sidecars.get("contained_computer", {})
    cc_running = cc.get("running", False) if isinstance(cc, dict) else False
    browser_info = sidecars.get("browser", {})
    browser_running = browser_info.get("running", False) if isinstance(browser_info, dict) else False
    sample = f"ok={ok}, contained_computer={cc_running}, browser={browser_running}"
    return ok is True, sample


def get_turn_events(turn_id: str) -> list[dict]:
    """Fetch all turn events from DB + API."""
    events = []
    # DB
    rows = db_query(
        "SELECT kind, payload_json FROM turn_events WHERE turn_id=? ORDER BY seq",
        (turn_id,),
    )
    for r in rows:
        try:
            payload = json.loads(r["payload_json"])
        except Exception:
            payload = {"_raw": r["payload_json"][:80]}
        events.append({"kind": r["kind"], "payload": payload, "source": "db"})
    # API fallback if DB empty
    if not events:
        status, body = http("GET", f"/api/chat/turns/{turn_id}/events?since=0")
        if status == 200 and body:
            items = body if isinstance(body, list) else body.get("events", [])
            for ev in items:
                events.append({
                    "kind": ev.get("kind", ""),
                    "payload": ev.get("data", ev),
                    "source": "api",
                })
    return events


def get_turn_status(turn_id: str) -> str:
    """Get current turn status from API or DB."""
    status, body = http("GET", f"/api/chat/turns/{turn_id}")
    if status == 200 and body:
        return body.get("status", "")
    rows = db_query(
        "SELECT status FROM agent_runs WHERE turn_id=? ORDER BY started_at DESC LIMIT 1",
        (turn_id,),
    )
    if rows:
        return rows[0].get("status", "")
    return ""


def get_kernel_projection(thread_id: str) -> dict | None:
    """Fetch the kernel-owned UI projection for final browser/plan state."""
    status, body = http("GET", f"/api/chat/threads/{thread_id}/kernel-projection")
    if status == 200 and isinstance(body, dict):
        return body
    return None


def get_assistant_texts(thread_id: str) -> list[str]:
    """Return newest assistant messages, preferring the DB for finished turns."""
    msgs = db_query(
        "SELECT text FROM chat_messages WHERE thread_id=? AND role='assistant' ORDER BY timestamp DESC LIMIT 5",
        (thread_id,),
    )
    if msgs:
        return [str(row.get("text") or "") for row in msgs]

    st, body = http("GET", f"/api/chat/threads/{thread_id}/messages")
    if st != 200 or not body:
        return []
    items = body if isinstance(body, list) else body.get("messages", body.get("items", []))
    assistants = [m for m in items if isinstance(m, dict) and m.get("role") == "assistant"]
    return [
        str(message.get("text", message.get("content", "")) or "")
        for message in reversed(assistants[-5:])
    ]


def projection_failure_sample(projection: dict | None) -> str | None:
    if not isinstance(projection, dict):
        return None

    browser = projection.get("browser")
    if isinstance(browser, dict) and browser.get("state") == "failed":
        reason = browser.get("failure_reason") or "unknown"
        return f"browser failed: {reason}"

    plan = projection.get("plan")
    steps = plan.get("steps") if isinstance(plan, dict) else None
    if isinstance(steps, list):
        blocked = [
            step
            for step in steps
            if isinstance(step, dict) and step.get("status") == "blocked"
        ]
        if blocked:
            title = blocked[0].get("title") or blocked[0].get("id") or "step"
            return f"plan blocked: {title}"

    return None


def evaluate_final_result(assistant_texts: list[str], projection: dict | None) -> tuple[bool, str]:
    projection_failure = projection_failure_sample(projection)
    if projection_failure:
        return False, projection_failure
    if not assistant_texts:
        return False, "no assistant messages"
    txt = assistant_texts[0]
    return True, f"msgs={len(assistant_texts)}, len={len(txt)}, preview={txt[:60]}"


def evaluate_phases(events: list[dict], turn_id: str, thread_id: str) -> dict:
    """Evaluate phases 4-8 from collected events. Return dict of phase_name -> (passed, sample)."""
    results = {}

    # Phase 4: Plan created
    plans = [e for e in events if e["kind"] in {"plan", "plan_update"}]
    if plans:
        p = plans[0]["payload"]
        markdown = str(p.get("markdown", ""))
        goal_text = p.get("goal") or (markdown.splitlines()[0] if markdown else "")
        goal = str(goal_text)[:60]
        steps = len(p.get("steps", []))
        sample = f"goal={goal}, steps={steps}" if steps else f"kind={plans[0]['kind']}, goal={goal}"
        results["Plan created"] = (True, sample)
    else:
        results["Plan created"] = (False, "no plan event yet")

    # Phase 5: Step advance
    steps = [e for e in events if e["kind"] == "step_advance"]
    if steps:
        parts = []
        for s in steps[:3]:
            p = s["payload"]
            fr = p.get("from", p.get("from_step", "?"))
            to = p.get("to", p.get("to_step", "?"))
            verified = p.get("verified", "")
            parts.append(f"{fr}->{to}" + (f" (v={verified})" if verified else ""))
        results["Step advance"] = (True, "; ".join(parts))
    else:
        results["Step advance"] = (False, "no step_advance events")

    # Phase 6: Activity browser
    activities = [e for e in events if e["kind"] == "activity"]
    browser_acts = [
        a for a in activities
        if any(kw in json.dumps(a["payload"]).lower()
               for kw in ("browser", "web", "navigate", "browse", "screenshot", "page"))
    ]
    if browser_acts:
        samples = [json.dumps(a["payload"])[:50] for a in browser_acts[:3]]
        results["Activity browser"] = (True, f"{len(browser_acts)} browser events; " + " | ".join(samples))
    elif activities:
        samples = [json.dumps(a["payload"])[:50] for a in activities[:3]]
        results["Activity browser"] = (True, f"{len(activities)} activity events; " + " | ".join(samples))
    else:
        results["Activity browser"] = (False, "no activity events")

    # Phase 7: Sub-turn browse (agent_runs / executions)
    runs = db_query(
        "SELECT run_id, status, role, model FROM agent_runs WHERE turn_id=? ORDER BY started_at",
        (turn_id,),
    )
    execs = db_query(
        """SELECT e.execution_id, e.kind, e.state FROM executions e
           JOIN agent_runs ar ON ar.thread_id = e.thread_id
           WHERE ar.turn_id=? ORDER BY e.created_at""",
        (turn_id,),
    )
    total = len(runs) + len(execs)
    if total > 0:
        sample = f"agent_runs={len(runs)}, executions={len(execs)}"
        if runs:
            roles = [r.get("role", "?") for r in runs[:3]]
            sample += f", roles={roles}"
        results["Sub-turn browse"] = (True, sample)
    else:
        results["Sub-turn browse"] = (False, "no agent_runs/executions")

    # Phase 8: Final result. A visible assistant message is not enough: the
    # kernel projection must not report a failed browser or blocked plan.
    results["Final result"] = evaluate_final_result(
        get_assistant_texts(thread_id),
        get_kernel_projection(thread_id),
    )

    return results


# ── main ─────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="E2E browser diagnostic")
    ap.add_argument("--thread-id", default=None, help="Existing thread ID")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT, help="Turn prompt")
    ap.add_argument("--timeout", type=int, default=480, help="Overall timeout (seconds)")
    ap.add_argument("--skip-turn", action="store_true", help="Only health checks")
    args = ap.parse_args()

    t_start = time.time()
    phases: list[Phase] = []

    def add(name, passed, sample, t0=None):
        dt = (time.time() - t0) if t0 else 0.0
        p = Phase(name, passed, dt, sample)
        phases.append(p)
        tag = "PASS" if passed else "FAIL"
        print(f"       [{tag}] {sample}")
        return p

    # 1. Health pre-check
    print("[1/10] Health pre-check...")
    t0 = time.time()
    ok, sample = check_health()
    add("Health pre-check", ok, sample, t0)

    if args.skip_turn:
        print("\n  --skip-turn: only health checks.")
        print_report(phases)
        sys.exit(0 if ok else 1)

    # 2. Thread ready
    print("[2/10] Thread ready...")
    t0 = time.time()
    if args.thread_id:
        st, body = http("GET", f"/api/chat/threads/{args.thread_id}/messages")
        thread_id = args.thread_id if st == 200 else ""
        add("Thread ready (existing)", st == 200, f"id={args.thread_id} HTTP {st}", t0)
    else:
        st, body = http("POST", "/api/chat/threads", body={})
        thread_id = ""
        if st in (200, 201) and body:
            thread_id = body.get("thread_id") or body.get("id") or ""
        add("Thread ready (created)", bool(thread_id), f"id={thread_id}", t0)
    if not thread_id:
        print("  Cannot proceed without a thread.")
        print_report(phases)
        sys.exit(1)

    # 3. Turn enqueued
    print(f"[3/10] Enqueuing turn (thread={thread_id[:16]}...)...")
    t0 = time.time()
    st, body = http("POST", "/api/chat/turns", body={"thread_id": thread_id, "prompt": args.prompt})
    turn_id = ""
    if body and isinstance(body, dict):
        turn_id = body.get("turn_id") or body.get("id") or ""
    turn_status = body.get("status", "?") if body and isinstance(body, dict) else "?"
    add("Turn enqueued", st in (200, 201, 202) and bool(turn_id),
        f"HTTP {st}, turn_id={turn_id[:20]}, status={turn_status}", t0)
    if not turn_id:
        print("  No turn_id. Aborting.")
        do_cleanup(thread_id, args.thread_id is not None)
        print_report(phases)
        sys.exit(1)

    # 4-9. Polling loop: monitor turn until terminal or global timeout
    print(f"[4-9/10] Monitoring turn (timeout={args.timeout}s)...")
    deadline = t_start + args.timeout
    last_eval = {}
    turn_terminal = ""
    plan_seen_time = None

    while time.time() < deadline:
        elapsed = time.time() - t_start
        events = get_turn_events(turn_id)
        turn_terminal = get_turn_status(turn_id)
        is_terminal = turn_terminal.lower() in TERMINAL_STATES

        # Evaluate phases 4-8
        last_eval = evaluate_phases(events, turn_id, thread_id)

        # Progress indicator
        n_events = len(events)
        plan_found = "plan" if "Plan created" in last_eval and last_eval["Plan created"][0] else ""
        step_found = "steps" if "Step advance" in last_eval and last_eval["Step advance"][0] else ""
        act_found = "activity" if "Activity browser" in last_eval and last_eval["Activity browser"][0] else ""
        flags = " ".join(filter(None, [plan_found, step_found, act_found]))
        print(f"  [{elapsed:>5.0f}s] events={n_events}, status={turn_terminal}, {flags}", flush=True)

        if is_terminal:
            print(f"  Turn reached terminal state: {turn_terminal}")
            break

        time.sleep(POLL_INTERVAL)

    # Record phases 4-8
    t_now = time.time()
    for phase_name in ["Plan created", "Step advance", "Activity browser", "Sub-turn browse", "Final result"]:
        passed, sample = last_eval.get(phase_name, (False, "not evaluated"))
        phases.append(Phase(phase_name, passed, t_now - t_start, sample))

    # Phase 9: Termination
    term_passed = turn_terminal.lower() in TERMINAL_STATES
    phases.append(Phase("Termination", term_passed, time.time() - t_start,
                        f"status={turn_terminal}" if term_passed else f"timeout ({args.timeout}s)"))

    # 10. Health post-check
    print("[10/10] Health post-check...")
    t0 = time.time()
    ok2, sample2 = check_health()
    add("Health post-check", ok2, sample2, t0)

    # Cleanup
    do_cleanup(thread_id, args.thread_id is not None)

    # Report
    print_report(phases)
    sys.exit(0 if all(p.passed for p in phases) else 1)


def do_cleanup(thread_id: str, user_provided: bool):
    """Delete thread if we created it."""
    if user_provided:
        print(f"\n  [info] Thread {thread_id} was user-provided, skipping cleanup.")
        return
    st, _ = http("DELETE", f"/api/chat/threads/{thread_id}")
    if st in (200, 202, 204):
        print(f"\n  [cleanup] Thread {thread_id} deleted.")
    else:
        print(f"\n  [cleanup] Could not delete thread (HTTP {st}). Delete manually if needed.")


def print_report(phases: list[Phase]):
    all_pass = all(p.passed for p in phases)
    w_name = min(max(len(p.name) for p in phases) + 2, 24)
    w_samp = 36
    sep_len = w_name + 16 + w_samp + 4
    print()
    print("=" * sep_len)
    print(f" {'Phase':<{w_name}} Result   Time  Sample")
    print("-" * sep_len)
    for p in phases:
        tag = "PASS" if p.passed else "FAIL"
        m = "+" if p.passed else "-"
        print(f" {m} {p.name:<{w_name}} [{tag}] {p.duration:>5.1f}s {p.sample[:w_samp]}")
    print("=" * sep_len)
    passed = sum(1 for p in phases if p.passed)
    total = len(phases)
    verdict = "ALL PASS" if all_pass else "SOME FAIL"
    print(f"  {verdict}  ({passed}/{total})")
    print()


if __name__ == "__main__":
    main()
