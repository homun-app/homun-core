"""Tests for deliverable mode, artifact extraction, media policies, and delivery ledger (H42)."""
from __future__ import annotations

from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.deliverable_dispatcher import (
    DeliverableTurnResult,
    dispatch_deliverables_for_turn,
)
from homun.application.deliverable_extractor import (
    DeliverableAttachment,
    extract_deliverables_from_text,
)
from homun.application.deliverable_ledger import (
    DeliverableLedger,
    get_deliverable_ledger,
    reset_deliverable_ledger,
    set_deliverable_ledger,
)
from homun.application.deliverable_policy import (
    BLOCKED_DELIVERABLE_EXTENSIONS,
    DELIVERABLE_EXTENSIONS,
    get_deliverable_category,
    validate_deliverable_path,
)


@pytest.fixture(autouse=True)
def clean_deliverable_environment(tmp_path):
    ledger = DeliverableLedger(db_path=tmp_path / "test_ledger.sqlite")
    set_deliverable_ledger(ledger)
    yield
    reset_deliverable_ledger()



# 1. Deliverable Policy
def test_deliverable_policy(tmp_path: Path):
    # Category mappings
    assert get_deliverable_category("report.pdf") == "document"
    assert get_deliverable_category("chart.png") == "image"
    assert get_deliverable_category("data.xlsx") == "data"
    assert get_deliverable_category("presentation.pptx") == "presentation"
    assert get_deliverable_category("voice.mp3") == "audio"
    assert get_deliverable_category("archive.zip") == "archive"
    assert get_deliverable_category("script.py") is None

    # Blocked extensions
    for ext in BLOCKED_DELIVERABLE_EXTENSIONS:
        ok, reason = validate_deliverable_path(f"/path/to/file{ext}")
        assert ok is False
        assert "forbidden from auto-delivery" in (reason or "")

    # Directory confinement
    allowed_dir = tmp_path / "scratch"
    allowed_dir.mkdir()
    child_doc = allowed_dir / "summary.pdf"
    child_doc.write_text("dummy")

    ok_child, _ = validate_deliverable_path(str(child_doc), allowed_dirs=[allowed_dir])
    assert ok_child is True

    outside_doc = tmp_path / "outside.pdf"
    outside_doc.write_text("dummy")
    ok_outside, reason_outside = validate_deliverable_path(str(outside_doc), allowed_dirs=[allowed_dir])
    assert ok_outside is False
    assert "outside allowed directories" in (reason_outside or "")


# 2. Deliverable Extraction (including code block exclusion rule)
def test_deliverable_extraction_and_code_block_protection():
    # Response containing real deliverable paths and code block examples
    message = (
        "Here is the final report for your review:\n"
        "I have saved the PDF to /tmp/reports/annual_summary.pdf and the chart to /tmp/charts/growth.png.\n\n"
        "If you want to reproduce this locally, run:\n"
        "```python\n"
        "import pandas as pd\n"
        "# Example path inside code block:\n"
        "df = pd.read_csv('/tmp/example_datasets/fake_data.csv')\n"
        "print('Loaded')\n"
        "```\n\n"
        "You can also inspect with `cat /tmp/debug/test_log.txt`.\n"
        "Let me know if you need anything else!"
    )

    cleaned_text, attachments = extract_deliverables_from_text(message)

    # 1. Exactly the 2 real deliverables outside code blocks must be extracted
    assert len(attachments) == 2
    filenames = {a.filename for a in attachments}
    assert "annual_summary.pdf" in filenames
    assert "growth.png" in filenames

    categories = {a.category for a in attachments}
    assert "document" in categories
    assert "image" in categories

    # 2. Example paths inside fenced code blocks or inline code MUST NOT be extracted
    assert "fake_data.csv" not in filenames
    assert "test_log.txt" not in filenames

    # 3. Code blocks inside cleaned text must remain intact without modification
    assert "import pandas as pd" in cleaned_text
    assert "df = pd.read_csv('/tmp/example_datasets/fake_data.csv')" in cleaned_text
    assert "`cat /tmp/debug/test_log.txt`" in cleaned_text

    # 4. Standalone deliverable paths in prose are replaced cleanly with bracketed labels
    assert "[annual_summary.pdf]" in cleaned_text
    assert "[growth.png]" in cleaned_text
    assert "/tmp/reports/annual_summary.pdf" not in cleaned_text


# 3. Deliverable Ledger & At-most-once Delivery
def test_deliverable_ledger():
    ledger = get_deliverable_ledger()

    # Initial state
    assert ledger.is_delivered("sess_100", "/tmp/report.pdf") is False

    # Record delivery
    receipt = ledger.record_delivery(
        session_id="sess_100",
        channel="telegram",
        path="/tmp/report.pdf",
        filename="report.pdf",
        category="document",
        metadata={"chat_id": "tg_123"},
    )
    assert receipt.receipt_id.startswith("dlv_")
    assert receipt.status == "delivered"
    assert ledger.is_delivered("sess_100", "/tmp/report.pdf") is True

    # Same file to different session is not yet delivered
    assert ledger.is_delivered("sess_200", "/tmp/report.pdf") is False

    # List receipts
    receipts = ledger.list_receipts(session_id="sess_100")
    assert len(receipts) == 1
    assert receipts[0].receipt_id == receipt.receipt_id


