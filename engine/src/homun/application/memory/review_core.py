"""Shared core logic for semantic clustering, deduplication preview, and pruning of memory notes."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set


def _tokenize(text: str) -> Set[str]:
    return set(re.findall(r"\w+", text.lower()))


def perform_memory_review(
    memory_port: Any,
    action: str = "preview",
    min_similarity: float = 0.75,
    project_id: Optional[str] = None,
    query: Optional[str] = None,
    limit: int = 20,
    actor_id: str = "person_local",
) -> Dict[str, Any]:
    """Analyze memory notes, group duplicate/redundant clusters by token overlap (Jaccard),

    and optionally prune the redundant notes while retaining canonical notes.
    """
    action_clean = (action or "preview").strip().lower()
    if action_clean not in ("preview", "prune"):
        raise ValueError(f"Action must be 'preview' or 'prune' (got {action!r})")

    min_sim = max(0.1, min(1.0, float(min_similarity)))
    max_limit = max(1, min(int(limit), 100))

    all_notes = memory_port.list(project_id=project_id, include_deleted=False)

    q = (query or "").strip().lower()
    if q:
        notes = [n for n in all_notes if q in n.text.lower()]
    else:
        notes = all_notes

    tokenized = [(n, _tokenize(n.text)) for n in notes]
    clusters: List[Dict[str, Any]] = []
    assigned_ids: Set[str] = set()

    for i in range(len(tokenized)):
        note_a, tokens_a = tokenized[i]
        if note_a.id in assigned_ids:
            continue
        group_redundant: List[Dict[str, Any]] = []
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
                created_b = (
                    note_b.created_at.isoformat()
                    if hasattr(note_b.created_at, "isoformat")
                    else str(note_b.created_at)
                )
                group_redundant.append({
                    "id": note_b.id,
                    "text": note_b.text,
                    "similarity": round(sim, 3),
                    "created_at": created_b,
                })
                assigned_ids.add(note_b.id)

        if group_redundant:
            assigned_ids.add(note_a.id)
            created_a = (
                note_a.created_at.isoformat()
                if hasattr(note_a.created_at, "isoformat")
                else str(note_a.created_at)
            )
            clusters.append({
                "canonical_id": note_a.id,
                "canonical_text": note_a.text,
                "canonical_created_at": created_a,
                "redundant_notes": group_redundant,
                "max_similarity": round(max_similarity, 3),
            })
            if len(clusters) >= max_limit:
                break

    if action_clean == "preview":
        return {
            "status": "preview",
            "action": "preview",
            "total_reviewed": len(notes),
            "duplicate_clusters": len(clusters),
            "candidates": clusters,
        }

    # action == "prune"
    pruned_ids: List[str] = []
    for cluster in clusters:
        for red in cluster["redundant_notes"]:
            memory_port.delete(red["id"], actor_id=actor_id)
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
