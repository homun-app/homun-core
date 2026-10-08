"""Tool execution for workspace checkpoint operations (C1 / H12).

Provides registered execution handlers for checkpoint listing, diffs, restore
planning, and approved filesystem rollbacks.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict

from homun.application.workspace_checkpoints import (
    get_workspace_working_diff,
    list_workspace_checkpoints,
    plan_workspace_restore,
    restore_workspace_checkpoint,
)
from homun.domain.errors import ConflictError, ValidationError
from homun.policy.work import require_work_access

logger = logging.getLogger(__name__)


def _workspace_root_for_run(ctx, run: Dict[str, Any]) -> Path:
    fallback = run.get("_workspace_root") or run.get("_cwd")
    if fallback:
        return Path(fallback).resolve()
    if hasattr(ctx, "data_dir") and hasattr(ctx, "workspace_id") and "id" in run:
        return (Path(ctx.data_dir).resolve() / "execution" / str(ctx.workspace_id) / str(run["id"])).resolve()
    raise ValidationError("Unable to resolve owned workspace directory for checkpoints")


def execute(ctx, actor, run: Dict[str, Any], tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
    store = ctx.repository.load()
    work_id = run.get("work_id")
    if work_id:
        require_work_access(store, actor, work_id)

    working_dir = _workspace_root_for_run(ctx, run)

    if tool == "checkpoint_list":
        limit = args.get("limit", 20)
        checkpoints = list_workspace_checkpoints(working_dir)
        return {
            "checkpoints": checkpoints[:limit],
            "count": len(checkpoints[:limit]),
            "total": len(checkpoints),
            "working_dir": str(working_dir),
        }

    if tool == "checkpoint_diff":
        commit_hash = args.get("commit_hash")
        diff_res = get_workspace_working_diff(working_dir, commit_hash=commit_hash)
        return {
            "checkpoint": diff_res.get("checkpoint"),
            "stat": diff_res.get("stat", ""),
            "diff": diff_res.get("diff", ""),
            "working_dir": str(working_dir),
        }

    if tool == "checkpoint_plan_restore":
        commit_hash = args["commit_hash"]
        plan = plan_workspace_restore(working_dir, commit_hash)
        return {
            "checkpoint": commit_hash,
            "plan": plan,
            "working_dir": str(working_dir),
        }

    if tool == "checkpoint_restore":
        # Mutative destructive rollback requires exact human approval
        if not run.get("_checkpoint_restore_approved"):
            raise ConflictError("Checkpoint restore requires exact human approval before execution")

        commit_hash = args["commit_hash"]
        file_path = args.get("file_path")
        safe = args.get("safe", True)
        res = restore_workspace_checkpoint(working_dir, commit_hash, file_path=file_path, safe=safe)
        return {
            "status": "restored",
            "checkpoint": commit_hash,
            "file_path": file_path,
            "safe": safe,
            "result": res,
            "working_dir": str(working_dir),
        }

    raise ValidationError(f"Unknown checkpoint tool: {tool}")
