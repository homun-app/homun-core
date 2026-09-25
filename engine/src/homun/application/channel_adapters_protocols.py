"""Protocol-level and niche messaging adapters (H33).

Derived from Hermes gateway/platforms and user-guide/messaging at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Includes Email (SMTP), IRC, Signal (signal-cli REST), SimpleX Chat,
BlueBubbles (iMessage), LINE, and SMS (Twilio).
"""
from __future__ import annotations

import json
import logging
import os
import smtplib
import socket
import time
from email.message import EmailMessage
from typing import Any, Dict, List, Optional
import uuid

import httpx

from homun.application.channel_contracts import (
    ChannelAdapter,
    _http_delivery_result,
    _token_from,
)
from homun.application.gateway_contracts import ChannelMedia, ChannelMessage

logger = logging.getLogger(__name__)


class EmailAdapter(ChannelAdapter):
    """SMTP outbound email (Hermes messaging catalog: email)."""

    platform = "email"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("message_id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("to") or payload.get("channel_id") or ""),
            user_id=str(payload.get("from") or payload.get("user_id") or ""),
            text=str(payload.get("subject") or "") + "\n" + str(payload.get("text") or payload.get("body") or ""),
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
        host = (
            str(self.config.get("smtp_host") or "").strip()
            or str(os.environ.get("HOMUN_SMTP_HOST") or os.environ.get("SMTP_HOST") or "").strip()
        )
        port = int(self.config.get("smtp_port") or os.environ.get("HOMUN_SMTP_PORT") or os.environ.get("SMTP_PORT") or 587)
        user = (
            str(self.config.get("smtp_user") or "").strip()
            or str(os.environ.get("HOMUN_SMTP_USER") or os.environ.get("SMTP_USER") or "").strip()
        )
        password = (
            str(self.config.get("smtp_password") or "").strip()
            or str(os.environ.get("HOMUN_SMTP_PASSWORD") or os.environ.get("SMTP_PASSWORD") or "").strip()
        )
        mail_from = (
            str(self.config.get("from") or "").strip()
            or str(os.environ.get("HOMUN_SMTP_FROM") or user or "").strip()
        )
        if not host or not mail_from or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)

        subject = str(self.config.get("subject") or thread_id or "Homun")
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = mail_from
        msg["To"] = channel_id
        if reply_to_id:
            msg["In-Reply-To"] = reply_to_id
        msg.set_content(text)
        try:
            with smtplib.SMTP(host, port, timeout=float(self.config.get("timeout") or 20.0)) as smtp:
                smtp.ehlo()
                if self.config.get("starttls", True):
                    smtp.starttls()
                    smtp.ehlo()
                if user and password:
                    smtp.login(user, password)
                smtp.send_message(msg)
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
                status_code=250,
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


class SignalAdapter(ChannelAdapter):
    """signal-cli REST API outbound (when SIGNAL_CLI_REST_URL is set)."""

    platform = "signal"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        envelope = payload.get("envelope") or payload
        data = envelope.get("dataMessage") or {}
        return ChannelMessage(
            id=str(envelope.get("timestamp") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(envelope.get("source") or payload.get("channel_id") or ""),
            user_id=str(envelope.get("sourceNumber") or envelope.get("source") or ""),
            text=str(data.get("message") or payload.get("text") or ""),
            is_direct=True,
            timestamp=float(envelope.get("timestamp") or time.time()) / (
                1000.0 if envelope.get("timestamp") and envelope.get("timestamp") > 10_000_000_000 else 1.0
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
            str(self.config.get("rest_url") or "").strip()
            or str(os.environ.get("SIGNAL_CLI_REST_URL") or os.environ.get("HOMUN_SIGNAL_CLI_REST_URL") or "").strip()
        )
        number = (
            str(self.config.get("number") or "").strip()
            or str(os.environ.get("SIGNAL_CLI_NUMBER") or os.environ.get("HOMUN_SIGNAL_NUMBER") or "").strip()
        )
        if not base or not number:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"{base.rstrip('/')}/v2/send"
        payload = {"message": text, "number": number, "recipients": [channel_id]}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 20.0)) as client:
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
                    error=f"Signal REST HTTP {resp.status_code}",
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


class IrcAdapter(ChannelAdapter):
    """Classic IRC PRIVMSG delivery when IRC_HOST is configured (H33)."""

    platform = "irc"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(payload.get("channel") or payload.get("channel_id") or ""),
            user_id=str(payload.get("nick") or payload.get("user_id") or ""),
            text=str(payload.get("text") or payload.get("message") or ""),
            is_direct=str(payload.get("channel") or "").startswith("#") is False,
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
        host = (
            str(self.config.get("host") or "").strip()
            or str(os.environ.get("IRC_HOST") or os.environ.get("HOMUN_IRC_HOST") or "").strip()
        )
        port = int(self.config.get("port") or os.environ.get("IRC_PORT") or os.environ.get("HOMUN_IRC_PORT") or 6667)
        nick = (
            str(self.config.get("nick") or "").strip()
            or str(os.environ.get("IRC_NICK") or os.environ.get("HOMUN_IRC_NICK") or "homun").strip()
        )
        if not host or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        password = str(self.config.get("password") or os.environ.get("IRC_PASSWORD") or os.environ.get("HOMUN_IRC_PASSWORD") or "")
        timeout = float(self.config.get("timeout") or 15.0)
        try:
            with socket.create_connection((host, port), timeout=timeout) as sock:
                sock.settimeout(timeout)

                def _send(line: str) -> None:
                    sock.sendall((line + "\r\n").encode("utf-8"))

                if password:
                    _send(f"PASS {password}")
                _send(f"NICK {nick}")
                _send(f"USER {nick} 0 * :Homun")
                sock.settimeout(2.0)
                try:
                    while True:
                        chunk = sock.recv(4096)
                        if not chunk:
                            break
                        for raw in chunk.decode("utf-8", errors="replace").splitlines():
                            if raw.upper().startswith("PING"):
                                _send("PONG " + raw.split(" ", 1)[1])
                except socket.timeout:
                    pass
                sock.settimeout(timeout)
                if channel_id.startswith("#"):
                    _send(f"JOIN {channel_id}")
                for i in range(0, len(text), 350):
                    _send(f"PRIVMSG {channel_id} :{text[i:i+350]}")
                _send("QUIT :homun")
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
                status_code=200,
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
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"SimpleX HTTP {resp.status_code}",
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


