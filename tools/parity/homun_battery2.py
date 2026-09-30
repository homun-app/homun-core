#!/usr/bin/env python3
"""Batteria parity Homun (pomeriggio): core, agente-file, curatore, delivery cron→chat."""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8765"
H = {"X-Homun-Actor-Id": "person_fabio", "Content-Type": "application/json"}
IMAGE = "sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
TAG = str(int(time.time()))[-6:]


def req(method, path, body=None, timeout=180):
    r = urllib.request.Request(BASE + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers=H)
    return json.load(urllib.request.urlopen(r, timeout=timeout))


def cmd(cid, kind, payload):
    return req("POST", "/v1/workspaces/ws_local/commands",
               {"command_id": f"{cid}-{TAG}", "type": kind, "payload": payload})["result"]


def work_version(work):
    items = req("GET", "/v1/workspaces/ws_local/works")["items"]
    return next(x for x in items if x["id"] == work)["version"]


def ensure_agent(cid, name, fields=None):
    """Riusa l'agente attivo con quel nome; crea solo se manca (niente duplicati)."""
    for a in req("GET", "/v1/workspaces/ws_local/agents")["items"]:
        if a["name"].casefold() == name.casefold() and a["status"] != "retired":
            return a["id"]
    return cmd(cid, "agent.create", {"name": name, **(fields or {})})["agent_id"]


def wait_run(work, run_id, timeout=360):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        runs = req("GET", f"/v1/workspaces/ws_local/works/{work}/agent-runs")["items"]
        run = next(x for x in runs if x["id"] == run_id)
        if run["status"] in ("completed", "failed", "waiting_input"):
            return run
        for j in req("GET", f"/v1/workspaces/ws_local/works/{work}/terminal-jobs")["items"]:
            if j.get("status") == "pending_approval":
                req("POST", f"/v1/workspaces/ws_local/works/{work}/terminal-jobs/{j['id']}/approve",
                    {"digest": j["digest"]})
        for e in req("GET", f"/v1/workspaces/ws_local/works/{work}/file-edits")["items"]:
            if e.get("status") == "pending_approval":
                req("POST", f"/v1/workspaces/ws_local/works/{work}/file-edits/{e['id']}/approve",
                    {"digest": e["digest"]})
        time.sleep(3)
    raise TimeoutError(run_id)


results = {}

print("=== T1 core loop ===")
t0 = time.monotonic()
conv = cmd("b2-conv", "conversation.create", {"title": "Battery2"})["conversation_id"]
msg = req("POST", "/v1/workspaces/ws_local/commands", {
    "command_id": f"b2-msg-{TAG}", "type": "conversation.post_message",
    "payload": {"conversation_id": conv, "text": "Rispondi solo con la parola OK"}})["result"]
results["t1_reply_ok"] = msg["assistant_text"].strip().upper().startswith("OK")
results["t1_seconds"] = round(time.monotonic() - t0, 1)
print(f"reply: {msg['assistant_text'][:60]!r} in {results['t1_seconds']}s")

print("=== T2 agente crea file (auto-approve agente autonomo) ===")
agent = ensure_agent("b2-agent", "Beta", {"autonomy_mode": "autonomous"})
work = cmd("b2-work", "work.create", {"conversation_id": conv, "title": "T2 file",
    "objective": "Create a file named parity_test.txt in your workspace with the exact content "
                 "hello parity, then report the path. One write, then finish. No questions."})["work_id"]
cmd("b2-plan", "plan.propose", {"work_id": work, "expected_version": work_version(work),
    "steps": [{"title": "Esegui", "assignee_id": agent, "capability": "agent_run"}]})
cmd("b2-plan2", "plan.accept", {"work_id": work, "expected_version": work_version(work)})
run = req("POST", f"/v1/workspaces/ws_local/works/{work}/agent-runs",
          {"command_id": f"b2-run-{TAG}", "expected_version": work_version(work),
           "material_ids": [], "terminal_image": IMAGE})
req("POST", f"/v1/workspaces/ws_local/works/{work}/agent-runs/{run['id']}/approve",
    {"command_id": f"b2-ap-{TAG}", "expected_version": run["expected_version"], "digest": run["digest"]})
t0 = time.monotonic()
finished = wait_run(work, run["id"])
auto_gates = 0  # count gates we did NOT have to approve manually
results["t2_status"] = finished["status"]
results["t2_seconds"] = round(time.monotonic() - t0, 1)
obs = json.dumps(finished.get("observations") or [], ensure_ascii=False)
results["t2_file_written"] = "parity_test.txt" in obs and "applied" in obs
print(f"run: {finished['status']} in {results['t2_seconds']}s | edit applicato: {results['t2_file_written']}")

print("=== Curatore live (pass forzata) ===")
curation = req("POST", "/v1/workspaces/ws_local/skills/curate")
results["curator_report"] = {k: curation.get(k) for k in ("archived", "archived_staged", "archived_unused")}
print("curatore:", results["curator_report"])

print("=== Cron delivery → chat (fire forzato) ===")
dconv = cmd("b2-dconv", "conversation.create", {"title": "Cron out"})["conversation_id"]
dwork = cmd("b2-dwork", "work.create", {"conversation_id": dconv, "title": "Deliver target",
    "objective": "riceve i deliver"})["work_id"]
from datetime import datetime, timedelta, timezone
due_at = (datetime.now(timezone.utc) + timedelta(seconds=8)).isoformat()
job = req("POST", "/v1/cron/jobs", {
    "schedule": f"at {due_at}", "prompt": f"Scrivi esattamente: BATTERY2-CRON-OK-{TAG}", "repeat": 1,
    "deliver": "chat", "auto_approve": True, "source_work_id": dwork})["job"]
print(f"job creato: {job['id']} deliver={job['deliver']} auto_approve={job['auto_approve']}")
# forza il fire dei job dovuti (il job e' appena creato, next_run nel futuro:
# usiamo fire-due che processa i claim disponibili)
fired = req("POST", "/v1/cron/fire-due", {"workspace_id": "ws_local", "limit": 5})
print("fire-due:", json.dumps(fired, ensure_ascii=False)[:200])
# aspetta la delivery (pump ~0.5s) e verifica
sent = False
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    deliveries = req("GET", "/v1/cron/deliveries?workspace_id=ws_local")["deliveries"]
    mine = [d for d in deliveries if d.get("job_id") == job["id"]]
    if mine:
        newest = mine[-1]
        print("delivery:", newest.get("status"), newest.get("error_code") or "")
        sent = newest.get("status") == "sent"
        break
    time.sleep(3)
results["cron_delivery_sent"] = sent
msgs = req("GET", f"/v1/workspaces/ws_local/conversations/{dconv}/messages")["items"]
delivered_msg = any(f"BATTERY2-CRON-OK-{TAG}" in (m.get("text") or "") for m in msgs)
results["cron_message_in_conversation"] = delivered_msg
print(f"delivery sent: {sent} | messaggio in conversazione: {delivered_msg}")

print("=== ESITO ===")
print(json.dumps(results, ensure_ascii=False, indent=2))
sys.exit(0 if results["t1_reply_ok"] else 1)
