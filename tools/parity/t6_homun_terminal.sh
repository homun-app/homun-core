#!/usr/bin/env bash
# T6 — Homun: terminal_execute with digest approval (H09).
# Exit 0 only when the run completes and HERMES-TERM-OK is observed.
set -euo pipefail
ENG="${HOMUN_ENGINE:-http://127.0.0.1:8765}"
WS="${HOMUN_WORKSPACE:-ws_local}"
ACT="${HOMUN_ACTOR:-person_fabio}"
IMAGE="${HOMUN_TERMINAL_IMAGE:-sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6}"
export ENG WS ACT IMAGE
python3 - <<'PY'
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ["ENG"].rstrip("/")
WS = os.environ["WS"]
ACTOR = os.environ["ACT"]
IMAGE = os.environ["IMAGE"]
H = {"X-Homun-Actor-Id": ACTOR, "Content-Type": "application/json"}
TAG = str(int(time.time()))
CMD = "echo HERMES-TERM-OK > term_test.txt"


def req(method: str, path: str, body=None, timeout: float = 180):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + path, method=method, data=data, headers=H)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc


def cmd(cid: str, kind: str, payload: dict):
    return req(
        "POST",
        f"/v1/workspaces/{WS}/commands",
        {"command_id": f"{cid}-{TAG}", "type": kind, "payload": payload},
    )["result"]


def work_version(work_id: str) -> int:
    items = req("GET", f"/v1/workspaces/{WS}/works")["items"]
    return next(item for item in items if item["id"] == work_id)["version"]


def ensure_agent(name: str) -> str:
    for agent in req("GET", f"/v1/workspaces/{WS}/agents")["items"]:
        if agent["name"].casefold() == name.casefold() and agent["status"] != "retired":
            return agent["id"]
    return cmd("t6-agent", "agent.create", {"name": name, "autonomy_mode": "autonomous"})["agent_id"]


def approve_pending(work_id: str) -> None:
    for kind in ("terminal-jobs", "file-edits"):
        items = req("GET", f"/v1/workspaces/{WS}/works/{work_id}/{kind}")["items"]
        for item in items:
            if item.get("status") != "pending_approval":
                continue
            print(f"approving {kind} {item['id']}")
            req(
                "POST",
                f"/v1/workspaces/{WS}/works/{work_id}/{kind}/{item['id']}/approve",
                {"digest": item["digest"]},
            )


def wait_run(work_id: str, run_id: str, timeout: float = 360):
    deadline = time.monotonic() + timeout
    last = None
    poll = 0
    while time.monotonic() < deadline:
        poll += 1
        runs = req("GET", f"/v1/workspaces/{WS}/works/{work_id}/agent-runs")["items"]
        last = next(item for item in runs if item["id"] == run_id)
        status = last["status"]
        if status == "pending_approval":
            req(
                "POST",
                f"/v1/workspaces/{WS}/works/{work_id}/agent-runs/{run_id}/approve",
                {
                    "command_id": f"t6-ap-{TAG}-{poll}",
                    "expected_version": last["expected_version"],
                    "digest": last["digest"],
                },
            )
        else:
            approve_pending(work_id)
        print(f"poll {poll}: run={status}")
        if status in ("completed", "failed", "waiting_input"):
            return last
        time.sleep(3)
    raise TimeoutError(run_id if last is None else last["status"])


conv_path = "/tmp/parity_conv_id"
if not os.path.exists(conv_path):
    raise SystemExit("missing /tmp/parity_conv_id — create a conversation first")
conv_id = open(conv_path, encoding="utf-8").read().strip()
if not conv_id:
    raise SystemExit("empty /tmp/parity_conv_id")

agent = ensure_agent("Beta")
work = cmd(
    "t6-work",
    "work.create",
    {
        "conversation_id": conv_id,
        "title": "T6 terminal parity",
        "objective": (
            f"Use terminal_execute exactly once to run this exact command: {CMD}. "
            "Then report the exit code and finish."
        ),
    },
)["work_id"]
print(f"W={work}")
cmd(
    "t6-plan",
    "plan.propose",
    {
        "work_id": work,
        "expected_version": work_version(work),
        "steps": [{"title": "Esegui", "assignee_id": agent, "capability": "agent_run"}],
    },
)
cmd("t6-plan2", "plan.accept", {"work_id": work, "expected_version": work_version(work)})
run = req(
    "POST",
    f"/v1/workspaces/{WS}/works/{work}/agent-runs",
    {
        "command_id": f"t6-run-{TAG}",
        "expected_version": work_version(work),
        "material_ids": [],
        "terminal_image": IMAGE,
    },
)
print(f"run proposed {run['id']}")
req(
    "POST",
    f"/v1/workspaces/{WS}/works/{work}/agent-runs/{run['id']}/approve",
    {
        "command_id": f"t6-ap0-{TAG}",
        "expected_version": run["expected_version"],
        "digest": run["digest"],
    },
)
print(f"run approved {run['id']}")

finished = wait_run(work, run["id"])
obs = json.dumps(finished.get("observations") or [], ensure_ascii=False)
ok = (
    finished["status"] == "completed"
    and "terminal_execute" in obs
    and "HERMES-TERM-OK" in obs
)
print("status:", finished["status"], "turns:", finished.get("turns"))
for observation in (finished.get("observations") or [])[-3:]:
    print("--", observation.get("tool"), ":", json.dumps(observation.get("result"), ensure_ascii=False)[:200])
open("/tmp/parity_w6", "w", encoding="utf-8").write(f"W={work}\n")
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
