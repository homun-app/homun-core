#!/usr/bin/env python3
"""Deterministic smoke for persisted /kernel-projection fixtures.

The live browser smoke proves a real gateway can complete a browser turn. This
script protects the stable UI/kernel contract without a live runtime: every JSON
fixture is a persisted response from
`GET /api/chat/threads/{thread_id}/kernel-projection` plus the expectations that
must survive reload, background runs, and legacy UI fallbacks.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE_DIR = ROOT / "scripts" / "fixtures" / "kernel_projection"

REQUIRED_CASES = {
    "terminal_liveness_after_reload",
    "runtime_plan_after_reload",
    "read_uncertain_effect_is_quiet",
    "write_uncertain_effect_needs_attention",
    "browser_active",
    "browser_done",
    "browser_failure",
    "plugin_capability_runtime",
    "automation_background_waiting_approval",
    "legacy_marker_quarantine",
}

REQUIRED_TOP_LEVEL = {
    "thread_id",
    "revision",
    "turn",
    "plan",
    "activity",
    "subagents",
    "browser",
    "capability_runtime",
    "attention",
    "actions",
}


def _json_files(fixtures_dir: Path) -> list[Path]:
    return sorted(path for path in fixtures_dir.glob("*.json") if path.is_file())


def _load_fixture(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise AssertionError("fixture root must be a JSON object")
    return payload


def _projection(fixture: dict[str, Any]) -> dict[str, Any]:
    projection = fixture.get("response", fixture.get("projection"))
    if not isinstance(projection, dict):
        raise AssertionError("fixture must contain response or projection object")
    return projection


def _get(payload: dict[str, Any], dotted_path: str) -> Any:
    value: Any = payload
    for part in dotted_path.split("."):
        if not isinstance(value, dict) or part not in value:
            raise AssertionError(f"missing projection path {dotted_path}")
        value = value[part]
    return value


def _expect_equal(
    projection: dict[str, Any],
    dotted_path: str,
    expected: Any,
    failures: list[str],
) -> None:
    try:
        actual = _get(projection, dotted_path)
    except AssertionError as error:
        failures.append(str(error))
        return
    if actual != expected:
        failures.append(f"{dotted_path}: expected {expected!r}, got {actual!r}")


def _expect_len(
    projection: dict[str, Any],
    dotted_path: str,
    expected: int,
    failures: list[str],
) -> None:
    try:
        actual = _get(projection, dotted_path)
    except AssertionError as error:
        failures.append(str(error))
        return
    if not isinstance(actual, list):
        failures.append(f"{dotted_path}: expected list, got {type(actual).__name__}")
        return
    if len(actual) != expected:
        failures.append(f"{dotted_path}: expected length {expected}, got {len(actual)}")


def _expect_plan_step(
    projection: dict[str, Any],
    expected: dict[str, str],
    failures: list[str],
) -> None:
    plan = projection.get("plan")
    if not isinstance(plan, dict):
        failures.append("plan: expected object")
        return
    steps = plan.get("steps")
    if not isinstance(steps, list):
        failures.append("plan.steps: expected list")
        return
    by_id = {step.get("id"): step for step in steps if isinstance(step, dict)}
    for step_id, status in expected.items():
        step = by_id.get(step_id)
        if not isinstance(step, dict):
            failures.append(f"plan.steps: missing step {step_id!r}")
            continue
        if step.get("status") != status:
            failures.append(
                f"plan.steps[{step_id}].status: expected {status!r}, got {step.get('status')!r}"
            )


def validate_fixture(path: Path) -> list[str]:
    failures: list[str] = []
    try:
        fixture = _load_fixture(path)
        case = fixture.get("case")
        if not isinstance(case, str) or not case:
            failures.append("case: expected non-empty string")
        endpoint = fixture.get("endpoint")
        if not isinstance(endpoint, str) or "/kernel-projection" not in endpoint:
            failures.append("endpoint: expected persisted /kernel-projection path")
        projection = _projection(fixture)
    except (OSError, json.JSONDecodeError, AssertionError) as error:
        return [str(error)]

    missing = REQUIRED_TOP_LEVEL.difference(projection)
    if missing:
        failures.append(f"projection: missing top-level keys {sorted(missing)}")
        return failures

    expectations = fixture.get("expect")
    if not isinstance(expectations, dict):
        failures.append("expect: expected object")
        return failures

    for key, value in expectations.get("equals", {}).items():
        _expect_equal(projection, key, value, failures)
    for key, value in expectations.get("lengths", {}).items():
        _expect_len(projection, key, int(value), failures)
    plan_steps = expectations.get("plan_steps")
    if isinstance(plan_steps, dict):
        _expect_plan_step(projection, plan_steps, failures)

    return failures


def run_smoke(fixtures_dir: Path) -> tuple[bool, str]:
    if not fixtures_dir.exists():
        return False, f"fixture directory does not exist: {fixtures_dir}"
    files = _json_files(fixtures_dir)
    if not files:
        return False, f"no fixtures found in {fixtures_dir}"

    seen_cases: set[str] = set()
    failures: list[str] = []
    for path in files:
        try:
            fixture = _load_fixture(path)
            case = fixture.get("case")
            if isinstance(case, str):
                seen_cases.add(case)
        except (OSError, json.JSONDecodeError):
            pass
        case_failures = validate_fixture(path)
        failures.extend(f"{path.name}: {failure}" for failure in case_failures)

    missing_cases = REQUIRED_CASES.difference(seen_cases)
    if missing_cases:
        failures.append(f"missing required cases: {sorted(missing_cases)}")

    if failures:
        return False, "\n".join(failures)
    return True, f"validated {len(files)} kernel projection fixtures"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures-dir", default=os.fspath(DEFAULT_FIXTURE_DIR))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    ok, detail = run_smoke(Path(args.fixtures_dir))
    print(detail)
    print("PASS kernel projection smoke" if ok else "FAIL kernel projection smoke")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
