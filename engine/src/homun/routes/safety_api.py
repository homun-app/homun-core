"""REST API routes for path security, URL safety, secret redaction, vault store, and write approvals (H40)."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from homun.application.path_security import check_path_safety
from homun.application.secret_redaction import redact_secrets
from homun.application.url_safety import is_safe_url, normalize_url_for_request
from homun.application.vault_store import VaultItemMetadata, VaultStore
from homun.application.write_approval_gate import get_write_approval_gate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/safety", tags=["safety"])

_VAULT_INSTANCE: Optional[VaultStore] = None


def _get_vault() -> VaultStore:
    global _VAULT_INSTANCE
    if _VAULT_INSTANCE is None:
        _VAULT_INSTANCE = VaultStore()
    return _VAULT_INSTANCE


# Request/Response models
class PathValidateRequest(BaseModel):
    path: str
    root: Optional[str] = None
    allow_sensitive: bool = False


class PathValidateResponse(BaseModel):
    is_safe: bool
    error: Optional[str] = None


class UrlValidateRequest(BaseModel):
    url: str
    allow_private: bool = False
    resolve_dns: bool = False


class UrlValidateResponse(BaseModel):
    is_safe: bool
    normalized_url: str
    error: Optional[str] = None


class RedactRequest(BaseModel):
    text: str


class RedactResponse(BaseModel):
    redacted_text: str


class VaultItemCreateRequest(BaseModel):
    kind: str
    label: str
    secret_payload: Dict[str, str]
    origin: Optional[str] = None


class VaultItemResponse(BaseModel):
    id: str
    kind: str
    label: str
    origin: Optional[str] = None
    created_at: str
    updated_at: str


class ApprovalStageRequest(BaseModel):
    subsystem: str
    action: str
    payload: Dict[str, Any]
    summary: str
    origin: str = "foreground"


class ApprovalResolveRequest(BaseModel):
    decision: str = Field(description="'approve' or 'reject'")
    reason: Optional[str] = None


@router.post("/path/validate", response_model=PathValidateResponse)
def validate_path(req: PathValidateRequest) -> PathValidateResponse:
    """Validate filesystem path against traversal and security policies."""
    is_safe, error = check_path_safety(req.path, req.root, allow_sensitive=req.allow_sensitive)
    return PathValidateResponse(is_safe=is_safe, error=error)


@router.post("/url/validate", response_model=UrlValidateResponse)
def validate_url(req: UrlValidateRequest) -> UrlValidateResponse:
    """Validate URL against SSRF, private address, and sensitive parameter policies."""
    norm = normalize_url_for_request(req.url)
    is_safe, error = is_safe_url(norm, allow_private=req.allow_private, resolve_dns=req.resolve_dns)
    return UrlValidateResponse(is_safe=is_safe, normalized_url=norm, error=error)


@router.post("/redact", response_model=RedactResponse)
def redact_content(req: RedactRequest) -> RedactResponse:
    """Scrub sensitive credentials, tokens, and keys from text."""
    redacted = redact_secrets(req.text)
    return RedactResponse(redacted_text=redacted)


@router.post("/vault/items", response_model=VaultItemResponse)
def create_vault_item(req: VaultItemCreateRequest) -> VaultItemResponse:
    """Store encrypted credential item in local vault."""
    vault = _get_vault()
    try:
        meta = vault.store_item(
            kind=req.kind,
            label=req.label,
            secret_payload=req.secret_payload,
            origin=req.origin,
        )
        return VaultItemResponse(
            id=meta.id,
            kind=meta.kind,
            label=meta.label,
            origin=meta.origin,
            created_at=meta.created_at,
            updated_at=meta.updated_at,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/vault/items", response_model=List[VaultItemResponse])
def list_vault_items(kind: Optional[str] = None) -> List[VaultItemResponse]:
    """List metadata for items in vault (model-safe, no secrets)."""
    vault = _get_vault()
    items = vault.list_items(kind=kind)
    return [
        VaultItemResponse(
            id=i.id,
            kind=i.kind,
            label=i.label,
            origin=i.origin,
            created_at=i.created_at,
            updated_at=i.updated_at,
        )
        for i in items
    ]


@router.delete("/vault/items/{item_id}", response_model=Dict[str, bool])
def delete_vault_item(item_id: str) -> Dict[str, bool]:
    """Delete an item from the vault."""
    vault = _get_vault()
    deleted = vault.delete_item(item_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Vault item '{item_id}' not found.")
    return {"deleted": True}


@router.post("/approvals/stage", response_model=Dict[str, Any])
def stage_approval(req: ApprovalStageRequest) -> Dict[str, Any]:
    """Stage a write action for approval."""
    gate = get_write_approval_gate()
    record = gate.stage_action(
        subsystem=req.subsystem,
        action=req.action,
        payload=req.payload,
        summary=req.summary,
        origin=req.origin,
    )
    return {
        "id": record.id,
        "subsystem": record.subsystem,
        "action": record.action,
        "summary": record.summary,
        "status": record.status,
        "origin": record.origin,
        "created_at": record.created_at,
    }


@router.get("/approvals/pending", response_model=List[Dict[str, Any]])
def list_pending_approvals(subsystem: Optional[str] = None) -> List[Dict[str, Any]]:
    """List pending write approval actions."""
    gate = get_write_approval_gate()
    records = gate.list_pending(subsystem=subsystem)
    return [
        {
            "id": r.id,
            "subsystem": r.subsystem,
            "action": r.action,
            "summary": r.summary,
            "status": r.status,
            "origin": r.origin,
            "created_at": r.created_at,
        }
        for r in records
    ]


@router.post("/approvals/{action_id}/resolve", response_model=Dict[str, Any])
def resolve_approval(action_id: str, req: ApprovalResolveRequest) -> Dict[str, Any]:
    """Resolve a pending approval action (approve or reject)."""
    gate = get_write_approval_gate()
    if req.decision.lower() == "approve":
        success, result, error = gate.approve_and_execute(action_id)
        if not success:
            raise HTTPException(status_code=400, detail=error or "Approval execution failed.")
        return {"id": action_id, "status": "approved", "result": result}
    elif req.decision.lower() == "reject":
        success, error = gate.reject_action(action_id, reason=req.reason)
        if not success:
            raise HTTPException(status_code=400, detail=error or "Rejection failed.")
        return {"id": action_id, "status": "rejected", "reason": req.reason}
    else:
        raise HTTPException(status_code=400, detail="Invalid decision; must be 'approve' or 'reject'.")
