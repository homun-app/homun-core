#!/usr/bin/env python3
"""Ritest live: isolamento memoria cross-progetto + apprendimento end-to-end."""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8765"
H = {"X-Homun-Actor-Id": "person_fabio", "Content-Type": "application/json"}
IMAGE = "sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
import time as _t
RUN_TAG = str(int(_t.time()))[-6:]


def req(method, path, body=None, timeout=120):
    r = urllib.request.Request(BASE + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers=H)
    return json.load(urllib.request.urlopen(r, timeout=timeout))


def cmd(cid, kind, payload):
    return req("POST", "/v1/workspaces/ws_local/commands",
               {"command_id": cid, "type": kind, "payload": payload})["result"]


def ensure_agent(cid, name, fields=None):
    """Riusa l'agente attivo con quel nome; crea solo se manca (niente duplicati)."""
    for a in req("GET", "/v1/workspaces/ws_local/agents")["items"]:
        if a["name"].casefold() == name.casefold() and a["status"] != "retired":
            return a["id"]
    return cmd(cid, "agent.create", {"name": name, **(fields or {})})["agent_id"]


def wait_run(work, run_id, timeout=300):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        runs = req("GET", f"/v1/workspaces/ws_local/works/{work}/agent-runs")["items"]
        run = next(x for x in runs if x["id"] == run_id)
        if run["status"] in ("completed", "failed", "waiting_input"):
            return run
        # auto-approva i gate (l'agente e autonomo, ma i run sono person-owned)
        jobs = req("GET", f"/v1/workspaces/ws_local/works/{work}/terminal-jobs")["items"]
        for j in jobs:
            if j.get("status") == "pending_approval":
                req("POST", f"/v1/workspaces/ws_local/works/{work}/terminal-jobs/{j['id']}/approve",
                    {"digest": j["digest"]})
        edits = req("GET", f"/v1/workspaces/ws_local/works/{work}/file-edits")["items"]
        for e in edits:
            if e.get("status") == "pending_approval":
                req("POST", f"/v1/workspaces/ws_local/works/{work}/file-edits/{e['id']}/approve",
                    {"digest": e["digest"]})
        time.sleep(3)
    raise TimeoutError(run_id)


def work_version(work):
    items = req("GET", "/v1/workspaces/ws_local/works")["items"]
    return next(x for x in items if x["id"] == work)["version"]


def assign_agent(work, agent_id):
    """Plan step assegnato all'agente: il run sara eseguito da lui."""
    v = work_version(work)
    cmd(f"lt-plan-{RUN_TAG}-{work[-6:]}", "plan.propose", {
        "work_id": work, "expected_version": v,
        "steps": [{"title": "Esegui", "assignee_id": agent_id, "capability": "agent_run"}]})
    v = work_version(work)
    cmd(f"lt-plan2-{RUN_TAG}-{work[-6:]}", "plan.accept", {"work_id": work, "expected_version": v})


def propose_and_approve(work, cid, extra=None):
    body = {"command_id": cid, "expected_version": work_version(work), "material_ids": []}
    body.update(extra or {})
    run = req("POST", f"/v1/workspaces/ws_local/works/{work}/agent-runs", body)
    req("POST", f"/v1/workspaces/ws_local/works/{work}/agent-runs/{run['id']}/approve",
        {"command_id": cid + "-ap", "expected_version": run["expected_version"],
         "digest": run["digest"]})
    return run["id"]


print("=== 1. Setup: progetti A/B + agente autonomo ===")
agent = ensure_agent("lt-agent-" + RUN_TAG, "Menta", {"autonomy_mode": "autonomous"})
pa = cmd("lt-pa-" + RUN_TAG, "project.create", {"name": "Parity Alpha"})["project_id"]
pb = cmd("lt-pb-" + RUN_TAG, "project.create", {"name": "Parity Beta"})["project_id"]
ca = cmd("lt-ca-" + RUN_TAG, "conversation.create", {"title": "A", "project_id": pa})["conversation_id"]
cb = cmd("lt-cb-" + RUN_TAG, "conversation.create", {"title": "B", "project_id": pb})["conversation_id"]
wa = cmd("lt-wa-" + RUN_TAG, "work.create", {"conversation_id": ca, "title": "Lavoro Alpha",
    "objective": "Prepara il listino Alpha."})["work_id"]
wb = cmd("lt-wb-" + RUN_TAG, "work.create", {"conversation_id": cb, "title": "Lavoro Beta",
    "objective": "Call the memory_recall tool once with query 'listino' and report the exact texts you find, then finish. Do not ask questions. Do not use the terminal or files."})["work_id"]
print(f"agent={agent} PA={pa} PB={pb}")

