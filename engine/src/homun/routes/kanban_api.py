"""FastAPI router for Kanban boards, cards, dependencies, worker claims, and reviews."""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from homun.storage.paths import default_data_dir
from homun.application.kanban_contracts import (
    KanbanBoard,
    KanbanCard,
    PRContract,
)
from homun.application.kanban_store import KanbanStore
from homun.application.kanban_workflow import (
    KanbanWorkflow,
    KanbanWorkflowError,
)

router = APIRouter(prefix="/v1/kanban", tags=["kanban"])

_data_dir = default_data_dir()
_kanban_store = KanbanStore(_data_dir / "kanban.db")
_kanban_workflow = KanbanWorkflow(_kanban_store)


# ── Schemas ────────────────────────────────────────────────────────────────────

class CreateBoardRequest(BaseModel):
    name: str
    description: Optional[str] = ""
    owner_profile: Optional[str] = "default"


class CreateCardRequest(BaseModel):
    board_id: str
    title: str
    description: Optional[str] = ""
    lane: Optional[str] = "backlog"
    dependencies: Optional[List[str]] = None


class FanOutRequest(BaseModel):
    board_id: str
    tasks: List[Dict[str, Any]]


class ClaimCardRequest(BaseModel):
    worker_id: str
    lease_seconds: Optional[float] = 60.0


class HeartbeatRequest(BaseModel):
    worker_id: str
    lease_seconds: Optional[float] = 60.0


class RequestReviewRequest(BaseModel):
    artifacts: Optional[List[str]] = None
    pr_contract: Optional[PRContract] = None


class ReviewCardRequest(BaseModel):
    approved: bool
    notes: Optional[str] = ""


class ReviewResponse(BaseModel):
    card: KanbanCard
    unlocked_dependants: List[str]


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/boards")
def list_boards(owner_profile: Optional[str] = Query(None)) -> List[KanbanBoard]:
    return _kanban_store.list_boards(owner_profile=owner_profile)


@router.post("/boards")
def create_board(req: CreateBoardRequest) -> KanbanBoard:
    board = KanbanBoard(
        name=req.name,
        description=req.description or "",
        owner_profile=req.owner_profile or "default",
    )
    return _kanban_store.create_board(board)


@router.get("/boards/{board_id}")
def get_board(board_id: str) -> KanbanBoard:
    board = _kanban_store.get_board(board_id)
    if not board:
        raise HTTPException(status_code=404, detail="Board not found")
    return board


@router.get("/boards/{board_id}/cards")
def list_cards(board_id: str, lane: Optional[str] = Query(None)) -> List[KanbanCard]:
    return _kanban_store.list_cards(board_id, lane=lane)


@router.post("/cards")
def create_card(req: CreateCardRequest) -> KanbanCard:
    card = KanbanCard(
        board_id=req.board_id,
        title=req.title,
        description=req.description or "",
        lane=req.lane or "backlog",
        dependencies=req.dependencies or [],
    )
    return _kanban_store.create_card(card)


@router.post("/cards/fan_out")
def fan_out_tasks(req: FanOutRequest) -> List[KanbanCard]:
    return _kanban_workflow.fan_out_dependencies(req.board_id, req.tasks)


@router.get("/cards/{card_id}")
def get_card(card_id: str) -> KanbanCard:
    card = _kanban_store.get_card(card_id)
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    return card


@router.post("/cards/{card_id}/claim")
def claim_card(card_id: str, req: ClaimCardRequest) -> KanbanCard:
    claimed = _kanban_store.claim_card(card_id, req.worker_id, lease_seconds=req.lease_seconds or 60.0)
    if not claimed:
        raise HTTPException(status_code=409, detail="Card could not be claimed (not in 'ready' lane or card missing)")
    return claimed


@router.post("/cards/{card_id}/heartbeat")
def heartbeat_card(card_id: str, req: HeartbeatRequest) -> Dict[str, Any]:
    renewed = _kanban_store.heartbeat(card_id, req.worker_id, lease_seconds=req.lease_seconds or 60.0)
    if not renewed:
        raise HTTPException(status_code=409, detail="Failed to renew lease for card")
    return {"success": True, "card_id": card_id}


@router.post("/cards/{card_id}/request_review")
def request_review(card_id: str, req: RequestReviewRequest) -> KanbanCard:
    try:
        return _kanban_workflow.request_review(
            card_id=card_id,
            artifacts=req.artifacts,
            pr_contract=req.pr_contract,
        )
    except KanbanWorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/cards/{card_id}/review")
def review_card(card_id: str, req: ReviewCardRequest) -> ReviewResponse:
    try:
        updated, unlocked = _kanban_workflow.review_card(
            card_id=card_id,
            approved=req.approved,
            notes=req.notes or "",
        )
        return ReviewResponse(card=updated, unlocked_dependants=unlocked)
    except KanbanWorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/recover_crashed")
def recover_crashed() -> Dict[str, Any]:
    recovered = _kanban_store.recover_crashed_workers()
    return {"success": True, "recovered_card_ids": recovered, "count": len(recovered)}
