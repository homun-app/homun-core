"""HTTP backup create/list (F2.5). Restore stays CLI-only against a clean directory."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from homun.context import get_context
from homun.storage.backup import BackupError, create_backup, list_backups

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/backups", tags=["backup"])


@router.get("")
def get_backups(workspace_id: str) -> dict[str, Any]:
    ctx = get_context()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Unknown workspace"},
        )
    backups_root = ctx.repository.path.parent / "backups"
    return {"items": list_backups(backups_root)}


@router.post("")
def post_backup(workspace_id: str) -> dict[str, Any]:
    ctx = get_context()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Unknown workspace"},
        )
    backups_root = ctx.repository.path.parent / "backups"
    try:
        with ctx.repository.locked() as connection:
            backup_dir = create_backup(
                workspace_id=ctx.workspace_id,
                source_db=ctx.repository.path,
                backups_root=backups_root,
                live_connection=connection,
            )
    except BackupError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "validation_error", "message": str(exc)},
        ) from exc
    return {
        "id": backup_dir.name,
        "path": str(backup_dir),
        "workspace_id": workspace_id,
        "note": "Restore with: python -m homun backup restore <path> --to <clean-dir>",
    }
