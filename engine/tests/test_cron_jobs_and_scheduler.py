"""Comprehensive tests for durable scheduling, cron jobs, occurrences, and incident tracking (H28/H29).

Covers:
- Schedule parsing: cron, relative intervals, one-shot timestamps, event triggers.
- Preflight validation: runnable payloads, script requirements, model/provider pins.
- Job CRUD and lifecycle: create, update, pause, resume, remove, list.
- Chained context injection (context_from gathering prior job output).
- Script execution and exit code tracking.
- Repeat limits and transition to completed.
- Quota hold: automatic pause, incident recording, resume clearing hold.
- Incident tracking with failure deduplication and resolution.
- Delivery queuing for non-local delivery targets.
- Atomic reservation via claim_job_for_fire.
- cronjob_manage tool integration in agent runs.
"""
from __future__ import annotations

import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from homun.application.cron_contracts import CronIncident, CronJob, CronOccurrence
from homun.application.cron_manager import (
    AGENT_RUNNER_UNAVAILABLE,
    CronManager,
    compute_next_cron,
    compute_next_run,
    parse_schedule,
    reset_store,
)
from homun.application.cron_store import CronStore, set_cron_store
from homun.application.cron_tools import execute as cron_execute
from homun.domain.errors import ValidationError


@pytest.fixture(autouse=True)
def clean_cron_store():
    store = CronStore(":memory:")
    set_cron_store(store)
    yield
    reset_store()
    set_cron_store(None)


def test_parse_schedule_and_compute_next_run():
    # 1. Standard cron
    parsed_cron = parse_schedule("0 9 * * *")
    assert parsed_cron["kind"] == "cron"
    assert parsed_cron["cron"] == "0 9 * * *"

    now_ts = datetime(2026, 9, 24, 8, 30, tzinfo=timezone.utc).timestamp()
    next_ts = compute_next_cron("0 9 * * *", now_ts)
    next_dt = datetime.fromtimestamp(next_ts, tz=timezone.utc)
    assert next_dt.hour == 9
    assert next_dt.minute == 0
    assert next_dt.day == 24

    # 2. Relative intervals
    parsed_int = parse_schedule("every 2h")
    assert parsed_int["kind"] == "interval"
    assert parsed_int["seconds"] == 7200

    parsed_min = parse_schedule("30m")
    assert parsed_min["kind"] == "interval"
    assert parsed_min["seconds"] == 1800

    job_int = CronJob(id="job-1", schedule_raw="every 15m")
    assert compute_next_run(job_int, now=1000.0) == 1000.0 + 900

    # 3. One-shot timestamps
    parsed_once = parse_schedule("at 2026-10-01T12:00:00Z")
    assert parsed_once["kind"] == "once"
    assert parsed_once["timestamp"] == datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc).timestamp()

    # 4. Event triggers
    parsed_evt = parse_schedule("on event:deploy_completed")
    assert parsed_evt["kind"] == "event"
    assert parsed_evt["event"] == "deploy_completed"
    job_evt = CronJob(id="job-2", schedule_raw="on event:deploy")
    assert compute_next_run(job_evt, now=1000.0) == 0.0

    # 5. Invalid schedules
    with pytest.raises(ValueError, match="cannot be empty"):
        parse_schedule("")
    with pytest.raises(ValueError, match="Unrecognized schedule format"):
        parse_schedule("invalid schedule expression xyz")


def test_preflight_validation_and_job_creation():
    mgr = CronManager(workspace_id="ws-test")

    # Valid job creation
    job = mgr.create_job(
        schedule="every 1h",
        prompt="Check system status and report anomalies",
        name="Hourly Healthcheck",
        skills=["system_monitor"],
        repeat=5,
    )
    assert job.id.startswith("job-")
    assert job.name == "Hourly Healthcheck"
    assert job.status == "active"
    assert job.repeat == 5
    assert job.next_run_at > job.created_at

    # Validation: missing payload
    with pytest.raises(ValueError, match="Job must specify at least one of prompt, script, or skills"):
        mgr.create_job(schedule="every 1h")

    # Validation: no_agent without script
    with pytest.raises(ValueError, match="no_agent=True requires a script path"):
        mgr.create_job(schedule="every 1h", prompt="hello", no_agent=True)

    # Validation: empty model_pin
    with pytest.raises(ValueError, match="model_pin cannot be an empty string"):
        mgr.create_job(schedule="every 1h", prompt="hello", model_pin="   ")


