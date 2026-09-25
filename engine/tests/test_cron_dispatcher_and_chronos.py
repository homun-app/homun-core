"""Tests for cron due-fire dispatcher and Chronos honesty."""
from __future__ import annotations

from pathlib import Path

from homun.application.chronos_provider import ChronosProvider
from homun.application.cron_dispatcher import fire_due_jobs, list_due_job_ids
from homun.application.cron_manager import CronManager
from homun.application.cron_store import CronStore, set_cron_store


def test_fire_due_interval_job_with_runner(tmp_path):
    store = CronStore(tmp_path / "cron.sqlite")
    set_cron_store(store)
    mgr = CronManager(workspace_id="ws-due", store=store)
    job = mgr.create_job(schedule="every 1h", prompt="tick", now=1000.0)
    # Make due
    job.next_run_at = 1000.0
    mgr._persist_job(job)

    assert list_due_job_ids("ws-due", now=2000.0) == [job.id]

    def runner(payload):
        return 0, "fired-ok", None

    results = fire_due_jobs("ws-due", now=2000.0, custom_runner=runner)
    assert len(results) == 1
    assert results[0]["occurrence"]["status"] == "success"
    assert "fired-ok" in results[0]["occurrence"]["output_preview"]
    set_cron_store(None)


def test_chronos_unconfigured_is_honest(monkeypatch):
    monkeypatch.delenv("HOMUN_CHRONOS_URL", raising=False)
    st = ChronosProvider().status()
    assert st.configured is False
    assert st.ready is False
    assert st.code == "backend_unavailable"


def test_chronos_crud_operations(monkeypatch):
    import httpx

    jobs_store = [{"id": "job-1", "name": "Backup", "schedule": "0 2 * * *"}]

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        method = request.method
        if url.endswith("/health"):
            return httpx.Response(200, json={"status": "ok"})
        if url.endswith("/v1/jobs") and method == "GET":
            return httpx.Response(200, json={"jobs": jobs_store})
        if url.endswith("/v1/jobs") and method == "POST":
            import json
            data = json.loads(request.content.decode("utf-8"))
            new_job = {"id": f"job-{len(jobs_store) + 1}", **data}
            jobs_store.append(new_job)
            return httpx.Response(201, json=new_job)
        if "/v1/jobs/" in url and method == "DELETE":
            jid = url.split("/")[-1]
            return httpx.Response(200, json={"deleted": True})
        if "/trigger" in url and method == "POST":
            return httpx.Response(200, json={"triggered": True, "run_id": "run-99"})
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)

    monkeypatch.setenv("HOMUN_CHRONOS_URL", "https://chronos.local")
    provider = ChronosProvider("https://chronos.local")

    real_client_init = httpx.Client.__init__

    def mock_client_init(self, *args, **kwargs):
        kwargs["transport"] = transport
        real_client_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", mock_client_init)

    st = provider.status()
    assert st.ready is True

    # 1. List
    jobs = provider.list_remote_jobs()
    assert len(jobs) == 1
    assert jobs[0]["id"] == "job-1"

    # 2. Create
    created = provider.create_remote_job({"name": "Sync", "schedule": "*/10 * * * *"})
    assert created["id"] == "job-2"
    assert created["name"] == "Sync"

    # 3. Trigger
    res = provider.trigger_remote_job("job-2")
    assert res.get("triggered") is True

    # 4. Delete
    assert provider.delete_remote_job("job-2") is True

