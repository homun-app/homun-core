"""Tests for H23 Optional Orchestration: Durable Kanban boards, dependencies, claims, heartbeats, reviews, and PR contracts."""

from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.kanban_contracts import (
    KanbanBoard,
    KanbanCard,
    PRContract,
)
from homun.application.kanban_store import KanbanStore
from homun.application.kanban_workflow import KanbanWorkflow


def test_kanban_dependencies_workflow_and_crash_recovery(tmp_path: Path):
    db_path = tmp_path / "kanban.db"
    store = KanbanStore(db_path)
    workflow = KanbanWorkflow(store)

    # 1. Create board
    board = store.create_board(KanbanBoard(name="Engineering Sprint", owner_profile="default"))
    assert board.id is not None

    # 2. Fan out tasks with dependency: Task B depends on Task A
    cards = workflow.fan_out_dependencies(
        board_id=board.id,
        tasks=[
            {"title": "Task A: Core Implementation", "dependencies": []},
            {"title": "Task B: Integration Tests", "dependencies": [0]},  # depends on task at index 0 (Task A)
        ],
    )
    assert len(cards) == 2
    card_a = cards[0]
    card_b = cards[1]

    assert card_a.lane == "ready"
    assert card_b.lane == "blocked"
    assert card_b.dependencies == [card_a.id]

    # 3. Worker claims Task A
    claimed = store.claim_card(card_a.id, worker_id="worker_alpha", lease_seconds=10.0)
    assert claimed is not None
    assert claimed.lane == "in_progress"
    assert claimed.assigned_worker_id == "worker_alpha"

    # Heartbeat renewal
    renewed = store.heartbeat(card_a.id, worker_id="worker_alpha", lease_seconds=20.0)
    assert renewed is True

    # 4. Crash recovery simulation (time advances past lease)
    crashed_time = claimed.claim_expires_at + 100.0
    recovered_ids = store.recover_crashed_workers(now=crashed_time)
    assert card_a.id in recovered_ids

    # Card A is back to 'ready' and unassigned
    reloaded_a = store.get_card(card_a.id)
    assert reloaded_a.lane == "ready"
    assert reloaded_a.assigned_worker_id is None

    # Worker Beta claims Task A
    claimed_beta = store.claim_card(card_a.id, worker_id="worker_beta", lease_seconds=60.0)
    assert claimed_beta is not None
    assert claimed_beta.assigned_worker_id == "worker_beta"

    # 5. Review & Changes Requested cycle
    workflow.request_review(
        card_id=card_a.id,
        artifacts=["docs/spec.pdf"],
        pr_contract=PRContract(pr_url="https://github.com/org/repo/pull/1", branch="feature/core"),
    )
    in_review_a = store.get_card(card_a.id)
    assert in_review_a.lane == "review"
    assert in_review_a.review_status == "pending"

    # Reviewer rejects / requests changes
    rejected_a, unlocked = workflow.review_card(
        card_id=card_a.id,
        approved=False,
        notes="Add docstrings and unit tests.",
    )
    assert rejected_a.lane == "in_progress"
    assert rejected_a.review_status == "changes_requested"
    assert len(unlocked) == 0

    # 6. Re-submit and approve -> Unlocks dependant Task B
    workflow.request_review(card_a.id, artifacts=["docs/spec.pdf", "tests/test_core.py"])
    approved_a, unlocked_dependants = workflow.review_card(
        card_id=card_a.id,
        approved=True,
        notes="Code and tests look great. Approved.",
    )
    assert approved_a.lane == "done"
    assert approved_a.review_status == "approved"
    assert card_b.id in unlocked_dependants

    # Task B is now unlocked and in 'ready' lane!
    reloaded_b = store.get_card(card_b.id)
    assert reloaded_b.lane == "ready"


def test_kanban_fastapi_endpoints():
    app = create_app()
    client = TestClient(app)

    # Create board
    b_resp = client.post("/v1/kanban/boards", json={"name": "API Sprint"})
    assert b_resp.status_code == 200
    board_id = b_resp.json()["id"]

    # Fan out cards
    fan_resp = client.post(
        "/v1/kanban/cards/fan_out",
        json={
            "board_id": board_id,
            "tasks": [
                {"title": "Step 1", "dependencies": []},
                {"title": "Step 2", "dependencies": [0]},
            ],
        },
    )
    assert fan_resp.status_code == 200
    created = fan_resp.json()
    assert len(created) == 2
    c1_id = created[0]["id"]

    # Claim Step 1
    claim_resp = client.post(f"/v1/kanban/cards/{c1_id}/claim", json={"worker_id": "agent_1"})
    assert claim_resp.status_code == 200
    assert claim_resp.json()["lane"] == "in_progress"

    # Request review
    rev_req_resp = client.post(
        f"/v1/kanban/cards/{c1_id}/request_review",
        json={"artifacts": ["report.pdf"]},
    )
    assert rev_req_resp.status_code == 200
    assert rev_req_resp.json()["lane"] == "review"

    # Approve review
    approve_resp = client.post(
        f"/v1/kanban/cards/{c1_id}/review",
        json={"approved": True, "notes": "Approved"},
    )
    assert approve_resp.status_code == 200
    assert approve_resp.json()["card"]["lane"] == "done"
    assert len(approve_resp.json()["unlocked_dependants"]) == 1
