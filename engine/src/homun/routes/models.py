"""Model provider HTTP API (F3.1)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from homun.context import get_context
from homun.models.interpretation import RosterEntry
from homun.models.types import ChatMessage
from homun.routes.sse import sse_event

router = APIRouter(prefix="/v1/models", tags=["models"])


class CredentialsRequest(BaseModel):
    api_key: str
    base_url: str | None = None
    default_model: str | None = None


class ActiveProviderRequest(BaseModel):
    provider_id: str


class CompleteRequest(BaseModel):
    messages: list[ChatMessage]
    provider_id: str | None = None
    connection_id: str | None = None
    model_id: str | None = None


class InterpretRequest(BaseModel):
    text: str
    roster: list[RosterEntry] = Field(default_factory=list)
    provider_id: str | None = None


class OllamaPresetRequest(BaseModel):
    model: str = "qwen3.5:4b"


@router.get("/providers")
def list_providers() -> dict[str, Any]:
    ctx = get_context()
    return {
        "active_provider_id": ctx.models.active_provider_id,
        "items": [p.model_dump(mode="json") for p in ctx.models.list_providers()],
    }


@router.get("/connections")
def list_connections() -> dict[str, Any]:
    """ModelPort connections — preferred over /providers for new UI."""
    ctx = get_context()
    return {
        "active_connection_id": ctx.models.active_provider_id,
        "items": [c.model_dump(mode="json") for c in ctx.models.list_connections()],
    }


@router.post("/chat")
def chat_complete(body: CompleteRequest) -> dict[str, Any]:
    """Alias of /complete — ModelPort chat entrypoint."""
    return complete(body)


@router.post("/chat/stream")
def chat_stream(body: CompleteRequest) -> StreamingResponse:
    """SSE token stream for ModelPort chat (live chunks then result)."""
    ctx = get_context()
    connection_id = body.connection_id or body.provider_id

    def events() -> Iterator[str]:
        pieces: list[str] = []
        try:
            for piece in ctx.models.stream(
                body.messages,
                connection_id=connection_id,
                model_id=body.model_id,
            ):
                pieces.append(piece)
                yield sse_event("token", {"text": piece, "source": "modelport"})
        except KeyError as exc:
            yield sse_event(
                "error",
                {"code": "not_found", "message": str(exc)},
            )
            return
        except RuntimeError as exc:
            yield sse_event(
                "error",
                {"code": "provider_unavailable", "message": str(exc)},
            )
            return
        text = "".join(pieces)
        last_usage = ctx.models.list_usage(limit=1)
        model_id = body.model_id
        if last_usage:
            model_id = model_id or last_usage[-1].model_id
        yield sse_event(
            "result",
            {
                "text": text,
                "provider_id": connection_id or ctx.models.active_provider_id,
                "model_id": model_id,
            },
        )

    return StreamingResponse(events(), media_type="text/event-stream")


@router.post("/providers/active")
def set_active_provider(body: ActiveProviderRequest) -> dict[str, Any]:
    ctx = get_context()
    try:
        ctx.models.set_active_provider(body.provider_id)
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc
    return {"active_provider_id": ctx.models.active_provider_id}


@router.post("/providers/openai_compatible/credentials")
def set_openai_credentials(body: CredentialsRequest) -> dict[str, Any]:
    ctx = get_context()
    try:
        ctx.models.set_openai_credentials(
            api_key=body.api_key,
            base_url=body.base_url,
            default_model=body.default_model,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "validation_error", "message": str(exc)},
        ) from exc
    providers = {p.id: p for p in ctx.models.list_providers()}
    info = providers["openai_compatible"]
    return {
        "ok": True,
        "credential_present": info.credential_present,
        "base_url": info.base_url,
        "default_model": info.default_model,
        "note": "API key stored in local secrets file (not encrypted; D-CRYPTO-01 pending).",
    }


@router.delete("/providers/openai_compatible/credentials")
def clear_openai_credentials() -> dict[str, Any]:
    ctx = get_context()
    ctx.models.clear_openai_credentials()
    return {"ok": True, "credential_present": False}


@router.post("/providers/{provider_id}/verify")
def verify_provider(provider_id: str) -> dict[str, Any]:
    ctx = get_context()
    result = ctx.models.verify(provider_id)
    status = 200 if result.ok else 503
    if not result.ok and "Unknown provider" in result.message:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": result.message},
        )
    if not result.ok:
        raise HTTPException(
            status_code=status,
            detail={
                "code": "provider_unavailable",
                "message": result.message,
            },
        )
    return result.model_dump(mode="json")


@router.post("/complete")
def complete(body: CompleteRequest) -> dict[str, Any]:
    ctx = get_context()
    try:
        result = ctx.models.complete(
            body.messages,
            provider_id=body.provider_id,
            connection_id=body.connection_id,
            model_id=body.model_id,
        )
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "provider_unavailable", "message": str(exc)},
        ) from exc
    return result.model_dump(mode="json")


@router.get("/usage")
def list_usage(limit: int = 50) -> dict[str, Any]:
    ctx = get_context()
    items = ctx.models.usage[-max(1, min(limit, 200)) :]
    return {"items": [u.model_dump(mode="json") for u in items]}


@router.get("/usage-attempts")
def list_usage_attempts(limit: int = 50) -> dict[str, Any]:
    """F3.5: interpret/model attempts with command context; tokens never invented as zero."""
    ctx = get_context()
    items = ctx.models.list_attempts(limit=limit)
    return {"items": [a.model_dump(mode="json") for a in items]}


@router.post("/interpret")
def interpret_message(body: InterpretRequest) -> dict[str, Any]:
    ctx = get_context()
    text = body.text.strip()
    if not text:
        raise HTTPException(
            status_code=400,
            detail={"code": "validation_error", "message": "text required"},
        )
    try:
        result = ctx.models.interpret(text, roster=body.roster, provider_id=body.provider_id)
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "provider_unavailable", "message": str(exc)},
        ) from exc
    return result.model_dump(mode="json")


@router.post("/providers/openai_compatible/ollama_preset")
def apply_ollama_preset(body: OllamaPresetRequest) -> dict[str, Any]:
    ctx = get_context()
    model = body.model.strip() or "qwen3.5:4b"
    ctx.models.apply_ollama_preset(model=model)
    return {
        "ok": True,
        "active_provider_id": ctx.models.active_provider_id,
        "base_url": "http://127.0.0.1:11434/v1",
        "default_model": model,
    }


@router.get("/ollama/tags")
def list_ollama_tags() -> dict[str, Any]:
    """List models from the local Ollama daemon (for Settings picker)."""
    request = Request(
        "http://127.0.0.1:11434/api/tags",
        method="GET",
        headers={"Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=3.0) as response:
            raw = response.read().decode("utf-8")
    except URLError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "provider_unavailable",
                "message": f"Ollama unreachable at 127.0.0.1:11434: {exc.reason}",
            },
        ) from exc
    parsed = json.loads(raw)
    models = parsed.get("models") if isinstance(parsed, dict) else None
    names: list[str] = []
    if isinstance(models, list):
        for item in models:
            if isinstance(item, dict) and item.get("name"):
                names.append(str(item["name"]))
    return {"items": names}
