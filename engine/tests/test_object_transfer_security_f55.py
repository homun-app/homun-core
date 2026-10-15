"""F5 review di sicurezza — attacchi al protocollo object-transfer v2.

Ogni test corrisponde a un rilievo della review indipendente (P1-P5) ed è
entrato rosso sul codice pre-correzione. Shared helpers in
tests/object_transfer_f55_support.py.
"""
from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from homun.peers.object_crypto import canonical_manifest_bytes, unsigned_manifest_dict
from object_transfer_f55_support import (
    OWNER,
    _grant,
    _pair_giulia,
    _pair_person,
    _published_event_count,
    _publish,
    _publish_manifest,
    _seal_for,
    _set_limits,
    _setup_shared,
    host,  # noqa: F401 - fixture
)


def test_cross_project_object_hijack_is_rejected(host):
    """Review P1: an object_id belongs to the project of its first
    publication. A member with write only on «Condiviso» cannot overwrite or
    supersede an object of «Privato» by redeclaring the project."""
    app, ctx, tmp_path = host
    shared, private = _setup_shared(ctx)
    with TestClient(app) as client:
        giulia_confirm, giulia = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", giulia_confirm["person_id"], shared, "write")
        giulia_peer = {"Authorization": f"Bearer {giulia_confirm['device_token']}"}

        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "g2", marta_confirm["person_id"], private, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}

        original = _seal_for(marta, marta, private, b"contratto privato", object_id="obj_contratto", version=1)
        published = _publish(client, marta_peer, private, original)
        assert published.status_code == 200, published.text
        meta_path = tmp_path / "object-transfers" / "obj_contratto" / "v1" / "meta.json"
        original_meta = meta_path.read_text()

        # Same version, same object_id, different declared project.
        attack = _seal_for(giulia, giulia, shared, b"contratto rubato", object_id="obj_contratto", version=1)
        denied = _publish(client, giulia_peer, shared, attack)
        assert denied.status_code == 403, denied.text
        assert denied.json()["detail"]["code"] == "permission_denied"
        assert meta_path.read_text() == original_meta

        # A higher version of someone else's object is equally rejected.
        attack_v2 = _seal_for(giulia, giulia, shared, b"contratto rubato v2", object_id="obj_contratto", version=2)
        denied_v2 = _publish(client, giulia_peer, shared, attack_v2)
        assert denied_v2.status_code == 403, denied_v2.text
        v2_meta = tmp_path / "object-transfers" / "obj_contratto" / "v2" / "meta.json"
        assert not v2_meta.exists()


