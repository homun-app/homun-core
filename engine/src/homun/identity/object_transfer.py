"""F5 fetta 5 — host-side store for resumable sealed object transfers.

Ciphertext and manifests live under the data directory. Peers fetch by chunk
index and resume after disconnect. Authorization: project grant plus a
confirmed device fingerprint listed as a recipient wrap. Credentials are
never stored here.

Publishing appends an `object_transfer.published` domain event on the project
aggregate so peers with a read grant see the announce on the remote event
cursor (snapshot listing remains the bootstrap path). New versions refuse
recipient wraps for revoked device fingerprints; already-downloaded copies
remain a declared UX limit.
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from typing import Any

from homun.domain.errors import DomainError, NotFoundError, PermissionDeniedError, ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, DomainEvent
from homun.peers.object_crypto import (
    ANNOUNCE_ALLOWED_KEYS,
    TRANSFER_META_ALLOWED_KEYS,
    TransferManifest,
    assert_no_credentials_in_transfer,
    missing_chunk_indices,
    verify_chunk,
)
from homun.policy import require_project_capability

_OBJECT_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")

EVENT_PUBLISHED = "object_transfer.published"


class ObjectTransferError(DomainError):
    code = "object_transfer_error"


def _root(data_dir: Path) -> Path:
    return Path(data_dir) / "object-transfers"


def _version_dir(data_dir: Path, object_id: str, version: int) -> Path:
    if not _OBJECT_ID_RE.fullmatch(object_id):
        raise ValidationError("Invalid object_id")
    if version < 1:
        raise ValidationError("version must be >= 1")
    return _root(data_dir) / object_id / f"v{version}"


def _meta_path(version_dir: Path) -> Path:
    return version_dir / "meta.json"


def _chunk_path(version_dir: Path, index: int) -> Path:
    return version_dir / "chunks" / f"{index}.bin"


def _read_meta(version_dir: Path) -> dict[str, Any]:
    path = _meta_path(version_dir)
    if not path.is_file():
        raise NotFoundError("Object version not found")
    return json.loads(path.read_text())


def _write_meta(version_dir: Path, meta: dict[str, Any]) -> None:
    version_dir.mkdir(parents=True, exist_ok=True)
    (version_dir / "chunks").mkdir(parents=True, exist_ok=True)
    tmp = _meta_path(version_dir).with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, indent=2, sort_keys=True))
    tmp.replace(_meta_path(version_dir))


def _person_device_fingerprints(store, person_id: str) -> set[str]:
    return {
        device.key_fingerprint
        for device in store.person_devices.values()
        if device.person_id == person_id
        and device.status == "confirmed"
        and device.key_fingerprint
    }


def _revoked_device_fingerprints(store) -> set[str]:
    return {
        device.key_fingerprint
        for device in store.person_devices.values()
        if device.status == "revoked" and device.key_fingerprint
    }


def _assert_no_revoked_recipient_wraps(store, manifest: TransferManifest) -> None:
    """New versions must not wrap keys for revoked devices (F5.3 revoke)."""
    revoked = _revoked_device_fingerprints(store)
    if not revoked:
        return
    blocked = [
        wrap.device_fingerprint
        for wrap in manifest.recipients
        if wrap.device_fingerprint in revoked
    ]
    if blocked:
        raise PermissionDeniedError(
            "Cannot wrap object key for revoked devices on new versions"
        )


def _require_recipient(store, actor: Actor, manifest: TransferManifest) -> None:
    fingerprints = _person_device_fingerprints(store, actor.id)
    recipient_fps = {wrap.device_fingerprint for wrap in manifest.recipients}
    if fingerprints.isdisjoint(recipient_fps):
        raise PermissionDeniedError("No recipient wrap for this person's devices")


def _present_indices(version_dir: Path, manifest: TransferManifest) -> list[int]:
    present: list[int] = []
    for descriptor in manifest.chunks:
        path = _chunk_path(version_dir, descriptor.index)
        if not path.is_file():
            continue
        try:
            verify_chunk(manifest, descriptor.index, path.read_bytes())
        except DomainError:
            continue
        present.append(descriptor.index)
    return present


def _present_blobs(version_dir: Path, manifest: TransferManifest) -> dict[int, bytes]:
    blobs: dict[int, bytes] = {}
    for descriptor in manifest.chunks:
        path = _chunk_path(version_dir, descriptor.index)
        if path.is_file():
            blobs[descriptor.index] = path.read_bytes()
    return blobs


def _transfer_status(version_dir: Path, manifest: TransferManifest) -> dict[str, Any]:
    present = _present_indices(version_dir, manifest)
    missing = missing_chunk_indices(manifest, _present_blobs(version_dir, manifest))
    return {
        "present_chunks": present,
        "missing_chunks": missing,
        "complete": len(missing) == 0,
        "chunk_count": len(manifest.chunks),
    }


def _announce_published(
    ctx,
    actor: Actor,
    *,
    project_id: str,
    manifest: TransferManifest,
) -> int:
    """Record a domain event so authorized peers see the transfer on the cursor."""
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            project = store.projects.get(project_id)
            if project is None or project.status == "archived":
                raise NotFoundError("Project not found")
            payload = {
                "project_id": project_id,
                "object_id": manifest.object_id,
                "version": manifest.version,
                "plaintext_size": manifest.plaintext_size,
                "plaintext_sha256": manifest.plaintext_sha256,
                "chunk_count": len(manifest.chunks),
            }
            assert_no_credentials_in_transfer(
                payload, allowed_keys=ANNOUNCE_ALLOWED_KEYS, label="announce"
            )
            event = DomainEvent(
                event_id=new_id("evt"),
                workspace_id=store.workspace_id,
                aggregate_id=project_id,
                aggregate_type="project",
                aggregate_version=project.version,
                sequence=store.next_sequence(),
                type=EVENT_PUBLISHED,
                actor_id=actor.id,
                command_id=new_id("cmd"),
                payload=payload,
            )
            store.events.append(event)
            sequence = event.sequence
        ctx.service.store = store
    return sequence


def publish_object(
    ctx,
    actor: Actor,
    *,
    project_id: str,
    manifest: dict[str, Any],
    chunks_b64: list[str] | None = None,
) -> dict[str, Any]:
    """Create or replace a sealed object version; optional bulk chunk upload."""
    store = ctx.repository.snapshot()
    require_project_capability(store, actor, project_id, "write")
    parsed = TransferManifest.from_dict(manifest)
    _assert_no_revoked_recipient_wraps(store, parsed)
    version_dir = _version_dir(ctx.data_dir, parsed.object_id, parsed.version)
    meta = {
        "project_id": project_id,
        "object_id": parsed.object_id,
        "version": parsed.version,
        "manifest": parsed.to_dict(),
    }
    assert_no_credentials_in_transfer(
        meta, allowed_keys=TRANSFER_META_ALLOWED_KEYS, label="transfer meta"
    )
    _write_meta(version_dir, meta)
    uploaded = 0
    if chunks_b64 is not None:
        if len(chunks_b64) != len(parsed.chunks):
            raise ValidationError("chunks_b64 length must match manifest.chunks")
        for index, encoded in enumerate(chunks_b64):
            try:
                blob = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as exc:
                raise ValidationError(f"Invalid base64 for chunk {index}") from exc
            put_chunk(ctx, actor, parsed.object_id, parsed.version, index, blob)
            uploaded += 1
    event_sequence = _announce_published(
        ctx, actor, project_id=project_id, manifest=parsed
    )
    status = _transfer_status(version_dir, parsed)
    return {
        "object_id": parsed.object_id,
        "version": parsed.version,
        "project_id": project_id,
        "uploaded_chunks": uploaded,
        "event_sequence": event_sequence,
        "event_type": EVENT_PUBLISHED,
        **status,
    }


def put_chunk(
    ctx,
    actor: Actor,
    object_id: str,
    version: int,
    index: int,
    ciphertext: bytes,
) -> dict[str, Any]:
    store = ctx.repository.snapshot()
    version_dir = _version_dir(ctx.data_dir, object_id, version)
    meta = _read_meta(version_dir)
    require_project_capability(store, actor, meta["project_id"], "write")
    manifest = TransferManifest.from_dict(meta["manifest"])
    verify_chunk(manifest, index, ciphertext)
    path = _chunk_path(version_dir, index)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(ciphertext)
    tmp.replace(path)
    status = _transfer_status(version_dir, manifest)
    return {
        "object_id": object_id,
        "version": version,
        "index": index,
        "size": len(ciphertext),
        **status,
    }


def get_manifest(ctx, actor: Actor, object_id: str, version: int) -> dict[str, Any]:
    store = ctx.repository.snapshot()
    version_dir = _version_dir(ctx.data_dir, object_id, version)
    meta = _read_meta(version_dir)
    require_project_capability(store, actor, meta["project_id"], "read")
    manifest = TransferManifest.from_dict(meta["manifest"])
    _require_recipient(store, actor, manifest)
    status = _transfer_status(version_dir, manifest)
    return {
        "project_id": meta["project_id"],
        "object_id": object_id,
        "version": version,
        "manifest": manifest.to_dict(),
        **status,
    }


def get_chunk(ctx, actor: Actor, object_id: str, version: int, index: int) -> bytes:
    store = ctx.repository.snapshot()
    version_dir = _version_dir(ctx.data_dir, object_id, version)
    meta = _read_meta(version_dir)
    require_project_capability(store, actor, meta["project_id"], "read")
    manifest = TransferManifest.from_dict(meta["manifest"])
    _require_recipient(store, actor, manifest)
    if index < 0 or index >= len(manifest.chunks):
        raise ValidationError("Chunk index out of range")
    path = _chunk_path(version_dir, index)
    if not path.is_file():
        raise NotFoundError("Chunk not uploaded yet")
    blob = path.read_bytes()
    verify_chunk(manifest, index, blob)
    return blob


def list_project_transfers(ctx, actor: Actor, project_id: str) -> list[dict[str, Any]]:
    """Summaries of sealed transfers in a project visible to this actor."""
    store = ctx.repository.snapshot()
    require_project_capability(store, actor, project_id, "read")
    root = _root(ctx.data_dir)
    if not root.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for object_dir in sorted(root.iterdir()):
        if not object_dir.is_dir():
            continue
        for version_dir in sorted(object_dir.iterdir()):
            if not version_dir.is_dir() or not version_dir.name.startswith("v"):
                continue
            meta_path = _meta_path(version_dir)
            if not meta_path.is_file():
                continue
            meta = json.loads(meta_path.read_text())
            if meta.get("project_id") != project_id:
                continue
            try:
                manifest = TransferManifest.from_dict(meta["manifest"])
                _require_recipient(store, actor, manifest)
            except DomainError:
                continue
            status = _transfer_status(version_dir, manifest)
            items.append({
                "object_id": meta["object_id"],
                "version": meta["version"],
                "plaintext_size": manifest.plaintext_size,
                "plaintext_sha256": manifest.plaintext_sha256,
                **status,
            })
    return items
