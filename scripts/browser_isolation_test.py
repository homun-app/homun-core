#!/usr/bin/env python3
"""
browser_isolation_test.py — Diagnostica browser in isolamento.

Uso:
  # Test CDP diretto (senza modelli, verifica solo il contained browser)
  python3 scripts/browser_isolation_test.py --cdp-only

  # Confronto modelli (default: stesso prompt, N modelli browser)
  python3 scripts/browser_isolation_test.py --models "minimax-m3,deepseek-v4-pro" --provider "8eb2018b-e43c-410c-b992-484bfadbe689"

  # Opzioni
  --prompt "Naviga a example.com e descrivi la pagina"
  --timeout 120          # secondi per ogni modello
  --gateway http://127.0.0.1:18765
  --cdp-url http://127.0.0.1:9222
"""

import argparse
import json
import os
import signal
import sqlite3
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# ── Paths ──────────────────────────────────────────────────────────────────

HOMUN_DIR = Path.home() / ".homun"
PROVIDERS_PATH = HOMUN_DIR / "providers.json"
TOKEN_PATH = HOMUN_DIR / "desktop-gateway-token"
DB_PATH = HOMUN_DIR / "homun.sqlite"

BROWSER_PROMPT = "Apri https://example.com e dimmi cosa vedi nella pagina."

# ── Helpers ────────────────────────────────────────────────────────────────

def read_token() -> str:
    """Read bearer token from ~/.homun/desktop-gateway-token."""
    return TOKEN_PATH.read_text().strip()


def gw_request(base: str, method: str, path: str, body: dict | None = None, token: str = "") -> dict | None:
    """HTTP request to the gateway. Returns parsed JSON or None on error."""
    url = f"{base}{path}"
    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urlopen(req, timeout=10) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except HTTPError as e:
        body_text = e.read().decode(errors="replace")[:300]
        print(f"  [HTTP {e.code}] {method} {path}: {body_text}")
        return None
    except (URLError, OSError) as e:
        print(f"  [NET ERR] {method} {path}: {e}")
        return None


def cdp_get(cdp_url: str, path: str) -> dict | list | None:
    """HTTP GET to CDP endpoint."""
    url = f"{cdp_url}{path}"
    try:
        with urlopen(url, timeout=5) as resp:
            return json.loads(resp.read())
    except (HTTPError, URLError, OSError) as e:
        print(f"  [CDP ERR] {path}: {e}")
        return None


def load_providers() -> dict:
    return json.loads(PROVIDERS_PATH.read_text())


def save_providers(data: dict):
    PROVIDERS_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False))


# ── CDP-only test ─────────────────────────────────────────────────────────

def run_cdp_test(cdp_url: str):
    """Direct CDP test: browser version, tabs, basic navigation check."""
    print("=" * 60)
    print("CDP ISOLATION TEST (no models involved)")
    print("=" * 60)

    # 1. Browser version
    ver = cdp_get(cdp_url, "/json/version")
    if ver is None:
        print("\n[PAIL] Cannot reach CDP on", cdp_url)
        print("  → Il contained browser (docker homun-cc) non è raggiungibile.")
        return
    browser = ver.get("Browser", "?")
    ws_url = ver.get("webSocketDebuggerUrl", "")
    print(f"\n  Browser version : {browser}")
    print(f"  WS debugger    : {ws_url[:80]}..." if ws_url else "  WS debugger    : n/a")

    # 2. Open tabs
    tabs = cdp_get(cdp_url, "/json/list")
    if tabs is None:
        print("\n[FAIL] Cannot list tabs")
        return
    tab_count = len(tabs)
    print(f"  Open tabs      : {tab_count}")
    for i, tab in enumerate(tabs[:5]):
        title = tab.get("title", "?")[:50]
        url = tab.get("url", "?")[:60]
        print(f"    [{i}] {title} — {url}")
    if tab_count > 5:
        print(f"    ... +{tab_count - 5} more")

    # 3. Protocol version
    proto = ver.get("Protocol-Version", "?")
    user_agent = ver.get("User-Agent", "?")[:80]
    print(f"\n  Protocol       : {proto}")
    print(f"  User-Agent     : {user_agent}")

    # Verdict
    print("\n" + "-" * 60)
    if tab_count >= 0 and browser != "?":
        print("  [PASS] CDP reachable. Browser funziona a livello sistema.")
        print("  Se i problemi persistono → è il modello, non il browser.")
    else:
        print("  [FAIL] CDP non risponde correttamente.")
    print("-" * 60)


