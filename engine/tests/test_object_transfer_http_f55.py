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


def _pair_giulia(client: TestClient, tmp_path):
    identity = load_device_identity(tmp_path / "giulia_key.json")
    invite = client.post(
        "/v1/workspaces/ws_local/people/invites",
        headers=OWNER,
        json={"role": "member"},
    ).json()["token"]
    present = client.post(
        "/v1/remote/pair",
        json={
            "invite_token": invite,
            "display_name": "Giulia",
            "device_name": "MacBook di Giulia",
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


def _seal_for(identity, plaintext: bytes, *, object_id: str = "obj_listino", version: int = 1):
    return seal_object(
        plaintext,
        object_id=object_id,
        version=version,
        recipient_public_pems={identity.fingerprint: identity.public_pem},
        chunk_size=1024,
    )


def test_peer_resumes_sealed_transfer_after_partial_download(host):
    app, ctx, tmp_path = host
    shared, _private = _setup_shared(ctx)
    plaintext = b"listino riservato\n" + b"row\n" * 800
    with TestClient(app) as client:
        confirm, identity = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", confirm["person_id"], shared, "read")
        peer = {"Authorization": f"Bearer {confirm['device_token']}"}

        sealed = _seal_for(identity, plaintext)
        # Publish manifest first; upload all but the last chunk (host-side resume).
        published = client.post(
            "/v1/workspaces/ws_local/remote/objects",
            headers=OWNER,
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
                headers=OWNER,
                content=chunk,
            )
            assert put.status_code == 200, put.text
            assert put.json()["complete"] is False

        put_last = client.put(
            f"/v1/workspaces/ws_local/remote/objects/{sealed.manifest.object_id}"
            f"/versions/1/chunks/{len(sealed.ciphertext_chunks) - 1}",
            headers=OWNER,
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
        recovered = open_object(
            manifest_body["manifest"],
            ordered,
            recipient_private_pem=identity.private_pem,
            recipient_fingerprint=identity.fingerprint,
        )
        assert recovered == plaintext


def test_no_grant_and_no_wrap_are_denied(host):
    app, ctx, tmp_path = host
    shared, private = _setup_shared(ctx)
    with TestClient(app) as client:
        confirm, identity = _pair_giulia(client, tmp_path)
        peer = {"Authorization": f"Bearer {confirm['device_token']}"}
        sealed = _seal_for(identity, b"secret")
        chunks_b64 = [
            base64.b64encode(chunk).decode("ascii") for chunk in sealed.ciphertext_chunks
        ]
        assert (
            client.post(
                "/v1/workspaces/ws_local/remote/objects",
                headers=OWNER,
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

        _grant(ctx, "g1", confirm["person_id"], private, "read")
        # Grant on a different project does not open the shared transfer.
        still = client.get(
            "/v1/workspaces/ws_local/remote/objects/obj_listino/versions/1",
            headers=peer,
        )
        assert still.status_code == 403

        _grant(ctx, "g2", confirm["person_id"], shared, "read")
        # Stranger device: wrap is for Giulia only — publish a second object
        # sealed for a different key and grant Giulia read → no wrap.
        from homun.peers.device_identity import generate_device_keypair

        stranger = generate_device_keypair()
        foreign = seal_object(
            b"not for giulia",
            object_id="obj_foreign",
            version=1,
            recipient_public_pems={stranger.fingerprint: stranger.public_pem},
        )
        foreign_b64 = [
            base64.b64encode(chunk).decode("ascii") for chunk in foreign.ciphertext_chunks
        ]
        assert (
            client.post(
                "/v1/workspaces/ws_local/remote/objects",
                headers=OWNER,
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
        _confirm, identity = _pair_giulia(client, tmp_path)
        sealed = _seal_for(identity, b"payload")
        assert (
            client.post(
                "/v1/workspaces/ws_local/remote/objects",
                headers=OWNER,
                json={
                    "project_id": shared,
                    "manifest": sealed.manifest.to_dict(),
                },
            ).status_code
            == 200
        )
        bad = client.put(
            "/v1/workspaces/ws_local/remote/objects/obj_listino/versions/1/chunks/0",
            headers={**OWNER, "Content-Type": "application/octet-stream"},
            content=b"not-the-ciphertext",
        )
        assert bad.status_code == 400


def test_publish_announces_transfer_on_remote_event_cursor(host):
    """Peers with a grant see object_transfer.published after the snapshot cursor."""
    app, ctx, tmp_path = host
    shared, private = _setup_shared(ctx)
    with TestClient(app) as client:
        confirm, identity = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", confirm["person_id"], shared, "read")
        peer = {"Authorization": f"Bearer {confirm['device_token']}"}

        snap = client.get(
            f"/v1/workspaces/ws_local/remote/snapshot?project_id={shared}",
            headers=peer,
        )
        assert snap.status_code == 200
        cursor = snap.json()["cursor"]

        sealed = _seal_for(identity, b"annuncio via eventi")
        chunks_b64 = [
            base64.b64encode(chunk).decode("ascii") for chunk in sealed.ciphertext_chunks
        ]
        published = client.post(
            "/v1/workspaces/ws_local/remote/objects",
            headers=OWNER,
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
        assert announce["payload"]["plaintext_sha256"] == sealed.manifest.plaintext_sha256
        assert "wrapped_key" not in json.dumps(announce["payload"])
        assert "recipients" not in announce["payload"]

        # Private project feed must not carry the shared-project announce.
        denied_private = client.get(
            f"/v1/workspaces/ws_local/remote/events?project_id={private}&cursor=0",
            headers=peer,
        )
        assert denied_private.status_code == 403
