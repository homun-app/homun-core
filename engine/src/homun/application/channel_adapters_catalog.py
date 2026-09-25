"""Extended Hermes messaging catalog adapters (H33).

Split from channel_adapters to keep the core registry module bounded.
Adapters here follow the same ChannelAdapter honesty contract.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional

import httpx

from homun.application.channel_adapters import (
    ChannelAdapter,
    _http_delivery_result,
    _token_from,
)
from homun.application.gateway_contracts import ChannelMedia, ChannelMessage

class FeishuChannelAdapter(ChannelAdapter):
    """Feishu/Lark IM message send (Hermes messaging catalog: feishu).

    Distinct from application.integration_feishu.FeishuAdapter (docs/comments).
    """

    platform = "feishu"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        event = payload.get("event") or payload
        message = event.get("message") or {}
        sender = (event.get("sender") or {}).get("sender_id") or {}
        content = message.get("content") or {}
        if isinstance(content, str):
            text = content
        else:
            text = str(content.get("text") or payload.get("text") or "")
        return ChannelMessage(
            id=str(message.get("message_id") or payload.get("message_id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(message.get("chat_id") or payload.get("channel_id") or ""),
            user_id=str(sender.get("user_id") or sender.get("open_id") or payload.get("user_id") or ""),
            text=text,
            is_direct=str(message.get("chat_type") or "") == "p2p",
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
        token = _token_from(
            self.config,
            "FEISHU_TENANT_ACCESS_TOKEN",
            "HOMUN_FEISHU_TENANT_ACCESS_TOKEN",
            "LARK_TENANT_ACCESS_TOKEN",
        )
        base = (
            str(self.config.get("base_url") or "").strip()
            or str(os.environ.get("HOMUN_FEISHU_BASE_URL") or "https://open.feishu.cn").strip()
        )
        if not token or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        receive_id_type = str(self.config.get("receive_id_type") or "chat_id")
        url = f"{base.rstrip('/')}/open-apis/im/v1/messages?receive_id_type={receive_id_type}"
        # Feishu expects JSON-encoded content string for text messages.
        body: Dict[str, Any] = {
            "receive_id": channel_id,
            "msg_type": "text",
            "content": json.dumps({"text": text}),
        }
        if reply_to_id:
            body["reply_message_id"] = reply_to_id
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=body, headers=headers)
            data = resp.json() if resp.content else {}
            code = data.get("code") if isinstance(data, dict) else None
            if resp.status_code >= 400 or (code not in (None, 0)):
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Feishu IM HTTP {resp.status_code} code={code}",
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
                extra={"message_id": (data.get("data") or {}).get("message_id") if isinstance(data, dict) else None},
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


class MattermostAdapter(ChannelAdapter):
    """Mattermost API v4 posts (Hermes messaging catalog: mattermost)."""

    platform = "mattermost"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        post = payload.get("data") or payload.get("post") or payload
        if isinstance(post, str):
            try:
                post = json.loads(post)
            except Exception:
                post = {"message": post}
        return ChannelMessage(
            id=str(post.get("id") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(post.get("channel_id") or payload.get("channel_id") or ""),
            user_id=str(post.get("user_id") or payload.get("user_id") or ""),
            text=str(post.get("message") or payload.get("text") or ""),
            is_direct=False,
            timestamp=float(post.get("create_at") or time.time()) / (
                1000.0 if post.get("create_at") and post.get("create_at") > 10_000_000_000 else 1.0
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
        base = (
            str(self.config.get("base_url") or "").strip()
            or str(os.environ.get("MATTERMOST_URL") or os.environ.get("HOMUN_MATTERMOST_URL") or "").strip()
        )
        token = _token_from(self.config, "MATTERMOST_TOKEN", "HOMUN_MATTERMOST_TOKEN")
        if not base or not token or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{base.rstrip('/')}/api/v4/posts"
        body: Dict[str, Any] = {"channel_id": channel_id, "message": text}
        if thread_id or reply_to_id:
            body["root_id"] = thread_id or reply_to_id
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
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
                    error=f"Mattermost HTTP {resp.status_code}",
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
                extra={"post_id": data.get("id") if isinstance(data, dict) else None},
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


class GoogleChatAdapter(ChannelAdapter):
    """Google Chat spaces.messages.create or incoming webhook."""

    platform = "google_chat"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        message = payload.get("message") or payload
        sender = message.get("sender") or {}
        space = payload.get("space") or {}
        return ChannelMessage(
            id=str(message.get("name") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(space.get("name") or payload.get("channel_id") or ""),
            user_id=str(sender.get("name") or sender.get("email") or ""),
            text=str(message.get("text") or payload.get("text") or ""),
            is_direct=str(space.get("type") or "") == "DM",
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
            or str(os.environ.get("GOOGLE_CHAT_WEBHOOK_URL") or os.environ.get("HOMUN_GOOGLE_CHAT_WEBHOOK_URL") or "").strip()
        )
        token = _token_from(self.config, "GOOGLE_CHAT_TOKEN", "HOMUN_GOOGLE_CHAT_TOKEN")
        if webhook:
            url = webhook
            headers = {"Content-Type": "application/json"}
            body: Dict[str, Any] = {"text": text}
        elif token and channel_id:
            space = channel_id if channel_id.startswith("spaces/") else f"spaces/{channel_id}"
            url = f"https://chat.googleapis.com/v1/{space}/messages"
            headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            body = {"text": text}
            if thread_id:
                body["thread"] = {"name": thread_id}
        else:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
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
                    error=f"Google Chat HTTP {resp.status_code}",
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


class DingTalkAdapter(ChannelAdapter):
    """DingTalk custom robot webhook send."""

    platform = "dingtalk"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        text_obj = payload.get("text") or {}
        return ChannelMessage(
            id=str(payload.get("msgId") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("conversationId") or payload.get("channel_id") or ""),
            user_id=str(payload.get("senderStaffId") or payload.get("senderId") or ""),
            text=str(text_obj.get("content") if isinstance(text_obj, dict) else text_obj or payload.get("text") or ""),
            is_direct=str(payload.get("conversationType") or "") == "1",
            timestamp=float(payload.get("createAt") or time.time()) / (
                1000.0 if payload.get("createAt") and float(payload.get("createAt")) > 10_000_000_000 else 1.0
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
        webhook = (
            str(self.config.get("webhook_url") or channel_id or "").strip()
            or str(os.environ.get("DINGTALK_WEBHOOK_URL") or os.environ.get("HOMUN_DINGTALK_WEBHOOK_URL") or "").strip()
        )
        if not webhook.startswith("http"):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        body = {"msgtype": "text", "text": {"content": text}}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(webhook, json=body)
            data = resp.json() if resp.content else {}
            errcode = data.get("errcode") if isinstance(data, dict) else None
            if resp.status_code >= 400 or (errcode not in (None, 0)):
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"DingTalk HTTP {resp.status_code} errcode={errcode}",
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


class WeComAdapter(ChannelAdapter):
    """WeCom (WeChat Work) group robot webhook send."""

    platform = "wecom"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("msgid") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("chatid") or payload.get("channel_id") or ""),
            user_id=str(payload.get("from") or payload.get("user_id") or ""),
            text=str((payload.get("text") or {}).get("content") if isinstance(payload.get("text"), dict) else payload.get("text") or ""),
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
            str(self.config.get("webhook_url") or channel_id or "").strip()
            or str(os.environ.get("WECOM_WEBHOOK_URL") or os.environ.get("HOMUN_WECOM_WEBHOOK_URL") or "").strip()
        )
        if not webhook.startswith("http"):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        body = {"msgtype": "text", "text": {"content": text}}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(webhook, json=body)
            data = resp.json() if resp.content else {}
            errcode = data.get("errcode") if isinstance(data, dict) else None
            if resp.status_code >= 400 or (errcode not in (None, 0)):
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"WeCom HTTP {resp.status_code} errcode={errcode}",
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



class LineAdapter(ChannelAdapter):
    """LINE Messaging API push (Hermes messaging catalog: line)."""

    platform = "line"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        events = payload.get("events") or [payload]
        event = events[0] if events else {}
        source = event.get("source") or {}
        message = event.get("message") or {}
        return ChannelMessage(
            id=str(event.get("replyToken") or event.get("webhookEventId") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(source.get("groupId") or source.get("roomId") or source.get("userId") or ""),
            user_id=str(source.get("userId") or ""),
            text=str(message.get("text") or payload.get("text") or ""),
            is_direct=str(source.get("type") or "") == "user",
            timestamp=float(event.get("timestamp") or time.time()) / (
                1000.0 if event.get("timestamp") and float(event.get("timestamp")) > 10_000_000_000 else 1.0
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
        token = _token_from(self.config, "LINE_CHANNEL_ACCESS_TOKEN", "HOMUN_LINE_CHANNEL_ACCESS_TOKEN")
        if not token or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = "https://api.line.me/v2/bot/message/push"
        body = {"to": channel_id, "messages": [{"type": "text", "text": text}]}
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=body, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform, channel_id=channel_id, text=text,
                    thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                    delivered=False, error=f"LINE HTTP {resp.status_code}", status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=True, status_code=resp.status_code,
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=False, error=str(exc),
            )


class TeamsAdapter(ChannelAdapter):
    """Microsoft Teams incoming webhook or Bot Framework reply URL."""

    platform = "teams"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        from_ = payload.get("from") or {}
        conv = payload.get("conversation") or {}
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(conv.get("id") or payload.get("channel_id") or ""),
            user_id=str(from_.get("id") or payload.get("user_id") or ""),
            text=str(payload.get("text") or ""),
            is_direct=str(conv.get("conversationType") or "") == "personal",
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
            or str(os.environ.get("TEAMS_WEBHOOK_URL") or os.environ.get("HOMUN_TEAMS_WEBHOOK_URL") or "").strip()
        )
        # channel_id may itself be an incoming webhook URL
        if not webhook.startswith("http") and channel_id.startswith("http"):
            webhook = channel_id
        if not webhook.startswith("http"):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        body = {"text": text}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(webhook, json=body)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform, channel_id=channel_id, text=text,
                    thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                    delivered=False, error=f"Teams HTTP {resp.status_code}", status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=True, status_code=resp.status_code,
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=False, error=str(exc),
            )


class SmsAdapter(ChannelAdapter):
    """Twilio Messages API SMS send (Hermes messaging catalog: sms)."""

    platform = "sms"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("MessageSid") or payload.get("SmsSid") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("From") or payload.get("channel_id") or ""),
            user_id=str(payload.get("From") or payload.get("user_id") or ""),
            text=str(payload.get("Body") or payload.get("text") or ""),
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
        account = (
            str(self.config.get("account_sid") or "").strip()
            or str(os.environ.get("TWILIO_ACCOUNT_SID") or os.environ.get("HOMUN_TWILIO_ACCOUNT_SID") or "").strip()
        )
        token = _token_from(self.config, "TWILIO_AUTH_TOKEN", "HOMUN_TWILIO_AUTH_TOKEN")
        from_number = (
            str(self.config.get("from") or "").strip()
            or str(os.environ.get("TWILIO_FROM_NUMBER") or os.environ.get("HOMUN_TWILIO_FROM_NUMBER") or "").strip()
        )
        if not account or not token or not from_number or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"https://api.twilio.com/2010-04-01/Accounts/{account}/Messages.json"
        data = {"To": channel_id, "From": from_number, "Body": text}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, data=data, auth=(account, token))
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform, channel_id=channel_id, text=text,
                    thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                    delivered=False, error=f"Twilio SMS HTTP {resp.status_code}", status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=True, status_code=resp.status_code,
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=False, error=str(exc),
            )



class BlueBubblesAdapter(ChannelAdapter):
    """BlueBubbles iMessage REST send (Hermes messaging catalog: bluebubbles)."""

    platform = "bluebubbles"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        data = payload.get("data") or payload
        return ChannelMessage(
            id=str(data.get("guid") or data.get("tempGuid") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(data.get("chatGuid") or data.get("channel_id") or ""),
            user_id=str(data.get("handle", {}).get("address") if isinstance(data.get("handle"), dict) else data.get("handle") or ""),
            text=str(data.get("text") or data.get("message") or ""),
            is_direct=True,
            timestamp=float(data.get("dateCreated") or time.time()) / (
                1000.0 if data.get("dateCreated") and float(data.get("dateCreated")) > 10_000_000_000 else 1.0
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
        base = (
            str(self.config.get("base_url") or "").strip()
            or str(os.environ.get("BLUEBUBBLES_URL") or os.environ.get("HOMUN_BLUEBUBBLES_URL") or "").strip()
        )
        password = (
            str(self.config.get("password") or "").strip()
            or str(os.environ.get("BLUEBUBBLES_PASSWORD") or os.environ.get("HOMUN_BLUEBUBBLES_PASSWORD") or "").strip()
        )
        if not base or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{base.rstrip('/')}/api/v1/message/text"
        params = {"password": password} if password else None
        body = {"chatGuid": channel_id, "text": text, "method": "apple-script"}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 20.0)) as client:
                resp = client.post(url, params=params, json=body)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform, channel_id=channel_id, text=text,
                    thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                    delivered=False, error=f"BlueBubbles HTTP {resp.status_code}", status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=True, status_code=resp.status_code,
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=False, error=str(exc),
            )



class WeixinAdapter(ChannelAdapter):
    """Weixin (WeChat Official Account) customer-service message send."""

    platform = "weixin"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        xmlish = payload.get("xml") or payload
        return ChannelMessage(
            id=str(xmlish.get("MsgId") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(xmlish.get("FromUserName") or payload.get("channel_id") or ""),
            user_id=str(xmlish.get("FromUserName") or payload.get("user_id") or ""),
            text=str(xmlish.get("Content") or payload.get("text") or ""),
            is_direct=True,
            timestamp=float(xmlish.get("CreateTime") or time.time()),
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
        token = _token_from(self.config, "WEIXIN_ACCESS_TOKEN", "HOMUN_WEIXIN_ACCESS_TOKEN")
        if not token or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token={token}"
        body = {"touser": channel_id, "msgtype": "text", "text": {"content": text}}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=body)
            data = resp.json() if resp.content else {}
            errcode = data.get("errcode") if isinstance(data, dict) else None
            if resp.status_code >= 400 or (errcode not in (None, 0)):
                return _http_delivery_result(
                    platform=self.platform, channel_id=channel_id, text=text,
                    thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                    delivered=False, error=f"Weixin HTTP {resp.status_code} errcode={errcode}",
                    status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=True, status_code=resp.status_code,
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=False, error=str(exc),
            )


class QqBotAdapter(ChannelAdapter):
    """QQ Bot (qqbot) channel message send via bot API."""

    platform = "qqbot"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        d = payload.get("d") or payload
        author = d.get("author") or {}
        return ChannelMessage(
            id=str(d.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(d.get("channel_id") or d.get("group_openid") or ""),
            user_id=str(author.get("id") or author.get("member_openid") or ""),
            text=str(d.get("content") or payload.get("text") or ""),
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
        token = _token_from(self.config, "QQBOT_TOKEN", "HOMUN_QQBOT_TOKEN")
        appid = (
            str(self.config.get("app_id") or "").strip()
            or str(os.environ.get("QQBOT_APP_ID") or os.environ.get("HOMUN_QQBOT_APP_ID") or "").strip()
        )
        if not token or not appid or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"https://api.sgroup.qq.com/channels/{channel_id}/messages"
        headers = {"Authorization": f"Bot {appid}.{token}", "Content-Type": "application/json"}
        body: Dict[str, Any] = {"content": text}
        if reply_to_id:
            body["msg_id"] = reply_to_id
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=body, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform, channel_id=channel_id, text=text,
                    thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                    delivered=False, error=f"QQBot HTTP {resp.status_code}", status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=True, status_code=resp.status_code,
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=False, error=str(exc),
            )



class SimplexAdapter(ChannelAdapter):
    """SimpleX Chat websocket/HTTP bridge send when SIMPLE_X_URL is set."""

    platform = "simplex"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("msgId") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("contact") or payload.get("channel_id") or ""),
            user_id=str(payload.get("contact") or payload.get("user_id") or ""),
            text=str(payload.get("msgBody") or payload.get("text") or ""),
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
            or str(os.environ.get("SIMPLEX_URL") or os.environ.get("HOMUN_SIMPLEX_URL") or "").strip()
        )
        token = _token_from(self.config, "SIMPLEX_TOKEN", "HOMUN_SIMPLEX_TOKEN")
        if not base or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{base.rstrip('/')}/send"
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = {"contact": channel_id, "text": text}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=body, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform, channel_id=channel_id, text=text,
                    thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                    delivered=False, error=f"SimpleX HTTP {resp.status_code}", status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=True, status_code=resp.status_code,
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=False, error=str(exc),
            )


class PhotonAdapter(ChannelAdapter):
    """Photon chat HTTP webhook send (Hermes messaging catalog: photon)."""

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
                    platform=self.platform, channel_id=channel_id, text=text,
                    thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                    delivered=False, error=f"Photon HTTP {resp.status_code}", status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=True, status_code=resp.status_code,
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=False, error=str(exc),
            )


class A2AAdapter(ChannelAdapter):
    """Agent-to-Agent (A2A) HTTP task message send."""

    platform = "a2a"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("messageId") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("contextId") or payload.get("channel_id") or ""),
            user_id=str(payload.get("from") or payload.get("user_id") or "peer"),
            text=str(payload.get("text") or payload.get("message") or ""),
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
            str(self.config.get("base_url") or channel_id or "").strip()
            or str(os.environ.get("A2A_URL") or os.environ.get("HOMUN_A2A_URL") or "").strip()
        )
        token = _token_from(self.config, "A2A_TOKEN", "HOMUN_A2A_TOKEN")
        if not base.startswith("http"):
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{base.rstrip('/')}/message:send"
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = {"message": {"role": "user", "parts": [{"type": "text", "text": text}]}}
        if thread_id:
            body["contextId"] = thread_id
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 20.0)) as client:
                resp = client.post(url, json=body, headers=headers)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform, channel_id=channel_id, text=text,
                    thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                    delivered=False, error=f"A2A HTTP {resp.status_code}", status_code=resp.status_code,
                )
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=True, status_code=resp.status_code,
            )
        except Exception as exc:
            return _http_delivery_result(
                platform=self.platform, channel_id=channel_id, text=text,
                thread_id=thread_id, reply_to_id=reply_to_id, media=media,
                delivered=False, error=str(exc),
            )