# ── Model comparison ──────────────────────────────────────────────────────

def create_thread(base: str, token: str) -> str | None:
    """Create a new chat thread via gateway. Returns thread_id."""
    resp = gw_request(base, "POST", "/api/chat/threads", token=token)
    if resp and isinstance(resp, dict):
        return resp.get("id") or resp.get("thread_id")
    return None


def delete_thread(base: str, token: str, thread_id: str):
    """Delete a chat thread."""
    gw_request(base, "DELETE", f"/api/chat/threads/{thread_id}", token=token)


def submit_turn(base: str, token: str, thread_id: str, prompt: str, request_id: str) -> str:
    """Submit a chat turn. Returns turn_id."""
    body = {"thread_id": thread_id, "prompt": prompt, "request_id": request_id}
    turn_id = f"turn_{request_id}"
    resp = gw_request(base, "POST", "/api/chat/turns", body=body, token=token)
    if resp and isinstance(resp, dict):
        return resp.get("turn_id", turn_id)
    return turn_id


def poll_turn(base: str, token: str, turn_id: str, timeout: int) -> str:
    """Poll turn status until terminal or timeout. Returns final status string."""
    deadline = time.time() + timeout
    last_status = "unknown"
    while time.time() < deadline:
        resp = gw_request(base, "GET", f"/api/chat/turns/{turn_id}", token=token)
        if resp and isinstance(resp, dict):
            status = resp.get("status", "")
            last_status = status
            if status in ("completed", "failed", "cancelled", "error"):
                return status
        time.sleep(3)
    return f"{last_status}(timeout)"


def collect_metrics(db_path: str, turn_id: str) -> dict:
    """Query sqlite for turn metrics."""
    metrics = {
        "agent_runs": 0,
        "total_events": 0,
        "activity_events": 0,
        "browser_actions": 0,
        "delta_count": 0,
        "tool_events": 0,
        "terminal_status": "unknown",
        "model_used": "?",
        "provider_used": "?",
        "run_statuses": [],
        "event_sequence": [],
    }

    if not Path(db_path).exists():
        print(f"  [WARN] DB not found: {db_path}")
        return metrics

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # Agent runs
        rows = cur.execute(
            "SELECT run_id, status, model, provider, role, started_at, completed_at, terminal_reason "
            "FROM agent_runs WHERE turn_id = ? ORDER BY attempt",
            (turn_id,),
        ).fetchall()
        metrics["agent_runs"] = len(rows)
        if rows:
            last = rows[-1]
            metrics["model_used"] = last["model"] or "?"
            metrics["provider_used"] = last["provider"] or "?"
            metrics["run_statuses"] = [r["status"] for r in rows]
            # Terminal from last run
            if rows[-1]["status"] in ("completed", "failed", "cancelled"):
                metrics["terminal_status"] = rows[-1]["status"]

        # Turn events
        events = cur.execute(
            "SELECT seq, kind, payload_json, created_at FROM turn_events "
            "WHERE turn_id = ? ORDER BY seq",
            (turn_id,),
        ).fetchall()
        metrics["total_events"] = len(events)

        browser_emojis = ("🌐", "👁️", "📸", "🔎", "🖱️", "⌨️")
        for ev in events:
            kind = ev["kind"]
            payload = ev["payload_json"] or ""
            metrics["event_sequence"].append(kind)
            if kind == "activity":
                metrics["activity_events"] += 1
                if any(emo in payload for emo in browser_emojis):
                    metrics["browser_actions"] += 1
            elif kind == "delta":
                metrics["delta_count"] += 1
            elif kind == "tool":
                metrics["tool_events"] += 1
            elif kind in ("done", "error", "cancelled"):
                metrics["terminal_status"] = kind

        # Detect snapshot loops: consecutive delta/heartbeat with no activity/tool between
        loop_count = 0
        idle_streak = 0
        for kind in metrics["event_sequence"]:
            if kind in ("delta", "heartbeat", "reasoning"):
                idle_streak += 1
            else:
                if idle_streak >= 3:
                    loop_count += 1
                idle_streak = 0
        if idle_streak >= 3:
            loop_count += 1
        metrics["snapshot_loops"] = loop_count

        conn.close()
    except Exception as e:
        print(f"  [DB ERR] {e}")

    return metrics