def test_job_crud_lifecycle_and_updates():
    mgr = CronManager(workspace_id="ws-test")
    job = mgr.create_job(
        schedule="every 30m",
        prompt="Initial prompt",
        name="Task A",
    )
    job_id = job.id

    # Get & List
    assert mgr.get_job(job_id) is not None
    assert len(mgr.list_jobs()) == 1

    # Pause
    paused = mgr.pause_job(job_id, reason="maintenance window")
    assert paused.status == "paused"
    assert paused.paused_reason == "maintenance window"
    assert paused.next_run_at == 0.0

    # Update
    updated = mgr.update_job(
        job_id,
        name="Task A Revised",
        prompt="Updated prompt",
        schedule="every 1h",
        model_pin="claude-3-5-sonnet",
        provider_pin="anthropic",
        repeat=10,
    )
    assert updated.name == "Task A Revised"
    assert updated.prompt == "Updated prompt"
    assert updated.schedule_raw == "every 1h"
    assert updated.model_pin == "claude-3-5-sonnet"
    assert updated.provider_pin == "anthropic"
    assert updated.repeat == 10

    # Resume
    resumed = mgr.resume_job(job_id, now=2000.0)
    assert resumed.status == "active"
    assert resumed.paused_reason is None
    assert resumed.next_run_at == 2000.0 + 3600

    # Remove
    assert mgr.remove_job(job_id) is True
    assert mgr.get_job(job_id).status == "cleared"
    assert len(mgr.list_jobs(include_cleared=False)) == 0
    assert len(mgr.list_jobs(include_cleared=True)) == 1


def test_execution_chained_context_and_repeat_completion():
    mgr = CronManager(workspace_id="ws-test")

    # Job 1: produces summary
    job1 = mgr.create_job(schedule="every 1h", prompt="Produce summary of metrics", name="Summary Job")
    def runner1(payload):
        return 0, "CPU: 42%, Memory: 68%, Status: OK", None
    occ1 = mgr.run_job(job1.id, now=1000.0, custom_runner=runner1)
    assert occ1.status == "success"
    assert "CPU: 42%" in job1.last_output

    # Job 2: consumes output from Job 1 via context_from
    received_prompts = []
    def runner2(payload):
        received_prompts.append(payload["prompt"])
        return 0, "Alert evaluation: all metrics within bounds", None

    job2 = mgr.create_job(
        schedule="every 2h",
        prompt="Evaluate alerts based on previous summary",
        context_from=[job1.id],
        repeat=1,  # one-time execution
    )
    occ2 = mgr.run_job(job2.id, now=1010.0, custom_runner=runner2)
    assert occ2.status == "success"
    assert len(received_prompts) == 1
    assert f"[Output from job {job1.id} (Summary Job)]:" in received_prompts[0]
    assert "CPU: 42%" in received_prompts[0]
    assert "[Current Task]:" in received_prompts[0]

    # Job 2 reached repeat=1 -> status becomes completed
    assert job2.status == "completed"
    assert job2.next_run_at == 0.0


def test_script_execution_in_workdir():
    mgr = CronManager(workspace_id="ws-test")
    with tempfile.TemporaryDirectory() as tmpdir:
        script_file = Path(tmpdir) / "check.sh"
        script_file.write_text("#!/bin/sh\necho 'Script output 123'\nexit 0\n")
        script_file.chmod(0o755)

        job = mgr.create_job(
            schedule="every 10m",
            script=str(script_file),
            workdir=tmpdir,
            no_agent=True,
        )
        occ = mgr.run_job(job.id, now=5000.0)
        assert occ.status == "success"
        assert occ.exit_code == 0
        assert "Script output 123" in occ.output_preview
        assert job.last_output.strip() == "Script output 123"


