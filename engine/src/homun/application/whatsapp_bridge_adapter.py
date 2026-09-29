"""WhatsApp via the local wa-rs-bridge sidecar (H-personal account path).

The Rust sidecar (github.com/homunbot/wa-rs, crate ``wa-rs-bridge``) owns the
WhatsApp Web session. Homun delivers outbound messages through its local HTTP
API and receives inbound traffic as callback posts on the generic channel
ingress route. An unreachable bridge is always a typed delivery failure,
never a silent success.
"""
from __future__ import annotations

import os
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx

from homun.application.channel_contracts import ChannelAdapter, _http_delivery_result, _token_from
from homun.application.gateway_contracts import ChannelMedia, ChannelMessage

DEFAULT_BRIDGE_URL = "http://127.0.0.1:8902"


def _strip_device_suffix(jid: str) -> str:
    """Drop the :NN device suffix: one identity, many devices.

    The same WhatsApp account (and the self-chat companion) addresses traffic
    with or without a device suffix; authorization and conversation identity
    must see the bare form.
    """
    head, sep, domain = jid.partition("@")
    if sep and ":" in head:
        head = head.split(":", 1)[0]
    return f"{head}{sep}{domain}" if sep else head.split(":", 1)[0]


class WhatsAppBridgeAdapter(ChannelAdapter):
    """WhatsApp personal account through the wa-rs-bridge sidecar."""

    platform = "whatsapp"

    def bridge_url(self) -> str:
        raw = str(
            self.config.get("bridge_url")
            or os.environ.get("HOMUN_WHATSAPP_BRIDGE_URL")
            or DEFAULT_BRIDGE_URL
        ).strip()
        return raw.rstrip("/")

    def bridge_status(self, timeout: float = 5.0) -> Optional[Dict[str, Any]]:
        """Return the sidecar status document, or None when unreachable."""
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.get(f"{self.bridge_url()}/status")
            if resp.status_code == 200:
                data = resp.json()
                return data if isinstance(data, dict) else None
        except (httpx.HTTPError, ValueError):
            return None
        return None

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        msg = payload.get("message") or {}
        chat = str(msg.get("chat") or "")
        sender = str(msg.get("sender") or chat)
        push_name = str(msg["push_name"]) if msg.get("push_name") else None
        if msg.get("self_echo"):
            # The self-chat companion echoed the owner's own note back: the
            # conversation identity must be the human, not the system JID.
            owner = msg.get("owner") or {}
            sender = str(owner.get("jid") or owner.get("lid") or sender)
            push_name = push_name or "note personali"
        sender = _strip_device_suffix(sender)
        is_group = bool(msg.get("is_group"))
        timestamp = _parse_timestamp(msg.get("timestamp"))
        return ChannelMessage(
            id=str(msg.get("id") or ""),
            platform=self.platform,
            channel_id=chat,
            user_id=sender,
            username=push_name,
            text=str(msg.get("text") or ""),
            is_direct=not is_group,
            timestamp=timestamp,
        )

    def send(
        self,
        channel_id: str,
        text: str,
        *,
        thread_id: Optional[str] = None,
        reply_to_id: Optional[str] = None,
        media: Optional[List[ChannelMedia]] = None,
    ) -> Dict[str, Any]:
        body = {"to": channel_id, "text": text}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(f"{self.bridge_url()}/send", json=body)
            data = resp.json() if resp.content else {}
            if resp.status_code == 200 and isinstance(data, dict) and data.get("ok"):
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=True,
                    status_code=resp.status_code,
                    extra={"provider_message_id": data.get("id")},
                )
            error = str((data or {}).get("error") or f"bridge HTTP {resp.status_code}")
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=False,
                error=error,
                status_code=resp.status_code,
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=False,
                error=f"wa-rs-bridge unreachable at {self.bridge_url()}: {exc}",
            )


def _parse_timestamp(value: Any) -> float:
    if value is None:
        return time.time()
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


# ── Meta Cloud API (business path) ────────────────────────────────────

class WhatsAppCloudApiAdapter(ChannelAdapter):
    """Official Meta Cloud API (business deployments).

    The ``whatsapp`` platform is the personal-account wa-rs-bridge; this
    adapter serves the Meta-hosted path under its own platform id.
    """

    platform = "whatsapp_cloud"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        entry = (payload.get("entry") or [{}])[0]
        changes = (entry.get("changes") or [{}])[0]
        val = changes.get("value") or {}
        msg = (val.get("messages") or [{}])[0]

        from_number = str(msg.get("from") or "")
        text_obj = msg.get("text") or {}
        text = str(text_obj.get("body") or "")

        return ChannelMessage(
            id=str(msg.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=from_number,
            user_id=from_number,
            text=text,
            is_direct=True,
            timestamp=float(msg.get("timestamp") or time.time()),
        )

    def send(
        self,
        channel_id: str,
        text: str,
        *,
        thread_id: Optional[str] = None,
        reply_to_id: Optional[str] = None,
        media: Optional[List[ChannelMedia]] = None,
    ) -> Dict[str, Any]:
        token = _token_from(
            self.config,
            "WHATSAPP_TOKEN",
            "HOMUN_WHATSAPP_TOKEN",
            "WHATSAPP_ACCESS_TOKEN",
        )
        phone_number_id = str(
            self.config.get("phone_number_id")
            or os.environ.get("WHATSAPP_PHONE_NUMBER_ID")
            or os.environ.get("HOMUN_WHATSAPP_PHONE_NUMBER_ID")
            or ""
        ).strip()
        if not token or not phone_number_id:
            return super().send(
                channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media
            )
        version = str(self.config.get("api_version") or "v21.0")
        url = f"https://graph.facebook.com/{version}/{phone_number_id}/messages"
        payload: Dict[str, Any] = {
            "messaging_product": "whatsapp",
            "to": channel_id,
            "type": "text",
            "text": {"body": text},
        }
        if reply_to_id:
            payload["context"] = {"message_id": reply_to_id}
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=payload, headers=headers)
            data = resp.json() if resp.content else {}
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"WhatsApp API HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            msg_id = None
            if isinstance(data, dict):
                messages = data.get("messages") or []
                if messages and isinstance(messages[0], dict):
                    msg_id = messages[0].get("id")
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
                status_code=resp.status_code,
                extra={"provider_message_id": msg_id},
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=False,
                error=str(exc),
            )

# Backward-compatible name for the Cloud API adapter (historical callers).
WhatsAppAdapter = WhatsAppCloudApiAdapter
