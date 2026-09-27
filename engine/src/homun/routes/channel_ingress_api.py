"""FastAPI router for Channel Inbound Ingress, Queuing, Recovery, and Polling (H32/H33/D1)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from homun.application.channel_adapters import ChannelRegistry
from homun.application.channel_delivery_recovery import ChannelPoller, get_channel_delivery_supervisor
from homun.application.channel_inbound_queue import InboundChannelQueue, get_inbound_channel_queue

router = APIRouter(prefix="/v1/gateway/channels", tags=["gateway_channels"])

_GLOBAL_CHANNEL_REGISTRY: Optional[ChannelRegistry] = None


def get_channel_registry() -> ChannelRegistry:
    global _GLOBAL_CHANNEL_REGISTRY
    if _GLOBAL_CHANNEL_REGISTRY is None:
        _GLOBAL_CHANNEL_REGISTRY = ChannelRegistry(
            inbound_queue=get_inbound_channel_queue(),
            delivery_supervisor=get_channel_delivery_supervisor(),
        )
    return _GLOBAL_CHANNEL_REGISTRY


def reset_channel_registry() -> None:
    global _GLOBAL_CHANNEL_REGISTRY
    _GLOBAL_CHANNEL_REGISTRY = None


class RecoverQueueResponse(BaseModel):
    recovered_count: int


@router.post("/{platform}/inbound", response_model=Dict[str, Any])
async def ingest_channel_inbound(
    platform: str,
    request: Request,
) -> Dict[str, Any]:
    """Ingress webhook for messaging platforms: persists to queue, checks pairing, leases turn, and delivers response."""
    try:
        raw_payload = await request.json()
    except Exception:
        raw_payload = {}

    registry = get_channel_registry()
    adapter = registry.get_adapter(platform)
    if not adapter:
        raise HTTPException(
            status_code=404,
            detail={"code": "channel_platform_unsupported", "message": f"Platform '{platform}' is not supported."},
        )

    # Echo or simple reply handler for webhook ingress
    def default_ingress_handler(msg) -> str:
        return f"Echo from Homun: {msg.text}"

    try:
        result = registry.dispatch_inbound(platform, raw_payload, default_ingress_handler)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "inbound_error", "message": str(exc)})
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"code": "inbound_failed", "message": str(exc)})


@router.get("/queue", response_model=Dict[str, Any])
def list_inbound_queue_items(
    platform: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> Dict[str, Any]:
    queue = get_inbound_channel_queue()
    items = queue.list_items(platform=platform, status=status, limit=limit)
    return {
        "count": len(items),
        "items": [it.to_dict() for it in items],
    }


@router.post("/queue/recover", response_model=RecoverQueueResponse)
def recover_stale_inbound_queue(
    max_age_seconds: float = Query(60.0, ge=1.0),
) -> RecoverQueueResponse:
    queue = get_inbound_channel_queue()
    recovered = queue.recover_stale_claims(max_age_seconds=max_age_seconds)
    return RecoverQueueResponse(recovered_count=recovered)


@router.post("/{platform}/poll-once", response_model=Dict[str, Any])
def poll_channel_once(
    platform: str,
    timeout: int = Query(5, ge=1, le=30),
) -> Dict[str, Any]:
    """Execute a single polling iteration for polling-capable channels (e.g. Telegram getUpdates)."""
    plat = platform.strip().lower()
    registry = get_channel_registry()
    adapter = registry.get_adapter(plat)
    if not adapter:
        raise HTTPException(status_code=404, detail={"code": "channel_platform_unsupported", "message": f"Platform '{platform}' is not supported."})

    token = getattr(adapter, "config", {}).get("bot_token") or getattr(adapter, "config", {}).get("TELEGRAM_BOT_TOKEN")
    if not token and plat == "telegram":
        raise HTTPException(status_code=400, detail={"code": "credentials_missing", "message": f"No bot token configured for {plat} polling."})

    queue = get_inbound_channel_queue()

    def _ingest_update(upd: Dict[str, Any]) -> None:
        try:
            msg = adapter.parse_inbound(upd)
            queue.enqueue(plat, upd, msg)
        except Exception:
            pass

    poller = ChannelPoller(plat, token or "", _ingest_update)
    updates = poller.poll_once(timeout=timeout)
    return {
        "platform": plat,
        "polled_count": len(updates),
        "updates": updates,
    }
