"""FastAPI router for surface features, companion, achievements, tours/tips, cleanup, security guidance, and catalog packs."""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from homun.storage.paths import default_data_dir
from homun.application.surface_companion import (
    CompanionManager,
    PetState,
)
from homun.application.surface_achievements import (
    Achievement,
    AchievementTracker,
)
from homun.application.surface_tours_tips import (
    Tip,
    TourAndTipManager,
    TourStep,
)
from homun.application.surface_cleanup import (
    CleanupExecutionReport,
    CleanupScanReport,
    DiskCleanupEngine,
)
from homun.application.surface_security_guidance import (
    SecurityAdvisory,
    SecurityGuidanceScanner,
)
from homun.application.surface_catalog_packs import (
    CatalogPacksManager,
    SkillPack,
)

router = APIRouter(prefix="/v1/catalog", tags=["surface_catalog"])

_data_dir = default_data_dir()
_companion_mgr = CompanionManager(_data_dir / "companion" / "pet_state.json")
_achievements_tracker = AchievementTracker(_data_dir / "achievements" / "unlocked.json")
_tour_tip_mgr = TourAndTipManager()
_cleanup_engine = DiskCleanupEngine(_data_dir)
_security_scanner = SecurityGuidanceScanner()
_packs_mgr = CatalogPacksManager(_data_dir / "skills_catalog")


# ── Companion & Skins ──────────────────────────────────────────────────────────

class ToggleCompanionRequest(BaseModel):
    enabled: bool


class SetSkinRequest(BaseModel):
    skin_id: str


class CompanionActionRequest(BaseModel):
    action: str = Field(..., description="feed, play, rest")


@router.get("/companion/state")
def get_companion_state() -> Dict[str, Any]:
    return _companion_mgr.render()


@router.post("/companion/toggle")
def toggle_companion(req: ToggleCompanionRequest) -> PetState:
    return _companion_mgr.set_enabled(req.enabled)


@router.post("/companion/skin")
def set_companion_skin(req: SetSkinRequest) -> PetState:
    try:
        return _companion_mgr.set_skin(req.skin_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/companion/action")
def companion_action(req: CompanionActionRequest) -> PetState:
    act = req.action.lower()
    if act == "feed":
        return _companion_mgr.feed()
    if act == "play":
        return _companion_mgr.play()
    if act == "rest":
        return _companion_mgr.rest()
    raise HTTPException(status_code=400, detail=f"Unknown companion action '{req.action}'")


# ── Achievements ───────────────────────────────────────────────────────────────

class UnlockAchievementRequest(BaseModel):
    achievement_id: str


@router.get("/achievements")
def list_achievements() -> Dict[str, Any]:
    return {
        "score": _achievements_tracker.get_score(),
        "achievements": _achievements_tracker.list_all(),
    }


@router.post("/achievements/unlock")
def unlock_achievement(req: UnlockAchievementRequest) -> Achievement:
    ach = _achievements_tracker.unlock(req.achievement_id)
    if not ach:
        raise HTTPException(status_code=404, detail="Achievement not found")
    return ach


# ── Tours & Tips ───────────────────────────────────────────────────────────────

@router.get("/tour")
def get_onboarding_tour() -> List[TourStep]:
    return _tour_tip_mgr.get_tour()


@router.get("/tips")
def get_tips(category: Optional[str] = Query(None)) -> List[Tip]:
    return _tour_tip_mgr.get_tips(category=category)


@router.get("/tips/random")
def get_random_tip(category: Optional[str] = Query(None)) -> Tip:
    return _tour_tip_mgr.get_random_tip(category=category)


# ── Disk Cleanup ───────────────────────────────────────────────────────────────

class CleanupExecuteRequest(BaseModel):
    categories: Optional[List[str]] = None


@router.post("/cleanup/scan")
def scan_cleanup() -> CleanupScanReport:
    return _cleanup_engine.scan()


@router.post("/cleanup/execute")
def execute_cleanup(req: CleanupExecuteRequest) -> CleanupExecutionReport:
    return _cleanup_engine.execute(categories=req.categories)


# ── Security Guidance ──────────────────────────────────────────────────────────

class SecurityScanRequest(BaseModel):
    text: str


@router.post("/security/scan")
def scan_security(req: SecurityScanRequest) -> List[SecurityAdvisory]:
    return _security_scanner.scan(req.text)


# ── Catalog Packs & Shipped Skills ─────────────────────────────────────────────

class PackActionRequest(BaseModel):
    pack_id: str


@router.get("/packs")
def list_catalog_packs() -> List[SkillPack]:
    return _packs_mgr.get_catalog_manifest()


@router.post("/packs/install")
def install_pack(req: PackActionRequest) -> SkillPack:
    try:
        return _packs_mgr.install_pack(req.pack_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/packs/uninstall")
def uninstall_pack(req: PackActionRequest) -> Dict[str, Any]:
    uninstalled = _packs_mgr.uninstall_pack(req.pack_id)
    return {"success": uninstalled, "pack_id": req.pack_id}
