"""Extended messaging adapters (H33).

Includes A2A, Buzz, Home Assistant, MS Graph webhook, Open WebUI,
Photon, and Raft adapters, plus re-exports for relay adapters.
Follows the ChannelAdapter honesty contract: refusal without real credentials.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional
import uuid

import httpx

from homun.application.channel_contracts import (
    ChannelAdapter,
    _http_delivery_result,
    _token_from,
)
from homun.application.channel_adapters_relay import (
    TeamsMeetingsAdapter,
    WeComCallbackAdapter,
    WhatsAppCloudAdapter,
    YuanbaoAdapter,
)
from homun.application.gateway_contracts import ChannelMedia, ChannelMessage


class A2AAdapter(ChannelAdapter):
    """Agent-to-Agent (A2A) protocol HTTP transport (Messaging catalog: a2a)."""

    platform = "a2a"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        message = payload.get("message") or payload
        parts = message.get("parts") or []
        text = ""
        for p in parts:
            if isinstance(p, dict) and p.get("text"):
                text += p["text"]
            elif isinstance(p, str):
                text += p
        if not text:
            text = str(payload.get("text") or message.get("text") or "")
        return ChannelMessage(
            id=str(message.get("id") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("context_id") or payload.get("channel_id") or message.get("context_id") or ""),
            user_id=str(message.get("sender") or payload.get("user_id") or "remote_agent"),
            text=text,
            is_direct=True,
            timestamp=float(payload.get("timestamp") or time.time()),
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
        base = (
            str(self.config.get("base_url") or "").strip()
            or str(os.environ.get("A2A_AGENT_URL") or os.environ.get("HOMUN_A2A_AGENT_URL") or "").strip()
        )
        token = _token_from(self.config, "A2A_BEARER_TOKEN", "HOMUN_A2A_BEARER_TOKEN")
        if not base:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{base.rstrip('/')}/message:send"
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = {
            "message": {
                "role": "user",
                "parts": [{"text": text}],
                "context_id": channel_id,
            }
        }
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=body, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"A2A HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
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
                error=str(exc),
            )


class BuzzAdapter(ChannelAdapter):
    """Buzz HTTP webhook send (Messaging catalog: buzz)."""

    platform = "buzz"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("channel") or payload.get("channel_id") or ""),
            user_id=str(payload.get("user") or payload.get("user_id") or ""),
            text=str(payload.get("text") or payload.get("message") or ""),
            is_direct=False,
            timestamp=float(payload.get("timestamp") or time.time()),
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
        webhook = (
            str(self.config.get("webhook_url") or "").strip()
            or str(os.environ.get("BUZZ_WEBHOOK_URL") or os.environ.get("HOMUN_BUZZ_WEBHOOK_URL") or "").strip()
        )
        if not webhook.startswith("http") and channel_id.startswith("http"):
            webhook = channel_id
        if not webhook.startswith("http"):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        body = {"channel": channel_id if not channel_id.startswith("http") else None, "text": text}
        body = {k: v for k, v in body.items() if v is not None}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(webhook, json=body)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Buzz HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
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
                error=str(exc),
            )


class PhotonAdapter(ChannelAdapter):
    """Photon chat HTTP webhook send (Messaging catalog: photon)."""

    platform = "photon"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("room") or payload.get("channel_id") or ""),
            user_id=str(payload.get("sender") or payload.get("user_id") or ""),
            text=str(payload.get("message") or payload.get("text") or ""),
            is_direct=False,
            timestamp=float(payload.get("timestamp") or time.time()),
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
        webhook = (
            str(self.config.get("webhook_url") or "").strip()
            or str(os.environ.get("PHOTON_WEBHOOK_URL") or os.environ.get("HOMUN_PHOTON_WEBHOOK_URL") or "").strip()
        )
        if not webhook.startswith("http") and channel_id.startswith("http"):
            webhook = channel_id
        if not webhook.startswith("http"):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        body = {"room": channel_id if not channel_id.startswith("http") else None, "text": text}
        body = {k: v for k, v in body.items() if v is not None}
        if "room" not in body:
            body["text"] = text
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(webhook, json=body)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Photon HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
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
                error=str(exc),
            )


class RaftAdapter(ChannelAdapter):
    """Raft event/channel HTTP publish (Messaging catalog: raft)."""

    platform = "raft"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("topic") or payload.get("channel_id") or ""),
            user_id=str(payload.get("publisher") or payload.get("user_id") or ""),
            text=str(payload.get("payload") or payload.get("text") or ""),
            is_direct=False,
            timestamp=float(payload.get("timestamp") or time.time()),
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
        base = (
            str(self.config.get("base_url") or "").strip()
            or str(os.environ.get("RAFT_URL") or os.environ.get("HOMUN_RAFT_URL") or "").strip()
        )
        token = _token_from(self.config, "RAFT_TOKEN", "HOMUN_RAFT_TOKEN")
        if not base or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{base.rstrip('/')}/topics/{channel_id}/publish"
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = {"text": text}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=body, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Raft HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
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
                error=str(exc),
            )


class HomeAssistantAdapter(ChannelAdapter):
    """Home Assistant notification / event service bridge (homeassistant)."""

    platform = "homeassistant"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        data = payload.get("data") or payload
        event = payload.get("event") or {}
        text = str(data.get("message") or event.get("message") or payload.get("text") or "")
        sender = str(data.get("sender") or event.get("origin") or payload.get("user_id") or "homeassistant")
        return ChannelMessage(
            id=str(payload.get("id") or payload.get("event_id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("channel_id") or data.get("entity_id") or "notify"),
            user_id=sender,
            text=text,
            is_direct=False,
            timestamp=float(payload.get("time_fired") or time.time()),
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
        token = _token_from(self.config, "HASS_TOKEN", "HOMUN_HASS_TOKEN", "HOMEASSISTANT_TOKEN")
        base = (
            str(self.config.get("base_url") or "").strip()
            or str(os.environ.get("HASS_URL") or os.environ.get("HOMUN_HASS_URL") or "").strip()
        )
        webhook = (
            str(self.config.get("webhook_url") or "").strip()
            or str(os.environ.get("HASS_WEBHOOK_URL") or os.environ.get("HOMUN_HASS_WEBHOOK_URL") or "").strip()
        )
        if not webhook and not (base and token):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)

        target_url = webhook if webhook else f"{base.rstrip('/')}/api/services/notify/{channel_id or 'notify'}"
        headers = {"Content-Type": "application/json"}
        if token and not webhook:
            headers["Authorization"] = f"Bearer {token}"
        body = {"message": text, "title": "Homun"}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(target_url, json=body, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"HomeAssistant HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
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
                error=str(exc),
            )


class MSGraphWebhookAdapter(ChannelAdapter):
    """Microsoft Graph webhook and chat message adapter (msgraph-webhook)."""

    platform = "msgraph"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        values = payload.get("value") or []
        first = values[0] if values and isinstance(values[0], dict) else payload
        resource_data = first.get("resourceData") or {}
        body = resource_data.get("body") or {}
        text = str(body.get("content") or first.get("text") or payload.get("text") or "")
        return ChannelMessage(
            id=str(first.get("id") or resource_data.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(resource_data.get("chatId") or payload.get("channel_id") or ""),
            user_id=str((first.get("from") or {}).get("user", {}).get("id") or payload.get("user_id") or ""),
            text=text,
            is_direct=False,
            timestamp=float(payload.get("timestamp") or time.time()),
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
        token = _token_from(self.config, "MSGRAPH_ACCESS_TOKEN", "HOMUN_MSGRAPH_TOKEN", "AZURE_TOKEN")
        base = (
            str(self.config.get("base_url") or "").strip()
            or str(os.environ.get("MSGRAPH_BASE_URL") or "https://graph.microsoft.com/v1.0").strip()
        )
        if not token or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{base.rstrip('/')}/chats/{channel_id}/messages"
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        body = {"body": {"contentType": "text", "content": text}}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=body, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"MSGraph HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
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
                error=str(exc),
            )


class OpenWebUIAdapter(ChannelAdapter):
    """Open WebUI webhook and chat integration (Messaging: open-webui)."""

    platform = "open_webui"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or payload.get("message_id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("chat_id") or payload.get("channel_id") or ""),
            user_id=str((payload.get("user") or {}).get("id") or payload.get("user_id") or ""),
            text=str(payload.get("content") or payload.get("message") or payload.get("text") or ""),
            is_direct=True,
            timestamp=float(payload.get("timestamp") or time.time()),
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
        webhook = (
            str(self.config.get("webhook_url") or "").strip()
            or str(os.environ.get("OPENWEBUI_WEBHOOK_URL") or os.environ.get("HOMUN_OPENWEBUI_WEBHOOK_URL") or "").strip()
        )
        base = (
            str(self.config.get("base_url") or "").strip()
            or str(os.environ.get("OPENWEBUI_URL") or os.environ.get("HOMUN_OPENWEBUI_URL") or "").strip()
        )
        token = _token_from(self.config, "OPENWEBUI_TOKEN", "HOMUN_OPENWEBUI_TOKEN")
        if not webhook and not (base and channel_id):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)

        target_url = webhook if webhook else f"{base.rstrip('/')}/api/v1/chats/{channel_id}/messages"
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = {"chat_id": channel_id, "content": text, "role": "assistant"}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(target_url, json=body, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"OpenWebUI HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
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
                error=str(exc),
            )
