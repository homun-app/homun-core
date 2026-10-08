"""Specialized enterprise and callback messaging adapters (H33).

Includes Teams meetings webhooks, WeCom callback webhooks,
WhatsApp Cloud (Meta Graph) API, and Tencent Yuanbao bot adapters.
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
from homun.application.gateway_contracts import ChannelMedia, ChannelMessage


class TeamsMeetingsAdapter(ChannelAdapter):
    """Teams meetings webhook integration (Messaging: teams-meetings)."""

    platform = "teams_meetings"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("meeting_id") or payload.get("channel_id") or ""),
            user_id=str((payload.get("from") or {}).get("id") or payload.get("user_id") or ""),
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
            or str(
                os.environ.get("TEAMS_MEETINGS_WEBHOOK_URL")
                or os.environ.get("HOMUN_TEAMS_MEETINGS_WEBHOOK_URL")
                or ""
            ).strip()
        )
        if not webhook.startswith("http") and channel_id.startswith("http"):
            webhook = channel_id
        if not webhook.startswith("http"):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        body = {"meeting_id": channel_id, "text": text}
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
                    error=f"TeamsMeetings HTTP {resp.status_code}",
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


class WeComCallbackAdapter(ChannelAdapter):
    """WeCom callback webhook integration (Messaging: wecom-callback)."""

    platform = "wecom_callback"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("MsgId") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("ToUserName") or payload.get("channel_id") or ""),
            user_id=str(payload.get("FromUserName") or payload.get("user_id") or ""),
            text=str(payload.get("Content") or payload.get("text") or ""),
            is_direct=True,
            timestamp=float(payload.get("CreateTime") or time.time()),
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
            or str(os.environ.get("WECOM_CALLBACK_URL") or os.environ.get("HOMUN_WECOM_CALLBACK_URL") or "").strip()
        )
        if not webhook.startswith("http") and channel_id.startswith("http"):
            webhook = channel_id
        if not webhook.startswith("http"):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        body = {"msgtype": "text", "text": {"content": text}, "touser": channel_id}
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
                    error=f"WeComCallback HTTP {resp.status_code}",
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


class WhatsAppCloudAdapter(ChannelAdapter):
    """WhatsApp Cloud (Meta Graph) API adapter (Messaging: whatsapp-cloud)."""

    platform = "whatsapp_cloud"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        entries = payload.get("entry") or []
        first = entries[0] if entries and isinstance(entries[0], dict) else {}
        changes = first.get("changes") or []
        first_change = changes[0] if changes and isinstance(changes[0], dict) else {}
        val = first_change.get("value") or {}
        messages = val.get("messages") or []
        msg = messages[0] if messages and isinstance(messages[0], dict) else payload
        text = str((msg.get("text") or {}).get("body") if isinstance(msg.get("text"), dict) else (msg.get("text") or ""))
        return ChannelMessage(
            id=str(msg.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(msg.get("from") or payload.get("channel_id") or ""),
            user_id=str(msg.get("from") or payload.get("user_id") or ""),
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
        token = _token_from(self.config, "WHATSAPP_CLOUD_TOKEN", "HOMUN_WHATSAPP_CLOUD_TOKEN")
        phone_id = (
            str(self.config.get("phone_number_id") or "").strip()
            or str(
                os.environ.get("WHATSAPP_PHONE_NUMBER_ID")
                or os.environ.get("HOMUN_WHATSAPP_PHONE_NUMBER_ID")
                or ""
            ).strip()
        )
        if not token or not phone_id or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"https://graph.facebook.com/v19.0/{phone_id}/messages"
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        body = {
            "messaging_product": "whatsapp",
            "to": channel_id,
            "type": "text",
            "text": {"body": text},
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
                    error=f"WhatsAppCloud HTTP {resp.status_code}",
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


class YuanbaoAdapter(ChannelAdapter):
    """Tencent Yuanbao bot API / webhook adapter (Messaging: yuanbao)."""

    platform = "yuanbao"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or payload.get("msg_id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("channel_id") or payload.get("bot_id") or ""),
            user_id=str(payload.get("user_id") or payload.get("sender") or ""),
            text=str(payload.get("content") or payload.get("text") or ""),
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
        token = _token_from(self.config, "YUANBAO_TOKEN", "HOMUN_YUANBAO_TOKEN")
        webhook = (
            str(self.config.get("webhook_url") or "").strip()
            or str(os.environ.get("YUANBAO_WEBHOOK_URL") or os.environ.get("HOMUN_YUANBAO_WEBHOOK_URL") or "").strip()
        )
        base = (
            str(self.config.get("base_url") or "").strip()
            or str(os.environ.get("YUANBAO_URL") or "https://yuanbao.tencent.com/api").strip()
        )
        if not webhook and not (token and channel_id):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)

        target_url = webhook if webhook else f"{base.rstrip('/')}/messages"
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = {"channel_id": channel_id, "text": text}
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
                    error=f"Yuanbao HTTP {resp.status_code}",
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
