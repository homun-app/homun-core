#!/usr/bin/env python3
"""Homun parity battery: core chat, agent file, curator, cron→chat delivery."""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "http://127.0.0.1:8765"
H = {"X-Homun-Actor-Id": "person_fabio", "Content-Type": "application/json"}
IMAGE = "sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
TAG = str(int(time.time()))[-6:]


def req(method, path, body=None, timeout=180):
    request = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers=H,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc


def cmd(cid, kind, payload):
    return req(
        "POST",
        "/v1/workspaces/ws_local/commands",
        {"command_id": f"{cid}-{TAG}", "type": kind, "payload": payload},
    )["result"]


def work_version(work):
    items = req("GET", "/v1/workspaces/ws_local/works")["items"]
    return next(item for item in items if item["id"] == work)["version"]


def ensure_agent(cid, name, fields=None):
    """Reuse the active agent with that name; create only when missing."""
    for agent in req("GET", "/v1/workspaces/ws_local/agents")["items"]:
        if agent["name"].casefold() == name.casefold() and agent["status"] != "retired":
            return agent["id"]
    return cmd(cid, "agent.create", {"name": name, **(fields or {})})["agent_id"]


def wait_run(work, run_id, timeout=360):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        runs = req("GET", f"/v1/workspaces/ws_local/works/{work}/agent-runs")["items"]
        run = next(item for item in runs if item["id"] == run_id)
        if run["status"] in ("completed", "failed", "waiting_input"):
            return run
        for job in req("GET", f"/v1/workspaces/ws_local/works/{work}/terminal-jobs")["items"]:
            if job.get("status") == "pending_approval":
                req(
                    "POST",
                    f"/v1/workspaces/ws_local/works/{work}/terminal-jobs/{job['id']}/approve",
                    {"digest": job["digest"]},
                )
        for edit in req("GET", f"/v1/workspaces/ws_local/works/{work}/file-edits")["items"]:
            if edit.get("status") == "pending_approval":
                req(
                    "POST",
                    f"/v1/workspaces/ws_local/works/{work}/file-edits/{edit['id']}/approve",
                    {"digest": edit["digest"]},
                )
        time.sleep(3)
    raise TimeoutError(run_id)


