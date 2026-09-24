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
