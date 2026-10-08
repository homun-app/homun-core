"""H10 Modal backend gating tests."""
from __future__ import annotations

import pytest

from homun.execution.cloud_backends import probe_cloud_backend
from homun.execution.contracts import ExecutionUnavailable
from homun.execution.modal_jobs import ModalJobs


def test_modal_probe_without_sdk(monkeypatch):
    monkeypatch.setattr(
        "homun.execution.modal_jobs.modal_sdk_available",
        lambda: False,
    )
    st = probe_cloud_backend("modal")
    assert st.ready is False
    assert "SDK" in (st.error or "")


def test_modal_probe_credentials_without_live_opt_in(monkeypatch):
    monkeypatch.setattr(
        "homun.execution.modal_jobs.modal_sdk_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "homun.execution.modal_jobs.modal_credentials_present",
        lambda: True,
    )
    monkeypatch.setattr(
        "homun.execution.modal_jobs.modal_live_allowed",
        lambda: False,
    )
    st = probe_cloud_backend("modal")
    assert st.configured is True
    assert st.ready is False
    assert "HOMUN_MODAL_ALLOW_LIVE" in (st.error or "")


def test_modal_jobs_refuse_without_live_flag(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "homun.execution.modal_jobs.modal_sdk_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "homun.execution.modal_jobs.modal_credentials_present",
        lambda: True,
    )
    monkeypatch.setattr(
        "homun.execution.modal_jobs.modal_live_allowed",
        lambda: False,
    )
    with pytest.raises(ExecutionUnavailable, match="HOMUN_MODAL_ALLOW_LIVE"):
        ModalJobs(tmp_path / "root")