def get_assistant_text(db_path: str, turn_id: str) -> str:
    """Try to extract the final assistant text from delta events."""
    if not Path(db_path).exists():
        return ""
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cur = conn.cursor()
        deltas = cur.execute(
            "SELECT payload_json FROM turn_events WHERE turn_id = ? AND kind = 'delta' ORDER BY seq",
            (turn_id,),
        ).fetchall()
        conn.close()
        # Concatenate delta text fragments
        parts = []
        for (pj,) in deltas:
            try:
                p = json.loads(pj)
                text = p.get("text", "") or p.get("content", "")
                if text:
                    parts.append(text)
            except json.JSONDecodeError:
                pass
        full = "".join(parts)
        return full[:500] if full else "(no text captured)"
    except Exception:
        return "(db read error)"


def run_model_comparison(
    base: str, token: str, models: list[str], provider_id: str,
    prompt: str, timeout: int,
):
    """Run the same prompt with different browser models and compare."""
    print("=" * 70)
    print("MODEL COMPARISON TEST")
    print(f"  Models   : {', '.join(models)}")
    print(f"  Provider : {provider_id}")
    print(f"  Prompt   : {prompt[:60]}...")
    print(f"  Timeout  : {timeout}s per model")
    print("=" * 70)

    # Backup providers.json
    backup = load_providers()
    original_browser = backup.get("roles", {}).get("browser", {}).copy()
    print(f"\n  Original browser role: {original_browser}")

    results = []
    thread_ids_to_clean = []

    try:
        for model in models:
            print(f"\n{'─' * 60}")
            print(f"  Testing model: {model}")
            print(f"{'─' * 60}")

            # Patch providers.json
            cfg = load_providers()
            if "roles" not in cfg:
                cfg["roles"] = {}
            cfg["roles"]["browser"] = {"provider_id": provider_id, "model": model}
            save_providers(cfg)
            print(f"  ✓ providers.json patched → browser={model}")
            time.sleep(1)  # let gateway reload

            # Create thread
            thread_id = create_thread(base, token)
            if not thread_id:
                print(f"  [FAIL] Cannot create thread")
                results.append({"model": model, "error": "thread creation failed"})
                continue
            thread_ids_to_clean.append(thread_id)
            print(f"  Thread: {thread_id}")

            # Submit turn
            request_id = str(uuid.uuid4())[:12]
            turn_id = submit_turn(base, token, thread_id, prompt, request_id)
            print(f"  Turn  : {turn_id}")

            # Wait
            t0 = time.time()
            print(f"  Waiting (max {timeout}s)...", end="", flush=True)
            status = poll_turn(base, token, turn_id, timeout)
            elapsed = time.time() - t0
            print(f" done ({elapsed:.1f}s, status={status})")

            # Collect metrics
            metrics = collect_metrics(DB_PATH, turn_id)
            assistant_text = get_assistant_text(DB_PATH, turn_id)

            result = {
                "model": model,
                "status": status,
                "elapsed_s": round(elapsed, 1),
                "agent_runs": metrics["agent_runs"],
                "activity_events": metrics["activity_events"],
                "browser_actions": metrics["browser_actions"],
                "tool_events": metrics["tool_events"],
                "total_events": metrics["total_events"],
                "snapshot_loops": metrics.get("snapshot_loops", 0),
                "model_used": metrics["model_used"],
                "assistant_len": len(assistant_text),
                "assistant_preview": assistant_text[:120],
                "error": None,
            }
            results.append(result)
            print(f"  Runs={result['agent_runs']}  Activity={result['activity_events']}  "
                  f"BrowserAct={result['browser_actions']}  Tools={result['tool_events']}  "
                  f"Loops={result['snapshot_loops']}")

    except KeyboardInterrupt:
        print("\n\n  [INTERRUPTED] Restoring providers.json...")
    finally:
        # Always restore
        save_providers(backup)
        print(f"\n  ✓ providers.json restored to original")

        # Clean up threads
        for tid in thread_ids_to_clean:
            delete_thread(base, token, tid)
        print(f"  ✓ Cleaned up {len(thread_ids_to_clean)} threads")

    # Print comparison table
    print("\n\n" + "=" * 70)
    print("COMPARISON TABLE")
    print("=" * 70)

    if not results:
        print("  No results collected.")
        return

    # Header
    hdr = f"{'Model':<22} {'Status':<16} {'Time':>6} {'Runs':>5} {'Act':>5} {'Brs':>5} {'Tool':>5} {'Loop':>5} {'Txt#':>5}"
    print(hdr)
    print("-" * len(hdr))
    for r in results:
        if r.get("error"):
            print(f"{r['model']:<22} ERROR: {r['error']}")
            continue
        print(
            f"{r['model']:<22} {r['status']:<16} {r['elapsed_s']:>5.1f}s "
            f"{r['agent_runs']:>5} {r['activity_events']:>5} {r['browser_actions']:>5} "
            f"{r['tool_events']:>5} {r['snapshot_loops']:>5} {r['assistant_len']:>5}"
        )

    # Diagnostics
    print("\n" + "-" * 70)
    print("DIAGNOSIS HINTS:")
    for r in results:
        if r.get("error"):
            continue
        loops = r.get("snapshot_loops", 0)
        brs = r.get("browser_actions", 0)
        if loops > 0 and brs == 0:
            print(f"  {r['model']}: ⚠️  {loops} snapshot loop(s) + 0 browser actions → MODEL ISSUE (loop without acting)")
        elif brs > 0 and r["status"] in ("completed",):
            print(f"  {r['model']}: ✓  Browser actions completed successfully")
        elif r["status"] in ("failed", "error", "cancelled"):
            print(f"  {r['model']}: ✗  Terminal status={r['status']} → check logs")
        elif loops == 0 and brs == 0:
            print(f"  {r['model']}: ?  No loops, no actions → model may not be using browser tools at all")
        else:
            print(f"  {r['model']}: ~  Mixed signals, inspect events manually")
    print("-" * 70)


