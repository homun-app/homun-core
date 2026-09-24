"""Execution of session_manage tool for agent runs (H30/H31).

Derived from Hermes hermes_cli/sessions_cmd.py and hermes_state_sessions.py
at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun provides a unified session_manage tool allowing agent tasks to inspect,
resume, fork, rewind, export, import, repair, and account for conversation sessions.
"""
from __future__ import annotations

from typing import Any, Dict

from homun.application.session_manager import SessionManager
from homun.domain.errors import ValidationError


def execute(ctx, actor, run, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if run.get("session_management", {}).get("policy") != "durable-sessions-v1":
        raise ValidationError("Session management tools are not enabled for this run")

    mgr = SessionManager(workspace_id=run.get("work_id") or "default")
    action = str(args.get("action") or "").strip().lower()

    if action == "create":
        session = mgr.create_session(
            cwd=str(args.get("cwd") or ""),
            title=args.get("title"),
            parent_id=args.get("parent_id"),
            model_pin=args.get("model_pin"),
            provider_pin=args.get("provider_pin"),
        )
        return {"status": "created", "session": session.to_dict()}

    if action == "get":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'get'")
        session = mgr.get_session(session_id)
        if not session:
            raise ValidationError(f"Session not found: {session_id}")
        lineage = mgr.get_lineage(session_id)
        return {"session": session.to_dict(), "lineage": lineage.to_dict()}

    if action == "list":
        query = args.get("query")
        include_archived = bool(args.get("include_archived") or False)
        sessions = mgr.list_sessions(include_archived=include_archived, query=query)
        return {
            "count": len(sessions),
            "sessions": [s.to_dict() for s in sessions],
        }

    if action == "update":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'update'")
        try:
            session = mgr.update_session(
                session_id,
                title=args.get("title"),
                cwd=args.get("cwd"),
                pinned=args.get("pinned"),
                archived=args.get("archived"),
                model_pin=args.get("model_pin"),
                provider_pin=args.get("provider_pin"),
            )
            return {"status": "updated", "session": session.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "resume":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'resume'")
        try:
            res = mgr.resume_session(session_id)
            return {"status": "resumed", **res}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "pin":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'pin'")
        try:
            session = mgr.pin_session(session_id, pinned=True)
            return {"status": "pinned", "session": session.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "unpin":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'unpin'")
        try:
            session = mgr.pin_session(session_id, pinned=False)
            return {"status": "unpinned", "session": session.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "archive":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'archive'")
        try:
            session = mgr.archive_session(session_id, archived=True)
            return {"status": "archived", "session": session.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "unarchive":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'unarchive'")
        try:
            session = mgr.archive_session(session_id, archived=False)
            return {"status": "unarchived", "session": session.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "prune":
        older_than = float(args.get("older_than_seconds") or 86400 * 30)
        include_archived = bool(args.get("include_archived") or False)
        res = mgr.prune_sessions(older_than, include_archived=include_archived)
        return {"status": "pruned", **res}

    if action == "export":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'export'")
        fmt = str(args.get("format") or "jsonl")
        redact = bool(args.get("redact_secrets") if args.get("redact_secrets") is not None else True)
        try:
            content = mgr.export_session(session_id, fmt=fmt, redact=redact)
            return {"status": "exported", "session_id": session_id, "format": fmt, "data": content}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "import":
        data = str(args.get("data") or "").strip()
        if not data:
            raise ValidationError("data transcript is required for 'import'")
        try:
            session = mgr.import_session(data, title=args.get("title"))
            return {"status": "imported", "session": session.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "rewind":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'rewind'")
        if args.get("turn_index") is None:
            raise ValidationError("turn_index is required for 'rewind'")
        try:
            outcome = mgr.rewind_session(session_id, int(args["turn_index"]))
            return {"status": "rewound", "outcome": outcome.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "fork":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'fork'")
        at_turn = (int(args["turn_index"]) if args.get("turn_index") is not None else None)
        try:
            session = mgr.fork_session(session_id, at_turn_index=at_turn, title=args.get("title"))
            return {"status": "forked", "session": session.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "handoff":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'handoff'")
        try:
            packet = mgr.handoff_session(session_id, target_profile=args.get("target_profile"))
            return packet
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "repair":
        res = mgr.repair_integrity()
        return {"status": "repaired", **res}

    if action == "usage":
        session_id = (str(args["session_id"]).strip() if args.get("session_id") else None)
        usage = mgr.get_usage(session_id)
        return {"usage": usage.to_dict()}

    raise ValidationError(f"Unsupported session action: {action!r}")