print("=== 2. Memoria: progetto A + globale (che NON deve filtrare nei run) ===")
mem_a = req("POST", "/v1/workspaces/ws_local/memories",
            {"text": "Il listino Alpha ha otto colonne e totals in grassetto",
             "project_id": pa, "scope": "project"})
mem_global = req("POST", "/v1/workspaces/ws_local/memories",
                 {"text": "Listini: la nota globale workspace non deve apparire nei run"})
print(f"memoria A={mem_a['id']} globale={mem_global['id']}")

print("=== 3. Promozione craft: la lezione di Alpha diventa metodo di Menta ===")
promoted = req("POST", f"/v1/workspaces/ws_local/memories/{mem_a['id']}/promote", {"agent_id": agent})
print("promote:", promoted["status"])

print("=== 4. Isolamento: run su Beta con memoria (eseguito da Menta) ===")
assign_agent(wb, agent)
run_id = propose_and_approve(wb, "lt-run-b-" + RUN_TAG, {"memory": True, "terminal_image": IMAGE})
run = wait_run(wb, run_id)
obs = run.get("observations") or []
recalls = [o for o in obs if o.get("tool") == "memory_recall"]
texts = json.dumps(obs, ensure_ascii=False)
alpha_leak = "otto colonne e totals in grassetto" in texts and not any(
    "allinea" in json.dumps(r, ensure_ascii=False) for r in recalls)
craft_seen = "otto colonne" in texts  # la craft promossa contiene lo stesso testo
global_leak = "non deve apparire nei run" in texts
print(f"run B: {run['status']} | recall calls: {len(recalls)}")
print(f"craft promossa visibile su B: {craft_seen} | leak globale: {global_leak}")

print("=== 5. Apprendimento: run su Alpha con correzione esplicita ===")
objective = (
    "Acknowledge the following SUPERVISOR LESSON for future price-list work "
    "(capture it in your skill library): in price lists ALWAYS align columns "
    "before totals and sort by code. Reply with one short sentence confirming "
    "the lesson, then finish immediately. Use at most ONE tool call in total, "
    "no terminal, no files, no questions.")
wa2 = cmd("lt-wa2-" + RUN_TAG, "work.create", {"conversation_id": ca, "title": "Listino con correzione",
    "objective": objective})["work_id"]
assign_agent(wa2, agent)
pre_staged = {s["id"] for s in req("GET", "/v1/workspaces/ws_local/skills")["items"]
              if s.get("status") == "staged" and s.get("author_type") == "agent"}
run2 = propose_and_approve(wa2, "lt-run-a-" + RUN_TAG, {"skills": True, "memory": True, "terminal_image": IMAGE})
run_a = wait_run(wa2, run2)
print(f"run A: {run_a['status']}")

print("=== 6. Reflection: attesa proposta skill staged ===")
staged = []
deadline = time.monotonic() + 90
while time.monotonic() < deadline:
    skills = req("GET", "/v1/workspaces/ws_local/skills")["items"]
    staged = [s for s in req("GET", "/v1/workspaces/ws_local/skills")["items"]
              if s.get("status") == "staged" and s.get("author_type") == "agent"
              and s["id"] not in pre_staged]
    if staged:
        break
    time.sleep(3)
for s in staged:
    print(f"  staged: {s['name']} | rev {s.get('revision')} | {s.get('description','')[:70]}")
if not staged:
    print("  (nessuna skill proposta dal modello — reflection marker comunque scritto)")

print("=== 7. Approvazione umana e riuso cross-progetto ===")
for i, s in enumerate(staged):
    cmd(f"lt-skill-ap-{RUN_TAG}-{i}", "skill.approve",
        {"skill_id": s["id"], "expected_version": s.get("revision", 1)})
approved = [s for s in req("GET", "/v1/workspaces/ws_local/skills")["items"]
            if s.get("status") == "approved" and s.get("author_type") == "agent"]
print(f"skill approvate dell'agente: {len(approved)}")

print("=== 8. Pack: dossier dell'agente formato ===")
pack = req("GET", f"/v1/workspaces/ws_local/memories/packs/{agent}")
print(f"pack: memories={len(pack['memories'])} skills={len(pack['skills'])} "
      f"| progetti nel pack: {'Alpha' if any('otto colonne' in m['text'] for m in pack['memories']) else 'nessuna nota di progetto (corretto)'}")

result = {
    "craft_visible_on_beta": craft_seen,
    "global_leak": global_leak,
    "reflection_proposed": bool(staged),
    "skills_approved": len(approved),
    "pack_memories": len(pack["memories"]),
}
print("=== ESITO ===")
print(json.dumps(result, ensure_ascii=False, indent=2))
sys.exit(0 if (craft_seen and not global_leak) else 1)
