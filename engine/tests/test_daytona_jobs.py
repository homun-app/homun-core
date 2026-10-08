"""H10 Daytona backend gating tests."""
from __future__ import annotations

import pytest

from homun.execution.cloud_backends import probe_cloud_backend
from homun.execution.contracts import ExecutionUnavailable
from homun.execution.daytona_jobs import DaytonaJobs


def test_daytona_probe_without_live_opt_in(monkeypatch):
    monkeypatch.setattr(
        "homun.execution.daytona_jobs.daytona_sdk_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "homun.execution.daytona_jobs.daytona_credentials_present",
        lambda: True,
    )
    monkeypatch.setattr(
        "homun.execution.daytona_jobs.daytona_live_allowed",
        lambda: False,
    )
    st = probe_cloud_backend("daytona")
    assert st.configured is True
    assert st.ready is False
    assert "HOMUN_DAYTONA_ALLOW_LIVE" in (st.error or "")


def test_daytona_jobs_refuse_without_live_flag(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "homun.execution.daytona_jobs.daytona_sdk_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "homun.execution.daytona_jobs.daytona_credentials_present",
        lambda: True,
    )
    monkeypatch.setattr(
        "homun.execution.daytona_jobs.daytona_live_allowed",
        lambda: False,
    )
    with pytest.raises(ExecutionUnavailable, match="HOMUN_DAYTONA_ALLOW_LIVE"):
        DaytonaJobs(tmp_path / "root")
