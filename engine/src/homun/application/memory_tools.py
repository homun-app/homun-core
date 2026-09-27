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

        action = (args.get("action") or "preview").strip().lower()
        if action not in ("preview", "prune"):
            return {"error_code": "invalid_action", "message": f"Action must be 'preview' or 'prune' (got {action!r})"}

        min_sim = float(args.get("min_similarity", 0.75))
        min_sim = max(0.1, min(1.0, min_sim))
        limit = max(1, min(args.get("limit", 20), 100))
        target_project_id = args.get("project_id") or project_id

        all_notes = ctx.memory.list(project_id=target_project_id, include_deleted=False)

        q = (args.get("query") or "").strip().lower()
        if q:
            notes = [n for n in all_notes if q in n.text.lower()]
        else:
            notes = all_notes

        import re

        def _tokenize(text: str) -> set[str]:
            return set(re.findall(r"\w+", text.lower()))

        tokenized = [(n, _tokenize(n.text)) for n in notes]
        clusters: list[dict[str, Any]] = []
        assigned_ids: set[str] = set()

        for i in range(len(tokenized)):
            note_a, tokens_a = tokenized[i]
            if note_a.id in assigned_ids:
                continue
            group_redundant: list[dict[str, Any]] = []
            max_similarity = 0.0

            for j in range(i + 1, len(tokenized)):
                note_b, tokens_b = tokenized[j]
                if note_b.id in assigned_ids:
                    continue

                sim = 0.0
                if note_a.text.strip().lower() == note_b.text.strip().lower():
                    sim = 1.0
                elif tokens_a or tokens_b:
                    union = tokens_a | tokens_b
                    sim = len(tokens_a & tokens_b) / len(union) if union else 0.0

                if sim >= min_sim:
                    max_similarity = max(max_similarity, sim)
                    group_redundant.append({
                        "id": note_b.id,
                        "text": note_b.text,
                        "similarity": round(sim, 3),
                        "created_at": note_b.created_at.isoformat() if hasattr(note_b.created_at, "isoformat") else str(note_b.created_at),
                    })
                    assigned_ids.add(note_b.id)

            if group_redundant:
                assigned_ids.add(note_a.id)
                clusters.append({
                    "canonical_id": note_a.id,
                    "canonical_text": note_a.text,
                    "canonical_created_at": note_a.created_at.isoformat() if hasattr(note_a.created_at, "isoformat") else str(note_a.created_at),
                    "redundant_notes": group_redundant,
                    "max_similarity": round(max_similarity, 3),
                })
                if len(clusters) >= limit:
                    break

        if action == "preview":
            return {
                "status": "preview",
                "action": "preview",
                "total_reviewed": len(notes),
                "duplicate_clusters": len(clusters),
                "candidates": clusters,
            }

        # action == "prune"
        pruned_ids: list[str] = []
        for cluster in clusters:
            for red in cluster["redundant_notes"]:
                ctx.memory.delete(red["id"], actor_id=actor.id)
                pruned_ids.append(red["id"])

        return {
            "status": "pruned",
            "action": "prune",
            "total_reviewed": len(notes),
            "duplicate_clusters": len(clusters),
            "pruned_count": len(pruned_ids),
            "pruned_ids": pruned_ids,
            "candidates": clusters,
        }

    raise ValidationError(f"Unknown memory tool: {tool}")
