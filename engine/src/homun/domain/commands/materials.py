"""Materials domain commands and validation."""

from __future__ import annotations
from typing import Any
import re
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, MaterialVersion, utc_now
from homun.policy import require_project_capability

MATERIAL_KINDS = frozenset({"note", "link", "file_ref"})

MATERIAL_STATUSES = frozenset({"active", "archived"})

from homun.domain.command_context import CommandContext


def _material_create(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    project_id = str(payload.get("project_id", "")).strip()
    if not project_id:
        raise ValidationError("project_id is required")
    require_project_capability(ctx.store, actor, project_id, "write")
    title = str(payload.get("title", "")).strip()
    if not title:
        raise ValidationError("Material title is required")
    kind = str(payload.get("kind", "note") or "note").strip()
    if kind not in MATERIAL_KINDS:
        raise ValidationError(f"Invalid material kind: {kind}")
    source_uri = payload.get("source_uri")
    source_uri_s = str(source_uri).strip() if source_uri not in (None, "") else None
    if kind in {"link", "file_ref"} and not source_uri_s:
        raise ValidationError(f"{kind} requires source_uri")
    material = MaterialVersion(
        id=new_id("mat"),
        workspace_id=ctx.store.workspace_id,
        project_id=project_id,
        title=title,
        kind=kind,
        text=str(payload.get("text", "") or ""),
        source_uri=source_uri_s,
        content_hash=(
            str(payload["content_hash"]).strip()
            if payload.get("content_hash") not in (None, "")
            else None
        ),
        mime_type=(
            str(payload["mime_type"]).strip()
            if payload.get("mime_type") not in (None, "")
            else None
        ),
        status="active",
        created_by=actor.id,
    )
    ctx.store.materials[material.id] = material
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=material.id,
        aggregate_type="material",
        aggregate_version=material.version,
        event_type="material.created",
        payload={"project_id": project_id, "kind": kind, "title": title},
    )
    return {
        "material_id": material.id,
        "project_id": project_id,
        "version": material.version,
        "kind": material.kind,
        "status": material.status,
    }


def _material_update(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    material = ctx.get_material(str(payload.get("material_id", "")))
    require_project_capability(ctx.store, actor, material.project_id, "write")
    ctx._require_expected_version(material.version, payload.get("expected_version"))
    if "title" in payload:
        title = str(payload.get("title", "")).strip()
        if not title:
            raise ValidationError("Material title is required")
        material.title = title
    if "kind" in payload:
        kind = str(payload.get("kind") or "").strip()
        if kind not in MATERIAL_KINDS:
            raise ValidationError(f"Invalid material kind: {kind}")
        material.kind = kind
    if "text" in payload:
        material.text = str(payload.get("text") or "")
    if "source_uri" in payload:
        raw = payload.get("source_uri")
        material.source_uri = str(raw).strip() if raw not in (None, "") else None
    if "content_hash" in payload:
        raw = payload.get("content_hash")
        material.content_hash = str(raw).strip() if raw not in (None, "") else None
    if "mime_type" in payload:
        raw = payload.get("mime_type")
        material.mime_type = str(raw).strip() if raw not in (None, "") else None
    if "status" in payload:
        status = str(payload.get("status") or "").strip()
        if status not in MATERIAL_STATUSES:
            raise ValidationError(f"Invalid material status: {status}")
        material.status = status
    if material.kind in {"link", "file_ref"} and not material.source_uri:
        raise ValidationError(f"{material.kind} requires source_uri")
    material.version += 1
    material.updated_at = utc_now()
    ctx.store.materials[material.id] = material
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=material.id,
        aggregate_type="material",
        aggregate_version=material.version,
        event_type="material.updated",
        payload={"project_id": material.project_id, "status": material.status},
    )
    return {
        "material_id": material.id,
        "project_id": material.project_id,
        "version": material.version,
        "title": material.title,
        "kind": material.kind,
        "status": material.status,
    }


def _material_archive(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _material_update(ctx, 
        actor,
        command_id,
        {
            "material_id": payload.get("material_id"),
            "expected_version": payload.get("expected_version"),
            "status": "archived",
        },
    )


def register_prepared_material(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Register application-prepared metadata; this command performs no I/O."""
    project_id = payload["project_id"]
    require_project_capability(ctx.store, actor, project_id, "write")
    content_hash = payload["content_hash"]
    if not re.fullmatch(r"[0-9a-f]{64}", content_hash):
        raise ValidationError("Invalid material content hash")
    if payload["storage_relpath"] != f"materials/content/{content_hash}/original":
        raise ValidationError("Invalid managed material path")
    if not payload["title"] or payload["byte_size"] < 0:
        raise ValidationError("Invalid prepared material metadata")
    if payload["extract_status"] not in {"extracted", "unsupported", "failed"}:
        raise ValidationError("Invalid extraction status")
    material_id = new_id("mat")
    version = 1
    material = MaterialVersion(
        id=material_id,
        workspace_id=ctx.store.workspace_id,
        project_id=project_id,
        title=payload["title"],
        kind="file_ref",
        text=payload["text"],
        source_uri=f"homun-blob://{material_id}/v{version}",
        content_hash=content_hash,
        mime_type=payload["mime_type"],
        origin_name=payload["origin_name"],
        relative_path=payload["relative_path"],
        storage_relpath=payload["storage_relpath"],
        byte_size=payload["byte_size"],
        extract_status=payload["extract_status"],
        status="active",
        created_by=actor.id,
    )
    ctx.store.materials[material.id] = material
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=material.id,
        aggregate_type="material",
        aggregate_version=material.version,
        event_type="material.ingested",
        payload={
            "project_id": project_id,
            "extract_status": material.extract_status,
            "byte_size": material.byte_size,
            "content_hash": content_hash,
        },
    )
    return {
        "material_id": material.id,
        "project_id": project_id,
        "version": material.version,
        "kind": material.kind,
        "status": material.status,
        "extract_status": material.extract_status,
        "content_hash": material.content_hash,
        "mime_type": material.mime_type,
        "byte_size": material.byte_size,
        "title": material.title,
    }

