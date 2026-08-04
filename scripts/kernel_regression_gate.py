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
        Step("desktop cursor grammar", ["npm", "run", "test:cursor-grammar"], cwd=DESKTOP),
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