class BlueBubblesAdapter(ChannelAdapter):
    """BlueBubbles iMessage REST bridge send (Hermes messaging catalog: bluebubbles)."""

    platform = "bluebubbles"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        data = payload.get("data") or payload
        handle = (data.get("handle") or {}).get("address") or data.get("sender") or ""
        chats = data.get("chats") or []
        chat_guid = chats[0].get("guid") if chats and isinstance(chats[0], dict) else ""
        return ChannelMessage(
            id=str(data.get("guid") or payload.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(chat_guid or payload.get("channel_id") or handle or ""),
            user_id=str(handle or payload.get("user_id") or ""),
            text=str(data.get("text") or payload.get("text") or ""),
            is_direct=not bool(data.get("isGroup")),
            timestamp=float(data.get("dateCreated") or time.time()) / (
                1000.0 if data.get("dateCreated") and data.get("dateCreated") > 10_000_000_000 else 1.0
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
        body = {"chatGuid": channel_id, "text": text}
        params = {"password": password} if password else None
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, json=body, params=params)
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"BlueBubbles HTTP {resp.status_code}",
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
    """LINE Messaging API push message adapter."""

    platform = "line"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        events = payload.get("events") or []
        first = events[0] if events and isinstance(events[0], dict) else payload
        source = first.get("source") or {}
        msg = first.get("message") or {}
        return ChannelMessage(
            id=str(msg.get("id") or first.get("id") or uuid.uuid4().hex[:8]),
            platform=self.platform,
            channel_id=str(source.get("groupId") or source.get("roomId") or source.get("userId") or payload.get("channel_id") or ""),
            user_id=str(source.get("userId") or payload.get("user_id") or ""),
            text=str(msg.get("text") or payload.get("text") or ""),
            is_direct=source.get("type") == "user",
            timestamp=float(first.get("timestamp") or time.time()) / (
                1000.0 if first.get("timestamp") and first.get("timestamp") > 10_000_000_000 else 1.0
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
            "LINE_CHANNEL_ACCESS_TOKEN",
            "HOMUN_LINE_CHANNEL_ACCESS_TOKEN",
            "LINE_TOKEN",
        )
        if not token or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = "https://api.line.me/v2/bot/message/push"
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        body = {"to": channel_id, "messages": [{"type": "text", "text": text}]}
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
                    error=f"LINE HTTP {resp.status_code}",
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


class SmsAdapter(ChannelAdapter):
    """Twilio SMS REST API adapter."""

    platform = "sms"

    def parse_inbound(self, payload: Dict[str, Any]) -> ChannelMessage:
        return ChannelMessage(
            id=str(payload.get("MessageSid") or payload.get("SmsSid") or payload.get("id") or uuid.uuid4().hex[:8]),
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
        sid = (
            str(self.config.get("account_sid") or "").strip()
            or str(os.environ.get("TWILIO_ACCOUNT_SID") or os.environ.get("HOMUN_TWILIO_ACCOUNT_SID") or "").strip()
        )
        token = _token_from(self.config, "TWILIO_AUTH_TOKEN", "HOMUN_TWILIO_AUTH_TOKEN")
        from_number = (
            str(self.config.get("from_number") or "").strip()
            or str(os.environ.get("TWILIO_FROM_NUMBER") or os.environ.get("HOMUN_TWILIO_FROM_NUMBER") or "").strip()
        )
        if not sid or not token or not from_number or not channel_id:
            return super().send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
        data = {"From": from_number, "To": channel_id, "Body": text}
        try:
            with httpx.Client(timeout=float(self.config.get("timeout") or 15.0)) as client:
                resp = client.post(url, data=data, auth=(sid, token))
            if resp.status_code >= 400:
                return _http_delivery_result(
                    platform=self.platform,
                    channel_id=channel_id,
                    text=text,
                    thread_id=thread_id,
                    reply_to_id=reply_to_id,
                    media=media,
                    delivered=False,
                    error=f"Twilio SMS HTTP {resp.status_code}",
                    status_code=resp.status_code,
                )
            res_data = resp.json() if resp.content else {}
            return _http_delivery_result(
                platform=self.platform,
                channel_id=channel_id,
                text=text,
                thread_id=thread_id,
                reply_to_id=reply_to_id,
                media=media,
                delivered=True,
                status_code=resp.status_code,
                extra={"message_sid": res_data.get("sid") if isinstance(res_data, dict) else None},
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