def test_quota_hold_and_incident_deduplication():
    mgr = CronManager(workspace_id="ws-test")
    job = mgr.create_job(schedule="every 1h", prompt="Run analytics")

    # 1. Trigger quota hold (H29)
    paused_job = mgr.trigger_quota_hold(job.id, reason="monthly token allowance exceeded", now=1000.0)
    assert paused_job.quota_hold is True
    assert paused_job.status == "paused"
    assert "quota_hold: monthly token allowance exceeded" in paused_job.paused_reason
    assert paused_job.next_run_at == 0.0

    # Incident created for quota hold
    incidents = mgr.get_incidents(job.id)
    assert len(incidents) == 1
    assert "Quota hold triggered" in incidents[0].error_message

    # Resume clears quota hold
    mgr.resume_job(job.id, now=1500.0)
    assert job.quota_hold is False
    assert job.status == "active"

    # 2. Incident deduplication across repeated failures
    def failing_runner(payload):
        return 1, "", "Connection to database failed: timeout"

    occ1 = mgr.run_job(job.id, now=2000.0, custom_runner=failing_runner)
    assert occ1.status == "failed"
    assert job.consecutive_errors == 1

    occ2 = mgr.run_job(job.id, now=2100.0, custom_runner=failing_runner)
    assert occ2.status == "failed"
    assert job.consecutive_errors == 2

    # Incidents list should have merged the repeated failure without spamming
    incidents = mgr.get_incidents(job.id)
    db_incident = next(i for i in incidents if "Connection to database failed" in i.error_message)
    assert db_incident.occurrence_count == 2
    assert db_incident.first_seen_at == 2000.0
    assert db_incident.last_seen_at == 2100.0
    assert db_incident.resolved is False

    # Resolve incidents
    resolved_count = mgr.resolve_incidents(job.id)
    assert resolved_count >= 2
    assert all(i.resolved for i in mgr.get_incidents(job.id))


def test_delivery_queuing_and_atomic_claim():
    mgr = CronManager(workspace_id="ws-test")
    job = mgr.create_job(
        schedule="every 1h",
        prompt="Generate report",
        deliver="chat",
    )

    def report_runner(payload):
        return 0, "Quarterly Revenue: $500K", None

    mgr.run_job(job.id, now=3000.0, custom_runner=report_runner)
    deliveries = mgr.get_deliveries()
    assert len(deliveries) == 1
    assert deliveries[0]["job_id"] == job.id
    assert deliveries[0]["target"] == "chat"
    assert "Quarterly Revenue" in deliveries[0]["output"]

    # Atomic claim check
    # Future timestamp: not yet due
    assert mgr.claim_job_for_fire(job.id, now=3000.0) is None
    # Past timestamp: job is due
    due_ts = job.next_run_at + 10.0
    claimed = mgr.claim_job_for_fire(job.id, now=due_ts)
    assert claimed is not None
    assert claimed.id == job.id


