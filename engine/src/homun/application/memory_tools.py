"""Execution of memory and session search tools in agent runs (H17/H18).

tools/session_search_tool.py (MIT).
Homun maintains SQLite as the authoritative memory ledger and checks project
and conversation authorization before returning messages or facts.
"""
from __future__ import annotations

from datetime import datetime
from homun.domain.errors import ValidationError
from homun.policy.work import require_conversation_access

MAX_MEMORY_CAPACITY = 500


def _parse_iso_date(value: str | None, field_name: str) -> str | None:
    if not value or not value.strip():
        return None
    raw = value.strip()
    try:
        dt = datetime.strptime(raw, "%Y-%m-%d")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        raise ValidationError(f"{field_name} must be in YYYY-MM-DD format (got {raw!r})")


def execute(ctx, actor, run, tool, args):
    if run.get("memory", {}).get("policy") != "scoped-workspace-v1":
        raise ValidationError("Memory tools are not enabled for this run")

    store = ctx.repository.load()
    work_id = run.get("work_id")
    work = store.works.get(str(work_id)) if work_id else None
    project_id = work.project_id if work else None

    if tool == "memory_recall":
        query = args["query"].strip()
        limit = max(1, min(args.get("limit", 5), 20))
        if not hasattr(ctx, "memory") or ctx.memory is None:
            return {"memories": [], "count": 0}
        notes = ctx.memory.recall(query, project_id=project_id, limit=limit)
        if work_id:
            work_notes = [
                n for n in ctx.memory.list(work_id=work_id, include_deleted=False)
                if query.lower() in n.text.lower() and n.id not in {m.id for m in notes}
            ]
            notes = (notes + work_notes)[:limit]
        return {
            "memories": [
                {
                    "id": n.id,
                    "text": n.text,
                    "project_id": n.project_id,
                    "created_at": n.created_at.isoformat() if hasattr(n.created_at, "isoformat") else str(n.created_at),
                }
                for n in notes
            ],
            "count": len(notes),
        }

    if tool == "memory_remember":
        text = args["text"].strip()
        if not text:
            return {"error_code": "invalid_memory", "message": "Memory text cannot be empty"}
        if not hasattr(ctx, "memory") or ctx.memory is None:
            return {"error_code": "memory_unavailable", "message": "Memory store is not available"}

        existing = ctx.memory.list(project_id=project_id, include_deleted=False)
        if len(existing) >= MAX_MEMORY_CAPACITY:
            return {
                "error_code": "memory_capacity_exceeded",
                "message": f"Memory capacity limit reached ({MAX_MEMORY_CAPACITY} notes).",
            }

        norm_text = " ".join(text.lower().split())
        for note in existing:
            if " ".join(note.text.lower().split()) == norm_text:
                return {
                    "status": "duplicate",
                    "id": note.id,
                    "message": "An identical memory note is already recorded.",
                }

        new_note = ctx.memory.add_approved(
            text=text,
            actor_id=actor.id,
            work_id=work_id,
            project_id=project_id,
        )
        return {
            "status": "stored",
            "id": new_note.id,
            "text": new_note.text,
        }

    if tool == "session_search":
        query = args["query"].strip().lower()
        limit = max(1, min(args.get("limit", 5), 20))
        from_d = _parse_iso_date(args.get("from_date"), "from_date")
        to_d = _parse_iso_date(args.get("to_date"), "to_date")

        authorized_conv_ids = set()
        for cid in store.conversations.keys():
            try:
                require_conversation_access(store, actor, cid, "read")
                authorized_conv_ids.add(cid)
            except Exception:
                continue

        matches = []
        for msg in store.messages.values():
            if msg.conversation_id not in authorized_conv_ids:
                continue
            msg_dt = msg.created_at.strftime("%Y-%m-%d") if hasattr(msg.created_at, "strftime") else str(msg.created_at)[:10]
            if from_d and msg_dt < from_d:
                continue
            if to_d and msg_dt > to_d:
                continue
            if query and query not in msg.text.lower():
                continue

            matches.append({
                "message_id": msg.id,
                "conversation_id": msg.conversation_id,
                "author_id": msg.author_id,
                "created_at": msg.created_at.isoformat() if hasattr(msg.created_at, "isoformat") else str(msg.created_at),
                "text_excerpt": msg.text[:200] + ("..." if len(msg.text) > 200 else ""),
            })

        matches.sort(key=lambda m: m["created_at"], reverse=True)
        results = matches[:limit]
        return {"results": results, "count": len(results)}

    if tool == "memory_review":
        if not hasattr(ctx, "memory") or ctx.memory is None:
            return {"error_code": "memory_unavailable", "message": "Memory store is not available"}

        from homun.application.memory_review_core import perform_memory_review

        try:
            return perform_memory_review(
                memory_port=ctx.memory,
                action=args.get("action", "preview"),
                min_similarity=float(args.get("min_similarity", 0.75)),
                project_id=args.get("project_id") or project_id,
                query=args.get("query"),
                limit=int(args.get("limit", 20)),
                actor_id=actor.id,
            )
        except ValueError as exc:
            return {"error_code": "invalid_action", "message": str(exc)}

    raise ValidationError(f"Unknown memory tool: {tool}")
