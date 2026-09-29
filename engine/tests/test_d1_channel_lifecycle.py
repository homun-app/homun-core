"""Tests for D1 Channel Inbound Lifecycle, Queue, Delivery Recovery, and Media Uploads (H32/H33)."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.channel_adapters import (
    ChannelRegistry,
    TelegramAdapter,
)
from homun.application.channel_delivery_recovery import (
    ChannelDeliverySupervisor,
    ChannelPoller,
    send_with_media_dispatch,
)
from homun.application.channel_inbound_queue import (
    InboundChannelQueue,
    InboundQueueItem,
)
from homun.application.gateway_contracts import ChannelMedia, ChannelMessage
from homun.application.gateway_pairing import GatewayPairingManager
from homun.application.gateway_turn_lease import TurnLeaseManager


@pytest.fixture
def clean_inbound_queue(tmp_path):
    db_file = tmp_path / "inbound_queue.sqlite"
    queue = InboundChannelQueue(db_path=db_file)
    return queue


@pytest.fixture
def clean_delivery_supervisor(tmp_path):
    db_file = tmp_path / "delivery_intents.sqlite"
    return ChannelDeliverySupervisor(db_path=db_file)


# ---------------------------------------------------------------------------
# 1. InboundChannelQueue Durability, Claims, and Recovery
# ---------------------------------------------------------------------------

def test_inbound_queue_enqueue_and_survives_reopen(tmp_path):
    db_file = tmp_path / "queue_reopen.sqlite"
    q1 = InboundChannelQueue(db_path=db_file)
    msg = ChannelMessage(
        id="msg_1", platform="telegram", channel_id="chat_1", user_id="user_1", text="hello"
    )
    raw = {"message_id": 1, "chat": {"id": "chat_1"}, "text": "hello"}
    item = q1.enqueue("telegram", raw, msg)
    assert item.status == "pending"
    assert item.attempts == 0

    q2 = InboundChannelQueue(db_path=db_file)
    fetched = q2.get_item(item.item_id)
    assert fetched is not None
    assert fetched.channel_id == "chat_1"
    assert fetched.raw_payload == raw


def test_inbound_queue_atomic_claim_and_concurrency(clean_inbound_queue):
    q = clean_inbound_queue
    msg = ChannelMessage(id="m1", platform="slack", channel_id="c1", user_id="u1", text="hi")
    item = q.enqueue("slack", {"text": "hi"}, msg)

    claims = []

    def _worker(w_id):
        res = q.claim_next(w_id, lease_seconds=10.0)
        if res:
            claims.append((w_id, res.item_id))

    threads = [threading.Thread(target=_worker, args=(f"worker_{i}",)) for i in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Exactly one worker wins the claim
    assert len(claims) == 1
    winner_worker, claimed_id = claims[0]
    assert claimed_id == item.item_id

    # Item is in processing state
    active = q.get_item(item.item_id)
    assert active.status == "processing"
    assert active.leased_by == winner_worker
    assert active.attempts == 1


def test_inbound_queue_completion_and_failure_retry(clean_inbound_queue):
    q = clean_inbound_queue
    msg = ChannelMessage(id="m2", platform="discord", channel_id="c2", user_id="u2", text="test")
    item = q.enqueue("discord", {}, msg)

    # Claim and complete
    claimed = q.claim_next("worker_1")
    assert claimed is not None
    q.complete(claimed.item_id, response_text="handled ok", delivery_receipt_id="del_999")

    done = q.get_item(item.item_id)
    assert done.status == "completed"
    assert done.response_text == "handled ok"
    assert done.delivery_receipt_id == "del_999"

    # Retryable failure resets to pending until max_attempts
    item2 = q.enqueue("discord", {}, msg)
    c2 = q.claim_next("worker_2")
    q.fail(c2.item_id, "temporary error", retryable=True)

    retried = q.get_item(item2.item_id)
    assert retried.status == "pending"
    assert retried.attempts == 1

    # Non-retryable failure marks failed immediately
    c3 = q.claim_next("worker_3")
    q.fail(c3.item_id, "fatal error", retryable=False)
    failed = q.get_item(item2.item_id)
    assert failed.status == "failed"


def test_inbound_queue_stale_claim_recovery(clean_inbound_queue):
    q = clean_inbound_queue
    msg = ChannelMessage(id="m3", platform="telegram", channel_id="c3", user_id="u3", text="recovering")
    item = q.enqueue("telegram", {}, msg)

    # Claim with lease expiring at t=100
    q.claim_next("crashed_worker", lease_seconds=10.0, now=100.0)
    in_flight = q.get_item(item.item_id)
    assert in_flight.status == "processing"

    # Recovery at t=105 (lease not yet expired): 0 recovered
    recovered_early = q.recover_stale_claims(now=105.0)
    assert recovered_early == 0

    # Recovery at t=115 (lease expired): recovers to pending
    recovered = q.recover_stale_claims(now=115.0)
    assert recovered == 1

    recovered_item = q.get_item(item.item_id)
    assert recovered_item.status == "pending"
    assert recovered_item.leased_by is None


# ---------------------------------------------------------------------------
# 2. Channel Delivery Recovery & Media Upload Protocols
# ---------------------------------------------------------------------------

def test_delivery_supervisor_intent_lifecycle(clean_delivery_supervisor):
    sup = clean_delivery_supervisor
    intent = sup.prepare_intent(
        platform="telegram",
        channel_id="chat_123",
        destination_id="chat_123",
        text="Hello outcome",
    )
    assert intent.status == "pending"

    # Success outcome
    delivered = sup.record_outcome(intent.intent_id, delivered=True, provider_message_id="msg_42")
    assert delivered.status == "delivered"
    assert delivered.provider_message_id == "msg_42"
    assert delivered.attempts == 1

    # Re-fetch
    fetched = sup.get_intent(intent.intent_id)
    assert fetched.status == "delivered"


def test_delivery_supervisor_retryable_vs_fatal_classification(clean_delivery_supervisor):
    sup = clean_delivery_supervisor
    # Transient error (503): retryable
    i1 = sup.prepare_intent("slack", "ch1", "ch1", "text 1")
    res1 = sup.record_outcome(i1.intent_id, delivered=False, error="503 Service Unavailable", status_code=503)
    assert res1.status == "failed_retryable"

    # Fatal error (404 Not Found): fatal
    i2 = sup.prepare_intent("slack", "ch2", "ch2", "text 2")
    res2 = sup.record_outcome(i2.intent_id, delivered=False, error="404 Channel not found", status_code=404)
    assert res2.status == "failed_fatal"


def test_telegram_send_photo_and_document_protocol(clean_delivery_supervisor, monkeypatch):
    """Verify that send_with_media_dispatch uses sendPhoto for images and sendDocument for other files."""
    calls = []

    class MockResp:
        status_code = 200
        content = b'{"ok": true, "result": {"message_id": 999}}'

        def json(self):
            return {"ok": True, "result": {"message_id": 999}}

    class MockClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, **k):
            calls.append({"url": url, "json": json})
            return MockResp()

    monkeypatch.setattr("homun.application.channel_delivery_recovery.httpx.Client", MockClient)

    adapter = TelegramAdapter(config={"bot_token": "tg_token_test"})

    # 1. Send image -> calls sendPhoto
    img_media = [ChannelMedia(mime_type="image/png", url="https://example.com/graph.png", file_name="graph.png")]
    res1 = send_with_media_dispatch(
        adapter, "12345", "Quarterly Report", media=img_media, supervisor=clean_delivery_supervisor
    )
    assert res1["delivered"] is True
    assert res1["provider_message_id"] == 999
    assert len(calls) == 1
    assert "sendPhoto" in calls[0]["url"]
    assert calls[0]["json"]["photo"] == "https://example.com/graph.png"
    assert calls[0]["json"]["caption"] == "Quarterly Report"

    # 2. Send PDF document -> calls sendDocument
    doc_media = [ChannelMedia(mime_type="application/pdf", url="https://example.com/doc.pdf", file_name="doc.pdf")]
    res2 = send_with_media_dispatch(
        adapter, "12345", "Project Proposal", media=doc_media, supervisor=clean_delivery_supervisor
    )
    assert res2["delivered"] is True
    assert len(calls) == 2
    assert "sendDocument" in calls[1]["url"]
    assert calls[1]["json"]["document"] == "https://example.com/doc.pdf"
    assert calls[1]["json"]["caption"] == "Project Proposal"


# ---------------------------------------------------------------------------
# 3. Channel Poller & Reconnection Loop
# ---------------------------------------------------------------------------

def test_telegram_channel_poller_and_offset_advancement(tmp_path):
    received_updates = []

    class MockPollerServer:
        def __init__(self):
            self.requests = []
            self.server = None
            self.thread = None

        def start(self):
            parent = self

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    parent.requests.append(self.path)
                    if "offset=0" in self.path:
                        body = json.dumps({
                            "ok": True,
                            "result": [
                                {"update_id": 100, "message": {"message_id": 1, "text": "first"}},
                                {"update_id": 101, "message": {"message_id": 2, "text": "second"}},
                            ],
                        }).encode()
                    elif "offset=102" in self.path:
                        body = json.dumps({"ok": True, "result": []}).encode()
                    else:
                        body = json.dumps({"ok": True, "result": []}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, *a):
                    return None

            self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.thread.start()
            return f"http://127.0.0.1:{self.server.server_address[1]}"

        def stop(self):
            if self.server:
                self.server.shutdown()
            if self.thread:
                self.thread.join(timeout=2)

    server = MockPollerServer()
    base_url = server.start()
    try:
        db_file = tmp_path / "poller_state.sqlite"
        poller = ChannelPoller(
            "telegram",
            "mock-bot-token",
            lambda upd: received_updates.append(upd),
            base_url=base_url,
            db_path=db_file,
        )

        assert poller.get_offset() == 0
        updates1 = poller.poll_once(timeout=1)
        assert len(updates1) == 2
        assert len(received_updates) == 2
        # Offset must be advanced to 101 + 1 = 102
        assert poller.get_offset() == 102

        # Second poll uses offset 102 and receives no new updates
        updates2 = poller.poll_once(timeout=1)
        assert len(updates2) == 0

        # Offset persists across new poller instance
        poller2 = ChannelPoller(
            "telegram",
            "mock-bot-token",
            lambda upd: None,
            base_url=base_url,
            db_path=db_file,
        )
        assert poller2.get_offset() == 102
    finally:
        server.stop()


# ---------------------------------------------------------------------------
# 4. FastAPI Ingress Route & End-to-End Delivery
# ---------------------------------------------------------------------------

def test_channel_ingress_api_authorized_flow(clean_inbound_queue, clean_delivery_supervisor, monkeypatch):
    monkeypatch.setattr("homun.routes.channel_ingress_api.get_inbound_channel_queue", lambda: clean_inbound_queue)
    monkeypatch.setattr("homun.routes.channel_ingress_api.get_channel_delivery_supervisor", lambda: clean_delivery_supervisor)

    # Set up registry with authorized pairing
    pairing_mgr = GatewayPairingManager(db_path=":memory:")
    req = pairing_mgr.request_pairing("telegram", "user_auth_1", username="bob")
    pairing_mgr.approve_code(req.code)

    lease_mgr = TurnLeaseManager()
    reg = ChannelRegistry(
        pairing_manager=pairing_mgr,
        lease_manager=lease_mgr,
        inbound_queue=clean_inbound_queue,
        delivery_supervisor=clean_delivery_supervisor,
    )
    monkeypatch.setattr("homun.routes.channel_ingress_api.get_channel_registry", lambda: reg)

    app = create_app()
    client = TestClient(app)

    payload = {
        "update_id": 1,
        "message": {
            "message_id": 10,
            "chat": {"id": "chat_99", "type": "private"},
            "from": {"id": "user_auth_1", "username": "bob"},
            "text": "Hello Homun agent",
            "date": 1700000000,
        },
    }

    resp = client.post("/v1/gateway/channels/telegram/inbound", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "processed"
    assert data["message_id"] == "10"
    # The authorized message is bridged into a supervised conversation: the
    # response is the assistant reply, never an echo of the inbound text.
    assert data["response"].strip()
    assert not data["response"].startswith("Echo from Homun")
    assert data.get("queue_item_id") is not None

    # Check queue item completed
    q_item = clean_inbound_queue.get_item(data["queue_item_id"])
    assert q_item.status == "completed"
    assert q_item.response_text == data["response"]


def test_channel_ingress_api_unauthorized_sender(clean_inbound_queue, clean_delivery_supervisor, monkeypatch):
    monkeypatch.setattr("homun.routes.channel_ingress_api.get_inbound_channel_queue", lambda: clean_inbound_queue)
    monkeypatch.setattr("homun.routes.channel_ingress_api.get_channel_delivery_supervisor", lambda: clean_delivery_supervisor)

    pairing_mgr = GatewayPairingManager(db_path=":memory:")
    reg = ChannelRegistry(
        pairing_manager=pairing_mgr,
        inbound_queue=clean_inbound_queue,
        delivery_supervisor=clean_delivery_supervisor,
    )
    monkeypatch.setattr("homun.routes.channel_ingress_api.get_channel_registry", lambda: reg)

    app = create_app()
    client = TestClient(app)

    payload = {
        "message": {
            "message_id": 20,
            "chat": {"id": "chat_unauth", "type": "private"},
            "from": {"id": "stranger_1", "username": "stranger"},
            "text": "Intruder ping",
        },
    }

    resp = client.post("/v1/gateway/channels/telegram/inbound", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "unauthorized"
    assert data["user_id"] == "stranger_1"


def test_channel_queue_listing_and_recovery_endpoints(clean_inbound_queue, monkeypatch):
    monkeypatch.setattr("homun.routes.channel_ingress_api.get_inbound_channel_queue", lambda: clean_inbound_queue)

    msg = ChannelMessage(id="q1", platform="slack", channel_id="ch_s", user_id="u_s", text="hi")
    clean_inbound_queue.enqueue("slack", {"raw": 1}, msg)

    app = create_app()
    client = TestClient(app)

    # 1. List queue items
    res_list = client.get("/v1/gateway/channels/queue?platform=slack")
    assert res_list.status_code == 200
    data = res_list.json()
    assert data["count"] == 1
    assert data["items"][0]["platform"] == "slack"

    # 2. Recover stale
    res_rec = client.post("/v1/gateway/channels/queue/recover?max_age_seconds=10")
    assert res_rec.status_code == 200
    assert "recovered_count" in res_rec.json()