# 4. REST API Routes
def test_deliverables_api_routes():
    app = create_app()
    client = TestClient(app)

    # 1. POST /v1/deliverables/scan
    text = (
        "Generated your files: /tmp/invoice.pdf\n"
        "```python\n# /tmp/fake_example.xlsx\n```\n"
    )
    resp = client.post("/v1/deliverables/scan", json={"text": text})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["deliverables"]) == 1
    assert data["deliverables"][0]["filename"] == "invoice.pdf"
    assert data["deliverables"][0]["category"] == "document"
    assert "[invoice.pdf]" in data["cleaned_text"]
    assert "# /tmp/fake_example.xlsx" in data["cleaned_text"]

    # 2. POST /v1/deliverables/deliver
    resp_dlv = client.post(
        "/v1/deliverables/deliver",
        json={
            "session_id": "sess_api_1",
            "channel": "slack",
            "path": "/tmp/invoice.pdf",
            "filename": "invoice.pdf",
            "category": "document",
        },
    )
    assert resp_dlv.status_code == 200
    receipt_data = resp_dlv.json()
    assert receipt_data["status"] == "delivered"
    assert receipt_data["receipt_id"].startswith("dlv_")

    # 3. GET /v1/deliverables/receipts
    resp_rcp = client.get("/v1/deliverables/receipts?session_id=sess_api_1")
    assert resp_rcp.status_code == 200
    assert len(resp_rcp.json()) == 1
    assert resp_rcp.json()[0]["filename"] == "invoice.pdf"

    # 4. POST /v1/deliverables/dispatch
    resp_disp = client.post(
        "/v1/deliverables/dispatch",
        json={
            "session_id": "sess_api_dispatch",
            "channel": "generic",
            "recipient_id": "user_456",
            "text": "Your report is ready at /tmp/summary.pdf and script ```python\n# /tmp/fake.py\n```",
        },
    )
    assert resp_disp.status_code == 200
    disp_data = resp_disp.json()
    assert disp_data["extracted_count"] == 1
    assert disp_data["new_deliverables_count"] == 1
    assert "[summary.pdf]" in disp_data["cleaned_text"]
    assert "# /tmp/fake.py" in disp_data["cleaned_text"]
    assert len(disp_data["receipts"]) == 1


# 5. Deliverable Dispatcher & At-most-once Media packaging
def test_deliverable_dispatcher():
    from homun.application.channel_contracts import ChannelAdapter
    from homun.application.gateway_contracts import ChannelMedia

    sent_calls = []

    class MockAdapter(ChannelAdapter):
        platform = "mock_chat"

        def send(self, channel_id, text, *, thread_id=None, reply_to_id=None, media=None):
            sent_calls.append({
                "channel_id": channel_id,
                "text": text,
                "media": media or [],
            })
            return {"delivered": True, "media_delivered": True, "platform": self.platform, "media_count": len(media or [])}

    mock_adapter = MockAdapter()
    text = (
        "Here are your outputs:\n"
        "- Document: /tmp/analysis_report.pdf\n"
        "- Chart: /tmp/growth_chart.png\n"
        "And snippet:\n"
        "```sh\ncat /tmp/debug.log\n```\n"
        "Check `cat /tmp/other.pdf` too."
    )

    # First turn: 2 new deliverables extracted and dispatched
    res1 = dispatch_deliverables_for_turn(
        session_id="sess_turn_1",
        platform="mock_chat",
        destination_id="dest_999",
        text=text,
        adapter=mock_adapter,
    )

    assert res1.extracted_count == 2
    assert len(res1.new_deliverables) == 2
    assert len(res1.already_delivered) == 0
    assert len(res1.receipts) == 2
    assert "[analysis_report.pdf]" in res1.cleaned_text
    assert "[growth_chart.png]" in res1.cleaned_text
    assert "cat /tmp/debug.log" in res1.cleaned_text
    assert "cat /tmp/other.pdf" in res1.cleaned_text

    assert len(sent_calls) == 1
    assert len(sent_calls[0]["media"]) == 2
    media_names = [m.file_name for m in sent_calls[0]["media"]]
    assert "analysis_report.pdf" in media_names
    assert "growth_chart.png" in media_names

    # Second turn with same text in same session: at-most-once deduplication prevents re-dispatching media
    res2 = dispatch_deliverables_for_turn(
        session_id="sess_turn_1",
        platform="mock_chat",
        destination_id="dest_999",
        text=text,
        adapter=mock_adapter,
    )
    assert res2.extracted_count == 2
    assert len(res2.new_deliverables) == 0
    assert len(res2.already_delivered) == 2
    assert len(sent_calls) == 2
    # No media re-attached on replay
    assert len(sent_calls[1]["media"]) == 0


# 6. Gateway Manage Adapter Send with Deliverable Mode
def test_gateway_manage_adapter_send_deliverables():
    from homun.application.gateway_tools import execute, reset_gateway_state

    reset_gateway_state()

    ctx = None
    actor = {"id": "user_1"}
    run = {"id": "run_gw_1", "gateway": {"policy": "core-gateway-v1"}}

    # Send with deliverable mode via generic adapter
    res = execute(
        ctx,
        actor,
        run,
        "gateway_manage",
        {
            "action": "adapter_send",
            "platform": "webhook",
            "channel_id": "https://example.com/webhook",
            "text": "File generated: /tmp/invoice.pdf\n```\n/tmp/not_a_deliverable.pdf\n```",
            "deliverable_mode": True,
        },
    )

    assert res["deliverables_extracted"] == 1
    assert "[invoice.pdf]" in res["cleaned_text"]
    assert "/tmp/not_a_deliverable.pdf" in res["cleaned_text"]
    assert len(res["receipts"]) == 1

