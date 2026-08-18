#!/usr/bin/env python3
"""Homun kernel regression gate.

Runs the deterministic checks that must stay green before closing regressions in
turn lifecycle, gateway steering, chat rendering, composer/runtime context, or
browser/activity UI. Live gateway/browser smoke is opt-in because it depends on
the current desktop runtime.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field


PYTHON = sys.executable or "python3"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESKTOP = os.path.join(ROOT, "apps", "desktop")


@dataclass(frozen=True)
class Step:
    label: str
    command: list[str]
    cwd: str = ROOT
    env: dict[str, str] = field(default_factory=dict)


def truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def build_plan(env: dict[str, str]) -> list[Step]:
    plan = [
        Step("rust format", ["cargo", "fmt", "--check"]),
        Step("gateway main ownership contract", [PYTHON, "scripts/check_gateway_main_contract.py"]),
        Step(
            "task runtime turn lifecycle",
            ["cargo", "test", "-p", "local-first-task-runtime", "turn_lifecycle"],
        ),
        Step(
            "task runtime turn reducer",
            [
                "cargo",
                "test",
                "-p",
                "local-first-task-runtime",
                "--test",
                "turn_reducer_contract",
            ],
        ),
        Step(
            "turn consistency audit unit tests",
            [PYTHON, "-m", "unittest", "scripts.test_audit_turn_consistency", "-v"],
        ),
        Step("kernel projection smoke", [PYTHON, "scripts/smoke_kernel_projection.py"]),
        Step(
            "browser diagnostic contract",
            [PYTHON, "-m", "unittest", "scripts.test_e2e_browser_diagnostic", "-v"],
        ),
        Step(
            "engine browser grounded fallback",
            [
                "cargo",
                "test",
                "-p",
                "local-first-engine",
                "browser_exhaustion_with_grounded_partial_result_delivers_that_evidence",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "task runtime active chat turn",
            ["cargo", "test", "-p", "local-first-task-runtime", "active_chat_turn"],
        ),
        Step(
            "task runtime finalizing fence",
            ["cargo", "test", "-p", "local-first-task-runtime", "finalizing"],
        ),
        Step(
            "task runtime enqueue",
            ["cargo", "test", "-p", "local-first-task-runtime", "enqueue_"],
        ),
        Step(
            "gateway boot maintenance",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_boot_maintenance",
            ],
        ),
        Step(
            "gateway background startup",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_background_startup",
            ],
        ),
        Step(
            "gateway turn recovery",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_turn_recovery",
            ],
        ),
        Step(
            "gateway routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_routes",
            ],
        ),
        Step(
            "gateway system status",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_system_status",
            ],
        ),
        Step(
            "gateway chat utility routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_chat_utility_routes",
            ],
        ),
        Step(
            "gateway recall context",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_recall_context",
            ],
        ),
        Step(
            "gateway proactivity",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_proactivity",
            ],
        ),
        Step(
            "gateway proactivity routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_proactivity_routes",
            ],
        ),
        Step(
            "gateway vault routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "vault_",
            ],
        ),
        Step(
            "gateway task maintenance",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_task_maintenance",
            ],
        ),
        Step(
            "gateway memory background",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_background",
            ],
        ),
        Step(
            "gateway memory bench",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "memorybench",
            ],
        ),
        Step(
            "gateway memory UI routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_ui_routes",
            ],
        ),
        Step(
            "gateway remote approval",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_remote_approval",
            ],
        ),
        Step(
            "gateway plugins",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_plugins",
            ],
        ),
        Step(
            "gateway plugin packages",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_plugin_packages",
            ],
        ),
        Step(
            "gateway chat threads",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_chat_threads",
            ],
        ),
        Step(
            "gateway chat branches",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_chat_branches",
            ],
        ),
        Step(
            "gateway chat tasks",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_chat_tasks",
            ],
        ),
        Step(
            "gateway chat memory",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_chat_memory",
            ],
        ),
        Step(
            "gateway memory dedup",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_dedup",
            ],
        ),
        Step(
            "gateway memory query embeddings",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_query_embeddings",
            ],
        ),
        Step(
            "gateway memory briefing",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_briefing",
            ],
        ),
        Step(
            "gateway memory turn context",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_turn_context",
            ],
        ),
        Step(
            "gateway memory clients",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_clients",
            ],
        ),
        Step(
            "gateway memory recall service",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_recall_service",
            ],
        ),
        Step(
            "gateway memory graph",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_graph",
            ],
        ),
        Step(
            "gateway memory graph routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_graph_routes",
            ],
        ),
        Step(
            "gateway memory graph maintenance",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_graph_maintenance",
            ],
        ),
        Step(
            "gateway memory graph persistence",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_graph_persistence",
            ],
        ),
        Step(
            "gateway memory tools",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_tools",
            ],
        ),
        Step(
            "gateway plan tools",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_plan_tools",
            ],
        ),
        Step(
            "gateway plan stall",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "plan_stall",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway tool budget",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_tool_budget",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway tool timeouts",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_tool_timeouts",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway action confirmations",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_action_confirmations",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway local authorization routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_local_authorization_routes",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway Composio routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_composio_routes",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway connector errors",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_connector_errors",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway MCP chat tools",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_mcp_chat_tools",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway MCP runtime",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_mcp_runtime",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway MCP connections",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_mcp_connections",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway MCP execution",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_mcp_execution",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway write-tool allowlist",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_write_tool_allowlist",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway thread files",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_thread_files",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway file security",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_file_security",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway transcription",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_transcription",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway usage routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_usage_routes",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway tags",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_tags",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway update routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_update_routes",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway project access",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "project_access",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway workspaces",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "workspace",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway skill routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_skill_routes",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway memory publications",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "memory_publication",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway memory sources",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "memory_source",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway task executor",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_task_executor",
            ],
        ),
        Step(
            "gateway capability registry",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "gateway_capability_registry",
                "--",
                "--nocapture",
            ],
        ),
        Step(
            "gateway capability routing",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_capability_routing",
            ],
        ),
        Step(
            "gateway chat markers",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_chat_markers",
            ],
        ),
        Step(
            "gateway project search tools",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_project_search_tools",
            ],
        ),
        Step(
            "gateway datetime tools",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_datetime_tools",
            ],
        ),
        Step(
            "gateway runtime flags",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_runtime_flags",
            ],
        ),
        Step(
            "gateway runtime settings",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_runtime_settings",
            ],
        ),
        Step(
            "gateway prompt instructions",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_prompt_instructions",
            ],
        ),
        Step(
            "gateway automation tools",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_automation_tools",
            ],
        ),
        Step(
            "gateway automation formatting",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_automation_formatting",
            ],
        ),
        Step(
            "gateway automation requests",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_automation_requests",
            ],
        ),
        Step(
            "gateway automation routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_automation_routes",
            ],
        ),
        Step(
            "gateway main tests owner",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_main_tests_owner_smoke",
            ],
        ),
        Step(
            "gateway template catalog",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_template_catalog",
            ],
        ),
        Step(
            "gateway project files",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_project_files",
            ],
        ),
        Step(
            "gateway project graph routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_project_graph_routes",
            ],
        ),
        Step(
            "gateway browser tools",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_browser_tools",
            ],
        ),
        Step(
            "gateway browser runtime",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_browser_runtime",
            ],
        ),
        Step(
            "gateway deliverables",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_deliverables",
            ],
        ),
        Step(
            "gateway model routing",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_model_routing",
            ],
        ),
        Step(
            "gateway model routes",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_model_routes",
            ],
        ),
        Step(
            "gateway tool execution",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_tool_execution",
            ],
        ),
        Step(
            "gateway channels",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_channels",
            ],
        ),
        Step(
            "gateway memory hygiene",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_hygiene",
            ],
        ),
        Step(
            "gateway artifact memory",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_artifact_memory",
            ],
        ),
        Step(
            "gateway artifacts",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_artifacts",
            ],
        ),
        Step(
            "gateway memory wiki",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_memory_wiki",
            ],
        ),
        Step(
            "gateway steering cleanup",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "steering",
            ],
        ),
        Step(
            "gateway turn broker heartbeat",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_turn_broker",
            ],
        ),
        Step(
            "model error mapping",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "model_error_mapping",
            ],
        ),
        Step(
            "extended health endpoint",
            [
                "cargo",
                "test",
                "-p",
                "local-first-desktop-gateway",
                "--bin",
                "local-first-desktop-gateway",
                "gateway_health",
            ],
        ),
        Step(
            "engine plan-before-act gate",
            [
                "cargo",
                "test",
                "-p",
                "local-first-engine",
                "plan_gate",
            ],
        ),
        Step(
            "engine replan nudge on stall",
            [
                "cargo",
                "test",
                "-p",
                "local-first-engine",
                "replan_nudge",
            ],
        ),
        Step(
            "engine forced replan on consecutive failures",
            [
                "cargo",
                "test",
                "-p",
                "local-first-engine",
                "forced_replan",
            ],
        ),
        Step(
            "process manager restart policy",
            [
                "cargo",
                "test",
                "-p",
                "local-first-process-manager",
                "restart_policy",
            ],
        ),
        Step("desktop unit tests", ["npm", "test"], cwd=DESKTOP),
        Step(
            "API contract validation",
            ["node", "--test", "tests/api-contract.test.mjs"],
            cwd=DESKTOP,
        ),
        Step(
            "planning state derivation",
            ["node", "--test", "src/lib/chat-runtime/planningState.test.mjs"],
            cwd=DESKTOP,
        ),
        Step(
            "plan step display derivation",
            ["node", "--test", "src/lib/chat-runtime/planStepDisplay.test.mjs"],
            cwd=DESKTOP,
        ),
        Step("desktop ui contract", ["npm", "run", "test:ui-contract"], cwd=DESKTOP),
        Step("desktop build", ["npm", "run", "build"], cwd=DESKTOP),
    ]
    if truthy(env.get("HOMUN_RUN_KERNEL_LIVE_SMOKE")):
        gateway_base = env.get("HOMUN_GATEWAY_BASE", "http://127.0.0.1:18765")
        smoke_env = {
            key: env[key]
            for key in ("HOMUN_DESKTOP_GATEWAY_TOKEN", "HOMUN_EVAL_GATEWAY_TOKEN")
            if key in env
        }
        plan.append(
            Step(
                "live gateway browser smoke",
                [PYTHON, "scripts/kernel_live_smoke.py", "--gateway-base", gateway_base],
                env=smoke_env,
            )
        )
    return plan


def run_step(step: Step) -> bool:
    print(f"== {step.label} ==", flush=True)
    start = time.time()
    merged_env = os.environ.copy()
    merged_env.update(step.env)
    result = subprocess.run(step.command, cwd=step.cwd, env=merged_env, check=False)
    elapsed = time.time() - start
    status = "PASS" if result.returncode == 0 else "FAIL"
    print(f"== {step.label}: {status} ({elapsed:.0f}s) ==", flush=True)
    return result.returncode == 0


def run_plan(plan: list[Step], runner=run_step) -> bool:
    for step in plan:
        if not runner(step):
            return False
    return True


def print_plan(plan: list[Step]) -> None:
    for index, step in enumerate(plan, start=1):
        rel_cwd = os.path.relpath(step.cwd, ROOT)
        print(f"{index}. {step.label}: {' '.join(step.command)} [{rel_cwd}]")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="Print the planned checks and exit")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    plan = build_plan(os.environ)
    print("== Homun kernel regression gate ==", flush=True)
    print_plan(plan)
    if args.list:
        return 0
    ok = run_plan(plan)
    print(f"== {'ALL GREEN' if ok else 'FAILURES'} ==", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
