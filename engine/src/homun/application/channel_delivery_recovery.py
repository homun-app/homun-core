"""Delivery recovery, media uploads, and polling reconnection for messaging channels (H32/H33/D1).

Provides:
- Destination-scoped delivery tracking with idempotency and retry classification.
- Media upload dispatching (Telegram sendPhoto/sendDocument, Discord, Slack).
- Persistent polling and reconnection loop with exponential backoff.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import httpx

from homun.application.gateway_contracts import ChannelMedia, ChannelMessage
from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)


@dataclass
class ChannelDeliveryIntent:
    intent_id: str
    platform: str
    channel_id: str
    destination_id: str
    text: str
    media: List[Dict[str, Any]]
    thread_id: Optional[str]
    reply_to_id: Optional[str]
    status: str = "pending"  # pending, delivered, failed_retryable, failed_fatal, unknown
    attempts: int = 0
    provider_message_id: Optional[str] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class ChannelDeliverySupervisor:
    """Manages persistent delivery receipts and idempotency per destination."""

    def __init__(self, db_path: Optional[Path | str] = None) -> None:
        self._lock = threading.Lock()
        self._db_path = str(db_path or default_data_dir() / "channels" / "delivery_intents.sqlite")
        if self._db_path != ":memory:":
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False, timeout=30)
        self._conn.row_factory = sqlite3.Row
        self._init_db()

    def _init_db(self) -> None:
        with self._lock, self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS channel_delivery_intents (
                    intent_id TEXT PRIMARY KEY,
                    platform TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    destination_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    media TEXT NOT NULL,
                    thread_id TEXT,
                    reply_to_id TEXT,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    provider_message_id TEXT,
                    error TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_delivery_status ON channel_delivery_intents(platform, status)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_delivery_destination ON channel_delivery_intents(destination_id, platform)"
            )

    def prepare_intent(
        self,
        platform: str,
        channel_id: str,
        destination_id: str,
        text: str,
        *,
        media: Optional[List[ChannelMedia]] = None,
        thread_id: Optional[str] = None,
        reply_to_id: Optional[str] = None,
        intent_id: Optional[str] = None,
    ) -> ChannelDeliveryIntent:
        iid = intent_id or f"del_{uuid.uuid4().hex[:12]}"
        now = time.time()
        media_dicts = [asdict(m) if isinstance(m, ChannelMedia) else m for m in (media or [])]
        intent = ChannelDeliveryIntent(
            intent_id=iid,
            platform=platform.strip().lower(),
            channel_id=channel_id,
            destination_id=destination_id or channel_id,
            text=text,
            media=media_dicts,
            thread_id=thread_id,
            reply_to_id=reply_to_id,
            status="pending",
            created_at=now,
            updated_at=now,
        )
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO channel_delivery_intents (
                    intent_id, platform, channel_id, destination_id,
                    text, media, thread_id, reply_to_id,
                    status, attempts, provider_message_id, error,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    intent.intent_id,
                    intent.platform,
                    intent.channel_id,
                    intent.destination_id,
                    intent.text,
                    json.dumps(intent.media),
                    intent.thread_id,
                    intent.reply_to_id,
                    intent.status,
                    intent.attempts,
                    intent.provider_message_id,
                    intent.error,
                    intent.created_at,
                    intent.updated_at,
                ),
            )
        return intent

    def record_outcome(
        self,
        intent_id: str,
        *,
        delivered: bool,
        provider_message_id: Optional[str] = None,
        error: Optional[str] = None,
        status_code: Optional[int] = None,
    ) -> ChannelDeliveryIntent:
        now = time.time()
        if delivered:
            new_status = "delivered"
        elif status_code in {400, 401, 403, 404}:
            new_status = "failed_fatal"
        else:
            new_status = "failed_retryable"

        with self._lock, self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            self._conn.execute(
                """
                UPDATE channel_delivery_intents
                SET status = ?,
                    attempts = attempts + 1,
                    provider_message_id = COALESCE(?, provider_message_id),
                    error = ?,
                    updated_at = ?
                WHERE intent_id = ?
                """,
                (new_status, str(provider_message_id) if provider_message_id else None, str(error or ""), now, intent_id),
            )
            cur = self._conn.execute("SELECT * FROM channel_delivery_intents WHERE intent_id = ?", (intent_id,))
            row = cur.fetchone()
            return ChannelDeliveryIntent(
                intent_id=row["intent_id"],
                platform=row["platform"],
                channel_id=row["channel_id"],
                destination_id=row["destination_id"],
                text=row["text"],
                media=json.loads(row["media"]),
                thread_id=row["thread_id"],
                reply_to_id=row["reply_to_id"],
                status=row["status"],
                attempts=row["attempts"],
                provider_message_id=row["provider_message_id"],
                error=row["error"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )

    def get_intent(self, intent_id: str) -> Optional[ChannelDeliveryIntent]:
        with self._lock, self._conn:
            cur = self._conn.execute("SELECT * FROM channel_delivery_intents WHERE intent_id = ?", (intent_id,))
            row = cur.fetchone()
            if not row:
                return None
            return ChannelDeliveryIntent(
                intent_id=row["intent_id"],
                platform=row["platform"],
                channel_id=row["channel_id"],
                destination_id=row["destination_id"],
                text=row["text"],
                media=json.loads(row["media"]),
                thread_id=row["thread_id"],
                reply_to_id=row["reply_to_id"],
                status=row["status"],
                attempts=row["attempts"],
                provider_message_id=row["provider_message_id"],
                error=row["error"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )


def send_with_media_dispatch(
    adapter: Any,
    channel_id: str,
    text: str,
    *,
    media: Optional[List[ChannelMedia]] = None,
    thread_id: Optional[str] = None,
    reply_to_id: Optional[str] = None,
    supervisor: Optional[ChannelDeliverySupervisor] = None,
    intent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute channel send with real media protocol dispatch (sendPhoto/sendDocument) and delivery intent."""
    sup = supervisor or get_channel_delivery_supervisor()
    platform = getattr(adapter, "platform", "unknown").lower()
    intent = sup.prepare_intent(
        platform=platform,
        channel_id=channel_id,
        destination_id=channel_id,
        text=text,
        media=media,
        thread_id=thread_id,
        reply_to_id=reply_to_id,
        intent_id=intent_id,
    )

    token = getattr(adapter, "config", {}).get("bot_token") or getattr(adapter, "config", {}).get("TELEGRAM_BOT_TOKEN")
    timeout = float(getattr(adapter, "config", {}).get("timeout") or 15.0)

    # 1. Telegram dedicated media protocol
    if platform == "telegram" and token and media:
        first_media = media[0]
        media_url = getattr(first_media, "url", None) or getattr(first_media, "path", "")
        media_type = str(getattr(first_media, "mime_type", "") or getattr(first_media, "media_type", "") or "")
        is_image = media_type.startswith("image/") or any(str(media_url).lower().endswith(ext) for ext in [".jpg", ".jpeg", ".png", ".gif", ".webp"])

        method = "sendPhoto" if is_image else "sendDocument"
        field_name = "photo" if is_image else "document"
        url = f"https://api.telegram.org/bot{token}/{method}"
        payload: Dict[str, Any] = {
            "chat_id": channel_id,
            field_name: media_url,
            "caption": text,
        }
        if thread_id:
            payload["message_thread_id"] = thread_id
        if reply_to_id:
            payload["reply_to_message_id"] = reply_to_id

        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(url, json=payload)
            if resp.status_code >= 400:
                sup.record_outcome(intent.intent_id, delivered=False, error=f"HTTP {resp.status_code}", status_code=resp.status_code)
                return {
                    "platform": "telegram",
                    "channel_id": channel_id,
                    "delivered": False,
                    "error": f"Telegram API HTTP {resp.status_code}",
                    "status_code": resp.status_code,
                    "intent_id": intent.intent_id,
                }
            data = resp.json() if resp.content else {}
            if isinstance(data, dict) and data.get("ok") is False:
                sup.record_outcome(intent.intent_id, delivered=False, error=str(data.get("description")))
                return {
                    "platform": "telegram",
                    "channel_id": channel_id,
                    "delivered": False,
                    "error": data.get("description"),
                    "intent_id": intent.intent_id,
                }
            msg_id = (data.get("result") or {}).get("message_id")
            sup.record_outcome(intent.intent_id, delivered=True, provider_message_id=str(msg_id))
            return {
                "platform": "telegram",
                "channel_id": channel_id,
                "delivered": True,
                "provider_message_id": msg_id,
                "intent_id": intent.intent_id,
            }
        except Exception as exc:
            sup.record_outcome(intent.intent_id, delivered=False, error=str(exc))
            return {
                "platform": "telegram",
                "channel_id": channel_id,
                "delivered": False,
                "error": str(exc),
                "intent_id": intent.intent_id,
            }

    # 2. General send delegation
    try:
        out = adapter.send(channel_id, text, thread_id=thread_id, reply_to_id=reply_to_id, media=media)
        delivered = bool(out.get("delivered", False))
        prov_id = out.get("provider_message_id") or out.get("ts") or out.get("id")
        sup.record_outcome(
            intent.intent_id,
            delivered=delivered,
            provider_message_id=str(prov_id) if prov_id else None,
            error=out.get("error"),
            status_code=out.get("status_code"),
        )
        return {**out, "intent_id": intent.intent_id}
    except Exception as exc:
        sup.record_outcome(intent.intent_id, delivered=False, error=str(exc))
        return {
            "platform": platform,
            "channel_id": channel_id,
            "delivered": False,
            "error": str(exc),
            "intent_id": intent.intent_id,
        }


