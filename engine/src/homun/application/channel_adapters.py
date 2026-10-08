"""Messaging platform and channel adapters for gateway routing (H33).

at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun maintains pluggable channel adapters for Telegram, Discord, Slack,
WhatsApp, and Webhook relays, supporting inbound parsing, media handling,
thread routing, authorization gates, and turn lease acquisition.
"""
from __future__ import annotations

import json
import logging
import os
import smtplib
import socket
import time
from typing import Any, Callable, Dict, List, Optional
import uuid

import httpx

from homun.application.channel_contracts import (
    ChannelAdapter,
    _http_delivery_result,
    _token_from,
)
from homun.application.channel_adapters_protocols import (
    BlueBubblesAdapter,
    EmailAdapter,
    IrcAdapter,
    LineAdapter,
    SignalAdapter,
    SimplexAdapter,
    SmsAdapter,
)
# WhatsApp cloud + bridge adapters live in whatsapp_bridge_adapter; the
# WhatsAppAdapter name stays importable from here for existing callers.
from homun.application.whatsapp_bridge_adapter import (
    WhatsAppAdapter,
    WhatsAppBridgeAdapter,
    WhatsAppCloudApiAdapter,
)  # noqa: F401 -- WhatsAppAdapter re-exported for backward compatibility
from homun.application.channel_adapters_catalog import (
    DingTalkAdapter,
    FeishuChannelAdapter,
    GoogleChatAdapter,
    MattermostAdapter,
    QqBotAdapter,
    TeamsAdapter,
    WeComAdapter,
    WeixinAdapter,
)
from homun.application.channel_adapters_extended import (
    A2AAdapter,
    BuzzAdapter,
    HomeAssistantAdapter,
    MSGraphWebhookAdapter,
    OpenWebUIAdapter,
    PhotonAdapter,
    RaftAdapter,
    TeamsMeetingsAdapter,
    WeComCallbackAdapter,
    WhatsAppCloudAdapter,
    YuanbaoAdapter,
)
from homun.application.gateway_contracts import (
    ChannelMedia,
    ChannelMessage,
    PlatformKind,
)
from homun.application.gateway_pairing import GatewayPairingManager
from homun.application.gateway_turn_lease import TurnLeaseManager

logger = logging.getLogger(__name__)


class TelegramAdapter(ChannelAdapter):
    """Telegram Bot API adapter."""

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
        if media:
            from homun.application.channel_delivery_recovery import send_with_media_dispatch
            return send_with_media_dispatch(
                self, channel_id, text, media=media, thread_id=thread_id, reply_to_id=reply_to_id
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
    """Discord Bot API adapter."""

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
    """Slack Web API adapter."""

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


class WebhookRelayAdapter(ChannelAdapter):
    """Generic outbound webhook relay."""

    platform = "webhook"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("channel_id") or payload.get("target") or "default"),
            user_id=str(payload.get("user_id") or payload.get("sender") or "webhook_caller"),
            text=str(payload.get("text") or payload.get("message") or ""),
            thread_id=payload.get("thread_id"),
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
        webhook_url = str(self.config.get("webhook_url") or os.environ.get("HOMUN_WEBHOOK_URL") or "").strip()
        if not webhook_url:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)

        payload = {
            "platform": self.platform,
            "channel_id": channel_id,
            "text": text,
            "thread_id": thread_id,
            "reply_to_id": reply_to_id,
            "media_count": len(media or []),
            "timestamp": time.time(),
        }
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 10.0)) as client:
                resp = client.post(webhook_url, json=payload)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Webhook HTTP {resp.status_code}",
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


