"""REST API routes for inference providers, credential pools, and auxiliary routing (H38)."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from homun.application.credential_pool import get_credential_pool
from homun.application.provider_registry import get_provider_registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["providers"])


class AddCredentialRequest(BaseModel):
    provider: str
    secret_value: str
    key_id: Optional[str] = None


class ReportCredentialRequest(BaseModel):
    provider: str
    key_id: str
    status: str  # "success" | "failure"
    error_type: Optional[str] = "rate_limit"
    cooldown_seconds: float = 60.0


class AdaptFixtureRequest(BaseModel):
    reasoning_effort: Optional[str] = None
    media_item: Optional[Dict[str, Any]] = None
    schema_def: Optional[Dict[str, Any]] = None


@router.get("/providers", response_model=List[Dict[str, Any]])
def list_providers() -> List[Dict[str, Any]]:
    """List all registered provider profiles and declared capabilities."""
    registry = get_provider_registry()
    profiles = registry.list_profiles()
    return [
        {
            "name": p.name,
            "display_name": p.display_name,
            "description": p.description,
            "api_mode": p.api_mode,
            "auth_type": p.auth_type,
            "base_url": p.base_url,
            "supports_vision": p.supports_vision,
            "supports_vision_tool_messages": p.supports_vision_tool_messages,
            "reasoning_format": p.reasoning_format,
            "supported_reasoning_efforts": p.supported_reasoning_efforts,
            "default_aux_model": p.default_aux_model,
            "fallback_models": p.fallback_models,
        }
        for p in profiles
    ]


@router.get("/providers/{name}", response_model=Dict[str, Any])
def get_provider(name: str) -> Dict[str, Any]:
    """Retrieve details of a specific provider profile."""
    registry = get_provider_registry()
    p = registry.get_profile(name)
    if not p:
        raise HTTPException(status_code=404, detail=f"Provider '{name}' not found")

    return {
        "name": p.name,
        "display_name": p.display_name,
        "description": p.description,
        "api_mode": p.api_mode,
        "auth_type": p.auth_type,
        "base_url": p.base_url,
        "supports_vision": p.supports_vision,
        "supports_vision_tool_messages": p.supports_vision_tool_messages,
        "reasoning_format": p.reasoning_format,
        "supported_reasoning_efforts": p.supported_reasoning_efforts,
        "default_aux_model": p.default_aux_model,
        "fallback_models": p.fallback_models,
    }


@router.post("/providers/{name}/adapt", response_model=Dict[str, Any])
def adapt_fixture(name: str, req: AdaptFixtureRequest) -> Dict[str, Any]:
    """Demonstrate wire adaptation of reasoning, media, and schema for this provider."""
    registry = get_provider_registry()
    p = registry.get_profile(name)
    if not p:
        raise HTTPException(status_code=404, detail=f"Provider '{name}' not found")

    extra_body, top_level = p.adapt_reasoning(req.reasoning_effort)
    media_res = p.adapt_media_fixture(req.media_item) if req.media_item else None
    schema_res = p.adapt_schema(req.schema_def) if req.schema_def else None

    return {
        "provider": p.name,
        "adapted_reasoning": {
            "extra_body": extra_body,
            "top_level": top_level,
        },
        "adapted_media": media_res,
        "adapted_schema": schema_res,
    }


@router.get("/credentials/pool", response_model=List[Dict[str, Any]])
def list_credentials(provider: Optional[str] = None) -> List[Dict[str, Any]]:
    """List credentials in the multi-credential pool with masked secrets."""
    pool = get_credential_pool()
    creds = pool.list_credentials(provider=provider)
    return [
        {
            "key_id": c.key_id,
            "provider": c.provider,
            "masked_secret": c.masked_value(),
            "status": c.status,
            "is_available": c.is_available,
            "usage_count": c.usage_count,
            "error_count": c.error_count,
            "last_used_at": c.last_used_at,
            "last_error": c.last_error,
        }
        for c in creds
    ]


@router.post("/credentials/pool", response_model=Dict[str, Any])
def add_credential(req: AddCredentialRequest) -> Dict[str, Any]:
    """Add a credential to the pool for failover rotation."""
    pool = get_credential_pool()
    cred = pool.add_credential(req.provider, req.secret_value, key_id=req.key_id)
    return {
        "key_id": cred.key_id,
        "provider": cred.provider,
        "status": cred.status,
        "masked_secret": cred.masked_value(),
    }


@router.post("/credentials/pool/report", response_model=Dict[str, Any])
def report_credential(req: ReportCredentialRequest) -> Dict[str, Any]:
    """Report success or error to trigger rotation or cooldown."""
    pool = get_credential_pool()
    if req.status == "success":
        pool.report_success(req.provider, req.key_id)
    else:
        pool.report_failure(
            req.provider, req.key_id, req.error_type or "error", req.cooldown_seconds
        )
    return {"success": True, "provider": req.provider, "key_id": req.key_id}
