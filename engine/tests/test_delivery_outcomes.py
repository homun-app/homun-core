"""Local delivery outcome, restart and independent-connection race evidence."""
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event

import pytest

from homun.application.deliverable_dispatcher import dispatch_deliverables_for_turn
from homun.application.deliverable_ledger import DeliverableLedger


class Stub:
    def __init__(self, response=None):
        self.calls = []
        self.response = response if response is not None else {"delivered": True, "media_delivered": True}

    def send(self, *args, **kwargs):
        self.calls.append(kwargs.get("media") or [])
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def dispatch(ledger, adapter=None, destination="room", platform="test"):
    return dispatch_deliverables_for_turn("session", platform, destination,
        "Report /tmp/report.pdf", ledger=ledger, adapter=adapter)


def test_no_adapter_is_retryable_intent(tmp_path):
    ledger = DeliverableLedger(tmp_path / "ledger.db")
    result = dispatch(ledger)
    assert result.receipts[0].status == "intent"
    assert not ledger.is_delivered("session", result.receipts[0].path)
    assert dispatch(ledger, Stub()).receipts[0].status == "delivered"


def test_refusal_is_failed_and_retryable_after_reopen(tmp_path):
    path = tmp_path / "ledger.db"
    result = dispatch(DeliverableLedger(path), Stub({"delivered": False}))
    assert result.receipts[0].status == "failed"
    adapter = Stub()
    result = dispatch(DeliverableLedger(path), adapter)
    assert result.receipts[0].status == "delivered"
    assert len(adapter.calls[0]) == 1


@pytest.mark.parametrize("response", [TimeoutError("lost acknowledgement"), {},
    {"delivered": False, "error": "connection reset"},
    {"delivered": False, "delivery_state": "unknown"}])
def test_unknown_never_redispatches_after_reopen(tmp_path, response):
    path = tmp_path / "ledger.db"
    first = dispatch(DeliverableLedger(path), Stub(response))
    assert first.receipts[0].status == "unknown"
    second = Stub()
    result = dispatch(DeliverableLedger(path), second)
    assert not any(second.calls)
    assert not result.already_delivered
    assert result.receipts[0].status == "unknown"


def test_dedup_is_scoped_to_destination_and_channel(tmp_path):
    ledger = DeliverableLedger(tmp_path / "ledger.db")
    adapter = Stub()
    dispatch(ledger, adapter)
    dispatch(ledger, adapter, destination="other")
    dispatch(ledger, adapter, platform="other")
    assert sum(len(call) for call in adapter.calls) == 3
    result = dispatch(DeliverableLedger(tmp_path / "ledger.db"), adapter)
    assert len(result.already_delivered) == 1
    assert sum(len(call) for call in adapter.calls) == 3


def test_independent_connections_claim_before_io(tmp_path):
    path = tmp_path / "ledger.db"
    ledgers = [DeliverableLedger(path), DeliverableLedger(path)]
    barrier = Barrier(2)
    entered, release = Event(), Event()

    class BlockingStub(Stub):
        def send(self, *args, **kwargs):
            if kwargs.get("media"):
                entered.set()
                assert release.wait(5)
            return super().send(*args, **kwargs)

    adapters = [BlockingStub(), BlockingStub()]
    def run(i):
        barrier.wait()
        return dispatch(ledgers[i], adapters[i])
    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(run, i) for i in range(2)]
        try:
            assert entered.wait(5)
            reopened = DeliverableLedger(path)
            assert reopened.list_receipts()[0].status == "pending"
            replay = Stub()
            dispatch(reopened, replay)
            assert not any(replay.calls)
        finally:
            release.set()
        [f.result() for f in futures]
    assert sum(len(call) for a in adapters for call in a.calls) == 1
    assert DeliverableLedger(path).list_receipts()[0].status == "delivered"


def test_legacy_migration_preserves_confirmed_not_failed_metadata(tmp_path):
    path = tmp_path / "ledger.db"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE receipts(receipt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, payload TEXT NOT NULL, delivered_at REAL NOT NULL)")
        conn.execute("CREATE UNIQUE INDEX idx_receipt_session_path ON receipts(session_id,path)")
        for name, metadata in [("yes", {"channel_response": {"delivered": True, "media_delivered": True, "channel_id": "room"}}), ("no", {"status": "failed"})]:
            data = dict(receipt_id=name, session_id="session", channel="test", path=f"/tmp/{name}.pdf", filename=f"{name}.pdf", category="document", status="delivered", delivered_at=1, metadata=metadata)
            conn.execute("INSERT INTO receipts VALUES(?,?,?,?,?)", (name,"session",data["path"],json.dumps(data),1))
    ledger = DeliverableLedger(path)
    assert ledger.is_delivered("session", "/tmp/yes.pdf")
    assert not ledger.is_delivered("session", "/tmp/no.pdf")
    assert {r.receipt_id: r.status for r in ledger.list_receipts()} == {"yes": "delivered", "no": "failed"}