# ── Main ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Browser isolation diagnostic tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--cdp-only", action="store_true", help="Test CDP only (no models)")
    parser.add_argument("--cdp-url", default="http://127.0.0.1:9222", help="CDP base URL")
    parser.add_argument("--gateway", default="http://127.0.0.1:18765", help="Gateway base URL")
    parser.add_argument("--models", default="minimax-m3,deepseek-v4-pro",
                        help="Comma-separated model list for comparison")
    parser.add_argument("--provider", default=None,
                        help="Provider ID for browser role (default: current from providers.json)")
    parser.add_argument("--prompt", default=BROWSER_PROMPT, help="Prompt for model comparison")
    parser.add_argument("--timeout", type=int, default=120, help="Timeout per model (seconds)")
    args = parser.parse_args()

    if args.cdp_only:
        run_cdp_test(args.cdp_url)
        return

    # Model comparison mode
    token = read_token()
    if not token:
        print("ERROR: cannot read gateway token from", TOKEN_PATH)
        sys.exit(1)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    if len(models) < 1:
        print("ERROR: provide at least 1 model with --models")
        sys.exit(1)

    provider_id = args.provider
    if not provider_id:
        cfg = load_providers()
        provider_id = cfg.get("roles", {}).get("browser", {}).get("provider_id", "")
        if not provider_id:
            print("ERROR: no provider_id in providers.json roles.browser, use --provider")
            sys.exit(1)

    run_model_comparison(args.gateway, token, models, provider_id, args.prompt, args.timeout)


if __name__ == "__main__":
    main()
