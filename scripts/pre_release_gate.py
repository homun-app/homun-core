#!/usr/bin/env python3
"""Homun pre-release guardrail (WS8.3).

This script gathers the deterministic checks that must stay green before a
release candidate. Model/gateway evals are opt-in through environment variables
because they depend on local runtime state.

Usage:
  python3 scripts/pre_release_gate.py
  HOMUN_RUN_MODEL_EVAL=1 HOMUN_EVAL_MODEL=gemma4:latest HOMUN_EVAL_RUNS=1 \
    python3 scripts/pre_release_gate.py
  HOMUN_EVAL_GATEWAY_BASE=http://127.0.0.1:18765 \
    HOMUN_EVAL_GATEWAY_TOKEN="$(cat ~/.homun/desktop-gateway-token)" \
    python3 scripts/pre_release_gate.py
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
BROWSER_AUTOMATION = os.path.join(ROOT, "runtimes", "browser-automation")
MEMORYBENCH_PROVIDER = os.path.join(ROOT, "benchmarks", "memorybench", "homun-provider")
GATEWAY_EVAL_SNIPPET = (
    "import scripts.eval_suite as e; "
    "ok = e.run_gateway_checks(); "
    "raise SystemExit(0 if ok else 1)"
)


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
        Step("rust format", ["cargo", "fmt", "--all", "--", "--check"]),
        Step(
            "gateway main ownership contract",
            [PYTHON, "scripts/check_gateway_main_contract.py"],
        ),
        Step(
            "rust clippy",
            [
                "cargo",
                "clippy",
                "--workspace",
                "--all-targets",
                "--locked",
                "--",
                "-D",
                "warnings",
            ],
        ),
        Step(
            "desktop dependency install",
            ["npm", "ci"],
            cwd=DESKTOP,
        ),
        Step(
            "desktop dependency audit",
            ["npm", "audit", "--audit-level=high"],
            cwd=DESKTOP,
        ),
        Step(
            "browser automation dependency audit",
            ["npm", "audit", "--audit-level=high"],
            cwd=BROWSER_AUTOMATION,
        ),
        Step(
            "capability tests",
            ["cargo", "test", "-p", "local-first-capabilities", "--", "--nocapture"],
        ),
        Step("orchestrator tests", ["cargo", "test", "-p", "local-first-orchestrator", "--", "--nocapture"]),
        Step("task runtime tests", ["cargo", "test", "-p", "local-first-task-runtime", "--", "--nocapture"]),
        Step(
            "turn consistency audit unit tests",
            [PYTHON, "-m", "unittest", "scripts.test_audit_turn_consistency", "-v"],
        ),
        Step("kernel projection smoke", [PYTHON, "scripts/smoke_kernel_projection.py"]),
        Step("engine tests", ["cargo", "test", "-p", "local-first-engine", "--", "--nocapture"]),
        Step("gateway tests", ["cargo", "test", "-p", "local-first-desktop-gateway", "--", "--nocapture"]),
        Step("memorybench provider", ["npm", "test"], cwd=MEMORYBENCH_PROVIDER),
        Step("desktop unit tests", ["npm", "test"], cwd=DESKTOP),
        Step("ui contract", ["npm", "run", "test:ui-contract"], cwd=DESKTOP),
        Step("desktop build", ["npm", "run", "build"], cwd=DESKTOP),
        Step(
            "stability soak unit tests",
            [PYTHON, "-m", "unittest", "scripts.test_stability_soak", "-v"],
        ),
        Step(
            "eval unit tests",
            [
                PYTHON,
                "-m",
                "unittest",
                "scripts.test_eval_suite",
                "scripts.test_pre_release_gate",
                "scripts.test_kernel_regression_gate",
                "scripts.test_smoke_kernel_projection",
                "scripts.test_e2e_browser_diagnostic",
                "scripts.test_production_smoke",
                "scripts.test_audit_homun_state",
                "-v",
            ],
        ),
        Step("eval syntax", [PYTHON, "-m", "py_compile", "scripts/eval_suite.py"]),
        Step(
            "deck renderer tests",
            [PYTHON, "-m", "unittest", "discover", "-s",
             "runtimes/contained-computer", "-p", "test_deck_render.py"],
        ),
        Step(
            "doc renderer tests",
            [PYTHON, "-m", "unittest", "discover", "-s",
             "runtimes/contained-computer", "-p", "test_doc_render.py"],
        ),
    ]
    if truthy(env.get("HOMUN_RUN_MODEL_EVAL")):
        model = env.get("HOMUN_EVAL_MODEL", "gemma4:latest")
        runs = env.get("HOMUN_EVAL_RUNS", "1")
        plan.append(Step("model eval", [PYTHON, "scripts/eval_suite.py", model, runs]))
    if env.get("HOMUN_EVAL_GATEWAY_BASE"):
        gateway_env = {
            key: env[key]
            for key in ("HOMUN_EVAL_GATEWAY_BASE", "HOMUN_EVAL_GATEWAY_TOKEN", "HOMUN_DESKTOP_GATEWAY_TOKEN")
            if key in env
        }
        plan.append(Step("gateway eval", [PYTHON, "-c", GATEWAY_EVAL_SNIPPET], env=gateway_env))
    if truthy(env.get("HOMUN_RUN_PRODUCTION_SMOKE")):
        gateway_base = env.get("HOMUN_EVAL_GATEWAY_BASE", "http://127.0.0.1:18765")
        smoke_env = {
            key: env[key]
            for key in ("HOMUN_EVAL_GATEWAY_TOKEN", "HOMUN_DESKTOP_GATEWAY_TOKEN")
            if key in env
        }
        plan.append(
            Step(
                "production smoke",
                [PYTHON, "scripts/production_smoke.py", "--gateway-base", gateway_base],
                env=smoke_env,
            )
        )
    if truthy(env.get("HOMUN_RUN_STABILITY_SOAK")):
        plan.append(
            Step(
                "live stability soak",
                [PYTHON, "scripts/stability_soak.py", "--hard-restart"],
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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    parse_args(argv)
    plan = build_plan(os.environ)
    print("== Homun pre-release gate ==", flush=True)
    for index, step in enumerate(plan, start=1):
        rel_cwd = os.path.relpath(step.cwd, ROOT)
        print(f"{index}. {step.label}: {' '.join(step.command)} [{rel_cwd}]", flush=True)
    ok = run_plan(plan)
    print(f"== {'ALL GREEN' if ok else 'FAILURES'} ==", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
