"""H10 managed Modal honesty and HTTP bridge tests."""
from __future__ import annotations

import json

import httpx

from homun.execution.cloud_backends import probe_cloud_backend
from homun.execution.managed_modal_jobs import ManagedModalJobSpec, ManagedModalJobs


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


def test_managed_modal_ready_with_live(monkeypatch):
    monkeypatch.setenv("HOMUN_MANAGED_MODAL_URL", "https://example.invalid/modal")
    monkeypatch.setenv("HOMUN_MANAGED_MODAL_ALLOW_LIVE", "1")
    st = probe_cloud_backend("managed_modal")
    assert st.ready is True


def test_managed_modal_jobs_http_exec(monkeypatch, tmp_path):
    monkeypatch.setenv("HOMUN_MANAGED_MODAL_URL", "https://mm.example/exec")
    monkeypatch.setenv("HOMUN_MANAGED_MODAL_ALLOW_LIVE", "1")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "mm.example"
        body = json.loads(request.content.decode())
        assert body["command"] == "echo hi"
        return httpx.Response(200, json={"exit_code": 0, "stdout": "hi\n", "stderr": ""})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    jobs = ManagedModalJobs(tmp_path, client=client)
    job = ManagedModalJobSpec(
        workspace_id="w",
        run_id="r",
        call_id="c1",
        image="python:3.12-slim",
        command="echo hi",
    )
    out = jobs.start(job)
    assert out["exit_code"] == 0
    assert "hi" in jobs.logs(job)["text"]
