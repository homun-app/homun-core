"""OpenAI-compatible chat completions and models API (H35).

Provides standard OpenAI-compatible endpoints:
- GET /v1/models: lists available model connections and MoA presets
- POST /v1/chat/completions: supports non-streaming JSON and streaming SSE,
  tool-calls mapping, and request idempotency via Idempotency-Key.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator, Dict, List, Optional
from uuid import uuid4

from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from homun.application.api_server_contracts import (
    GLOBAL_IDEMPOTENCY_STORE,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionChunkChoiceDelta,
    ChatCompletionChoice,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ModelInfo,
    ModelListResponse,
)
from homun.context import get_context
from homun.domain.errors import DomainError
from homun.models.agent_turn import ToolDefinition
from homun.models.native_turn import NativeMessage, ToolCall

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["openai_compat"])


@router.get("/models", response_model=ModelListResponse)
def list_models() -> ModelListResponse:
    """List available models and presets in OpenAI format."""
    ctx = get_context()
    models: List[ModelInfo] = []
    seen = set()

    for conn in ctx.models.list_connections():
        model_id = conn.model_id or conn.id
        if model_id and model_id not in seen:
            seen.add(model_id)
            models.append(ModelInfo(id=model_id, owned_by=conn.kind))

    # Add default virtual models
    if "homun-agent" not in seen:
        models.append(ModelInfo(id="homun-agent", owned_by="homun"))
    if "moa:default" not in seen:
        models.append(ModelInfo(id="moa:default", owned_by="homun-moa"))

    return ModelListResponse(data=models)


def _convert_messages(raw_messages: List[Dict[str, Any]]) -> List[NativeMessage]:
    """Convert OpenAI messages into Homun NativeMessages."""
    converted: List[NativeMessage] = []
    for m in raw_messages:
        role = m.get("role", "user")
        if role not in ("system", "user", "assistant", "tool"):
            role = "user"
        content = str(m.get("content") or "")
        t_calls: List[ToolCall] = []
        for raw_tc in m.get("tool_calls") or []:
            fn = raw_tc.get("function") or {}
            args = fn.get("arguments", "{}")
            if isinstance(args, str):
                try:
                    args_dict = json.loads(args)
                except Exception:
                    args_dict = {"raw": args}
            else:
                args_dict = args or {}
            t_calls.append(ToolCall(
                id=raw_tc.get("id") or f"call_{uuid4().hex[:8]}",
                name=fn.get("name") or raw_tc.get("name") or "tool",
                arguments=args_dict,
            ))
        converted.append(NativeMessage(
            role=role,
            content=content,
            tool_calls=t_calls,
            tool_call_id=m.get("tool_call_id"),
            name=m.get("name"),
        ))
    return converted


def _convert_tools(raw_tools: Optional[List[Dict[str, Any]]]) -> Optional[List[ToolDefinition]]:
    """Convert OpenAI tool definitions into Homun ToolDefinitions."""
    if not raw_tools:
        return None
    tools: List[ToolDefinition] = []
    for rt in raw_tools:
        if rt.get("type") == "function" or "function" in rt:
            fn = rt.get("function") or rt
            tools.append(ToolDefinition(
                name=fn.get("name") or "tool",
                description=fn.get("description") or "",
                input_schema=fn.get("parameters") or {"type": "object"},
            ))
    return tools or None


@router.post("/chat/completions")
async def chat_completions(
    req: ChatCompletionRequest,
    request: Request,
    idempotency_key_header: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    """OpenAI-compatible chat completion endpoint supporting streaming, tools, and idempotency."""
    ctx = get_context()
    idem_key = idempotency_key_header or req.idempotency_key
    actor_id = request.headers.get("X-Homun-Actor-Id", "default")
    req_dict = req.model_dump()

    # 1. Idempotency Check
    cached = GLOBAL_IDEMPOTENCY_STORE.get(idem_key, req_dict, actor_id=actor_id)
    if cached is not None:
        return JSONResponse(content=cached, headers={"X-Cache-Lookup": "HIT"})

    native_messages = _convert_messages(req.messages)
    native_tools = _convert_tools(req.tools)

    # 2. Execution via Models Port
    try:
        if native_tools:
            res = ctx.models.complete_tools(native_messages, tools=native_tools, model_id=req.model)
        else:
            res = ctx.models.complete_tools(native_messages, tools=None, model_id=req.model)
    except Exception as exc:
        logger.error("Chat completion error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    # 3. Handle Streaming Response
    if req.stream:
        cmpl_id = f"chatcmpl-{uuid4().hex[:16]}"
        created_ts = int(time.time())

        async def sse_generator() -> AsyncIterator[str]:
            if await request.is_disconnected():
                return

            # Initial role chunk
            chunk_role = ChatCompletionChunk(
                id=cmpl_id,
                created=created_ts,
                model=req.model,
                choices=[ChatCompletionChunkChoice(
                    index=0,
                    delta=ChatCompletionChunkChoiceDelta(role="assistant", content=""),
                )],
            )
            yield f"data: {chunk_role.model_dump_json()}\n\n"

            if await request.is_disconnected():
                return

            # Content chunk if content exists
            if res.message.content:
                chunk_content = ChatCompletionChunk(
                    id=cmpl_id,
                    created=created_ts,
                    model=req.model,
                    choices=[ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionChunkChoiceDelta(content=res.message.content),
                    )],
                )
                yield f"data: {chunk_content.model_dump_json()}\n\n"

            if await request.is_disconnected():
                return

            # Tool calls chunks if any
            if res.message.tool_calls:
                for idx, tc in enumerate(res.message.tool_calls):
                    if await request.is_disconnected():
                        return
                    tc_delta = {
                        "index": idx,
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments),
                        },
                    }
                    chunk_tc = ChatCompletionChunk(
                        id=cmpl_id,
                        created=created_ts,
                        model=req.model,
                        choices=[ChatCompletionChunkChoice(
                            index=0,
                            delta=ChatCompletionChunkChoiceDelta(tool_calls=[tc_delta]),
                        )],
                    )
                    yield f"data: {chunk_tc.model_dump_json()}\n\n"

            if await request.is_disconnected():
                return

            # Finish chunk
            finish = "tool_calls" if res.message.tool_calls else "stop"
            chunk_finish = ChatCompletionChunk(
                id=cmpl_id,
                created=created_ts,
                model=req.model,
                choices=[ChatCompletionChunkChoice(
                    index=0,
                    delta=ChatCompletionChunkChoiceDelta(),
                    finish_reason=finish,
                )],
            )
            yield f"data: {chunk_finish.model_dump_json()}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(sse_generator(), media_type="text/event-stream")

    # 4. Handle Non-Streaming Response
    finish_reason = "tool_calls" if res.message.tool_calls else "stop"
    tool_calls_payload = None
    if res.message.tool_calls:
        tool_calls_payload = [
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.name,
                    "arguments": json.dumps(tc.arguments),
                },
            }
            for tc in res.message.tool_calls
        ]

    choice_msg = {
        "role": "assistant",
        "content": res.message.content or None,
    }
    if tool_calls_payload:
        choice_msg["tool_calls"] = tool_calls_payload

    usage_dict = None
    if res.usage:
        usage_dict = {
            "prompt_tokens": res.usage.input_tokens or 0,
            "completion_tokens": res.usage.output_tokens or 0,
            "total_tokens": (res.usage.input_tokens or 0) + (res.usage.output_tokens or 0),
        }

    response_obj = ChatCompletionResponse(
        model=req.model,
        choices=[ChatCompletionChoice(
            index=0,
            message=choice_msg,
            finish_reason=finish_reason,
        )],
        usage=usage_dict,
    )
    resp_dict = response_obj.model_dump()

    # Save for idempotency
    GLOBAL_IDEMPOTENCY_STORE.put(idem_key, req_dict, resp_dict, actor_id=actor_id)
    return JSONResponse(content=resp_dict)