def wait_assistant(conv_id, after_count, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        items = req("GET", f"/v1/workspaces/ws_local/conversations/{conv_id}/messages")["items"]
        if len(items) > after_count:
            for message in reversed(items):
                if message.get("author_id") != "person_fabio":
                    return message
        time.sleep(1.5)
    raise TimeoutError(f"no assistant reply on {conv_id}")


results = {}

print("=== T1 core loop ===")
t0 = time.monotonic()
conv = cmd("b2-conv", "conversation.create", {"title": "Battery2"})["conversation_id"]
posted = req(
    "POST",
    "/v1/workspaces/ws_local/commands",
    {
        "command_id": f"b2-msg-{TAG}",
        "type": "conversation.post_message",
        "payload": {"conversation_id": conv, "text": "Rispondi solo con la parola OK"},
    },
)["result"]
results["t1_post_shape"] = sorted(posted.keys())
assistant = wait_assistant(conv, after_count=1)
text = (assistant.get("text") or "").strip()
results["t1_reply_ok"] = text.upper().startswith("OK")
results["t1_seconds"] = round(time.monotonic() - t0, 1)
print(f"reply: {text[:60]!r} in {results['t1_seconds']}s")

print("=== T2 agent creates file (autonomous assignee) ===")
agent = ensure_agent("b2-agent", "Beta", {"autonomy_mode": "autonomous"})
work = cmd(
    "b2-work",
    "work.create",
    {
        "conversation_id": conv,
        "title": "T2 file",
        "objective": (
            "Create a file named parity_test.txt in your workspace with the exact content "
            "hello parity, then report the path. One write, then finish. No questions."
        ),
    },
)["work_id"]
cmd(
    "b2-plan",
    "plan.propose",
    {
        "work_id": work,
        "expected_version": work_version(work),
        "steps": [{"title": "Esegui", "assignee_id": agent, "capability": "agent_run"}],
    },
)
cmd("b2-plan2", "plan.accept", {"work_id": work, "expected_version": work_version(work)})
run = req(
    "POST",
    f"/v1/workspaces/ws_local/works/{work}/agent-runs",
    {
        "command_id": f"b2-run-{TAG}",
        "expected_version": work_version(work),
        "material_ids": [],
        "terminal_image": IMAGE,
    },
)
req(
    "POST",
    f"/v1/workspaces/ws_local/works/{work}/agent-runs/{run['id']}/approve",
    {
        "command_id": f"b2-ap-{TAG}",
        "expected_version": run["expected_version"],
        "digest": run["digest"],
    },
)
t0 = time.monotonic()
finished = wait_run(work, run["id"])
results["t2_status"] = finished["status"]
results["t2_seconds"] = round(time.monotonic() - t0, 1)
obs = json.dumps(finished.get("observations") or [], ensure_ascii=False)
results["t2_file_written"] = "parity_test.txt" in obs and "applied" in obs
print(
    f"run: {finished['status']} in {results['t2_seconds']}s | "
    f"edit applied: {results['t2_file_written']}"
)

print("=== Curator live (forced pass) ===")
curation = req("POST", "/v1/workspaces/ws_local/skills/curate")
results["curator_report"] = {
    k: curation.get(k) for k in ("archived", "archived_staged", "archived_unused")
}
print("curator:", results["curator_report"])

print("=== Cron delivery → chat ===")
# Agent cron jobs stage a run, then reconcile → delivery. fire-due count may be 0
# if the lifecycle pump already claimed the due job — that is not a failure by itself.
dconv = cmd("b2-dconv", "conversation.create", {"title": "Cron out"})["conversation_id"]
dwork = cmd(
    "b2-dwork",
    "work.create",
    {"conversation_id": dconv, "title": "Deliver target", "objective": "riceve i deliver"},
)["work_id"]
due_at = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()
marker = f"BATTERY2-CRON-OK-{TAG}"
job = req(
    "POST",
    "/v1/cron/jobs",
    {
        "schedule": f"at {due_at}",
        "prompt": f"Scrivi esattamente: {marker}",
        "repeat": 1,
        "deliver": "chat",
        "auto_approve": True,
        "source_work_id": dwork,
    },
)["job"]
print(
    f"job created: {job['id']} deliver={job['deliver']} "
    f"auto_approve={job['auto_approve']} next_run_at={job.get('next_run_at')}"
)
# Wait until the one-shot is due, then nudge fire-due (pump may already have won).
while time.time() < float(job["next_run_at"]) + 0.5:
    time.sleep(0.25)
fired = req("POST", "/v1/cron/fire-due", {"workspace_id": "ws_local", "limit": 5})
results["cron_fire_due"] = {"count": fired.get("count"), "results": fired.get("results")}
print("fire-due:", json.dumps(results["cron_fire_due"], ensure_ascii=False)[:240])

sent = False
delivery_status = None
deadline = time.monotonic() + 180
while time.monotonic() < deadline:
    deliveries = req("GET", "/v1/cron/deliveries?workspace_id=ws_local")["deliveries"]
    mine = [row for row in deliveries if row.get("job_id") == job["id"]]
    if mine:
        newest = mine[-1]
        delivery_status = newest.get("status")
        print("delivery:", delivery_status, newest.get("error_code") or "")
        sent = delivery_status == "sent"
        if delivery_status in ("sent", "failed"):
            break
    time.sleep(3)
results["cron_delivery_sent"] = sent
results["cron_delivery_status"] = delivery_status
msgs = req("GET", f"/v1/workspaces/ws_local/conversations/{dconv}/messages")["items"]
delivered_msg = any(marker in (message.get("text") or "") for message in msgs)
results["cron_message_in_conversation"] = delivered_msg
print(f"delivery sent: {sent} | message in conversation: {delivered_msg}")

print("=== RESULT ===")
print(json.dumps(results, ensure_ascii=False, indent=2))
ok = (
    results["t1_reply_ok"]
    and results.get("t2_status") == "completed"
    and results.get("t2_file_written")
    and results.get("cron_delivery_sent")
    and results.get("cron_message_in_conversation")
)
sys.exit(0 if ok else 1)
