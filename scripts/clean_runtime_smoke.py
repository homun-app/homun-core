#!/usr/bin/env python3
"""Run Homun smoke scenarios against an isolated runtime profile.

This wrapper intentionally does not touch the default ``~/.homun`` profile.
It starts a gateway process with ``HOMUN_DATA_DIR`` pointing at a throwaway or
explicit profile directory, runs ``production_smoke.py`` against that gateway,
then audits the same profile with ``audit_homun_state.py``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GATEWAY_BIN = ROOT / "target" / "release" / "local-first-desktop-gateway"
PYTHON = sys.executable or "python3"
CONFIG_FILES = (
    "providers.json",
    "runtime-settings.json",
    "user-prefs.json",
    "artifact-destinations.json",
)
SECRET_CONFIG_FILES = (
    "secret-key",
    "secrets.json",
    "browser-checkpoint-secrets.json",
)


@dataclass(frozen=True)
class CommandResult:
    name: str
    returncode: int
    stdout: str
    stderr: str
    args: list[str]


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_gateway(base_url: str, timeout_seconds: float = 30.0) -> None:
    deadline = time.time() + timeout_seconds
    last_error = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url.rstrip('/')}/api/health", timeout=2) as response:
                if 200 <= response.status < 500:
                    return
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = str(error)
        time.sleep(0.25)
    raise RuntimeError(f"gateway did not become ready at {base_url}: {last_error}")


def run_command(args: Sequence[str], env: dict[str, str], name: str) -> CommandResult:
    completed = subprocess.run(
        list(args),
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return CommandResult(
        name=name,
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
        args=list(args),
    )


def start_gateway(binary: Path, data_dir: Path, port: int, token: str) -> subprocess.Popen[str]:
    if not binary.exists():
        raise FileNotFoundError(
            f"gateway binary not found: {binary}. Build it with: "
            "cargo build -p local-first-desktop-gateway --release"
        )
    env = os.environ.copy()
    env.update(
        {
            "HOMUN_DATA_DIR": os.fspath(data_dir),
            "HOMUN_DESKTOP_GATEWAY_PORT": str(port),
            "PORT": str(port),
            "HOMUN_DESKTOP_GATEWAY_TOKEN": token,
            "HOMUN_EVAL_GATEWAY_TOKEN": token,
        }
    )
    return subprocess.Popen(
        [os.fspath(binary)],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def stop_gateway(process: subprocess.Popen[str]) -> tuple[str, str]:
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    stdout = ""
    stderr = ""
    if process.stdout is not None:
        stdout = process.stdout.read()
    if process.stderr is not None:
        stderr = process.stderr.read()
    return stdout, stderr


def evidence_path(data_dir: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = data_dir / "clean-smoke-evidence"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{stamp}.json"


def seed_config(source_dir: Path, data_dir: Path, include_secrets: bool = False) -> list[str]:
    copied: list[str] = []
    source_dir = source_dir.expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    for name in CONFIG_FILES + (SECRET_CONFIG_FILES if include_secrets else ()):
        source = source_dir / name
        if not source.is_file():
            continue
        target = data_dir / name
        shutil.copy2(source, target)
        copied.append(name)
    return copied


def build_smoke_args(args: argparse.Namespace, base_url: str) -> list[str]:
    command = [
        PYTHON,
        "scripts/production_smoke.py",
        "--profile",
        args.profile,
        "--gateway-base",
        base_url,
    ]
    for scenario in args.scenario:
        command.extend(["--scenario", scenario])
    return command


def build_audit_args(data_dir: Path, max_timeline_events: int) -> list[str]:
    return [
        PYTHON,
        "scripts/audit_homun_state.py",
        "--data-dir",
        os.fspath(data_dir),
        "--max-findings-per-code",
        "0",
        "--max-timeline-events",
        str(max_timeline_events),
    ]


def write_evidence(
    *,
    path: Path,
    data_dir: Path,
    base_url: str,
    smoke: CommandResult | None,
    audit: CommandResult,
    gateway_stdout: str,
    gateway_stderr: str,
    seeded_config: list[str],
    timeout_env: dict[str, str],
) -> None:
    payload = {
        "data_dir": os.fspath(data_dir),
        "gateway_base": base_url,
        "seeded_config": seeded_config,
        "timeout_env": timeout_env,
        "smoke": None if smoke is None else smoke.__dict__,
        "audit": audit.__dict__,
        "gateway": {
            "stdout_tail": gateway_stdout[-8000:],
            "stderr_tail": gateway_stderr[-8000:],
        },
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, help="Persistent clean profile directory to use")
    parser.add_argument("--keep", action="store_true", help="Keep a temporary profile after the run")
    parser.add_argument("--gateway-bin", type=Path, default=DEFAULT_GATEWAY_BIN)
    parser.add_argument("--port", type=int, default=0, help="Gateway port, or 0 for a free port")
    parser.add_argument("--profile", choices=("baseline", "extended", "all"), default="baseline")
    parser.add_argument("--scenario", action="append", default=[], help="Scenario id, repeatable")
    parser.add_argument("--skip-smoke", action="store_true", help="Only boot gateway and audit the clean profile")
    parser.add_argument("--max-timeline-events", type=int, default=20)
    parser.add_argument("--model-headers-timeout-secs", type=int, default=15)
    parser.add_argument("--model-first-token-timeout-secs", type=int, default=30)
    parser.add_argument("--model-idle-timeout-secs", type=int, default=30)
    parser.add_argument(
        "--seed-config-from",
        type=Path,
        help="Copy selected non-DB config files from another Homun profile before boot",
    )
    parser.add_argument(
        "--copy-secrets",
        action="store_true",
        help="With --seed-config-from, also copy local secret config files into the isolated profile",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    temp_root: str | None = None
    if args.data_dir is None:
        temp_root = tempfile.mkdtemp(prefix="homun-clean-profile-")
        data_dir = Path(temp_root)
    else:
        data_dir = args.data_dir.resolve()
        data_dir.mkdir(parents=True, exist_ok=True)

    port = args.port or find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    token = f"clean-smoke-{uuid.uuid4().hex}"
    timeout_env = {
        "HOMUN_MODEL_HEADERS_TIMEOUT_SECS": str(args.model_headers_timeout_secs),
        "HOMUN_MODEL_FIRST_TOKEN_SECS": str(args.model_first_token_timeout_secs),
        "HOMUN_MODEL_IDLE_TIMEOUT_SECS": str(args.model_idle_timeout_secs),
    }
    process: subprocess.Popen[str] | None = None
    smoke_result: CommandResult | None = None
    seeded_config: list[str] = []
    gateway_stdout = ""
    gateway_stderr = ""
    result_code = 1
    try:
        if args.seed_config_from is not None:
            seeded_config = seed_config(args.seed_config_from, data_dir, args.copy_secrets)
        previous_timeout_env = {key: os.environ.get(key) for key in timeout_env}
        os.environ.update(timeout_env)
        try:
            process = start_gateway(args.gateway_bin, data_dir, port, token)
        finally:
            for key, previous in previous_timeout_env.items():
                if previous is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous
        wait_for_gateway(base_url)

        env = os.environ.copy()
        env.update(
            {
                "HOMUN_DATA_DIR": os.fspath(data_dir),
                "HOMUN_DESKTOP_GATEWAY_TOKEN": token,
                "HOMUN_EVAL_GATEWAY_TOKEN": token,
                **timeout_env,
            }
        )
        if not args.skip_smoke:
            smoke_result = run_command(build_smoke_args(args, base_url), env, "production_smoke")
        audit_result = run_command(build_audit_args(data_dir, args.max_timeline_events), env, "audit_homun_state")
        result_code = max(
            smoke_result.returncode if smoke_result is not None else 0,
            audit_result.returncode,
        )
    except (FileNotFoundError, RuntimeError) as error:
        print(f"FAIL clean-runtime-smoke: {error}", file=sys.stderr)
        return 2
    finally:
        if process is not None:
            gateway_stdout, gateway_stderr = stop_gateway(process)

    path = evidence_path(data_dir)
    write_evidence(
        path=path,
        data_dir=data_dir,
        base_url=base_url,
        smoke=smoke_result,
        audit=audit_result,
        gateway_stdout=gateway_stdout,
        gateway_stderr=gateway_stderr,
        seeded_config=seeded_config,
        timeout_env=timeout_env,
    )
    print(f"Evidence: {path}")
    if smoke_result is not None:
        print(smoke_result.stdout, end="")
        print(smoke_result.stderr, end="", file=sys.stderr)
    print(audit_result.stdout, end="")
    print(audit_result.stderr, end="", file=sys.stderr)

    if temp_root is not None and not args.keep:
        shutil.rmtree(temp_root, ignore_errors=True)
    return result_code


if __name__ == "__main__":
    raise SystemExit(main())