def test_cron_tool_execution():
    run = {
        "work_id": "ws-tool",
        "cron": {"policy": "durable-cron-v1", "version": 1},
    }
    ctx = MagicMock()
    actor = MagicMock()

    # 1. Add job
    res_add = cron_execute(ctx, actor, run, "cronjob_manage", {
        "action": "add",
        "schedule": "every 2h",
        "prompt": "Backup database",
        "name": "DB Backup",
    })
    assert res_add["status"] == "created"
    job_id = res_add["job"]["id"]
    assert "_cron" in run
    assert any(j["id"] == job_id for j in run["_cron"]["jobs"])

    # 2. List jobs
    res_list = cron_execute(ctx, actor, run, "cronjob_manage", {"action": "list"})
    assert res_list["count"] == 1
    assert res_list["jobs"][0]["name"] == "DB Backup"

    # 3. Get job
    res_get = cron_execute(ctx, actor, run, "cronjob_manage", {"action": "get", "job_id": job_id})
    assert res_get["job"]["id"] == job_id

    # 4. Update job
    res_upd = cron_execute(ctx, actor, run, "cronjob_manage", {
        "action": "update",
        "job_id": job_id,
        "name": "DB Backup High Priority",
        "repeat": 3,
    })
    assert res_upd["status"] == "updated"
    assert res_upd["job"]["name"] == "DB Backup High Priority"

    # 5. Pause & Resume
    res_pause = cron_execute(ctx, actor, run, "cronjob_manage", {"action": "pause", "job_id": job_id})
    assert res_pause["status"] == "paused"

    res_resume = cron_execute(ctx, actor, run, "cronjob_manage", {"action": "resume", "job_id": job_id})
    assert res_resume["status"] == "active"

    # 6. Run job with mock ctx: runner is attempted but fails honestly (no synthetic success)
    res_run = cron_execute(ctx, actor, run, "cronjob_manage", {"action": "run", "job_id": job_id})
    assert res_run["status"] == "executed"
    assert res_run["occurrence"]["status"] == "failed"
    assert res_run["occurrence"]["error"] in {"backend_unavailable", "execution_failed"}
    assert res_run["occurrence"]["output_preview"]

    # 7. History records the failed attempt
    res_hist = cron_execute(ctx, actor, run, "cronjob_manage", {"action": "history", "job_id": job_id})
    assert res_hist["count"] == 1

    # 8. Incidents recorded for unavailable runner
    res_inc = cron_execute(ctx, actor, run, "cronjob_manage", {"action": "incidents", "job_id": job_id})
    assert res_inc["count"] >= 1

    # 9. Remove job
    res_rem = cron_execute(ctx, actor, run, "cronjob_manage", {"action": "remove", "job_id": job_id})
    assert res_rem["status"] == "removed"

    # 10. Disabled policy raises error
    run_disabled = {"work_id": "ws-tool"}
    with pytest.raises(ValidationError, match="Cron scheduling tools are not enabled"):
        cron_execute(ctx, actor, run_disabled, "cronjob_manage", {"action": "list"})


def test_cron_jobs_survive_store_reopen(tmp_path):
    """H28/H29: jobs, history, incidents, and deliveries survive a new process/store."""
    db = tmp_path / "cron.sqlite"
    store1 = CronStore(db)
    mgr1 = CronManager(workspace_id="ws-persist", store=store1)
    job = mgr1.create_job(
        schedule="every 1h",
        prompt="nightly report",
        name="Nightly",
        deliver="chat",
    )

    def ok_runner(payload):
        return 0, "report body", None

    occ = mgr1.run_job(job.id, now=1000.0, custom_runner=ok_runner)
    assert occ.status == "success"
    assert len(mgr1.get_deliveries()) == 1
    job_id = job.id
    store1.close()

    store2 = CronStore(db)
    mgr2 = CronManager(workspace_id="ws-persist", store=store2)
    restored = mgr2.get_job(job_id)
    assert restored is not None
    assert restored.name == "Nightly"
    assert restored.run_count == 1
    assert "report body" in (restored.last_output or "")
    hist = mgr2.get_history(job_id)
    assert len(hist) == 1
    assert hist[0].status == "success"
    assert len(mgr2.get_deliveries()) == 1
    assert mgr2.get_deliveries()[0]["target"] == "chat"

    # Isolation: another workspace does not see these jobs
    other = CronManager(workspace_id="ws-other", store=store2)
    assert other.list_jobs() == []
    store2.close()


def test_prompt_job_without_runner_is_not_synthetic_success():
    mgr = CronManager(workspace_id="ws-honest")
    job = mgr.create_job(schedule="every 1h", prompt="do work")
    occ = mgr.run_job(job.id, now=50.0)
    assert occ.status == "failed"
    assert occ.error == "backend_unavailable"
    assert AGENT_RUNNER_UNAVAILABLE in occ.output_preview
    assert job.error_count == 1
    assert mgr.get_incidents(job.id)