def test_published_versions_are_immutable(host):
    """Review P1: an existing version is never replaced; identical
    republication is idempotent (no duplicate announce), anything else is a
    typed version conflict."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        giulia_confirm, giulia = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", giulia_confirm["person_id"], shared, "write")
        giulia_peer = {"Authorization": f"Bearer {giulia_confirm['device_token']}"}

        v1 = _seal_for(giulia, giulia, shared, b"prima stesura", object_id="obj_listino", version=1)
        first = _publish(client, giulia_peer, shared, v1)
        assert first.status_code == 200, first.text
        events_after_first = _published_event_count(ctx)

        # Different content for the same version → version conflict.
        v1_changed = _seal_for(giulia, giulia, shared, b"prima stesura RISCRITTA", object_id="obj_listino", version=1)
        conflict = _publish(client, giulia_peer, shared, v1_changed)
        assert conflict.status_code == 409, conflict.text
        assert conflict.json()["detail"]["code"] == "version_conflict"

        # Byte-identical republication → idempotent 200, no duplicate announce.
        again = _publish(client, giulia_peer, shared, v1)
        assert again.status_code == 200, again.text
        assert again.json()["event_sequence"] == first.json()["event_sequence"]
        assert _published_event_count(ctx) == events_after_first

        # A new lower/equal version after a higher one exists → conflict.
        v2 = _seal_for(giulia, giulia, shared, b"seconda stesura", object_id="obj_listino", version=2)
        assert _publish(client, giulia_peer, shared, v2).status_code == 200
        v2_changed = _seal_for(giulia, giulia, shared, b"seconda stesura alt", object_id="obj_listino", version=2)
        assert _publish(client, giulia_peer, shared, v2_changed).status_code == 409


def test_put_chunk_checks_permission_on_the_object_project(host):
    """Review P1 verification: put_chunk authorizes on the project of
    the stored object (from meta), not on anything the caller declares."""
    app, ctx, tmp_path = host
    shared, private = _setup_shared(ctx)
    with TestClient(app) as client:
        giulia_confirm, giulia = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", giulia_confirm["person_id"], shared, "write")
        giulia_peer = {"Authorization": f"Bearer {giulia_confirm['device_token']}"}

        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "g2", marta_confirm["person_id"], private, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}

        sealed = _seal_for(marta, marta, private, b"documento privato", object_id="obj_riservato", version=1)
        published = client.post(
            "/v1/workspaces/ws_local/remote/objects",
            headers=marta_peer,
            json={"project_id": private, "manifest": sealed.manifest.to_dict()},
        )
        assert published.status_code == 200, published.text

        denied = client.put(
            "/v1/workspaces/ws_local/remote/objects/obj_riservato/versions/1/chunks/0",
            headers=giulia_peer,
            content=sealed.ciphertext_chunks[0],
        )
        assert denied.status_code == 403, denied.text
        assert denied.json()["detail"]["code"] == "permission_denied"
        assert not (
            tmp_path / "object-transfers" / "obj_riservato" / "v1" / "chunks" / "0.bin"
        ).exists()


def test_publish_requires_publisher_signature_and_active_device(host):
    """Review P2: the host verifies the manifest signature AND that
    the signing device is an active device of the requesting person."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        _giulia_confirm, giulia = _pair_giulia(client, tmp_path)

        sealed = _seal_for(marta, marta, shared, b"firmato da Marta")
        honest = _publish(client, marta_peer, shared, sealed)
        assert honest.status_code == 200, honest.text

        # Altered signature → rejected.
        tampered_sig = sealed.manifest.to_dict()
        tampered_sig["publisher_signature_b64"] = (
            tampered_sig["publisher_signature_b64"][:-8] + "AAAAAAAA"
        )
        denied_sig = _publish_manifest(
            client, marta_peer, shared, tampered_sig, sealed.ciphertext_chunks
        )
        assert denied_sig.status_code == 400, denied_sig.text
        assert (
            denied_sig.json()["detail"]["reason"]
            == "object_transfer.publisher_signature_invalid"
        )

        # Field modified after signing → signature no longer covers the manifest.
        modified = sealed.manifest.to_dict()
        modified["chunk_size"] = modified["chunk_size"] + 1
        denied_modified = _publish_manifest(
            client, marta_peer, shared, modified, sealed.ciphertext_chunks
        )
        assert denied_modified.status_code == 400, denied_modified.text
        assert (
            denied_modified.json()["detail"]["reason"]
            == "object_transfer.publisher_signature_invalid"
        )

        # Signed by another device while claiming Marta's fingerprint → rejected.
        forged = sealed.manifest.to_dict()
        forged["publisher_signature_b64"] = giulia.sign(
            canonical_manifest_bytes(unsigned_manifest_dict(forged))
        )
        denied_forged = _publish_manifest(
            client, marta_peer, shared, forged, sealed.ciphertext_chunks
        )
        assert denied_forged.status_code == 400, denied_forged.text
        assert (
            denied_forged.json()["detail"]["reason"]
            == "object_transfer.publisher_signature_invalid"
        )

        # publisher_fingerprint of a confirmed device of ANOTHER person → 403.
        giulia_manifest = _seal_for(giulia, marta, shared, b"da Giulia").manifest.to_dict()
        denied_person = _publish_manifest(client, marta_peer, shared, giulia_manifest)
        assert denied_person.status_code == 403, denied_person.text
        assert (
            denied_person.json()["detail"]["reason"]
            == "object_transfer.publisher_device_mismatch"
        )

        # Revoked publisher device → 403 even with a valid session: today the
        # API pairs one device per person, so a second (revoked) device of the
        # same person is added directly to the store.
        from homun.domain.models import PersonDevice, utc_now
        from homun.peers.device_identity import generate_device_keypair

        second = generate_device_keypair()
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                store.person_devices["pdev_second_marta"] = PersonDevice(
                    id="pdev_second_marta",
                    workspace_id=ctx.workspace_id,
                    person_id=marta_confirm["person_id"],
                    name="Secondo dispositivo",
                    key_fingerprint=second.fingerprint,
                    status="revoked",
                    created_at=utc_now(),
                )
            ctx.service.store = store
        revoked_publisher = _seal_for(second, marta, shared, b"device revocato", version=2)
        denied_revoked = _publish(client, marta_peer, shared, revoked_publisher)
        assert denied_revoked.status_code == 403, denied_revoked.text
        assert (
            denied_revoked.json()["detail"]["reason"]
            == "object_transfer.publisher_device_mismatch"
        )


