"""Tests for H44 Optional Operations: Profiles, Distributions, Doctor Diagnostics, Config Migrations, and Daemon Lifecycle."""

import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.profile_operations import (
    ProfileOperationsManager,
    ProfileValidationError,
    ProfileNotFoundError,
)
from homun.application.config_lifecycle import (
    ConfigLifecycleManager,
    CURRENT_CONFIG_SCHEMA_VERSION,
)
from homun.application.doctor_diagnostics import DoctorDiagnostics
from homun.application.daemon_lifecycle import DaemonManager


def test_profile_operations_lifecycle_and_distribution(tmp_path: Path):
    profiles_dir = tmp_path / "profiles"
    mgr = ProfileOperationsManager(profiles_dir)

    # 1. Default profile initialized
    profiles = mgr.list_profiles()
    assert len(profiles) == 1
    assert profiles[0].name == "default"
    assert profiles[0].is_active is True

    # 2. Create new profile
    meta = mgr.create_profile(
        name="researcher",
        description="Isolated research profile",
        config_overrides={"model": "gpt-5-mini", "temperature": 0.2},
        tags=["research", "deep-reasoning"],
    )
    assert meta.name == "researcher"
    assert mgr.get_profile("researcher").description == "Isolated research profile"

    # Invalid names rejected
    with pytest.raises(ProfileValidationError):
        mgr.create_profile(name="invalid name with spaces!")

    # Switch active profile
    mgr.set_active_profile("researcher")
    assert mgr.get_active_profile_name() == "researcher"
    assert mgr.get_profile("researcher").is_active is True

    # Protection: cannot delete active profile
    with pytest.raises(ProfileValidationError, match="Cannot delete active"):
        mgr.delete_profile("researcher")

    # Protection: cannot delete default profile
    mgr.set_active_profile("default")
    with pytest.raises(ProfileValidationError, match="Cannot delete default"):
        mgr.delete_profile("default")

    # 3. Export distribution package
    pkg = mgr.export_distribution_package("researcher")
    assert pkg["profile"]["name"] == "researcher"
    assert "checksum" in pkg
    assert pkg["config_content"]["model"] == "gpt-5-mini"

    # 4. Import distribution package with integrity verification
    imported = mgr.import_distribution_package(pkg, target_name="coder")
    assert imported.name == "coder"
    assert imported.config_overrides["model"] == "gpt-5-mini"

    # Tampered checksum fails import
    tampered_pkg = dict(pkg)
    tampered_pkg["checksum"] = "bad_checksum_12345"
    with pytest.raises(ProfileValidationError, match="Integrity check failed"):
        mgr.import_distribution_package(tampered_pkg, target_name="tampered")

    # Clean deletion of inactive profile
    mgr.delete_profile("coder")
    assert len(mgr.list_profiles()) == 2


def test_config_lifecycle_and_migration(tmp_path: Path):
    config_dir = tmp_path / "config"
    mgr = ConfigLifecycleManager(config_dir)

    # 1. Default config load
    cfg = mgr.load_raw_config()
    assert cfg["schema_version"] == CURRENT_CONFIG_SCHEMA_VERSION

    # 2. Simulate legacy v1 config
    legacy_v1 = {
        "schema_version": 1,
        "terminal_env": "docker",
        "providers": ["openai", "anthropic"],
    }
    mgr.save_config(legacy_v1)
    assert mgr.get_schema_version(mgr.load_raw_config()) == 1

    # 3. Run migration
    res = mgr.migrate()
    assert res.success is True
    assert res.from_version == 1
    assert res.to_version == CURRENT_CONFIG_SCHEMA_VERSION
    assert res.backup_path is not None

    migrated = mgr.load_raw_config()
    assert migrated["schema_version"] == CURRENT_CONFIG_SCHEMA_VERSION
    assert migrated["terminal"]["backend"] == "docker"
    assert migrated["safety"]["egress_filtering"] is True
    assert isinstance(migrated["providers"], dict)
    assert migrated["providers"]["profiles"] == ["openai", "anthropic"]


def test_doctor_diagnostics(tmp_path: Path):
    data_dir = tmp_path / "homun_data"
    data_dir.mkdir(parents=True)
    cfg_mgr = ConfigLifecycleManager(data_dir / "config")
    doctor = DoctorDiagnostics(data_dir, config_lifecycle=cfg_mgr)

    report = doctor.run_all(fix=False)
    assert report.all_passed is True
    assert len(report.findings) >= 8

    # Verify key finding categories
    categories = {f.category for f in report.findings}
    assert "platform" in categories
    assert "tools" in categories
    assert "backend" in categories
    assert "storage" in categories
    assert "config" in categories

    # Auto-repair run
    repair_report = doctor.run_all(fix=True)
    assert repair_report.all_passed is True


def test_daemon_lifecycle(tmp_path: Path):
    run_dir = tmp_path / "run"
    daemon = DaemonManager(run_dir)

    # Initially stopped
    st = daemon.status()
    assert st.state == "stopped"
    assert st.is_alive is False

    # Write current PID
    my_pid = daemon.write_pid()
    assert daemon.read_pid() == my_pid
    st = daemon.status()
    assert st.state == "running"
    assert st.is_alive is True

    # Stale PID detection
    fake_pid = 999999
    daemon.write_pid(fake_pid)
    st = daemon.status()
    assert st.state == "stale_pid"
    assert st.is_alive is False

    # Clear PID
    daemon.clear_pid()
    assert daemon.status().state == "stopped"


def test_operations_fastapi_endpoints():
    app = create_app()
    client = TestClient(app)

    # Profiles list
    profiles_resp = client.get("/v1/operations/profiles")
    assert profiles_resp.status_code == 200
    assert any(p["name"] == "default" for p in profiles_resp.json())

    # Doctor check
    doctor_resp = client.get("/v1/operations/doctor")
    assert doctor_resp.status_code == 200
    assert "all_passed" in doctor_resp.json()

    # Daemon status
    daemon_resp = client.get("/v1/operations/daemon/status")
    assert daemon_resp.status_code == 200
    assert daemon_resp.json()["state"] in ("stopped", "running", "stale_pid")

    # Config migration
    cfg_resp = client.post("/v1/operations/config/migrate")
    assert cfg_resp.status_code == 200
    assert cfg_resp.json()["success"] is True
