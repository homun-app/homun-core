"""HTTP surface for persistent goals and quality gates (H25)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from homun.application.goal_store import get_goal_store
from homun.application.goal_contracts import GoalContract, GoalGate

router = APIRouter(prefix="/v1/goals", tags=["goals"])


class GoalStateResponse(BaseModel):
    session_id: str
    goal: str
    status: str
    turns_used: int
    max_turns: Optional[int] = None
    subgoals: List[str] = Field(default_factory=list)
    contract: Dict[str, Any]
    gates: List[Dict[str, Any]] = Field(default_factory=list)
    waiting_on_pid: Optional[int] = None
    waiting_on_session: Optional[str] = None
    waiting_until: Optional[float] = None
    updated_at: Optional[float] = None


class GoalListResponse(BaseModel):
    count: int
    goals: List[GoalStateResponse]


@router.get("", response_model=GoalListResponse)
def list_goals() -> Dict[str, Any]:
    store = get_goal_store()
    raw = store.list_all()
    items = []
    for item in raw:
        items.append(
            GoalStateResponse(
                session_id=item.get("session_id", ""),
                goal=item.get("goal", ""),
                status=item.get("status", "active"),
                turns_used=item.get("turns_used", 0),
                max_turns=item.get("max_turns"),
                subgoals=item.get("subgoals", []),
                contract=item.get("contract", {}),
                gates=item.get("gates", []),
                waiting_on_pid=item.get("waiting_on_pid"),
                waiting_on_session=item.get("waiting_on_session"),
                waiting_until=item.get("waiting_until"),
                updated_at=item.get("updated_at"),
            )
        )
    return {"count": len(items), "goals": items}


@router.get("/{session_id}", response_model=GoalStateResponse)
def get_goal(session_id: str) -> Dict[str, Any]:
    store = get_goal_store()
    state = store.get(session_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    data = state.to_dict()
    return GoalStateResponse(
        session_id=session_id,
        goal=data.get("goal", ""),
        status=data.get("status", "active"),
        turns_used=data.get("turns_used", 0),
        max_turns=data.get("max_turns"),
        subgoals=data.get("subgoals", []),
        contract=data.get("contract", {}),
        gates=data.get("gates", []),
        waiting_on_pid=data.get("waiting_on_pid"),
        waiting_on_session=data.get("waiting_on_session"),
        waiting_until=data.get("waiting_until"),
    ).model_dump()


@router.delete("/{session_id}")
def delete_goal(session_id: str) -> Dict[str, Any]:
    store = get_goal_store()
    store.delete(session_id)
    return {"deleted": True, "session_id": session_id}