def test_manifest_project_must_match_declared_project(host):
    """Review P2: the signed manifest binds the object to a project;
    the request cannot declare a different one."""
    app, ctx, tmp_path = host
    shared, private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        _grant(ctx, "gm2", marta_confirm["person_id"], private, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}

        sealed = _seal_for(marta, marta, shared, b"progetto condiviso")
        denied = _publish(client, marta_peer, private, sealed)
        assert denied.status_code == 400, denied.text
        assert denied.json()["detail"]["reason"] == "object_transfer.declared_project_mismatch"
        assert not (tmp_path / "object-transfers" / "obj_listino").exists()


def test_v1_manifest_is_rejected_with_typed_error(host):
    """Review P2: v1 manifests (unsigned) are refused, typed."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}

        sealed = _seal_for(marta, marta, shared, b"payload v2")
        legacy = sealed.manifest.to_dict()
        legacy["protocol"] = "homun-object-transfer/v1"
        denied = client.post(
            "/v1/workspaces/ws_local/remote/objects",
            headers=marta_peer,
            json={"project_id": shared, "manifest": legacy},
        )
        assert denied.status_code == 400, denied.text
        assert denied.json()["detail"]["reason"] == "object_transfer.protocol_unsupported"


def test_announce_and_manifest_do_not_leak_plaintext_hash(host):
    """Review P4: plaintext_sha256 (and the exact size) must not travel in the
    object_transfer.published event — visible to every peer with a read grant,
    even without a wrap — nor in the cleartext manifest. The announce only
    carries a size rounded up to 64 KiB."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        giulia_confirm, _giulia = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", giulia_confirm["person_id"], shared, "read")
        peer = {"Authorization": f"Bearer {giulia_confirm['device_token']}"}

        plaintext = b"file noto\n" + b"z" * 200_000
        sealed = _seal_for(marta, _giulia, shared, plaintext)
        published = _publish(client, marta_peer, shared, sealed)
        assert published.status_code == 200, published.text

        page = client.get(
            f"/v1/workspaces/ws_local/remote/events?project_id={shared}&cursor=0",
            headers=peer,
        )
        announce = next(
            item
            for item in page.json()["items"]
            if item["type"] == "object_transfer.published"
        )
        assert "plaintext_sha256" not in announce["payload"]
        assert "plaintext_size" not in announce["payload"]
        assert announce["payload"]["approx_size_bytes"] % 65_536 == 0
        assert announce["payload"]["approx_size_bytes"] >= len(plaintext)
        assert announce["payload"]["approx_size_bytes"] - len(plaintext) <= 65_536

        manifest_resp = client.get(
            "/v1/workspaces/ws_local/remote/objects/obj_listino/versions/1",
            headers=peer,
        )
        assert manifest_resp.status_code == 200, manifest_resp.text
        assert "plaintext_sha256" not in manifest_resp.text
        assert "plaintext_size" not in manifest_resp.text

        snap = client.get(
            f"/v1/workspaces/ws_local/remote/snapshot?project_id={shared}",
            headers=peer,
        )
        assert "plaintext_sha256" not in snap.text
        assert "plaintext_size" not in snap.text

        meta_on_disk = (
            tmp_path / "object-transfers" / "obj_listino" / "v1" / "meta.json"
        ).read_text()
        assert "plaintext_sha256" not in meta_on_disk
        assert "plaintext_size" not in meta_on_disk


