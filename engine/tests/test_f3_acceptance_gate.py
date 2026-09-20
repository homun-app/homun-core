"""F3 acceptance gate (fake): three intents + objective stability under corrections.

Live Ollama proofs stay behind HOMUN_LIVE=1 / separate manual runs — not required in CI.
Domain/planning must not hardcode sector branches; only FakeProvider keywords are deterministic CI stubs.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import Actor
from homun.domain.service import DomainService
from homun.domain.store import WorkspaceStore

SCENARIOS = [
    (
        "catalogo",
        "Prepara il catalogo prodotti autunno per il cliente Acme",
        "catalogo",
    ),
    (
        "ricerca",
        "Avvia una ricerca di mercato sulla concorrenza europea",
        "mercato",
    ),
    (
        "analisi_log",
        "Analizza i log di errore del servizio checkout ultima settimana",
        "log",
    ),
]


@pytest.fixture
def client(tmp_path: Path):
    db_path = tmp_path / "ws_local.sqlite3"
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    )
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
    reset_context_for_tests(None)


def _headers() -> dict[str, str]:
    return {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}


def _create_conversation_and_work(client: TestClient, *, title: str, objective: str) -> tuple[str, str]:
    created = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": f"cmd_conv_{title}",
            "type": "conversation.create",
            "payload": {"title": title},
        },
    )
    assert created.status_code == 200, created.text
    conversation_id = created.json()["result"]["conversation_id"]
    work = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": f"cmd_work_{title}",
            "type": "work.create",
            "payload": {
                "conversation_id": conversation_id,
                "title": title,
                "objective": objective,
            },
        },
    )
    assert work.status_code == 200, work.text
    return conversation_id, str(work.json()["result"]["work_id"])


@pytest.mark.parametrize(("slug", "user_text", "_keyword"), SCENARIOS)
def test_f3_gate_three_intents_propose_plan(
    client: TestClient, slug: str, user_text: str, _keyword: str
) -> None:
    conversation_id, work_id = _create_conversation_and_work(
        client, title=slug, objective=f"Obiettivo iniziale {slug}"
    )
    posted = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": f"cmd_msg_{slug}",
            "type": "conversation.post_message",
            "payload": {
                "conversation_id": conversation_id,
                "text": user_text,
                "roster": [{"id": "person_fabio", "display_name": "Fabio", "kind": "person"}],
            },
        },
    )
    assert posted.status_code == 200, posted.text
    result = posted.json()["result"]
    assert result["interpretation"]["kind"] == "command_proposal"
    assert result.get("plan_draft")
    assert result.get("plan_proposed"), f"expected plan for {slug}"
    assert result["plan_proposed"]["work_id"] == work_id
    assert int(result["plan_proposed"]["plan_revision"]) >= 1
    # Fake complete path still distinguishes intents without domain sector switches.
    complete = client.post(
        "/v1/models/complete",
        json={
            "messages": [{"role": "user", "content": user_text}],
            "provider_id": "fake",
        },
    )
    assert complete.status_code == 200
    assert complete.json()["text"]


def test_f3_gate_objective_survives_ten_corrections() -> None:
    store = WorkspaceStore("ws_test")
    svc = DomainService(store)
    actor = Actor(id="person_fabio", workspace_id="ws_test", display_name="Fabio")
    conv = svc.apply(actor, "c0", "conversation.create", {"title": "Catalogo"})
    work = svc.apply(
        actor,
        "w0",
        "work.create",
        {
            "conversation_id": conv["conversation_id"],
            "title": "Catalogo",
            "objective": "Obiettivo v0",
        },
    )
    work_id = str(work["work_id"])
    version = int(work["version"])
    for index in range(1, 11):
        next_objective = f"Obiettivo v{index}"
        preview = svc.apply(
            actor,
            f"prev_{index}",
            "work.preview_patch",
            {
                "work_id": work_id,
                "expected_version": version,
                "changes": [{"field": "objective", "to_value": next_objective}],
            },
        )
        proposal = preview.get("proposal") or preview
        assert proposal.get("summary_lines") or proposal.get("changes")
        applied = svc.apply(
            actor,
            f"apply_{index}",
            "work.apply_patch",
            {
                "work_id": work_id,
                "expected_version": version,
                "changes": [{"field": "objective", "to_value": next_objective}],
            },
        )
        version = int(applied["version"])
        assert svc.get_work(work_id).objective == next_objective
    assert svc.get_work(work_id).objective == "Obiettivo v10"
    assert version >= 11


def test_domain_has_no_sector_hardcoding() -> None:
    """Acceptance: domain/planning packages must not branch on sector keywords."""
    root = Path(__file__).resolve().parents[1] / "src" / "homun"
    banned = ("catalogo", "listino", "mercato", "concorren")
    offenders: list[str] = []
    for path in (root / "domain").rglob("*.py"):
        text = path.read_text(encoding="utf-8").lower()
        for word in banned:
            if word in text:
                offenders.append(f"{path.name}:{word}")
    for path in (root / "planning").rglob("*.py"):
        text = path.read_text(encoding="utf-8").lower()
        for word in banned:
            if word in text:
                offenders.append(f"{path.name}:{word}")
    assert offenders == [], f"Sector hardcoding in domain/planning: {offenders}"
