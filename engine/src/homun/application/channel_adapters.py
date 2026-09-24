"""Messaging platform and channel adapters for gateway routing (H33).

Derived from Hermes gateway/platforms/ and gateway/platform_registry.py
at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun maintains pluggable channel adapters for Telegram, Discord, Slack,
WhatsApp, and Webhook relays, supporting inbound parsing, media handling,
thread routing, authorization gates, and turn lease acquisition.
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

import httpx

from homun.application.gateway_contracts import (
    ChannelMedia,
    ChannelMessage,
    PlatformKind,
)
from homun.application.gateway_pairing import GatewayPairingManager
from homun.application.gateway_turn_lease import TurnLeaseManager

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


class TelegramAdapter(ChannelAdapter):
    platform = "telegram"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        msg = payload.get("message") or payload
        from_user = msg.get("from") or {}
        chat = msg.get("chat") or {}
        user_id = str(from_user.get("id") or "")
        chat_id = str(chat.get("id") or "")
        text = str(msg.get("text") or msg.get("caption") or "")

        media_items = []
        if "photo" in msg:
            media_items.append(ChannelMedia(mime_type="image/jpeg", size_bytes=1024))
        if "document" in msg:
            doc = msg["document"]
            media_items.append(ChannelMedia(mime_type=doc.get("mime_type", "application/octet-stream"), file_name=doc.get("file_name")))

        return ChannelMessage(
            id=str(msg.get("message_id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=chat_id,
            user_id=user_id,
            username=from_user.get("username"),
            text=text,
            topic_id=str(msg.get("message_thread_id")) if msg.get("message_thread_id") else None,
            thread_id=str(msg.get("message_thread_id")) if msg.get("message_thread_id") else None,
            is_direct=(chat.get("type") == "private"),
            media=media_items,
            timestamp=float(msg.get("date") or time.time()),
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
        token = _token_from(self.config, "TELEGRAM_BOT_TOKEN", "HOMUN_TELEGRAM_BOT_TOKEN")
        if not token:
            return super().send(
                channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media
            )
        payload: Dict[str, Any] = {"chat_id": channel_id, "text": text}
        if thread_id:
            payload["message_thread_id"] = thread_id
        if reply_to_id:
            payload["reply_to_message_id"] = reply_to_id
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=payload)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Telegram API HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            data = resp.json() if resp.content else {}
            if isinstance(data, dict) and data.get("ok") is False:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=str(data.get("description") or "Telegram API rejected send"),
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
                extra={"provider_message_id": ((data.get("result") or {}) if isinstance(data, dict) else {}).get("message_id")},
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


class DiscordAdapter(ChannelAdapter):
    platform = "discord"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        author = payload.get("author") or {}
        user_id = str(author.get("id") or "")
        channel_id = str(payload.get("channel_id") or "")
        text = str(payload.get("content") or "")

        media_items = []
        for att in payload.get("attachments") or []:
            media_items.append(ChannelMedia(
                url=att.get("url"),
                mime_type=att.get("content_type", "application/octet-stream"),
                file_name=att.get("filename"),
                size_bytes=att.get("size", 0),
            ))

        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=channel_id,
            user_id=user_id,
            username=author.get("username"),
            text=text,
            thread_id=str(payload.get("thread_id")) if payload.get("thread_id") else None,
            is_direct=bool(payload.get("guild_id") is None),
            media=media_items,
            timestamp=time.time(),
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
        token = _token_from(self.config, "DISCORD_BOT_TOKEN", "HOMUN_DISCORD_BOT_TOKEN")
        if not token:
            return super().send(
                channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media
            )
        payload: Dict[str, Any] = {"content": text}
        if reply_to_id:
            payload["message_reference"] = {"message_id": reply_to_id}
        url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
        headers = {"Authorization": f"Bot {token}", "Content-Type": "application/json"}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Discord API HTTP {resp.status_code}",
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


class SlackAdapter(ChannelAdapter):
    platform = "slack"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        event = payload.get("event") or payload
        user_id = str(event.get("user") or "")
        channel_id = str(event.get("channel") or "")
        text = str(event.get("text") or "")
        thread_ts = event.get("thread_ts")

        media_items = []
        for f in event.get("files") or []:
            media_items.append(ChannelMedia(
                url=f.get("url_private"),
                mime_type=f.get("mimetype", "application/octet-stream"),
                file_name=f.get("name"),
                size_bytes=f.get("size", 0),
            ))

        return ChannelMessage(
            id=str(event.get("ts") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=channel_id,
            user_id=user_id,
            text=text,
            thread_id=str(thread_ts) if thread_ts else None,
            is_direct=channel_id.startswith("D"),
            media=media_items,
            timestamp=float(event.get("ts") or time.time()),
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
        token = _token_from(self.config, "SLACK_BOT_TOKEN", "HOMUN_SLACK_BOT_TOKEN")
        if not token:
            return super().send(
                channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media
            )
        payload: Dict[str, Any] = {"channel": channel_id, "text": text}
        if thread_id:
            payload["thread_ts"] = thread_id
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post("https://slack.com/api/chat.postMessage", json=payload, headers=headers)
            data = resp.json() if resp.content else {}
            if resp.status_code >= 400 or (isinstance(data, dict) and data.get("ok") is False):
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=str((data or {}).get("error") if isinstance(data, dict) else f"Slack HTTP {resp.status_code}"),
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
                extra={"ts": data.get("ts") if isinstance(data, dict) else None},
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


class WhatsAppAdapter(ChannelAdapter):
    platform = "whatsapp"

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


class WebhookRelayAdapter(ChannelAdapter):
    platform = "webhook"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("channel_id") or "default_channel"),
            user_id=str(payload.get("user_id") or "anonymous_user"),
            username=payload.get("username"),
            text=str(payload.get("text") or ""),
            thread_id=payload.get("thread_id"),
            topic_id=payload.get("topic_id"),
            is_direct=bool(payload.get("is_direct", True)),
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
        url = (
            str(self.config.get("webhook_url") or "").strip()
            or str(os.environ.get("HOMUN_WEBHOOK_URL") or "").strip()
        )
        if not url:
            return super().send(
                channel_id,
                text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
            )
        body = {
            "channel_id": channel_id,
            "text": text,
            "thread_id": thread_id,
            "reply_to_id": reply_to_id,
            "media_count": len(media or []),
            "platform": self.platform,
        }
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 10.0)) as client:
                resp = client.post(url, json=body)
            if resp.status_code >= 400:
                return {
                    "delivered": False,
                    "platform": self.platform,
                    "channel_id": channel_id,
                    "thread_id": thread_id,
                    "reply_to_id": reply_to_id,
                    "text": text,
                    "media_count": len(media or []),
                    "sent_at": time.time(),
                    "error": f"Webhook relay HTTP {resp.status_code}",
                    "code": "backend_unavailable",
                    "status_code": resp.status_code,
                }
            return {
                "delivered": True,
                "platform": self.platform,
                "channel_id": channel_id,
                "thread_id": thread_id,
                "reply_to_id": reply_to_id,
                "text": text,
                "media_count": len(media or []),
                "sent_at": time.time(),
                "status_code": resp.status_code,
            }
        except Exception as exc:
            return {
                "delivered": False,
                "platform": self.platform,
                "channel_id": channel_id,
                "thread_id": thread_id,
                "reply_to_id": reply_to_id,
                "text": text,
                "media_count": len(media or []),
                "sent_at": time.time(),
                "error": str(exc),
                "code": "backend_unavailable",
            }


class NtfyAdapter(ChannelAdapter):
    """ntfy.sh / self-hosted topic push (Hermes messaging catalog)."""

    platform = "ntfy"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("topic") or payload.get("channel_id") or "default"),
            user_id=str(payload.get("sender") or "ntfy"),
            text=str(payload.get("message") or payload.get("text") or ""),
            is_direct=True,
            timestamp=float(payload.get("time") or time.time()),
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
            str(self.config.get("server") or "").strip()
            or str(os.environ.get("HOMUN_NTFY_SERVER") or os.environ.get("NTFY_SERVER") or "").strip()
            or "https://ntfy.sh"
        )
        topic = channel_id.strip()
        if not topic:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{base.rstrip('/')}/{topic}"
        headers: Dict[str, str] = {"Content-Type": "text/plain; charset=utf-8"}
        token = _token_from(self.config, "NTFY_TOKEN", "HOMUN_NTFY_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, content=text.encode("utf-8"), headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"ntfy HTTP {resp.status_code}",
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


class MatrixAdapter(ChannelAdapter):
    """Matrix Client-Server API m.room.message send (when homeserver + token set)."""

    platform = "matrix"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        content = payload.get("content") or {}
        sender = str(payload.get("sender") or "")
        room = str(payload.get("room_id") or payload.get("channel_id") or "")
        return ChannelMessage(
            id=str(payload.get("event_id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=room,
            user_id=sender,
            text=str(content.get("body") or payload.get("text") or ""),
            is_direct=False,
            timestamp=float(payload.get("origin_server_ts") or time.time()) / (
                1000.0 if payload.get("origin_server_ts") else 1.0
            ),
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
        homeserver = (
            str(self.config.get("homeserver") or "").strip()
            or str(os.environ.get("MATRIX_HOMESERVER") or os.environ.get("HOMUN_MATRIX_HOMESERVER") or "").strip()
        )
        token = _token_from(self.config, "MATRIX_ACCESS_TOKEN", "HOMUN_MATRIX_ACCESS_TOKEN")
        if not homeserver or not token:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        txn = uuid.uuid4().hex
        url = f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{channel_id}/send/m.room.message/{txn}"
        payload: Dict[str, Any] = {"msgtype": "m.text", "body": text}
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.put(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Matrix API HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            data = resp.json() if resp.content else {}
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
                status_code=resp.status_code,
                extra={"event_id": data.get("event_id") if isinstance(data, dict) else None},
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


class ChannelRegistry:
    """Registry and dispatcher for multi-platform channel adapters."""

    def __init__(
        self,
        pairing_manager: Optional[GatewayPairingManager] = None,
        lease_manager: Optional[TurnLeaseManager] = None,
    ):
        self.pairing_manager = pairing_manager or GatewayPairingManager()
        self.lease_manager = lease_manager or TurnLeaseManager()
        self._adapters: Dict[str, ChannelAdapter] = {
            "telegram": TelegramAdapter(),
            "discord": DiscordAdapter(),
            "slack": SlackAdapter(),
            "whatsapp": WhatsAppAdapter(),
            "webhook": WebhookRelayAdapter(),
            "ntfy": NtfyAdapter(),
            "matrix": MatrixAdapter(),
        }

    def register_adapter(self, adapter: ChannelAdapter) -> None:
        self._adapters[adapter.platform.lower()] = adapter

    def get_adapter(self, platform: str) -> Optional[ChannelAdapter]:
        return self._adapters.get(platform.strip().lower())

    def dispatch_inbound(
        self,
        platform: str,
        raw_payload: Dict[str, Any],
        handler: Callable[[ChannelMessage], str],
    ) -> Dict[str, Any]:
        """Dispatch inbound payload: authorization check, turn lease acquire, execution, and release."""
        adapter = self.get_adapter(platform)
        if not adapter:
            raise ValueError(f"No adapter registered for platform: {platform}")

        message = adapter.parse_inbound(raw_payload)

        # 1. Authorization check
        if not self.pairing_manager.is_user_authorized(message.platform, message.user_id):
            return {
                "status": "unauthorized",
                "platform": message.platform,
                "user_id": message.user_id,
                "message": f"Unauthorized sender. To pair, send a pairing request code.",
            }

        # 2. Turn lease serialization: resolve session/routing key
        routing_key = f"{message.platform}:{message.channel_id}:{message.thread_id or 'main'}"
        token = self.lease_manager.acquire(routing_key, owner_key=message.user_id, timeout=5.0)
        try:
            # 3. Handle message
            response_text = handler(message)

            # 4. Deliver response
            delivery_res = adapter.send(
                message.channel_id,
                response_text,
                thread_id=message.thread_id,
                reply_to_id=message.id,
            )
            return {
                "status": "processed",
                "message_id": message.id,
                "routing_key": routing_key,
                "response": response_text,
                "delivery": delivery_res,
            }
        finally:
            self.lease_manager.release(token)