def test_manifest_size_limits_are_enforced_before_writing(host, monkeypatch):
    """Review P5: chunk count, chunk size and object size limits are
    validated on the manifest BEFORE anything is written to disk."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        _confirm, giulia = _pair_giulia(client, tmp_path)

        # Too many chunks.
        _set_limits(monkeypatch, MAX_CHUNKS_PER_OBJECT=3)
        sealed = _seal_for(marta, giulia, shared, b"x" * 4_096, object_id="obj_lim1")
        denied = _publish(client, marta_peer, shared, sealed)
        assert denied.status_code == 400, denied.text
        assert denied.json()["detail"]["reason"] == "object_transfer.too_many_chunks"
        assert not (tmp_path / "object-transfers" / "obj_lim1").exists()

        # Single chunk larger than the ceiling.
        _set_limits(monkeypatch, MAX_CHUNK_BYTES=1024, MAX_CHUNKS_PER_OBJECT=10_000)
        sealed = _seal_for(marta, giulia, shared, b"y" * 4_096, object_id="obj_lim2")
        denied = _publish(client, marta_peer, shared, sealed)
        assert denied.status_code == 400, denied.text
        assert denied.json()["detail"]["reason"] == "object_transfer.chunk_too_large"
        assert not (tmp_path / "object-transfers" / "obj_lim2").exists()

        # Whole object over the ceiling.
        _set_limits(
            monkeypatch,
            MAX_CHUNKS_PER_OBJECT=10_000,
            MAX_CHUNK_BYTES=1_048_576,
            MAX_OBJECT_BYTES=4_096,
        )
        sealed = _seal_for(marta, giulia, shared, b"z" * 8_192, object_id="obj_lim3")
        denied = _publish(client, marta_peer, shared, sealed)
        assert denied.status_code == 400, denied.text
        assert denied.json()["detail"]["reason"] == "object_transfer.object_too_large"
        assert not (tmp_path / "object-transfers" / "obj_lim3").exists()


def test_project_quota_is_enforced(host, monkeypatch):
    """Review P5: per-project quota refuses transfers that would
    exhaust the host disk, without writing files."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        _confirm, giulia = _pair_giulia(client, tmp_path)

        _set_limits(monkeypatch, MAX_PROJECT_BYTES=8_192, MAX_CHUNKS_PER_OBJECT=10_000)
        first = _seal_for(marta, giulia, shared, b"a" * 2_048, object_id="obj_q1")
        assert _publish(client, marta_peer, shared, first).status_code == 200
        second = _seal_for(marta, giulia, shared, b"b" * 8_192, object_id="obj_q2")
        denied = _publish(client, marta_peer, shared, second)
        assert denied.status_code == 400, denied.text
        assert denied.json()["detail"]["reason"] == "object_transfer.project_quota_exceeded"
        assert not (tmp_path / "object-transfers" / "obj_q2").exists()


def test_chunk_body_limit_is_enforced_before_reading(host, monkeypatch):
    """Review P5: an oversized chunk body is refused on Content-Length /
    while streaming, before it is stored."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        _confirm, giulia = _pair_giulia(client, tmp_path)

        _set_limits(monkeypatch, MAX_CHUNK_BYTES=None)
        sealed = _seal_for(marta, giulia, shared, b"payload", object_id="obj_body")
        assert _publish_manifest(
            client, marta_peer, shared, sealed.manifest.to_dict()
        ).status_code == 200

        _set_limits(monkeypatch, MAX_CHUNK_BYTES=64)
        denied = client.put(
            "/v1/workspaces/ws_local/remote/objects/obj_body/versions/1/chunks/0",
            headers={**marta_peer, "Content-Type": "application/octet-stream"},
            content=b"Q" * 2_048,
        )
        assert denied.status_code == 400, denied.text
        assert denied.json()["detail"]["reason"] == "object_transfer.chunk_too_large"
        assert not (
            tmp_path / "object-transfers" / "obj_body" / "v1" / "chunks" / "0.bin"
        ).exists()

        # JSON transport is capped too.
        denied_json = client.put(
            "/v1/workspaces/ws_local/remote/objects/obj_body/versions/1/chunks/0",
            headers={**marta_peer, "Content-Type": "application/json"},
            json={"ciphertext_b64": base64.b64encode(b"R" * 2_048).decode("ascii")},
        )
        assert denied_json.status_code == 400, denied_json.text
        assert denied_json.json()["detail"]["reason"] == "object_transfer.chunk_too_large"
        assert not (
            tmp_path / "object-transfers" / "obj_body" / "v1" / "chunks" / "0.bin"
        ).exists()
