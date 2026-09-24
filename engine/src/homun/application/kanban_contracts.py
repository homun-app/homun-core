"""Domain contracts for Kanban boards, cards, dependencies, and PR workflows."""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

DEFAULT_LANES = ["backlog", "ready", "in_progress", "review", "done", "blocked"]


class PRContract(BaseModel):
    pr_url: Optional[str] = None
    branch: Optional[str] = None
    commit_sha: Optional[str] = None
    target_branch: str = "main"


class KanbanCard(BaseModel):
    id: str = Field(default_factory=lambda: f"card_{uuid.uuid4().hex[:10]}")
    board_id: str
    title: str
    description: str = ""
    lane: str = "backlog"
    assigned_worker_id: Optional[str] = None
    dependencies: List[str] = Field(default_factory=list, description="IDs of cards that must be done first")
    artifacts: List[str] = Field(default_factory=list, description="Paths or URIs of produced deliverables")
    heartbeat_at: Optional[float] = None
    claim_expires_at: Optional[float] = None
    review_status: Optional[str] = None  # pending, approved, changes_requested
    review_notes: Optional[str] = None
    pr_contract: Optional[PRContract] = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)


class KanbanBoard(BaseModel):
    id: str = Field(default_factory=lambda: f"board_{uuid.uuid4().hex[:10]}")
    name: str
    description: str = ""
    owner_profile: str = "default"
    lanes: List[str] = Field(default_factory=lambda: list(DEFAULT_LANES))
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
