"""H10 managed Modal honesty."""
from __future__ import annotations

from homun.execution.cloud_backends import probe_cloud_backend


def test_managed_modal_requires_url(monkeypatch):
    monkeypatch.delenv("HOMUN_MANAGED_MODAL_URL", raising=False)
    monkeypatch.delenv("NOUS_MODAL_URL", raising=False)
    st = probe_cloud_backend("managed_modal")
    assert st.configured is False
    assert st.ready is False


def test_managed_modal_gated_without_live(monkeypatch):
    monkeypatch.setenv("HOMUN_MANAGED_MODAL_URL", "https://example.invalid/modal")
    monkeypatch.delenv("HOMUN_MANAGED_MODAL_ALLOW_LIVE", raising=False)
    st = probe_cloud_backend("managed_modal")
    assert st.configured is True
    assert st.ready is False
    assert "HOMUN_MANAGED_MODAL_ALLOW_LIVE" in (st.error or "")
