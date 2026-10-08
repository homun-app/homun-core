"""Messaging catalog adapters (H33).

Split from channel_adapters to keep the core registry module bounded.
Adapters here follow the same ChannelAdapter honesty contract: refusal without real credentials.
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
from homun.application.channel_adapters_protocols import (
    BlueBubblesAdapter,
    EmailAdapter,
    IrcAdapter,
    LineAdapter,
    SignalAdapter,
    SimplexAdapter,
    SmsAdapter,
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
from homun.application.gateway_contracts import ChannelMedia, ChannelMessage


class FeishuChannelAdapter(ChannelAdapter):
    """Feishu/Lark IM message send (Messaging catalog: feishu).

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
    """Mattermost API v4 posts (Messaging catalog: mattermost)."""

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
        token = _token_from(
            self.config,
            "MATTERMOST_TOKEN",
            "HOMUN_MATTERMOST_TOKEN",
            "MATTERMOST_BOT_TOKEN",
        )
        base = (
            str(self.config.get("base_url") or "").strip()
            or str(os.environ.get("HOMUN_MATTERMOST_URL") or os.environ.get("MATTERMOST_URL") or "").strip()
        )
        if not token or not base or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{base.rstrip('/')}/api/v4/posts"
        body: Dict[str, Any] = {"channel_id": channel_id, "message": text}
        root_id = thread_id or reply_to_id
        if root_id:
            body["root_id"] = root_id
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
    """Google Chat space message delivery via webhook or bearer API."""

    platform = "google_chat"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        message = payload.get("message") or payload
        space = payload.get("space") or message.get("space") or {}
        sender = message.get("sender") or payload.get("user") or {}
        return ChannelMessage(
            id=str(message.get("name") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(space.get("name") or payload.get("channel_id") or ""),
            user_id=str(sender.get("name") or sender.get("displayName") or payload.get("user_id") or ""),
            text=str(message.get("text") or payload.get("text") or ""),
            is_direct=str(space.get("type") or "").upper() == "DM",
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
        target_url = ""
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if webhook.startswith("http"):
            target_url = webhook
        elif channel_id.startswith("http"):
            target_url = channel_id
        elif token and channel_id.startswith("spaces/"):
            target_url = f"https://chat.googleapis.com/v1/{channel_id}/messages"
            headers["Authorization"] = f"Bearer {token}"
        else:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)

        body: Dict[str, Any] = {"text": text}
        thread_key = thread_id or reply_to_id
        if thread_key:
            body["thread"] = {"threadKey": thread_key} if not thread_key.startswith("spaces/") else {"name": thread_key}
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
                    error=f"Google Chat HTTP {resp.status_code}",
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
                extra={"message_name": data.get("name") if isinstance(data, dict) else None},
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
    """DingTalk custom robot webhook or OpenAPI sender."""

    platform = "dingtalk"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        text_obj = payload.get("text") or {}
        text = text_obj.get("content") if isinstance(text_obj, dict) else payload.get("text")
        return ChannelMessage(
            id=str(payload.get("msgId") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("conversationId") or payload.get("channel_id") or ""),
            user_id=str(payload.get("senderStaffId") or payload.get("senderId") or payload.get("user_id") or ""),
            text=str(text or ""),
            is_direct=not bool(payload.get("isInAtList", True)),
            timestamp=float(payload.get("createAt") or time.time()) / (
                1000.0 if payload.get("createAt") and payload.get("createAt") > 10_000_000_000 else 1.0
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
            str(self.config.get("webhook_url") or "").strip()
            or str(os.environ.get("DINGTALK_WEBHOOK_URL") or os.environ.get("HOMUN_DINGTALK_WEBHOOK_URL") or "").strip()
        )
        token = _token_from(self.config, "DINGTALK_ACCESS_TOKEN", "HOMUN_DINGTALK_TOKEN")
        target_url = ""
        if webhook.startswith("http"):
            target_url = webhook
        elif channel_id.startswith("http"):
            target_url = channel_id
        elif token:
            target_url = f"https://oapi.dingtalk.com/robot/send?access_token={token}"
        else:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)

        body = {"msgtype": "text", "text": {"content": text}}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(target_url, json=body)
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
    """WeCom (WeChat Work) group bot webhook and app message send."""

    platform = "wecom"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("msgid") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("chatid") or payload.get("channel_id") or ""),
            user_id=str(payload.get("from") or payload.get("user_id") or ""),
            text=str(payload.get("text") or payload.get("content") or ""),
            is_direct=bool(payload.get("is_direct")),
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
            or str(os.environ.get("WECOM_WEBHOOK_URL") or os.environ.get("HOMUN_WECOM_WEBHOOK_URL") or "").strip()
        )
        token = _token_from(self.config, "WECOM_BOT_KEY", "HOMUN_WECOM_KEY", "WECOM_TOKEN")
        target_url = ""
        if webhook.startswith("http"):
            target_url = webhook
        elif channel_id.startswith("http"):
            target_url = channel_id
        elif token:
            target_url = f"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={token}"
        else:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)

        body = {"msgtype": "text", "text": {"content": text}}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(target_url, json=body)
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


class TeamsAdapter(ChannelAdapter):
    """Microsoft Teams incoming webhook / Bot Framework message adapter."""

    platform = "teams"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        sender = (payload.get("from") or {}).get("name") or (payload.get("from") or {}).get("id") or ""
        conversation = (payload.get("conversation") or {}).get("id") or ""
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(conversation or payload.get("channel_id") or ""),
            user_id=str(sender or payload.get("user_id") or ""),
            text=str(payload.get("text") or ""),
            is_direct=bool((payload.get("conversation") or {}).get("isGroup") is False),
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
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Teams HTTP {resp.status_code}",
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


class WeixinAdapter(ChannelAdapter):
    """Weixin / WeChat Official Account custom message send (Messaging catalog: weixin)."""

    platform = "weixin"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("MsgId") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("FromUserName") or payload.get("channel_id") or ""),
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
        token = _token_from(self.config, "WEIXIN_ACCESS_TOKEN", "HOMUN_WEIXIN_ACCESS_TOKEN")
        if not token or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token={token}"
        body = {"touser": channel_id, "msgtype": "text", "text": {"content": text}}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=body)
            data = resp.json() if resp.content else {}
            if resp.status_code >= 400 or (isinstance(data, dict) and data.get("errcode", 0) != 0):
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Weixin HTTP {resp.status_code} {data.get('errmsg', '')}".strip(),
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


class QqBotAdapter(ChannelAdapter):
    """QQ Bot OpenAPI v2 channel message send (Messaging catalog: qqbot)."""

    platform = "qqbot"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        d = payload.get("d") or payload
        author = d.get("author") or {}
        return ChannelMessage(
            id=str(d.get("id") or payload.get("id") or uuid.uuid4().hex[:8]),
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
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"QQBot HTTP {resp.status_code}",
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
