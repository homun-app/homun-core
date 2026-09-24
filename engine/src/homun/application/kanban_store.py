"""Durable SQLite storage engine for Kanban boards, cards, and worker claims."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from homun.application.kanban_contracts import (
    DEFAULT_LANES,
    KanbanBoard,
    KanbanCard,
    PRContract,
)


class KanbanStore:
    """Thread-safe SQLite store for Kanban boards, cards, and leases."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_tables()

    def _get_connection(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.db_path), timeout=10.0)
        con.execute("PRAGMA journal_mode=WAL")
        return con

    def _init_tables(self) -> None:
        with self._get_connection() as con:
            con.execute("""
                CREATE TABLE IF NOT EXISTS kanban_boards (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    owner_profile TEXT NOT NULL,
                    lanes_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
            """)
            con.execute("""
                CREATE TABLE IF NOT EXISTS kanban_cards (
                    id TEXT PRIMARY KEY,
                    board_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    lane TEXT NOT NULL,
                    assigned_worker_id TEXT,
                    dependencies_json TEXT NOT NULL,
                    artifacts_json TEXT NOT NULL,
                    heartbeat_at REAL,
                    claim_expires_at REAL,
                    review_status TEXT,
                    review_notes TEXT,
                    pr_contract_json TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    FOREIGN KEY(board_id) REFERENCES kanban_boards(id)
                )
            """)
            con.commit()

    def create_board(self, board: KanbanBoard) -> KanbanBoard:
        with self._get_connection() as con:
            con.execute(
                """
                INSERT INTO kanban_boards (id, name, description, owner_profile, lanes_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    board.id,
                    board.name,
                    board.description,
                    board.owner_profile,
                    json.dumps(board.lanes),
                    board.created_at,
                    board.updated_at,
                ),
            )
            con.commit()
        return board

    def get_board(self, board_id: str) -> Optional[KanbanBoard]:
        with self._get_connection() as con:
            row = con.execute("SELECT id, name, description, owner_profile, lanes_json, created_at, updated_at FROM kanban_boards WHERE id = ?", (board_id,)).fetchone()
            if not row:
                return None
            return KanbanBoard(
                id=row[0],
                name=row[1],
                description=row[2],
                owner_profile=row[3],
                lanes=json.loads(row[4]),
                created_at=row[5],
                updated_at=row[6],
            )

    def list_boards(self, owner_profile: Optional[str] = None) -> List[KanbanBoard]:
        with self._get_connection() as con:
            if owner_profile:
                rows = con.execute("SELECT id, name, description, owner_profile, lanes_json, created_at, updated_at FROM kanban_boards WHERE owner_profile = ? ORDER BY created_at DESC", (owner_profile,)).fetchall()
            else:
                rows = con.execute("SELECT id, name, description, owner_profile, lanes_json, created_at, updated_at FROM kanban_boards ORDER BY created_at DESC").fetchall()
            return [
                KanbanBoard(
                    id=r[0],
                    name=r[1],
                    description=r[2],
                    owner_profile=r[3],
                    lanes=json.loads(r[4]),
                    created_at=r[5],
                    updated_at=r[6],
                )
                for r in rows
            ]

    def create_card(self, card: KanbanCard) -> KanbanCard:
        # Determine initial lane: if it has dependencies that are not done, put in 'blocked'
        if card.dependencies:
            all_done = self._are_dependencies_done(card.dependencies)
            if not all_done and card.lane not in ("blocked", "backlog"):
                card.lane = "blocked"

        with self._get_connection() as con:
            con.execute(
                """
                INSERT INTO kanban_cards (
                    id, board_id, title, description, lane, assigned_worker_id,
                    dependencies_json, artifacts_json, heartbeat_at, claim_expires_at,
                    review_status, review_notes, pr_contract_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    card.id,
                    card.board_id,
                    card.title,
                    card.description,
                    card.lane,
                    card.assigned_worker_id,
                    json.dumps(card.dependencies),
                    json.dumps(card.artifacts),
                    card.heartbeat_at,
                    card.claim_expires_at,
                    card.review_status,
                    card.review_notes,
                    json.dumps(card.pr_contract.model_dump()) if card.pr_contract else None,
                    card.created_at,
                    card.updated_at,
                ),
            )
            con.commit()
        return card

    def _row_to_card(self, r: Any) -> KanbanCard:
        pr_data = json.loads(r[12]) if r[12] else None
        return KanbanCard(
            id=r[0],
            board_id=r[1],
            title=r[2],
            description=r[3],
            lane=r[4],
            assigned_worker_id=r[5],
            dependencies=json.loads(r[6]),
            artifacts=json.loads(r[7]),
            heartbeat_at=r[8],
            claim_expires_at=r[9],
            review_status=r[10],
            review_notes=r[11],
            pr_contract=PRContract(**pr_data) if pr_data else None,
            created_at=r[13],
            updated_at=r[14],
        )

    def get_card(self, card_id: str) -> Optional[KanbanCard]:
        with self._get_connection() as con:
            row = con.execute("SELECT id, board_id, title, description, lane, assigned_worker_id, dependencies_json, artifacts_json, heartbeat_at, claim_expires_at, review_status, review_notes, pr_contract_json, created_at, updated_at FROM kanban_cards WHERE id = ?", (card_id,)).fetchone()
            if not row:
                return None
            return self._row_to_card(row)

    def list_cards(self, board_id: str, lane: Optional[str] = None) -> List[KanbanCard]:
        with self._get_connection() as con:
            if lane:
                rows = con.execute("SELECT id, board_id, title, description, lane, assigned_worker_id, dependencies_json, artifacts_json, heartbeat_at, claim_expires_at, review_status, review_notes, pr_contract_json, created_at, updated_at FROM kanban_cards WHERE board_id = ? AND lane = ? ORDER BY created_at ASC", (board_id, lane)).fetchall()
            else:
                rows = con.execute("SELECT id, board_id, title, description, lane, assigned_worker_id, dependencies_json, artifacts_json, heartbeat_at, claim_expires_at, review_status, review_notes, pr_contract_json, created_at, updated_at FROM kanban_cards WHERE board_id = ? ORDER BY created_at ASC", (board_id,)).fetchall()
            return [self._row_to_card(r) for r in rows]

    def update_card(self, card: KanbanCard) -> KanbanCard:
        card.updated_at = time.time()
        with self._get_connection() as con:
            con.execute(
                """
                UPDATE kanban_cards
                SET title = ?, description = ?, lane = ?, assigned_worker_id = ?,
                    dependencies_json = ?, artifacts_json = ?, heartbeat_at = ?,
                    claim_expires_at = ?, review_status = ?, review_notes = ?,
                    pr_contract_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    card.title,
                    card.description,
                    card.lane,
                    card.assigned_worker_id,
                    json.dumps(card.dependencies),
                    json.dumps(card.artifacts),
                    card.heartbeat_at,
                    card.claim_expires_at,
                    card.review_status,
                    card.review_notes,
                    json.dumps(card.pr_contract.model_dump()) if card.pr_contract else None,
                    card.updated_at,
                    card.id,
                ),
            )
            con.commit()
        return card

    def _are_dependencies_done(self, dep_ids: List[str]) -> bool:
        if not dep_ids:
            return True
        with self._get_connection() as con:
            placeholders = ",".join("?" for _ in dep_ids)
            rows = con.execute(f"SELECT id, lane FROM kanban_cards WHERE id IN ({placeholders})", dep_ids).fetchall()
            done_map = {r[0]: (r[1] == "done") for r in rows}
            return all(done_map.get(d, False) for d in dep_ids)

    def unlock_dependants(self, completed_card_id: str) -> List[str]:
        """Check cards in 'blocked' that depend on completed_card_id; transition to 'ready' if all deps done."""
        unlocked = []
        with self._get_connection() as con:
            rows = con.execute("SELECT id, board_id, title, description, lane, assigned_worker_id, dependencies_json, artifacts_json, heartbeat_at, claim_expires_at, review_status, review_notes, pr_contract_json, created_at, updated_at FROM kanban_cards WHERE lane = 'blocked'").fetchall()
            candidates = [self._row_to_card(r) for r in rows if completed_card_id in json.loads(r[6])]

        for card in candidates:
            if self._are_dependencies_done(card.dependencies):
                card.lane = "ready"
                self.update_card(card)
                unlocked.append(card.id)

        return unlocked

    def claim_card(self, card_id: str, worker_id: str, lease_seconds: float = 60.0) -> Optional[KanbanCard]:
        """Claim a card in 'ready' lane for a specific worker."""
        now = time.time()
        card = self.get_card(card_id)
        if not card:
            return None
        if card.lane != "ready":
            return None

        card.lane = "in_progress"
        card.assigned_worker_id = worker_id
        card.heartbeat_at = now
        card.claim_expires_at = now + lease_seconds
        return self.update_card(card)

    def heartbeat(self, card_id: str, worker_id: str, lease_seconds: float = 60.0) -> bool:
        """Renew lease for an in_progress card."""
        now = time.time()
        card = self.get_card(card_id)
        if not card or card.lane != "in_progress" or card.assigned_worker_id != worker_id:
            return False

        card.heartbeat_at = now
        card.claim_expires_at = now + lease_seconds
        self.update_card(card)
        return True

    def recover_crashed_workers(self, now: Optional[float] = None) -> List[str]:
        """Return cards whose worker lease has expired back to 'ready' lane."""
        current_time = now or time.time()
        recovered = []
        with self._get_connection() as con:
            rows = con.execute(
                """
                SELECT id, board_id, title, description, lane, assigned_worker_id,
                       dependencies_json, artifacts_json, heartbeat_at, claim_expires_at,
                       review_status, review_notes, pr_contract_json, created_at, updated_at
                FROM kanban_cards
                WHERE lane = 'in_progress' AND claim_expires_at < ?
                """,
                (current_time,),
            ).fetchall()
            crashed_cards = [self._row_to_card(r) for r in rows]

        for card in crashed_cards:
            card.lane = "ready"
            card.assigned_worker_id = None
            card.claim_expires_at = None
            self.update_card(card)
            recovered.append(card.id)

        return recovered
