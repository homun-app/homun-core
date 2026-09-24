"""H10 cloud terminal backend honesty."""
from __future__ import annotations

import pytest

from homun.execution.cloud_backends import (
    UnavailableCloudJobs,
    list_cloud_backend_status,
    probe_cloud_backend,
)
from homun.execution.contracts import ExecutionUnavailable


def test_unconfigured_modal_is_honest(monkeypatch):
    for key in ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "HOMUN_MODAL_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    st = probe_cloud_backend("modal")
    assert st.configured is False
    assert st.ready is False
    assert st.code == "backend_unavailable"


def test_configured_but_gated_daytona_refuses_start(monkeypatch):
    monkeypatch.setenv("DAYTONA_API_KEY", "test-key-not-real")
    monkeypatch.setattr(
        "homun.execution.daytona_jobs.daytona_sdk_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "homun.execution.daytona_jobs.daytona_live_allowed",
        lambda: False,
    )
    st = probe_cloud_backend("daytona")
    assert st.configured is True
    assert st.ready is False
    backend = UnavailableCloudJobs("daytona")
    with pytest.raises(ExecutionUnavailable, match="HOMUN_DAYTONA_ALLOW_LIVE|not yet wired|Daytona"):
        backend.start(object())


def test_catalog_lists_all_h10_cloud_backends():
    names = {row["name"] for row in list_cloud_backend_status()}
    assert names == {"modal", "managed_modal", "singularity", "daytona", "vercel"}
