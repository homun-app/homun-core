"""Area B — lavori dalla chat: dalla richiesta operativa al documento approvato.

Percorso della UI: `engine-intake-creation.ts` (classifica → proposta intake),
`engine-intake-client.ts` (conferma), `engine-synthesis-client.ts` o
`engine-agent-run-client.ts` (esecuzione), `engine-work-review.ts` (revisione).
La scelta dell'esecutore segue la capability dell'accordo, come fa la UI.
"""
from __future__ import annotations

import pytest

from .harness import WORKSPACE, normalize_for_match, run_indices
from .reporting import GoldenRun

pytestmark = pytest.mark.golden

RICHIESTA_NOTA = (
    "Prepara una nota operativa: rinnovo contratto fornitore Rossi entro il 30 novembre, "
    "Marco segue la parte legale, io il budget (max 12.000 euro)."
)
COMMENTO_CORREZIONE = (
    "Aggiungi una sezione «Rischi» con le conseguenze di un ritardo oltre il 30 novembre."
)


def _execute_work(
    golden, work_id: str, expected_version: int, material_ids: list[str], run: GoldenRun
) -> dict:
    """Esegue il lavoro secondo la capability dell'accordo, come la UI.

    Restituisce l'artifact appena prodotto.
    """
    client = golden.client
    capability = _latest_intake_capability(client, work_id)
    if capability in {"general", "agent_run"}:
        run.recorder.note(
            f"esecuzione tramite run agente (capability {capability!r}): nelle prove del "
            "19/10/2026 i run adattivi con una connessione il cui id differisce dalla kind "
            "terminavano «blocked» con «Selected model transport differs from the approved "
            "runtime»."
        )
        run_view = client.prepare_agent_run(work_id, expected_version, material_ids)
        client.approve_agent_run(work_id, run_view)
        client.wait_agent_run(work_id, run_view["id"])
    else:
        proposal = client.prepare_synthesis(work_id, expected_version, material_ids)
        client.approve_synthesis(work_id, proposal)
        client.wait_synthesis(work_id, proposal["id"])
    row = client.work_row(work_id)
    artifact = (row or {}).get("latest_artifact") or {}
    assert artifact.get("content"), "esecuzione completata senza artifact leggibile"
    return artifact


def _latest_intake_capability(client, work_id: str) -> str:
    items = client.get(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/intake").get("items") or []
    for item in reversed(items):
        if item.get("status") == "confirmed":
            return str(item.get("capability") or "synthesize")
    return "synthesize"


def _story_b(golden, run: GoldenRun) -> None:
    client = golden.client
    with run.step("B1.richiesta"):
        conversation_id = client.create_conversation("Nuova richiesta")
        created = client.create_work(conversation_id, "Nuova richiesta", RICHIESTA_NOTA)
        work_id = str(created["work_id"])
        version = int(created["version"])
        classified = client.classify_intake(work_id, RICHIESTA_NOTA)
        assert classified.get("kind") == "work_request", (
            f"la richiesta operativa è stata classificata come {classified.get('kind')!r}"
        )
    with run.step("B1.proposta"):
        proposal = client.propose_intake(work_id, RICHIESTA_NOTA, version)
        assert proposal.get("status") == "pending_confirmation", str(proposal.get("status"))
        assert str(proposal.get("title") or "").strip(), "proposta senza titolo"
        assert str(proposal.get("objective") or "").strip(), "proposta senza obiettivo"
    with run.step("B2.conferma"):
        confirmed = client.confirm_intake(work_id, proposal)
        assert confirmed.get("status") == "confirmed", str(
            confirmed.get("status") or confirmed.get("error_code")
        )
        version = int(client.work_detail(work_id)["work"]["version"])
    with run.step("B2.esecuzione"):
        first = _execute_work(golden, work_id, version, [], run)
        first_version = int(first["version"])
    with run.step("B3.fatti"):
        content = normalize_for_match(first["content"])
        for needle, label in [
            ("rossi", "il fornitore Rossi"),
            ("marco", "il responsabile legale Marco"),
            ("30novembre", "la scadenza 30 novembre"),
            ("12000", "il budget 12.000"),
        ]:
            assert needle in content, f"la nota non contiene {label}"
    with run.step("B4.correzione"):
        version = int(client.work_detail(work_id)["work"]["version"])
        client.review_work(
            work_id, version, first["id"], "request_changes", comment=COMMENTO_CORREZIONE
        )
        version = int(client.work_detail(work_id)["work"]["version"])
    with run.step("B4.nuova-versione"):
        second = _execute_work(golden, work_id, version, [], run)
        assert int(second["version"]) > first_version, (
            f"la correzione non ha prodotto una nuova versione ({second['version']} ≤ {first_version})"
        )
    with run.step("B5.approvazione"):
        version = int(client.work_detail(work_id)["work"]["version"])
        outcome = client.review_work(work_id, version, second["id"], "approve")
        assert outcome.get("status") == "completed", str(outcome.get("status"))
    with run.step("B5.elenchi"):
        row = client.work_row(work_id)
        assert row is not None, "il lavoro non è nell'elenco Compiti"
        assert row.get("status") == "completed", f"stato inatteso in Compiti: {row.get('status')}"
        documents = client.list_artifacts()
        assert any(item.get("id") == second["id"] for item in documents), (
            "il risultato approvato non è nell'elenco Documenti"
        )


@pytest.mark.parametrize("run_index", run_indices())
def test_b_lavoro_dalla_chat(golden, run_index: int) -> None:
    golden.run(["B1", "B2", "B3", "B4", "B5"], run_index, _story_b)
