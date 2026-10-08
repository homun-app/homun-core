"""Contracts and schemas for OpenAI-compatible API and idempotent runs (H35).

Homun provides external clients (OpenAI SDK, IDEs, curl) with standard endpoints:
- POST /v1/chat/completions (streaming SSE + non-streaming JSON, tool calls, usage)
- GET /v1/models
- Idempotent request execution via Idempotency-Key
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Union
from uuid import uuid4

from pydantic import BaseModel, Field

from homun.storage.paths import default_data_dir


class ChatCompletionMessage(BaseModel):
    role: str
    content: Optional[str] = None
    name: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[Dict[str, Any]]
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None
    stream: bool = False
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    idempotency_key: Optional[str] = None


class ModelInfo(BaseModel):
    id: str
    object: str = "model"
    created: int = Field(default_factory=lambda: int(time.time()))
    owned_by: str = "homun"


class ModelListResponse(BaseModel):
    object: str = "list"
    data: List[ModelInfo]


class ChatCompletionChoice(BaseModel):
    index: int = 0
    message: Dict[str, Any]
    finish_reason: Optional[str] = "stop"


class ChatCompletionResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid4().hex[:16]}")
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: List[ChatCompletionChoice]
    usage: Optional[Dict[str, Any]] = None


class ChatCompletionChunkChoiceDelta(BaseModel):
    role: Optional[str] = None
    content: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None


class ChatCompletionChunkChoice(BaseModel):
    index: int = 0
    delta: ChatCompletionChunkChoiceDelta
    finish_reason: Optional[str] = None


class ChatCompletionChunk(BaseModel):
    id: str
    object: str = "chat.completion.chunk"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: List[ChatCompletionChunkChoice]
    usage: Optional[Dict[str, Any]] = None


class IdempotencyStore:
    """Durable idempotency cache for OpenAI-compatible API requests (H35).

    Default path: HOMUN_DATA_DIR/api_idempotency.sqlite (override HOMUN_IDEMPOTENCY_DB).
    """

    def __init__(self, ttl_seconds: int = 86400, db_path: Optional[str] = None):
        self.ttl_seconds = ttl_seconds
        self._lock = threading.RLock()
        if db_path is None:
            override = os.environ.get("HOMUN_IDEMPOTENCY_DB")
            if override:
                db_path = override
            else:
                root = default_data_dir()
                root.mkdir(parents=True, exist_ok=True)
                db_path = str(root / "api_idempotency.sqlite")
        self.db_path = str(db_path)
        if self.db_path != ":memory:":
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        if self.db_path != ":memory:":
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS idempotency (
                cache_key TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                created_at REAL NOT NULL
            )
            """
        )
        self._conn.commit()

    def _compute_key(self, key: Optional[str], body: Dict[str, Any], actor_id: str = "") -> str:
        if key:
            return f"key:{actor_id}:{key.strip()}"
        body_digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        return f"body:{actor_id}:{body_digest}"

    def get(self, key: Optional[str], body: Dict[str, Any], actor_id: str = "") -> Optional[Dict[str, Any]]:
        k = self._compute_key(key, body, actor_id)
        with self._lock:
            row = self._conn.execute(
                "SELECT payload, created_at FROM idempotency WHERE cache_key = ?",
                (k,),
            ).fetchone()
            if row is None:
                return None
            payload, created_at = row
            if time.time() - float(created_at) > self.ttl_seconds:
                self._conn.execute("DELETE FROM idempotency WHERE cache_key = ?", (k,))
                self._conn.commit()
                return None
            try:
                data = json.loads(payload)
                return data if isinstance(data, dict) else None
            except Exception:
                return None

    def put(self, key: Optional[str], body: Dict[str, Any], response: Dict[str, Any], actor_id: str = "") -> None:
        k = self._compute_key(key, body, actor_id)
        blob = json.dumps(response, ensure_ascii=False, sort_keys=True)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO idempotency(cache_key, payload, created_at)
                VALUES(?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    payload = excluded.payload,
                    created_at = excluded.created_at
                """,
                (k, blob, time.time()),
            )
            self._conn.commit()

    def clear(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM idempotency")
            self._conn.commit()


GLOBAL_IDEMPOTENCY_STORE = IdempotencyStore(db_path=os.environ.get("HOMUN_IDEMPOTENCY_DB") or None)
