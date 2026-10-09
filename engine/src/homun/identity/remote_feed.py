"""F5 fetta 3 — feed eventi e snapshot per i peer, per progetto.

Il peer autorizzato (AccessGrant read sul progetto) si abbona agli eventi
con cursor: ordinamento per sequence dello spazio, mai orologio del client.
La revoca del grant interrompe lo stream con errore tipizzato. Lo snapshot
iniziale porta la proiezione corrente del progetto, poi il cursor riempie
il resto. Mai tutte le chat: solo il perimetro del progetto autorizzato."""
from __future__ import annotations

from typing import Any

from homun.domain.models import Actor
from homun.identity import object_transfer
from homun.policy import require_project_capability
from homun.policy.read import visible_event

REMOTE_PAGE_LIMIT = 200


def _project_aggregates(store, project_id: str) -> set[tuple[str, str]]:
    """Le coppie (aggregate_type, aggregate_id) nel perimetro del progetto."""
    scope = {("project", project_id)}
    for conversation in store.conversations.values():
        if conversation.project_id == project_id:
            scope.add(("conversation", conversation.id))
    for work in store.works.values():
        if work.project_id == project_id:
            scope.add(("work", work.id))
    for plan in store.plans.values():
        if plan.work_id in {w.id for w in store.works.values() if w.project_id == project_id}:
            scope.add(("plan", plan.work_id))
    for conversation in store.conversations.values():
        if conversation.project_id == project_id:
            for message in store.messages.values():
                if message.conversation_id == conversation.id:
                    scope.add(("message", message.id))
    return scope


def _require_remote_read(store, actor: Actor, project_id: str) -> None:
    project = store.projects.get(project_id)
    if project is None or project.status == "archived":
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Project not found")
    require_project_capability(store, actor, project_id, "read")


def remote_events(ctx, actor: Actor, *, project_id: str, cursor: int,
                  limit: int = REMOTE_PAGE_LIMIT) -> dict[str, Any]:
    """Gli eventi autorizzati del progetto dopo il cursor, in ordine di sequence."""
    store = ctx.repository.snapshot()
    _require_remote_read(store, actor, project_id)
    scope = _project_aggregates(store, project_id)
    items = []
    scanned = 0
    next_cursor = cursor
    for event in store.events:  # già in ordine di sequence
        if event.sequence <= cursor:
            continue
        scanned += 1
        if (event.aggregate_type, event.aggregate_id) in scope:
            view = visible_event(store, actor, event)
            if view is None:
                continue
            items.append({
                "sequence": event.sequence,
                "type": event.type,
                "aggregate_type": event.aggregate_type,
                "aggregate_id": event.aggregate_id,
                "occurred_at": event.occurred_at.isoformat(),
                "actor_id": event.actor_id,
                "payload": view["payload"],
            })
            next_cursor = event.sequence
            if len(items) >= min(limit, REMOTE_PAGE_LIMIT):
                break
    return {"items": items, "cursor": next_cursor,
            "has_more": scanned > len(items) and len(items) >= min(limit, REMOTE_PAGE_LIMIT)}


def remote_snapshot(ctx, actor: Actor, *, project_id: str) -> dict[str, Any]:
    """Proiezione corrente del progetto per il bootstrap del peer."""
    store = ctx.repository.snapshot()
    _require_remote_read(store, actor, project_id)
    project = store.projects[project_id]
    conversations = []
    for conversation in sorted(store.conversations.values(), key=lambda c: c.created_at):
        if conversation.project_id != project_id:
            continue
        messages = [{"id": m.id, "author_id": m.author_id, "text": m.text,
                     "created_at": m.created_at.isoformat()}
                    for m in sorted(store.messages.values(), key=lambda m: m.created_at)
                    if m.conversation_id == conversation.id]
        conversations.append({"id": conversation.id, "title": conversation.title,
                              "version": conversation.version, "archived": conversation.archived,
                              "messages": messages})
    works = []
    for work in sorted(store.works.values(), key=lambda w: w.created_at):
        if work.project_id != project_id:
            continue
        works.append({"id": work.id, "title": work.title, "objective": work.objective,
                      "status": work.status, "version": work.version,
                      "primary_conversation_id": work.primary_conversation_id,
                      "owner_id": work.owner_id})
    last_sequence = max((e.sequence for e in store.events), default=0)
    return {
        "project": {"id": project.id, "name": project.name, "status": project.status,
                    "version": project.version},
        "conversations": conversations,
        "works": works,
        "object_transfers": object_transfer.list_project_transfers(ctx, actor, project_id),
        "cursor": last_sequence,
    }
