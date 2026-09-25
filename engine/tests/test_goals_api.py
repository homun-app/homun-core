"""Tests for the persistent goals HTTP API (H25)."""
from fastapi.testclient import TestClient
from homun.app import create_app
from homun.application.goal_contracts import GoalContract, GoalState
from homun.application.goal_store import GoalStore, set_goal_store


def test_goals_api_crud(tmp_path):
    store = GoalStore(tmp_path / "goals_test.sqlite")
    set_goal_store(store)

    state = GoalState(
        goal="Audit sicurezza del codice",
        status="active",
        turns_used=2,
        max_turns=10,
        subgoals=["Ispezione AST", "Verifica dipendenze"],
        contract=GoalContract(
            outcome="Rapporto di audit",
            verification="Zero vulnerabilità critiche",
            stop_when="Tutti i file verificati",
        ),
    )
    store.put("sess_abc123", state)

    client = TestClient(create_app())

    # List goals
    res = client.get("/v1/goals")
    assert res.status_code == 200
    data = res.json()
    assert data["count"] == 1
    assert data["goals"][0]["session_id"] == "sess_abc123"
    assert data["goals"][0]["goal"] == "Audit sicurezza del codice"
    assert data["goals"][0]["contract"]["outcome"] == "Rapporto di audit"

    # Get specific goal
    res_single = client.get("/v1/goals/sess_abc123")
    assert res_single.status_code == 200
    single_data = res_single.json()
    assert single_data["session_id"] == "sess_abc123"
    assert single_data["turns_used"] == 2

    # Get non-existent goal
    res_404 = client.get("/v1/goals/sess_non_existent")
    assert res_404.status_code == 404

    # Delete goal
    res_del = client.delete("/v1/goals/sess_abc123")
    assert res_del.status_code == 200
    assert res_del.json()["deleted"] is True

    # Verify deleted
    res_after = client.get("/v1/goals")
    assert res_after.json()["count"] == 0

    set_goal_store(None)