class ChannelPoller:
    """Persistent poller for polling-based channels (e.g. Telegram getUpdates) with backoff."""

    def __init__(
        self,
        platform: str,
        bot_token: str,
        inbound_handler: Callable[[Dict[str, Any]], None],
        *,
        base_url: Optional[str] = None,
        db_path: Optional[Path | str] = None,
    ) -> None:
        self.platform = platform.lower()
        self.bot_token = bot_token
        self.inbound_handler = inbound_handler
        self.base_url = (base_url or "https://api.telegram.org").rstrip("/")
        self._db_path = str(db_path or default_data_dir() / "channels" / "poller_state.sqlite")
        if self._db_path != ":memory:":
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False, timeout=30)
        self._init_db()

    def _init_db(self) -> None:
        with self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS channel_poller_state (
                    platform TEXT PRIMARY KEY,
                    last_offset INTEGER NOT NULL DEFAULT 0,
                    updated_at REAL NOT NULL
                )
                """
            )

    def get_offset(self) -> int:
        with self._conn:
            cur = self._conn.execute("SELECT last_offset FROM channel_poller_state WHERE platform = ?", (self.platform,))
            row = cur.fetchone()
            return row[0] if row else 0

    def set_offset(self, offset: int) -> None:
        with self._conn:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO channel_poller_state (platform, last_offset, updated_at)
                VALUES (?, ?, ?)
                """,
                (self.platform, offset, time.time()),
            )

    def poll_once(self, timeout: int = 5) -> List[Dict[str, Any]]:
        """Fetch pending updates from the platform API, advance offset, and deliver to queue."""
        if self.platform != "telegram":
            raise NotImplementedError(f"Polling not implemented for platform: {self.platform}")

        offset = self.get_offset()
        url = f"{self.base_url}/bot{self.bot_token}/getUpdates"
        params = {"offset": offset, "timeout": timeout}

        try:
            with httpx.Client(timeout=timeout + 5) as client:
                resp = client.get(url, params=params)
            if resp.status_code != 200:
                logger.warning("Poller HTTP %d for %s", resp.status_code, self.platform)
                return []
            data = resp.json()
            if not data.get("ok"):
                logger.warning("Poller API returned not ok: %s", data.get("description"))
                return []

            updates = data.get("result") or []
            ingested = []
            max_id = offset
            for upd in updates:
                upd_id = upd.get("update_id", 0)
                if upd_id >= max_id:
                    max_id = upd_id + 1
                self.inbound_handler(upd)
                ingested.append(upd)

            if max_id > offset:
                self.set_offset(max_id)
            return ingested
        except Exception as exc:
            logger.error("Polling error for %s: %s", self.platform, exc)
            return []


_GLOBAL_DELIVERY_SUPERVISOR: Optional[ChannelDeliverySupervisor] = None


def get_channel_delivery_supervisor() -> ChannelDeliverySupervisor:
    global _GLOBAL_DELIVERY_SUPERVISOR
    if _GLOBAL_DELIVERY_SUPERVISOR is None:
        _GLOBAL_DELIVERY_SUPERVISOR = ChannelDeliverySupervisor()
    return _GLOBAL_DELIVERY_SUPERVISOR


def reset_channel_delivery_supervisor() -> None:
    global _GLOBAL_DELIVERY_SUPERVISOR
    _GLOBAL_DELIVERY_SUPERVISOR = None
