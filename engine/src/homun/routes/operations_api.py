"""FastAPI router for operations, profiles, configuration migrations, doctor diagnostics, and daemon control."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from homun.storage.paths import default_data_dir
from homun.application.profile_operations import (
    ProfileDistributionPackage,
    ProfileError,
    ProfileMetadata,
    ProfileNotFoundError,
    ProfileOperationsManager,
    ProfileValidationError,
)
from homun.application.config_lifecycle import (
    ConfigLifecycleManager,
    ConfigMigrationResult,
)
from homun.application.doctor_diagnostics import (
    DoctorDiagnostics,
    DoctorReport,
)
from homun.application.daemon_lifecycle import (
    DaemonManager,
    DaemonStatus,
)

router = APIRouter(prefix="/v1/operations", tags=["operations"])

_data_dir = default_data_dir()
_profile_mgr = ProfileOperationsManager(_data_dir / "profiles")
_config_mgr = ConfigLifecycleManager(_data_dir / "config")
_doctor = DoctorDiagnostics(_data_dir, config_lifecycle=_config_mgr)
_daemon_mgr = DaemonManager(_data_dir / "run")


# ── Profiles Schemas & Endpoints ───────────────────────────────────────────────

class CreateProfileRequest(BaseModel):
    name: str = Field(..., description="Unique profile identifier")
    description: Optional[str] = ""
    parent_profile: Optional[str] = None
    config_overrides: Optional[Dict[str, Any]] = None
    tags: Optional[List[str]] = None


class ImportProfileRequest(BaseModel):
    package_data: Dict[str, Any]
    target_name: Optional[str] = None
    overwrite: Optional[bool] = False


@router.get("/profiles")
def list_profiles() -> List[ProfileMetadata]:
    return _profile_mgr.list_profiles()


@router.post("/profiles")
def create_profile(req: CreateProfileRequest) -> ProfileMetadata:
    try:
        return _profile_mgr.create_profile(
            name=req.name,
            description=req.description or "",
            parent_profile=req.parent_profile,
            config_overrides=req.config_overrides,
            tags=req.tags,
        )
    except ProfileValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ProfileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/profiles/{name}")
def get_profile(name: str) -> ProfileMetadata:
    try:
        return _profile_mgr.get_profile(name)
    except ProfileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/profiles/{name}/activate")
def activate_profile(name: str) -> Dict[str, Any]:
    try:
        _profile_mgr.set_active_profile(name)
        return {"success": True, "active_profile": name}
    except ProfileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/profiles/{name}")
def delete_profile(name: str) -> Dict[str, Any]:
    try:
        _profile_mgr.delete_profile(name)
        return {"success": True, "deleted": name}
    except ProfileValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ProfileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/profiles/{name}/export")
def export_profile(name: str) -> Dict[str, Any]:
    try:
        return _profile_mgr.export_distribution_package(name)
    except ProfileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/profiles/import")
def import_profile(req: ImportProfileRequest) -> ProfileMetadata:
    try:
        return _profile_mgr.import_distribution_package(
            package_data=req.package_data,
            target_name=req.target_name,
            overwrite=bool(req.overwrite),
        )
    except ProfileValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Configuration Schemas & Endpoints ──────────────────────────────────────────

@router.get("/config")
def get_config() -> Dict[str, Any]:
    return _config_mgr.load_raw_config()


@router.post("/config/migrate")
def migrate_config() -> ConfigMigrationResult:
    return _config_mgr.migrate()


# ── Doctor Diagnostics Endpoints ───────────────────────────────────────────────

@router.get("/doctor")
def run_doctor_diagnostics(fix: bool = Query(False, description="Apply automated fixes")) -> DoctorReport:
    return _doctor.run_all(fix=fix)


@router.post("/doctor/repair")
def run_doctor_repair() -> DoctorReport:
    return _doctor.run_all(fix=True)


# ── Daemon Control Endpoints ───────────────────────────────────────────────────

@router.get("/daemon/status")
def get_daemon_status() -> DaemonStatus:
    return _daemon_mgr.status()


@router.post("/daemon/restart")
def restart_daemon() -> Dict[str, Any]:
    return _daemon_mgr.restart()
