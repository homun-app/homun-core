"""Base contracts and shared delivery helpers for messaging channel adapters (H33).

Separated from channel_adapters to prevent circular imports and bounded module sizes.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, List, Optional

from homun.application.gateway_contracts import ChannelMedia, ChannelMessage

logger = logging.getLogger(__name__)


def _token_from(config: Dict[str, Any], *env_keys: str) -> str:
    for key in ("bot_token", "token", "api_token"):
        val = str(config.get(key) or "").strip()
        if val:
            return val
    for env in env_keys:
        val = str(os.environ.get(env) or "").strip()
        if val:
            return val
    return ""


def _http_delivery_result(
    *,
    platform: str,
    channel_id: str,
    text: str,
    thread_id: Optional[str],
    reply_to_id: Optional[str],
    media: Optional[List[ChannelMedia]],
    delivered: bool,
    error: Optional[str] = None,
    status_code: Optional[int] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "delivered": delivered,
        "platform": platform,
        "channel_id": channel_id,
        "thread_id": thread_id,
        "reply_to_id": reply_to_id,
        "text": text,
        "media_count": len(media or []),
        "sent_at": time.time(),
    }
    if error:
        out["error"] = error
        out["code"] = "backend_unavailable"
    if status_code is not None:
        out["status_code"] = status_code
    if extra:
        out.update(extra)
    return out


class ChannelAdapter:
    """Base class for messaging channel adapters."""

    platform: str = "generic"

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = dict(config or {})

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        raise NotImplementedError

    def format_outbound(self, text: str, *, reply_to: Optional[str] = None) -> Dict[str, Any]:
        return {"text": text, "reply_to": reply_to}

    def send(
        self,
        channel_id: str,
        text: str,
        *,
        thread_id: Optional[str] = None,
        reply_to_id: Optional[str] = None,
        media: Optional[List[ChannelMedia]] = None,
    ) -> Dict[str, Any]:
        """Deliver outbound message to platform destination.

        Base adapters have no transport. Subclasses must override with a real
        client; otherwise Homun reports an explicit delivery failure.
        """
        return {
            "delivered": False,
            "platform": self.platform,
            "channel_id": channel_id,
            "thread_id": thread_id,
            "reply_to_id": reply_to_id,
            "text": text,
            "media_count": len(media or []),
            "sent_at": time.time(),
            "error": (
                f"Channel transport for platform '{self.platform}' is not configured. "
                "Refusing to report delivery without a real outbound client."
            ),
            "code": "backend_unavailable",
        }
