"""FastAPI router for Gateway DM pairing management (H32/H33)."""
from __future__ import annotations

from typing import Any, Dict, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from homun.application.gateway_pairing import (
    get_gateway_pairing_manager,
)

router = APIRouter(prefix="/v1/gateway/pairing", tags=["gateway_pairing"])


class PairingCreateRequest(BaseModel):
    platform: str
    user_id: str
    username: Optional[str] = None


class PairingCodeRequest(BaseModel):
    code: str


class PairingRevokeRequest(BaseModel):
    platform: str
    user_id: str


@router.get("", response_model=Dict[str, Any])
def list_pairing_requests(
    platform: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
) -> Dict[str, Any]:
    mgr = get_gateway_pairing_manager()
    reqs = mgr.list_pairing_requests(platform=platform, status=status)
    return {
        "count": len(reqs),
        "requests": [r.to_dict() for r in reqs],
    }


@router.post("/request", response_model=Dict[str, Any])
def request_pairing(req: PairingCreateRequest) -> Dict[str, Any]:
    mgr = get_gateway_pairing_manager()
    try:
        pairing = mgr.request_pairing(
            platform=req.platform,
            user_id=req.user_id,
            username=req.username,
        )
        return {"status": "requested", "pairing": pairing.to_dict()}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "pairing_error", "message": str(exc)})


@router.post("/approve", response_model=Dict[str, Any])
def approve_pairing(req: PairingCodeRequest) -> Dict[str, Any]:
    mgr = get_gateway_pairing_manager()
    try:
        pairing = mgr.approve_code(req.code)
        return {"status": "approved", "pairing": pairing.to_dict()}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "pairing_error", "message": str(exc)})


@router.post("/decline", response_model=Dict[str, Any])
def decline_pairing(req: PairingCodeRequest) -> Dict[str, Any]:
    mgr = get_gateway_pairing_manager()
    try:
        pairing = mgr.decline_code(req.code)
        return {"status": "declined", "pairing": pairing.to_dict()}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "pairing_error", "message": str(exc)})


@router.post("/revoke", response_model=Dict[str, Any])
def revoke_pairing(req: PairingRevokeRequest) -> Dict[str, Any]:
    mgr = get_gateway_pairing_manager()
    revoked = mgr.revoke_user(req.platform, req.user_id)
    return {
        "status": "revoked" if revoked else "not_found",
        "platform": req.platform,
        "user_id": req.user_id,
    }
