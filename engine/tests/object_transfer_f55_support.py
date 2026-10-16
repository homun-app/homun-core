"""Shared fixtures and helpers for the F5.5 object-transfer HTTP tests."""
from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.peers.device_identity import load_device_identity
from homun.peers.object_crypto import seal_object

LAUNCHER_TOKEN = "t" * 40
OWNER = {
    "X-Homun-Actor-Id": "person_fabio",
    "Authorization": f"Bearer {LAUNCHER_TOKEN}",
}

PUBLISH_URL = "/v1/workspaces/ws_local/remote/objects"


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


def _publish(client, headers, project_id, sealed):
    return _publish_manifest(
        client, headers, project_id, sealed.manifest.to_dict(), sealed.ciphertext_chunks
    )


def _publish_manifest(client, headers, project_id, manifest_dict, chunks=()):
    body = {"project_id": project_id, "manifest": manifest_dict}
    if chunks:
        body["chunks_b64"] = [
            base64.b64encode(chunk).decode("ascii") for chunk in chunks
        ]
    return client.post(PUBLISH_URL, headers=headers, json=body)


def _published_event_count(ctx) -> int:
    return sum(
        1
        for event in ctx.repository.snapshot().events
        if event.type == "object_transfer.published"
    )


def _set_limits(monkeypatch, **overrides):
    """Set HOMUN_OBJECT_TRANSFER_* env overrides; None deletes the variable."""
    for name in (
        "MAX_CHUNK_BYTES",
        "MAX_CHUNKS_PER_OBJECT",
        "MAX_OBJECT_BYTES",
        "MAX_PROJECT_BYTES",
    ):
        if name not in overrides:
            monkeypatch.delenv(f"HOMUN_OBJECT_TRANSFER_{name}", raising=False)
    for name, value in overrides.items():
        if value is None:
            monkeypatch.delenv(f"HOMUN_OBJECT_TRANSFER_{name}", raising=False)
        else:
            monkeypatch.setenv(f"HOMUN_OBJECT_TRANSFER_{name}", str(value))
