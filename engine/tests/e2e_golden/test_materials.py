"""Area C — materiali e file: progetto, upload, ricerca e riassunto.

Percorso della UI: `engine-projects-client.ts` (progetto e upload multipart),
poi la stessa filiera dell'area B con i materiali selezionati
(`material_ids` nella proposta di esecuzione), come nella guida d'uso
(«Un lavoro con materiali»).
I marcatori dei file esistono SOLO nei file: se il risultato li cita, ha
letto davvero i materiali e non il prompt.
"""
from __future__ import annotations

import secrets

import pytest

from .fixtures.materials import MD_MARKERS, MD_NAME, MD_TEXT, PDF_MARKERS, PDF_NAME, make_pdf
from .common import GoldenError, normalize_for_match, run_indices
from .reporting import GoldenRun

pytestmark = pytest.mark.golden

RICHIESTA_RICERCA = (
    "Trova le scadenze e i responsabili nei materiali del progetto e prepara "
    "un breve riepilogo operativo con date e nomi."
)
RICHIESTA_RIASSUNTO = (
    "Riassumi il file «appunti-riunione.md» con i suoi punti chiave: date, "
    "responsabili e cose da fare."
)


def _run_intake_work(golden, conversation_id: str, text: str, material_ids: list[str], run: GoldenRun) -> dict:
    """Filiera completa della UI per un lavoro con materiali; ritorna l'artifact.

    Ogni richiesta passa da `conversation.post_message` (porta d'ingresso):
    la proposta nasce dal turno, la conferma dall'endpoint di conferma.
    """
    from .test_work import _execute_work, _pending_proposal, _work_request_outcome
    from .common import ensure_accepted

    client = golden.client
    created = client.create_work(conversation_id, "Nuova richiesta", "Obiettivo da concordare")
    work_id = str(created["work_id"])
    roster = client.ui_roster()
    result, error = client.post_message(conversation_id, text, roster=roster)
    ensure_accepted(error, "richiesta di lavoro rifiutata")
    if result.get("chat_agent"):
        client.resolve_reply(conversation_id, result, result.get("message_id"))
    outcome = _work_request_outcome(result)
    run.recorder.note(f"materiali run {run.run_index}: esito della richiesta = {outcome}")
    if outcome == "chiarimento":
        # La richiesta dei materiali è specifica: un chiarimento qui è un difetto
        # del turno, non una scelta legittima.
        raise GoldenError("front_door", f"la richiesta con materiali è finita in chiarimento: {outcome}", "")
    proposal = _pending_proposal(client, work_id)
    assert proposal is not None, "nessuna proposta in attesa di conferma dopo il messaggio"
    client.confirm_intake(work_id, proposal)
    version = int(client.work_detail(work_id)["work"]["version"])
    return _execute_work(golden, work_id, version, material_ids, run)


def _story_c(golden, run: GoldenRun) -> None:
    client = golden.client
    with run.step("C1.progetto"):
        created = client.create_project(
            f"Materiali golden {secrets.token_hex(3)}", "Progetto di prova del percorso d'oro"
        )
        project_id = str(created["project_id"])
    with run.step("C1.caricamento"):
        md = client.upload_material(project_id, MD_NAME, MD_TEXT.encode(), "text/markdown")
        pdf = client.upload_material(project_id, PDF_NAME, make_pdf(), "application/pdf")
        assert md.get("material_id"), "upload markdown senza id"
        assert pdf.get("material_id"), "upload pdf senza id"
    with run.step("C1.lettura"):
        for material_id, markers in [(md["material_id"], MD_MARKERS), (pdf["material_id"], PDF_MARKERS)]:
            body = client.material_content(material_id)
            assert body.get("extract_status") == "extracted", (
                f"{material_id}: estrazione {body.get('extract_status')!r}"
            )
            text = normalize_for_match(body.get("text") or "")
            for marker in markers[:2]:
                assert normalize_for_match(marker) in text, f"contenuto estratto senza {marker!r}"
    with run.step("C2.ricerca"):
        conversation_id = client.create_conversation("Materiali: scadenze", project_id)
        artifact = _run_intake_work(
            golden, conversation_id, RICHIESTA_RICERCA,
            [md["material_id"], pdf["material_id"]], run,
        )
    with run.step("C2.contenuti"):
        content = normalize_for_match(artifact["content"])
        from_md = [m for m in MD_MARKERS if normalize_for_match(m) in content]
        from_pdf = [m for m in PDF_MARKERS if normalize_for_match(m) in content]
        assert from_md, "il riepilogo non cita nessun contenuto del file markdown"
        assert from_pdf, "il riepilogo non cita nessun contenuto del pdf"
        run.recorder.note(
            f"C2 run {run.run_index}: citati dal md {from_md}, dal pdf {from_pdf}"
        )
    with run.step("C3.riassunto"):
        conversation_id = client.create_conversation("Materiali: riassunto", project_id)
        artifact = _run_intake_work(
            golden, conversation_id, RICHIESTA_RIASSUNTO, [md["material_id"]], run
        )
    with run.step("C3.punti-chiave"):
        content = normalize_for_match(artifact["content"])
        cited = [m for m in MD_MARKERS if normalize_for_match(m) in content]
        assert len(cited) >= 2, f"il riassunto presenta meno di due punti chiave del file: {cited}"


@pytest.mark.parametrize("run_index", run_indices())
def test_c_materiali(golden, run_index: int) -> None:
    golden.run(["C1", "C2", "C3"], run_index, _story_c)
