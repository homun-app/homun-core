"""H35 durable API idempotency store."""
from __future__ import annotations

from homun.application.api_server_contracts import IdempotencyStore


def test_idempotency_survives_reopen(tmp_path):
    db = tmp_path / "idem.sqlite"
    store1 = IdempotencyStore(db_path=str(db))
    body = {"model": "m", "messages": [{"role": "user", "content": "hi"}]}
    store1.put("k1", body, {"id": "cmpl-1", "choices": []}, actor_id="a1")
    store1.put("k1", body, {"id": "cmpl-1", "choices": []}, actor_id="a1")  # overwrite ok

    store2 = IdempotencyStore(db_path=str(db))
    hit = store2.get("k1", body, actor_id="a1")
    assert hit is not None
    assert hit["id"] == "cmpl-1"
    assert store2.get("k1", body, actor_id="other") is None
