"""F5 fetta 5 — HTTP routes for resumable sealed object transfers."""
from __future__ import annotations

import base64

from fastapi import APIRouter, Header, Request, Response
from pydantic import BaseModel, Field

from homun.domain.errors import DomainError, ValidationError
from homun.identity import object_transfer
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix="/v1", tags=["object-transfer"])


class PublishObjectRequest(BaseModel):
    project_id: str = Field(min_length=4, max_length=80)
    manifest: dict = Field(min_length=1)
    chunks_b64: list[str] | None = None


class PutChunkRequest(BaseModel):
    ciphertext_b64: str = Field(min_length=1)


@router.post("/workspaces/{workspace_id}/remote/objects")
def publish_remote_object(
    workspace_id: str,
    body: PublishObjectRequest,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
):
    """Publish a sealed object version (manifest + optional bulk chunks)."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return object_transfer.publish_object(
            ctx,
            actor,
            project_id=body.project_id,
            manifest=body.manifest,
            chunks_b64=body.chunks_b64,
        )
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.put(
    "/workspaces/{workspace_id}/remote/objects/{object_id}/versions/{version}/chunks/{index}"
)
async def put_remote_object_chunk(
    workspace_id: str,
    object_id: str,
    version: int,
    index: int,
    request: Request,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
):
    """Upload one ciphertext chunk (raw body or JSON ciphertext_b64)."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    try:
        if content_type == "application/json":
            payload = PutChunkRequest.model_validate(await request.json())
            try:
                ciphertext = base64.b64decode(payload.ciphertext_b64, validate=True)
            except (ValueError, TypeError) as exc:
                raise ValidationError("Invalid ciphertext_b64") from exc
        else:
            ciphertext = await request.body()
            if not ciphertext:
                raise ValidationError("Empty chunk body")
        return object_transfer.put_chunk(
            ctx, actor, object_id, version, index, ciphertext
        )
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get(
    "/workspaces/{workspace_id}/remote/objects/{object_id}/versions/{version}"
)
def get_remote_object_manifest(
    workspace_id: str,
    object_id: str,
    version: int,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
):
    """Fetch manifest and resume status (requires grant + recipient wrap)."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return object_transfer.get_manifest(ctx, actor, object_id, version)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get(
    "/workspaces/{workspace_id}/remote/objects/{object_id}/versions/{version}/chunks/{index}"
)
def get_remote_object_chunk(
    workspace_id: str,
    object_id: str,
    version: int,
    index: int,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
):
    """Download one verified ciphertext chunk as octet-stream."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        blob = object_transfer.get_chunk(ctx, actor, object_id, version, index)
    except DomainError as exc:
        raise _http_error(exc) from exc
    return Response(content=blob, media_type="application/octet-stream")


@router.get("/workspaces/{workspace_id}/remote/objects")
def list_remote_objects(
    workspace_id: str,
    project_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
):
    """List sealed transfers in a project visible to this peer."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return {
            "project_id": project_id,
            "items": object_transfer.list_project_transfers(ctx, actor, project_id),
        }
    except DomainError as exc:
        raise _http_error(exc) from exc
