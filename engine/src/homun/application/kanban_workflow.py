"""Kanban orchestration workflow: dependency fan-out, reviews, and completion unlocking."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from homun.application.kanban_contracts import (
    KanbanCard,
    PRContract,
)
from homun.application.kanban_store import KanbanStore


class KanbanWorkflowError(Exception):
    """Base error for Kanban workflow failures."""
    pass


class KanbanWorkflow:
    """Orchestrates multi-card dependencies, reviews, and completion unlocks."""

    def __init__(self, store: KanbanStore) -> None:
        self.store = store

    def fan_out_dependencies(
        self,
        board_id: str,
        tasks: List[Dict[str, Any]],
    ) -> List[KanbanCard]:
        """Create a set of tasks with explicit parent-child or sequential dependencies.

        Each task dict may contain:
        - 'title': task title
        - 'description': task description
        - 'dependencies': list of task indices or card IDs
        - 'lane': optional initial lane (defaults to 'ready' if no deps, 'blocked' if deps exist)
        """
        created_cards: List[KanbanCard] = []
        index_to_id: Dict[int, str] = {}

        for idx, t in enumerate(tasks):
            raw_deps = t.get("dependencies", [])
            resolved_deps: List[str] = []
            for d in raw_deps:
                if isinstance(d, int) and d in index_to_id:
                    resolved_deps.append(index_to_id[d])
                elif isinstance(d, str):
                    resolved_deps.append(d)

            lane = t.get("lane") or ("blocked" if resolved_deps else "ready")
            card = KanbanCard(
                board_id=board_id,
                title=t["title"],
                description=t.get("description", ""),
                lane=lane,
                dependencies=resolved_deps,
            )
            saved = self.store.create_card(card)
            created_cards.append(saved)
            index_to_id[idx] = saved.id

        return created_cards

    def request_review(
        self,
        card_id: str,
        artifacts: Optional[List[str]] = None,
        pr_contract: Optional[PRContract] = None,
    ) -> KanbanCard:
        """Submit completed work for human or peer review."""
        card = self.store.get_card(card_id)
        if not card:
            raise KanbanWorkflowError(f"Card '{card_id}' not found")
        if card.lane != "in_progress":
            raise KanbanWorkflowError(f"Cannot request review for card in lane '{card.lane}' (must be in_progress)")

        card.lane = "review"
        card.review_status = "pending"
        if artifacts:
            card.artifacts.extend(artifacts)
        if pr_contract:
            card.pr_contract = pr_contract

        return self.store.update_card(card)

    def review_card(
        self,
        card_id: str,
        approved: bool,
        notes: str = "",
    ) -> Tuple[KanbanCard, List[str]]:
        """Review a card: if approved, transitions to 'done' and unlocks dependants."""
        card = self.store.get_card(card_id)
        if not card:
            raise KanbanWorkflowError(f"Card '{card_id}' not found")
        if card.lane != "review":
            raise KanbanWorkflowError(f"Cannot review card in lane '{card.lane}' (must be in 'review')")

        unlocked_dependants: List[str] = []

        if approved:
            card.lane = "done"
            card.review_status = "approved"
            card.review_notes = notes or "Review approved"
            updated = self.store.update_card(card)
            unlocked_dependants = self.store.unlock_dependants(card.id)
            return updated, unlocked_dependants
        else:
            card.lane = "in_progress"
            card.review_status = "changes_requested"
            card.review_notes = notes or "Changes requested during review"
            updated = self.store.update_card(card)
            return updated, []
