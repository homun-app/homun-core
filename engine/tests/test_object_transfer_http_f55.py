"""F5 fetta 5 — HTTP transfer routes on top of object_crypto.

Host publishes a sealed object; peer with grant + recipient wrap fetches
chunks and resumes after a partial download. No grant / no wrap → typed 403.
"""
from __future__ import annotations

import base64
import json

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.peers.device_identity import load_device_identity
from homun.peers.object_crypto import open_object, seal_object

LAUNCHER_TOKEN = "t" * 40
OWNER = {
    "X-Homun-Actor-Id": "person_fabio",
    "Authorization": f"Bearer {LAUNCHER_TOKEN}",
}


@pytest.fixture
def host(tmp_path):
    ctx = create_context(db_path=tmp_path / "host.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    app = create_app(session_token=LAUNCHER_TOKEN)
    yield app, ctx, tmp_path
    reset_context_for_tests(None)
    ctx.close()


def _apply_host(ctx, command_id, kind, payload):
    from homun.domain.models import Actor

    actor = Actor(id="person_fabio", workspace_id=ctx.workspace_id, display_name="Fabio")
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result


def _setup_shared(ctx):
    shared = _apply_host(ctx, "p1", "project.create", {"name": "Condiviso"})["project_id"]
    private = _apply_host(ctx, "p2", "project.create", {"name": "Privato"})["project_id"]
    return shared, private


def _pair_person(client: TestClient, tmp_path, name: str):
    identity = load_device_identity(tmp_path / f"{name.lower()}_key.json")
    invite = client.post(
        "/v1/workspaces/ws_local/people/invites",
        headers=OWNER,
        json={"role": "member"},
    ).json()["token"]
    present = client.post(
        "/v1/remote/pair",
        json={
            "invite_token": invite,
            "display_name": name,
            "device_name": f"MacBook di {name}",
            "public_key": identity.public_b64,
            "protocol_version": 1,
        },
    ).json()
    confirm = client.post(
        "/v1/remote/pair/confirm",
        json={
            "pairing_id": present["pairing_id"],
            "invite_token": invite,
            "signature": identity.sign(present["nonce"]),
        },
    ).json()
    assert confirm["person_id"]
    return confirm, identity


def _pair_giulia(client: TestClient, tmp_path):
    return _pair_person(client, tmp_path, "Giulia")


def _grant(ctx, command_id, person_id, project_id, capability="read"):
    _apply_host(
        ctx,
        command_id,
        "grant.issue",
        {
            "project_id": project_id,
            "subject_id": person_id,
            "capability": capability,
        },
    )


def _seal_for(publisher, recipient, project_id, plaintext, *, object_id="obj_listino", version=1):
    return seal_object(
        plaintext,
        project_id=project_id,
        object_id=object_id,
        version=version,
        recipient_public_pems={recipient.fingerprint: recipient.public_pem},
        publisher_identity=publisher,
        chunk_size=1024,
    )


def test_peer_resumes_sealed_transfer_after_partial_download(host):
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    plaintext = b"listino riservato\n" + b"row\n" * 800
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        giulia_confirm, giulia = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", giulia_confirm["person_id"], shared, "read")
        peer = {"Authorization": f"Bearer {giulia_confirm['device_token']}"}

        sealed = _seal_for(marta, giulia, shared, plaintext)
        # Publish manifest first; upload all but the last chunk (host-side resume).
        published = client.post(
            "/v1/workspaces/ws_local/remote/objects",
            headers=marta_peer,
            json={
                "project_id": shared,
                "manifest": sealed.manifest.to_dict(),
            },
        )
        assert published.status_code == 200, published.text
        assert published.json()["complete"] is False

        for index, chunk in enumerate(sealed.ciphertext_chunks[:-1]):
            put = client.put(
                f"/v1/workspaces/ws_local/remote/objects/{sealed.manifest.object_id}"
                f"/versions/1/chunks/{index}",
                headers=marta_peer,
                content=chunk,
            )
            assert put.status_code == 200, put.text
            assert put.json()["complete"] is False

        put_last = client.put(
            f"/v1/workspaces/ws_local/remote/objects/{sealed.manifest.object_id}"
            f"/versions/1/chunks/{len(sealed.ciphertext_chunks) - 1}",
            headers=marta_peer,
            content=sealed.ciphertext_chunks[-1],
        )
        assert put_last.status_code == 200, put_last.text
        assert put_last.json()["complete"] is True

        listed = client.get(
            f"/v1/workspaces/ws_local/remote/objects?project_id={shared}",
            headers=peer,
        )
        assert listed.status_code == 200
        assert listed.json()["items"][0]["object_id"] == "obj_listino"

        snap = client.get(
            f"/v1/workspaces/ws_local/remote/snapshot?project_id={shared}",
            headers=peer,
        )
        assert snap.status_code == 200
        assert any(
            item["object_id"] == "obj_listino"
            for item in snap.json()["object_transfers"]
        )
        # The replica snapshot carries the active devices of the project so
        # the recipient can verify publisher signatures (review P2).
        trusted = {
            device["key_fingerprint"]: base64.b64decode(device["public_key"])
            for device in snap.json()["devices"]
            if device["status"] == "confirmed" and device.get("public_key")
        }
        assert marta.fingerprint in trusted

        # Simulate resume: peer already has chunk 0 locally; asks host for missing.
        manifest_resp = client.get(
            "/v1/workspaces/ws_local/remote/objects/obj_listino/versions/1",
            headers=peer,
        )
        assert manifest_resp.status_code == 200, manifest_resp.text
        manifest_body = manifest_resp.json()
        assert manifest_body["complete"] is True
        assert manifest_body["missing_chunks"] == []

        local_chunks: dict[int, bytes] = {0: sealed.ciphertext_chunks[0]}
        for index in range(1, len(sealed.ciphertext_chunks)):
            chunk_resp = client.get(
                f"/v1/workspaces/ws_local/remote/objects/obj_listino/versions/1/chunks/{index}",
                headers=peer,
            )
            assert chunk_resp.status_code == 200
            assert chunk_resp.headers["content-type"].startswith("application/octet-stream")
            local_chunks[index] = chunk_resp.content

        ordered = [local_chunks[i] for i in range(len(sealed.ciphertext_chunks))]
        opened = open_object(
            manifest_body["manifest"],
            ordered,
            recipient_private_pem=giulia.private_pem,
            recipient_fingerprint=giulia.fingerprint,
            trusted_publisher_pems=trusted,
            expected_object_id="obj_listino",
            expected_version=1,
            expected_project_id=shared,
        )
        assert opened.plaintext == plaintext
        assert opened.publisher_fingerprint == marta.fingerprint


def test_no_grant_and_no_wrap_are_denied(host):
    app, ctx, tmp_path = host
    shared, private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        giulia_confirm, giulia = _pair_giulia(client, tmp_path)
        peer = {"Authorization": f"Bearer {giulia_confirm['device_token']}"}
        sealed = _seal_for(marta, giulia, shared, b"secret")
        chunks_b64 = [
            base64.b64encode(chunk).decode("ascii") for chunk in sealed.ciphertext_chunks
        ]
        assert (
            client.post(
                "/v1/workspaces/ws_local/remote/objects",
                headers=marta_peer,
                json={
                    "project_id": shared,
                    "manifest": sealed.manifest.to_dict(),
                    "chunks_b64": chunks_b64,
                },
            ).status_code
            == 200
        )

        # Paired but no grant on shared project.
        denied = client.get(
            "/v1/workspaces/ws_local/remote/objects/obj_listino/versions/1",
            headers=peer,
        )
        assert denied.status_code == 403

        _grant(ctx, "g1", giulia_confirm["person_id"], private, "read")
        # Grant on a different project does not open the shared transfer.
        still = client.get(
            "/v1/workspaces/ws_local/remote/objects/obj_listino/versions/1",
            headers=peer,
        )
        assert still.status_code == 403

        _grant(ctx, "g2", giulia_confirm["person_id"], shared, "read")
        # Stranger device: wrap is for Giulia only — publish a second object
        # sealed for a different key and grant Giulia read → no wrap.
        from homun.peers.device_identity import generate_device_keypair

        stranger = generate_device_keypair()
        foreign = seal_object(
            b"not for giulia",
            project_id=shared,
            object_id="obj_foreign",
            version=1,
            recipient_public_pems={stranger.fingerprint: stranger.public_pem},
            publisher_identity=marta,
        )
        foreign_b64 = [
            base64.b64encode(chunk).decode("ascii") for chunk in foreign.ciphertext_chunks
        ]
        assert (
            client.post(
                "/v1/workspaces/ws_local/remote/objects",
                headers=marta_peer,
                json={
                    "project_id": shared,
                    "manifest": foreign.manifest.to_dict(),
                    "chunks_b64": foreign_b64,
                },
            ).status_code
            == 200
        )
        no_wrap = client.get(
            "/v1/workspaces/ws_local/remote/objects/obj_foreign/versions/1",
            headers=peer,
        )
        assert no_wrap.status_code == 403


def test_corrupt_chunk_upload_rejected(host):
    app, ctx, tmp_path = host
    shared, _ = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        _confirm, giulia = _pair_giulia(client, tmp_path)
        sealed = _seal_for(marta, giulia, shared, b"payload")
        assert (
            client.post(
                "/v1/workspaces/ws_local/remote/objects",
                headers=marta_peer,
                json={
                    "project_id": shared,
                    "manifest": sealed.manifest.to_dict(),
                },
            ).status_code
            == 200
        )
        bad = client.put(
            "/v1/workspaces/ws_local/remote/objects/obj_listino/versions/1/chunks/0",
            headers={**marta_peer, "Content-Type": "application/octet-stream"},
            content=b"not-the-ciphertext",
        )
        assert bad.status_code == 400


def test_revoked_device_cannot_be_wrapped_on_new_versions(host):
    """After device revoke, publish rejects manifests that still wrap that device."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        giulia_confirm, giulia = _pair_giulia(client, tmp_path)

        v1 = _seal_for(marta, giulia, shared, b"pre-revoca", version=1)
        assert (
            client.post(
                "/v1/workspaces/ws_local/remote/objects",
                headers=marta_peer,
                json={
                    "project_id": shared,
                    "manifest": v1.manifest.to_dict(),
                    "chunks_b64": [
                        base64.b64encode(chunk).decode("ascii")
                        for chunk in v1.ciphertext_chunks
                    ],
                },
            ).status_code
            == 200
        )

        revoked = client.post(
            f"/v1/workspaces/ws_local/devices/{giulia_confirm['device_id']}/revoke",
            headers=OWNER,
        )
        assert revoked.status_code == 200, revoked.text

        v2 = _seal_for(marta, giulia, shared, b"post-revoca", version=2)
        denied = client.post(
            "/v1/workspaces/ws_local/remote/objects",
            headers=marta_peer,
            json={
                "project_id": shared,
                "manifest": v2.manifest.to_dict(),
                "chunks_b64": [
                    base64.b64encode(chunk).decode("ascii")
                    for chunk in v2.ciphertext_chunks
                ],
            },
        )
        assert denied.status_code == 403, denied.text
        detail = denied.json().get("detail") or {}
        assert detail.get("code") == "permission_denied"
        assert "revoked" in (detail.get("message") or "").lower()

        # Unknown fingerprint (never registered) is still publishable; only
        # known-revoked devices are blocked on new versions.
        from homun.peers.device_identity import generate_device_keypair

        other = generate_device_keypair()
        alternate = seal_object(
            b"altro destinatario",
            project_id=shared,
            object_id="obj_listino",
            version=2,
            recipient_public_pems={other.fingerprint: other.public_pem},
            publisher_identity=marta,
            chunk_size=1024,
        )
        ok = client.post(
            "/v1/workspaces/ws_local/remote/objects",
            headers=marta_peer,
            json={
                "project_id": shared,
                "manifest": alternate.manifest.to_dict(),
                "chunks_b64": [
                    base64.b64encode(chunk).decode("ascii")
                    for chunk in alternate.ciphertext_chunks
                ],
            },
        )
        assert ok.status_code == 200, ok.text


def test_publish_rejects_manifest_with_credential_fields(host):
    """Secret-store / credential keys must never travel in transfer JSON."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        _confirm, giulia = _pair_giulia(client, tmp_path)
        sealed = _seal_for(marta, giulia, shared, b"benign payload")
        tainted = sealed.manifest.to_dict()
        tainted["api_key"] = "sk-must-not-publish"
        denied = client.post(
            "/v1/workspaces/ws_local/remote/objects",
            headers=marta_peer,
            json={
                "project_id": shared,
                "manifest": tainted,
                "chunks_b64": [
                    base64.b64encode(chunk).decode("ascii")
                    for chunk in sealed.ciphertext_chunks
                ],
            },
        )
        assert denied.status_code == 400, denied.text
        detail = denied.json().get("detail") or {}
        assert detail.get("code") == "object_crypto_error"
        assert "credential" in (detail.get("message") or "").lower() or "unsupported" in (
            detail.get("message") or ""
        ).lower()


def test_secret_store_values_never_appear_in_transfer_artifacts(host):
    """Homun credentials stay in the secret store — not in transfer on-disk/API."""
    app, ctx, tmp_path = host
    marker = "sk-homun-transfer-leak-probe-9f3c2a1b"
    ctx.models.secrets.put("openai_api_key", marker)
    assert ctx.models.secrets.get("openai_api_key") == marker

    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        giulia_confirm, giulia = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", giulia_confirm["person_id"], shared, "read")
        peer = {"Authorization": f"Bearer {giulia_confirm['device_token']}"}

        sealed = _seal_for(marta, giulia, shared, b"catalogo senza segreti")
        chunks_b64 = [
            base64.b64encode(chunk).decode("ascii") for chunk in sealed.ciphertext_chunks
        ]
        published = client.post(
            "/v1/workspaces/ws_local/remote/objects",
            headers=marta_peer,
            json={
                "project_id": shared,
                "manifest": sealed.manifest.to_dict(),
                "chunks_b64": chunks_b64,
            },
        )
        assert published.status_code == 200, published.text

        manifest = client.get(
            "/v1/workspaces/ws_local/remote/objects/obj_listino/versions/1",
            headers=peer,
        )
        assert manifest.status_code == 200, manifest.text
        listing = client.get(
            f"/v1/workspaces/ws_local/remote/objects?project_id={shared}",
            headers=peer,
        )
        assert listing.status_code == 200, listing.text
        snap = client.get(
            f"/v1/workspaces/ws_local/remote/snapshot?project_id={shared}",
            headers=peer,
        )
        assert snap.status_code == 200, snap.text
        events = client.get(
            f"/v1/workspaces/ws_local/remote/events?project_id={shared}&cursor=0",
            headers=peer,
        )
        assert events.status_code == 200, events.text

        surfaces = [
            published.text,
            manifest.text,
            listing.text,
            snap.text,
            events.text,
            json.dumps(sealed.manifest.to_dict()),
        ]
        for path in (tmp_path / "object-transfers").rglob("*"):
            if path.is_file():
                surfaces.append(path.read_text(encoding="utf-8", errors="ignore"))
        joined = "\n".join(surfaces)
        assert marker not in joined
        assert "openai_api_key" not in joined
        assert "secret_store" not in joined


def _publish(client, headers, project_id, sealed):
    return _publish_manifest(
        client, headers, project_id, sealed.manifest.to_dict(), sealed.ciphertext_chunks
    )


def _publish_manifest(client, headers, project_id, manifest_dict, chunks=()):
    return client.post(
        "/v1/workspaces/ws_local/remote/objects",
        headers=headers,
        json={
            "project_id": project_id,
            "manifest": manifest_dict,
            "chunks_b64": [
                base64.b64encode(chunk).decode("ascii") for chunk in chunks
            ],
        },
    )


def _published_event_count(ctx) -> int:
    return sum(
        1
        for event in ctx.repository.snapshot().events
        if event.type == "object_transfer.published"
    )


def test_cross_project_object_hijack_is_rejected(host):
    """Security review P1: an object_id belongs to the project of its first
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
    """Security review P1: an existing version is never replaced; identical
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
    """Security review P1 verification: put_chunk authorizes on the project of
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


def test_publish_announces_transfer_on_remote_event_cursor(host):
    """Peers with a grant see object_transfer.published after the snapshot cursor."""
    app, ctx, tmp_path = host
    shared, private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        giulia_confirm, giulia = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", giulia_confirm["person_id"], shared, "read")
        peer = {"Authorization": f"Bearer {giulia_confirm['device_token']}"}

        snap = client.get(
            f"/v1/workspaces/ws_local/remote/snapshot?project_id={shared}",
            headers=peer,
        )
        assert snap.status_code == 200
        cursor = snap.json()["cursor"]

        sealed = _seal_for(marta, giulia, shared, b"annuncio via eventi")
        chunks_b64 = [
            base64.b64encode(chunk).decode("ascii") for chunk in sealed.ciphertext_chunks
        ]
        published = client.post(
            "/v1/workspaces/ws_local/remote/objects",
            headers=marta_peer,
            json={
                "project_id": shared,
                "manifest": sealed.manifest.to_dict(),
                "chunks_b64": chunks_b64,
            },
        )
        assert published.status_code == 200, published.text
        body = published.json()
        assert body["event_type"] == "object_transfer.published"
        assert body["event_sequence"] > cursor

        page = client.get(
            f"/v1/workspaces/ws_local/remote/events"
            f"?project_id={shared}&cursor={cursor}",
            headers=peer,
        )
        assert page.status_code == 200, page.text
        items = page.json()["items"]
        announce = next(
            (item for item in items if item["type"] == "object_transfer.published"),
            None,
        )
        assert announce is not None
        assert announce["aggregate_type"] == "project"
        assert announce["aggregate_id"] == shared
        assert announce["sequence"] == body["event_sequence"]
        assert announce["payload"]["object_id"] == "obj_listino"
        assert announce["payload"]["version"] == 1
        assert announce["payload"]["approx_size_bytes"] % 65_536 == 0
        assert "plaintext_sha256" not in announce["payload"]
        assert "plaintext_size" not in announce["payload"]
        assert "wrapped_key" not in json.dumps(announce["payload"])
        assert "recipients" not in announce["payload"]

        # Private project feed must not carry the shared-project announce.
        denied_private = client.get(
            f"/v1/workspaces/ws_local/remote/events?project_id={private}&cursor=0",
            headers=peer,
        )
        assert denied_private.status_code == 403


def test_publish_requires_publisher_signature_and_active_device(host):
    """Security review P2: the host verifies the manifest signature AND that
    the signing device is an active device of the requesting person."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        giulia_confirm, giulia = _pair_giulia(client, tmp_path)

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
        detail = denied_sig.json()["detail"]
        assert detail["reason"] == "object_transfer.publisher_signature_invalid"

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
        from homun.peers.object_crypto import canonical_manifest_bytes, unsigned_manifest_dict

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
    """Security review P2: the signed manifest binds the object to a project;
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
        detail = denied.json()["detail"]
        assert detail["reason"] == "object_transfer.declared_project_mismatch"
        assert not (tmp_path / "object-transfers" / "obj_listino").exists()


def test_v1_manifest_is_rejected_with_typed_error(host):
    """Security review P2: v1 manifests (unsigned) are refused, typed."""
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
        detail = denied.json()["detail"]
        assert detail["reason"] == "object_transfer.protocol_unsupported"


def test_announce_and_manifest_do_not_leak_plaintext_hash(host):
    """Security review P4: plaintext_sha256 (and the exact size) must not
    travel in the object_transfer.published event — visible to every peer
    with a read grant, even without a wrap — nor in the cleartext manifest.
    The announce only carries a size rounded up to 64 KiB."""
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    with TestClient(app) as client:
        marta_confirm, marta = _pair_person(client, tmp_path, "Marta")
        _grant(ctx, "gm", marta_confirm["person_id"], shared, "write")
        marta_peer = {"Authorization": f"Bearer {marta_confirm['device_token']}"}
        giulia_confirm, giulia = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", giulia_confirm["person_id"], shared, "read")
        peer = {"Authorization": f"Bearer {giulia_confirm['device_token']}"}

        plaintext = b"file noto\n" + b"z" * 200_000
        sealed = _seal_for(marta, giulia, shared, plaintext)
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
