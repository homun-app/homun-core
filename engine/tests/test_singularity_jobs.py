"""H10 Singularity/Apptainer execution bridge."""
from __future__ import annotations

import os
import stat
import time
from pathlib import Path

import pytest

from homun.execution.cloud_backends import probe_cloud_backend
from homun.execution.contracts import ExecutionUnavailable
from homun.execution.singularity_jobs import (
    SingularityJobSpec,
    SingularityJobs,
    find_singularity_executable,
)


def _fake_cli(tmp_path: Path) -> Path:
    """Minimal CLI that supports `version` and `exec ... /bin/sh -c <cmd>`."""
    path = tmp_path / "fake-apptainer"
    path.write_text(
        """#!/bin/sh
if [ "$1" = "version" ]; then
  echo "apptainer version 1.3.0-homun-test"
  exit 0
fi
if [ "$1" = "exec" ]; then
  # argv: exec --containall --no-home --writable-tmpfs --bind X --pwd /work IMAGE /bin/sh -c CMD
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-c" ]; then
      shift
      eval "$1"
      exit $?
    fi
    shift
  done
  exit 2
fi
echo "unexpected: $*" >&2
exit 1
"""
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_probe_ready_when_fake_cli_present(tmp_path, monkeypatch):
    cli = _fake_cli(tmp_path)
    monkeypatch.setenv("HOMUN_SINGULARITY_BIN", str(cli))
    for key in ("SINGULARITY_BIN",):
        monkeypatch.delenv(key, raising=False)
    st = probe_cloud_backend("singularity")
    assert st.configured is True
    assert st.ready is True
    assert st.error is None


def test_probe_unconfigured_without_binary(monkeypatch):
    monkeypatch.delenv("HOMUN_SINGULARITY_BIN", raising=False)
    monkeypatch.delenv("SINGULARITY_BIN", raising=False)
    monkeypatch.setattr(
        "homun.execution.singularity_jobs.shutil.which",
        lambda _name: None,
    )
    st = probe_cloud_backend("singularity")
    assert st.configured is False
    assert st.ready is False


def test_singularity_jobs_execute_via_cli(tmp_path, monkeypatch):
    cli = _fake_cli(tmp_path)
    monkeypatch.setenv("HOMUN_SINGULARITY_BIN", str(cli))
    root = tmp_path / "exec"
    jobs = SingularityJobs(root, executable=str(cli))
    spec = SingularityJobSpec(
        workspace_id="ws",
        run_id="run1",
        call_id="c1",
        image="docker://alpine:3.19",
        command='printf hello > "$PWD/out.txt"',
    )
    state = jobs.start(spec)
    deadline = time.time() + 5
    while state.get("running") and time.time() < deadline:
        time.sleep(0.05)
        state = jobs.inspect(spec)
    assert state.get("running") is False
    assert state.get("exit_code") in (0, None) or state.get("status") == "exited"
    out = jobs.workspace(spec) / "out.txt"
    # Fake CLI eval runs in host workspace cwd; file should exist.
    assert out.read_text() == "hello" or (jobs.logs(spec)["text"].find("hello") >= 0) or out.exists()
    jobs.remove(spec)


def test_find_executable_prefers_env(tmp_path, monkeypatch):
    cli = _fake_cli(tmp_path)
    monkeypatch.setenv("HOMUN_SINGULARITY_BIN", str(cli))
    assert find_singularity_executable() == str(cli)


def test_missing_cli_raises_unavailable(tmp_path, monkeypatch):
    monkeypatch.delenv("HOMUN_SINGULARITY_BIN", raising=False)
    monkeypatch.setattr(
        "homun.execution.singularity_jobs.find_singularity_executable",
        lambda: None,
    )
    with pytest.raises(ExecutionUnavailable):
        SingularityJobs(tmp_path / "root")
