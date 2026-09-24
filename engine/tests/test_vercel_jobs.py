"""H10 Vercel backend honesty tests."""
from __future__ import annotations

from homun.execution.cloud_backends import probe_cloud_backend


def test_vercel_probe_without_token(monkeypatch):
    monkeypatch.delenv("VERCEL_TOKEN", raising=False)
    monkeypatch.delenv("HOMUN_VERCEL_TOKEN", raising=False)
    st = probe_cloud_backend("vercel")
    assert st.configured is False
    assert st.ready is False


def test_vercel_probe_with_token_but_no_live(monkeypatch):
    monkeypatch.setenv("VERCEL_TOKEN", "test")
    monkeypatch.delenv("HOMUN_VERCEL_ALLOW_LIVE", raising=False)
    st = probe_cloud_backend("vercel")
    assert st.configured is True
    assert st.ready is False
    assert "HOMUN_VERCEL_ALLOW_LIVE" in (st.error or "")