class NtfyAdapter(ChannelAdapter):
    """ntfy HTTP topic publish (H33)."""

    platform = "ntfy"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("topic") or payload.get("channel_id") or ""),
            user_id=str(payload.get("user") or payload.get("user_id") or "ntfy"),
            text=str(payload.get("message") or payload.get("text") or ""),
            is_direct=False,
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
        server = (
            str(self.config.get("server") or "").strip()
            or str(os.environ.get("NTFY_SERVER") or os.environ.get("HOMUN_NTFY_SERVER") or "https://ntfy.sh").strip()
        )
        token = _token_from(self.config, "NTFY_TOKEN", "HOMUN_NTFY_TOKEN")
        if not channel_id or not server:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{server.rstrip('/')}/{channel_id}"
        headers: Dict[str, str] = {"Title": "Homun"}
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
    """Matrix Client-Server v3 room message delivery (H33)."""

    platform = "matrix"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        content = payload.get("content") or {}
        return ChannelMessage(
            id=str(payload.get("event_id") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("room_id") or payload.get("channel_id") or ""),
            user_id=str(payload.get("sender") or payload.get("user_id") or ""),
            text=str(content.get("body") or payload.get("text") or ""),
            is_direct=False,
            timestamp=float(payload.get("origin_server_ts", 0)) / 1000.0 or time.time(),
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
        inbound_queue: Optional[Any] = None,
        delivery_supervisor: Optional[Any] = None,
    ):
        self.pairing_manager = pairing_manager or GatewayPairingManager()
        self.lease_manager = lease_manager or TurnLeaseManager()
        self.inbound_queue = inbound_queue
        self.delivery_supervisor = delivery_supervisor
        core: List[ChannelAdapter] = [
            TelegramAdapter(), DiscordAdapter(), SlackAdapter(),
            WhatsAppBridgeAdapter(), WhatsAppCloudApiAdapter(),
            WebhookRelayAdapter(), NtfyAdapter(), MatrixAdapter(), EmailAdapter(),
            SignalAdapter(), IrcAdapter(), FeishuChannelAdapter(), MattermostAdapter(),
            GoogleChatAdapter(), DingTalkAdapter(), WeComAdapter(), LineAdapter(),
            TeamsAdapter(), SmsAdapter(), BlueBubblesAdapter(), WeixinAdapter(),
            QqBotAdapter(), SimplexAdapter(), PhotonAdapter(), A2AAdapter(),
            BuzzAdapter(), RaftAdapter(), HomeAssistantAdapter(), MSGraphWebhookAdapter(),
            OpenWebUIAdapter(), TeamsMeetingsAdapter(), WeComCallbackAdapter(),
            WhatsAppCloudAdapter(), YuanbaoAdapter(),
        ]
        self._adapters: Dict[str, ChannelAdapter] = {a.platform.lower(): a for a in core}
        self._adapters["msgraph_webhook"] = self._adapters["msgraph"]
        self._adapters["open-webui"] = self._adapters["open_webui"]
        self._adapters["teams-meetings"] = self._adapters["teams_meetings"]
        self._adapters["wecom-callback"] = self._adapters["wecom_callback"]
        self._adapters["whatsapp-cloud"] = self._adapters["whatsapp_cloud"]

    def register_adapter(self, adapter: ChannelAdapter) -> None:
        self._adapters[adapter.platform.lower()] = adapter

    def get_adapter(self, platform: str) -> Optional[ChannelAdapter]:
        return self._adapters.get(platform.strip().lower())

    def dispatch_inbound(
        self,
        platform: str,
        raw_payload: Dict[str, Any],
        handler: Callable[[ChannelMessage], str],
        pre_handler: Optional[Callable[[ChannelMessage], Optional[str]]] = None,
    ) -> Dict[str, Any]:
        """Dispatch inbound payload: authorization check, turn lease acquire, execution, and release.

        ``pre_handler`` runs first and may claim the message (approval relay
        replies never become conversation turns); returning None hands the
        message to the normal ``handler``.
        """
        adapter = self.get_adapter(platform)
        if not adapter:
            raise ValueError(f"No adapter registered for platform: {platform}")

        message = adapter.parse_inbound(raw_payload)
        q_item = None
        if self.inbound_queue:
            q_item = self.inbound_queue.enqueue(platform, raw_payload, message, status="pending")

        # 1. Authorization check
        is_auth = self.pairing_manager.is_user_authorized(message.platform, message.user_id)
        if not is_auth and adapter:
            allowed_conf = getattr(adapter, "config", {}).get("allowed_users")
            if isinstance(allowed_conf, list) and (len(allowed_conf) == 0 or message.user_id in allowed_conf or getattr(message, "username", "") in allowed_conf):
                is_auth = True
        if not is_auth:
            if q_item:
                self.inbound_queue.fail(q_item.item_id, "Unauthorized sender", retryable=False)
            return {"status": "unauthorized", "platform": message.platform, "user_id": message.user_id, "message": "Unauthorized sender. To pair, send a pairing request code."}

        # 2. Turn lease serialization: resolve session/routing key
        routing_key = f"{message.platform}:{message.channel_id}:{message.thread_id or 'main'}"
        token = self.lease_manager.acquire(routing_key, owner_key=message.user_id, timeout=5.0)
        try:
            # 3. Handle message (the pre-handler may claim it: relay replies are
            # decisions, not conversation)
            response_text = None
            if pre_handler is not None:
                response_text = pre_handler(message)
            if response_text is None:
                response_text = handler(message)

            # 4. Deliver response
            from homun.application.channel_delivery_recovery import send_with_media_dispatch
            delivery_res = send_with_media_dispatch(
                adapter,
                message.channel_id,
                response_text,
                thread_id=message.thread_id,
                reply_to_id=message.id,
                supervisor=self.delivery_supervisor,
            )
            if q_item:
                self.inbound_queue.complete(
                    q_item.item_id,
                    response_text,
                    delivery_receipt_id=delivery_res.get("intent_id"),
                )
            return {
                "status": "processed",
                "message_id": message.id,
                "routing_key": routing_key,
                "response": response_text,
                "delivery": delivery_res,
                "queue_item_id": q_item.item_id if q_item else None,
            }
        except Exception as exc:
            if q_item:
                self.inbound_queue.fail(q_item.item_id, str(exc), retryable=True)
            raise
        finally:
            self.lease_manager.release(token)
