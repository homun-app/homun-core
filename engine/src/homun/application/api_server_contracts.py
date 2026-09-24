"""Contracts and schemas for OpenAI-compatible API and idempotent runs (H35).

Derived from Hermes gateway/platforms/api_server*.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun provides external clients (OpenAI SDK, IDEs, curl) with standard endpoints:
- POST /v1/chat/completions (streaming SSE + non-streaming JSON, tool calls, usage)
- GET /v1/models
- Idempotent request execution via Idempotency-Key
"""
from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Dict, List, Literal, Optional, Union
from uuid import uuid4

from pydantic import BaseModel, Field


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
    """Thread-safe in-memory/cache store for idempotent requests."""

    def __init__(self, ttl_seconds: int = 86400):
        self._store: Dict[str, Dict[str, Any]] = {}
        self.ttl_seconds = ttl_seconds

    def _compute_key(self, key: Optional[str], body: Dict[str, Any], actor_id: str = "") -> str:
        if key:
            return f"key:{actor_id}:{key.strip()}"
        body_digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        return f"body:{actor_id}:{body_digest}"

    def get(self, key: Optional[str], body: Dict[str, Any], actor_id: str = "") -> Optional[Dict[str, Any]]:
        k = self._compute_key(key, body, actor_id)
        entry = self._store.get(k)
        if entry is None:
            return None
        if time.time() - entry["ts"] > self.ttl_seconds:
            self._store.pop(k, None)
            return None
        return entry["response"]

    def put(self, key: Optional[str], body: Dict[str, Any], response: Dict[str, Any], actor_id: str = "") -> None:
        k = self._compute_key(key, body, actor_id)
        self._store[k] = {
            "ts": time.time(),
            "response": response,
        }

    def clear(self) -> None:
        self._store.clear()


GLOBAL_IDEMPOTENCY_STORE = IdempotencyStore()
