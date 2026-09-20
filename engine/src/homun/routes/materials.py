"""Material reads and ingestion transport."""
import hashlib
from typing import Any
from uuid import uuid4
from fastapi import APIRouter, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import Response
from homun.context import get_context
from homun.application.material_ingest import ingest_file, MAX_UPLOAD_BYTES
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError, ValidationError
from homun.materials.blob import read_material_blob
from homun.policy import require_project_capability
from homun.routes.domain_support import _actor_from_headers, _http_error

router = APIRouter(tags=["materials"])

@router.get("/projects/{project_id}/materials")
def list_project_materials(
    workspace_id: str,
    project_id: str,
    include_archived: bool = Query(default=False),
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        require_project_capability(ctx.service.store, actor, project_id, "read")
    except NotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc
    except PermissionDeniedError as exc:
        raise _http_error(exc) from exc
    items = []
    for material in ctx.service.store.materials.values():
        if material.project_id != project_id:
            continue
        if not include_archived and material.status != "active":
            continue
        items.append(material.model_dump(mode="json"))
    return {"items": items}


@router.get("/materials/{material_id}")
def get_material(
    workspace_id: str,
    material_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        material = ctx.service.get_material(material_id)
        require_project_capability(ctx.service.store, actor, material.project_id, "read")
    except NotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc
    except PermissionDeniedError as exc:
        raise _http_error(exc) from exc
    return material.model_dump(mode="json")


@router.post("/projects/{project_id}/materials/ingest")
async def ingest_project_material(
    workspace_id: str,
    project_id: str,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    relative_path: str | None = Form(default=None),
    x_homun_command_id: str | None = Header(default=None),
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail={"code": "material_too_large", "message": f"Material exceeds {MAX_UPLOAD_BYTES} bytes"})
    filename = file.filename or relative_path or "upload"
    try:
        result = ingest_file(
            ctx, actor,
            command_id=x_homun_command_id if x_homun_command_id is not None else f"cmd_ingest_{uuid4().hex}",
            project_id=project_id,
            filename=filename,
            data=data,
            title=title,
            relative_path=relative_path,
            mime_type=file.content_type,
        )
    except (NotFoundError, PermissionDeniedError, ValidationError, ConflictError) as exc:
        raise _http_error(exc) from exc
    return result


@router.get("/materials/{material_id}/content")
def get_material_content(
    workspace_id: str,
    material_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        material = ctx.service.get_material(material_id)
        require_project_capability(ctx.service.store, actor, material.project_id, "read")
    except NotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc
    except PermissionDeniedError as exc:
        raise _http_error(exc) from exc
    return {
        "material_id": material.id,
        "title": material.title,
        "extract_status": material.extract_status,
        "mime_type": material.mime_type,
        "byte_size": material.byte_size,
        "content_hash": material.content_hash,
        "text": material.text,
        "origin_name": material.origin_name,
        "relative_path": material.relative_path,
    }


@router.get("/materials/{material_id}/blob")
def get_material_blob(
    workspace_id: str,
    material_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> Response:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        material = ctx.service.get_material(material_id)
        require_project_capability(ctx.service.store, actor, material.project_id, "read")
    except NotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc
    except PermissionDeniedError as exc:
        raise _http_error(exc) from exc
    if not material.storage_relpath:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Material has no stored blob"},
        )
    try:
        data = read_material_blob(ctx.data_dir, material.storage_relpath)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Blob missing on disk"},
        ) from exc
    if material.content_hash and hashlib.sha256(data).hexdigest() != material.content_hash:
        raise HTTPException(status_code=409, detail={"code": "material_integrity_error", "message": "Stored material failed content integrity verification"})
    media = material.mime_type or "application/octet-stream"
    filename = material.origin_name or material.title or "download"
    return Response(
        content=data,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


