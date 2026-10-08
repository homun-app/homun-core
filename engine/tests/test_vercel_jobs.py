"""H10 Vercel backend honesty and REST bridge tests."""
from __future__ import annotations

import json

import httpx
import pytest

from homun.execution.cloud_backends import probe_cloud_backend
from homun.execution.contracts import ExecutionUnavailable
from homun.execution.vercel_jobs import VercelJobSpec, VercelJobs


def test_vercel_probe_without_token(monkeypatch):
    monkeypatch.delenv("VERCEL_TOKEN", raising=False)
    monkeypatch.delenv("HOMUN_VERCEL_TOKEN", raising=False)
    st = probe_cloud_backend("vercel")
    assert st.configured is False
    assert st.ready is False


def test_vercel_probe_with_token_but_no_live(monkeypatch):
    monkeypatch.setenv("VERCEL_TOKEN", "test")
    monkeypatch.setenv("VERCEL_PROJECT_ID", "prj_x")
    monkeypatch.delenv("HOMUN_VERCEL_ALLOW_LIVE", raising=False)
    st = probe_cloud_backend("vercel")
    assert st.configured is True
    assert st.ready is False
    assert "HOMUN_VERCEL_ALLOW_LIVE" in (st.error or "")


def test_vercel_probe_ready_with_live(monkeypatch):
    monkeypatch.setenv("VERCEL_TOKEN", "test")
    monkeypatch.setenv("VERCEL_PROJECT_ID", "prj_x")
    monkeypatch.setenv("HOMUN_VERCEL_ALLOW_LIVE", "1")
    st = probe_cloud_backend("vercel")
    assert st.ready is True


def test_vercel_jobs_require_project(monkeypatch, tmp_path):
    monkeypatch.setenv("VERCEL_TOKEN", "test")
    monkeypatch.delenv("VERCEL_PROJECT_ID", raising=False)
    monkeypatch.delenv("HOMUN_VERCEL_PROJECT_ID", raising=False)
    monkeypatch.setenv("HOMUN_VERCEL_ALLOW_LIVE", "1")
    with pytest.raises(ExecutionUnavailable, match="project id"):
        VercelJobs(tmp_path)


def test_vercel_jobs_start_via_rest(monkeypatch, tmp_path):
    monkeypatch.setenv("VERCEL_TOKEN", "tok")
    monkeypatch.setenv("VERCEL_PROJECT_ID", "prj_x")
    monkeypatch.setenv("HOMUN_VERCEL_ALLOW_LIVE", "1")

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, str(request.url)))
        if request.method == "POST" and request.url.path == "/v2/sandboxes":
            return httpx.Response(200, json={"session": {"id": "sess_1"}})
        if request.method == "POST" and "/cmd" in request.url.path:
            return httpx.Response(200, json={"exitCode": 0, "stdout": "ok\n", "stderr": ""})
        if request.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(500, text="unexpected")

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport)
    jobs = VercelJobs(tmp_path, client=client)
    job = VercelJobSpec(
        workspace_id="w",
        run_id="r",
        call_id="c1",
        image="python:3.12-slim",
        command="echo ok",
    )
    out = jobs.start(job)
    assert out["exit_code"] == 0
    assert out["status"] == "exited"
    assert any("/v2/sandboxes" in u for _, u in calls)
    logs = jobs.logs(job)
    assert "ok" in logs["text"]