def test_abandoned_claim_is_not_retried_after_restart(tmp_path):
    import os
    import subprocess
    import sys
    from pathlib import Path

    path = tmp_path / "ledger.db"
    script = '''
import os, sys
from homun.application.deliverable_dispatcher import dispatch_deliverables_for_turn
from homun.application.deliverable_ledger import DeliverableLedger
class Crash:
    def send(self, *args, **kwargs):
        os._exit(17)
dispatch_deliverables_for_turn("session", "test", "room", "Report /tmp/report.pdf", adapter=Crash(), ledger=DeliverableLedger(sys.argv[1]))
'''
    result = subprocess.run([sys.executable, "-c", script, str(path)],
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}, check=False)
    assert result.returncode == 17
    reopened = DeliverableLedger(path)
    assert reopened.list_receipts()[0].status == "pending"
    adapter = Stub()
    result = dispatch(reopened, adapter)
    assert not adapter.calls
    assert result.delivery_response["code"] == "delivery_outcome_unknown"
    assert not result.already_delivered


def test_base_adapter_is_known_refusal_not_unknown(tmp_path):
    from homun.application.channel_contracts import ChannelAdapter
    ledger = DeliverableLedger(tmp_path / "ledger.db")
    result = dispatch(ledger, ChannelAdapter())
    assert result.receipts[0].status == "failed"
    assert dispatch(ledger, Stub()).receipts[0].status == "delivered"


def test_old_claim_cannot_finalize_a_new_retry(tmp_path):
    ledger = DeliverableLedger(tmp_path / "ledger.db")
    args = ("session", "test", "/tmp/report.pdf", "report.pdf", "document")
    old, claimed = ledger.claim_delivery(*args, destination_id="room")
    assert claimed
    ledger.finish_delivery(old, "failed")
    new, claimed = ledger.claim_delivery(*args, destination_id="room")
    assert claimed
    with pytest.raises(ValueError, match="no longer pending"):
        ledger.finish_delivery(old, "delivered")
    ledger.finish_delivery(new, "delivered")
    assert ledger.list_receipts()[0].receipt_id == new.receipt_id


def test_message_delivery_does_not_certify_media_upload(tmp_path):
    ledger = DeliverableLedger(tmp_path / "ledger.db")
    result = dispatch(ledger, Stub({"delivered": True, "media_count": 1}))
    assert result.receipts[0].status == "unknown"
    assert result.delivery_response["code"] == "delivery_outcome_unknown"
    assert not ledger.is_delivered("session", result.receipts[0].path)
    replay = Stub()
    dispatch(ledger, replay)
    assert not replay.calls


def test_explicit_media_acknowledgement_confirms_delivery(tmp_path):
    ledger = DeliverableLedger(tmp_path / "ledger.db")
    result = dispatch(ledger, Stub({"delivered": True, "media_delivered": True}))
    assert result.receipts[0].status == "delivered"
    assert ledger.is_delivered("session", result.receipts[0].path)


def test_compatibility_receipt_does_not_promote_negative_response(tmp_path):
    ledger = DeliverableLedger(tmp_path / "ledger.db")
    receipt = ledger.record_delivery("s", "test", "/tmp/a.pdf", "a.pdf", "document",
        metadata={"channel_response": {"delivered": False}})
    assert receipt.status == "failed"
    assert not ledger.is_delivered("s", receipt.path)


@pytest.mark.parametrize('extra', [{'delivery_state': 'failed'}, {'status': 'failed'}, {'status_code': 500}])
def test_conflicting_ack_is_unknown(extra):
    from homun.application.delivery_outcomes import delivery_status
    assert delivery_status({'delivered': True, 'media_delivered': True, **extra}, has_media=True) == 'unknown'


def test_compatibility_receipt_requires_media_proof(tmp_path):
    ledger = DeliverableLedger(tmp_path / 'ledger.db')
    receipt = ledger.record_delivery('s', 'test', '/tmp/a.pdf', 'a.pdf', 'document',
        metadata={'channel_response': {'delivered': True, 'media_count': 1}})
    assert receipt.status == 'unknown'


def test_legacy_unproven_unscoped_receipt_blocks_replay(tmp_path):
    path = tmp_path / 'legacy.db'
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE receipts(receipt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, payload TEXT NOT NULL, delivered_at REAL NOT NULL)')
        data = dict(receipt_id='old', session_id='session', channel='test', path=str(__import__('pathlib').Path('/tmp/report.pdf').resolve()), filename='report.pdf', category='document', status='delivered', delivered_at=1, metadata={})
        conn.execute('INSERT INTO receipts VALUES(?,?,?,?,?)', ('old','session',data['path'],json.dumps(data),1))
    ledger = DeliverableLedger(path)
    assert ledger.list_receipts()[0].status == 'unknown'
    adapter = Stub()
    dispatch(ledger, adapter)
    assert not adapter.calls
