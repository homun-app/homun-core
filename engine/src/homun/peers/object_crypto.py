"""F5 fetta 5 — object/version encryption and resumable transfer manifests.

Uses existing primitives only (libsodium via PyNaCl):
- Random 32-byte object key per object/version
- Sealed-box wrap of that key for each authorized device (Ed25519 → X25519)
- XChaCha20-Poly1305 secretstream for authenticated payload chunks
- Manifest with per-chunk ciphertext hashes for resume after disconnect
- v2: publisher-bound manifest — Ed25519 detached signature by the publishing
  device over the canonical (JCS-equivalent) unsigned manifest form

Credentials and workspace keys are never placed in a transfer. A relay that
sees ciphertext + manifest cannot decrypt without a recipient wrap.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Mapping, Sequence

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from nacl.bindings import (
    crypto_secretstream_xchacha20poly1305_HEADERBYTES,
    crypto_secretstream_xchacha20poly1305_KEYBYTES,
    crypto_secretstream_xchacha20poly1305_TAG_FINAL,
    crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    crypto_secretstream_xchacha20poly1305_init_pull,
    crypto_secretstream_xchacha20poly1305_init_push,
    crypto_secretstream_xchacha20poly1305_pull,
    crypto_secretstream_xchacha20poly1305_push,
    crypto_secretstream_xchacha20poly1305_state,
    crypto_sign_ed25519_pk_to_curve25519,
    crypto_sign_ed25519_sk_to_curve25519,
)
from nacl.exceptions import CryptoError
from nacl.public import PrivateKey, PublicKey, SealedBox

from homun.domain.errors import DomainError
from homun.peers.device_identity import DeviceIdentity, key_fingerprint

PROTOCOL_ID = "homun-object-transfer/v2"
DEFAULT_CHUNK_SIZE = 65_536
OBJECT_KEY_BYTES = crypto_secretstream_xchacha20poly1305_KEYBYTES
# Review P4: announce events only carry a size rounded up to this granularity,
# so peers with a read grant cannot confirm an exact known-file size.
ANNOUNCE_SIZE_GRANULARITY = 64 * 1024

MANIFEST_ALLOWED_KEYS = frozenset({
    "protocol",
    "project_id",
    "object_id",
    "version",
    "chunk_size",
    "header_b64",
    "chunks",
    "recipients",
    "publisher_fingerprint",
    "publisher_signature_b64",
})
CHUNK_ALLOWED_KEYS = frozenset({"index", "sha256", "size"})
RECIPIENT_ALLOWED_KEYS = frozenset({"device_fingerprint", "wrapped_key_b64"})
ANNOUNCE_ALLOWED_KEYS = frozenset({
    "project_id",
    "object_id",
    "version",
    "approx_size_bytes",
    "chunk_count",
})
TRANSFER_META_ALLOWED_KEYS = frozenset({
    "project_id",
    "object_id",
    "version",
    "manifest",
    "event_sequence",
})

# Defense in depth: refuse credential / secret-store field names even if a
# future schema change widens an allowlist by mistake.
_CREDENTIAL_FIELD_NAMES = frozenset({
    "access_token",
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "client_secret",
    "credential",
    "credentials",
    "openai_api_key",
    "password",
    "passwd",
    "private_key",
    "refresh_token",
    "secret",
    "secrets",
    "secret_store",
    "token",
    "workspace_key",
})


class ObjectCryptoError(DomainError):
    code = "object_crypto_error"


def assert_no_credentials_in_transfer(
    data: Mapping,
    *,
    allowed_keys: frozenset[str],
    label: str,
) -> None:
    """Fail closed if transfer JSON carries credential / secret-store fields.

    Object transfers may only use an allowlisted schema. Homun's secret store
    and workspace keys must never appear in manifests, meta, or announce events.
    """
    if not isinstance(data, Mapping):
        raise ObjectCryptoError(f"{label} must be an object")
    unknown = sorted(str(key) for key in data if str(key) not in allowed_keys)
    if unknown:
        raise ObjectCryptoError(f"Unsupported {label} fields: {', '.join(unknown)}")
    for key in data:
        key_l = str(key).lower()
        if key_l in _CREDENTIAL_FIELD_NAMES or key_l.endswith(
            ("_secret", "_password", "_api_key")
        ):
            raise ObjectCryptoError(
                f"Credentials must not appear in object transfers ({label}.{key})"
            )


@dataclass(frozen=True)
class ChunkDescriptor:
    index: int
    sha256: str
    size: int

    def to_dict(self) -> dict:
        return {"index": self.index, "sha256": self.sha256, "size": self.size}

    @classmethod
    def from_dict(cls, data: Mapping) -> ChunkDescriptor:
        assert_no_credentials_in_transfer(
            data, allowed_keys=CHUNK_ALLOWED_KEYS, label="chunk"
        )
        return cls(index=int(data["index"]), sha256=str(data["sha256"]), size=int(data["size"]))


@dataclass(frozen=True)
class RecipientWrap:
    device_fingerprint: str
    wrapped_key_b64: str

    def to_dict(self) -> dict:
        return {
            "device_fingerprint": self.device_fingerprint,
            "wrapped_key_b64": self.wrapped_key_b64,
        }

    @classmethod
    def from_dict(cls, data: Mapping) -> RecipientWrap:
        assert_no_credentials_in_transfer(
            data, allowed_keys=RECIPIENT_ALLOWED_KEYS, label="recipient"
        )
        return cls(
            device_fingerprint=str(data["device_fingerprint"]),
            wrapped_key_b64=str(data["wrapped_key_b64"]),
        )


def _required(data: Mapping, key: str, label: str) -> object:
    if key not in data:
        raise ObjectCryptoError(
            f"{label} field is required: {key}",
            reason="object_transfer.manifest_field_missing",
        )
    return data[key]


@dataclass(frozen=True)
class TransferManifest:
    """Resumable transfer description. Ciphertext lives beside the manifest.

    v2 binds the manifest to one publisher: `publisher_fingerprint` names the
    signing device and `publisher_signature_b64` is its detached Ed25519
    signature over the canonical form of the manifest without the signature.
    """

    protocol: str
    project_id: str
    object_id: str
    version: int
    chunk_size: int
    header_b64: str
    chunks: tuple[ChunkDescriptor, ...]
    recipients: tuple[RecipientWrap, ...]
    publisher_fingerprint: str
    publisher_signature_b64: str

    def ciphertext_size(self) -> int:
        return sum(chunk.size for chunk in self.chunks)

    def approx_size_bytes(self) -> int:
        """Announce-safe size: ciphertext total rounded up to 64 KiB."""
        return rounded_size_bytes(self.ciphertext_size())

    def to_dict(self) -> dict:
        return {
            "protocol": self.protocol,
            "project_id": self.project_id,
            "object_id": self.object_id,
            "version": self.version,
            "chunk_size": self.chunk_size,
            "header_b64": self.header_b64,
            "chunks": [chunk.to_dict() for chunk in self.chunks],
            "recipients": [wrap.to_dict() for wrap in self.recipients],
            "publisher_fingerprint": self.publisher_fingerprint,
            "publisher_signature_b64": self.publisher_signature_b64,
        }

    @classmethod
    def from_dict(cls, data: Mapping) -> TransferManifest:
        assert_no_credentials_in_transfer(
            data, allowed_keys=MANIFEST_ALLOWED_KEYS, label="manifest"
        )
        if data.get("protocol") != PROTOCOL_ID:
            raise ObjectCryptoError(
                f"Unsupported object-transfer protocol: {data.get('protocol')!r}",
                reason="object_transfer.protocol_unsupported",
            )
        chunks = tuple(ChunkDescriptor.from_dict(item) for item in data.get("chunks", []))
        recipients = tuple(
            RecipientWrap.from_dict(item) for item in data.get("recipients", [])
        )
        return cls(
            protocol=PROTOCOL_ID,
            project_id=str(_required(data, "project_id", "manifest")),
            object_id=str(_required(data, "object_id", "manifest")),
            version=int(_required(data, "version", "manifest")),
            chunk_size=int(_required(data, "chunk_size", "manifest")),
            header_b64=str(_required(data, "header_b64", "manifest")),
            chunks=chunks,
            recipients=recipients,
            publisher_fingerprint=str(_required(data, "publisher_fingerprint", "manifest")),
            publisher_signature_b64=str(_required(data, "publisher_signature_b64", "manifest")),
        )


def rounded_size_bytes(total: int, granularity: int = ANNOUNCE_SIZE_GRANULARITY) -> int:
    """Round a byte size up to a multiple of granularity (review P4)."""
    if granularity < 1:
        raise ObjectCryptoError("Size granularity must be positive")
    return ((total + granularity - 1) // granularity) * granularity


def canonical_manifest_bytes(unsigned_manifest: Mapping) -> bytes:
    """Canonical encoding of the unsigned manifest (JCS-equivalent subset).

    UTF-8 JSON with lexicographically sorted object keys, no whitespace and
    Python-default integer formatting (decimal digits, no leading zeros —
    Python never emits them). Strings keep their characters; JSON escaping is
    the minimal one of json.dumps with ensure_ascii=False. The same function
    runs on both sides, so sender and verifier agree byte for byte.
    """
    return json.dumps(
        unsigned_manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def unsigned_manifest_dict(manifest: TransferManifest | Mapping) -> dict:
    """The manifest form covered by the publisher signature."""
    data = manifest.to_dict() if isinstance(manifest, TransferManifest) else dict(manifest)
    data.pop("publisher_signature_b64", None)
    return data


def sign_manifest(unsigned_manifest: Mapping, publisher: DeviceIdentity) -> str:
    return publisher.sign(canonical_manifest_bytes(unsigned_manifest))


def verify_manifest_signature(
    manifest: TransferManifest, publisher_public_pem: bytes
) -> None:
    """Fail closed unless the manifest signature comes from the device named
    by publisher_fingerprint (the PEM must be that device's registered key)."""
    try:
        if key_fingerprint(publisher_public_pem) != manifest.publisher_fingerprint:
            raise ValueError("public key does not match publisher_fingerprint")
        signature = base64.b64decode(manifest.publisher_signature_b64, validate=True)
        public = serialization.load_pem_public_key(publisher_public_pem)
        if not isinstance(public, Ed25519PublicKey):
            raise ValueError("publisher key must be Ed25519")
        public.verify(signature, canonical_manifest_bytes(unsigned_manifest_dict(manifest)))
    except ObjectCryptoError:
        raise
    except Exception as exc:
        raise ObjectCryptoError(
            "Manifest publisher signature is not valid",
            reason="object_transfer.publisher_signature_invalid",
        ) from exc


@dataclass(frozen=True)
class SealedObject:
    manifest: TransferManifest
    ciphertext_chunks: tuple[bytes, ...]


@dataclass(frozen=True)
class OpenedObject:
    """Decrypted payload plus the verified identity of who published it."""

    plaintext: bytes
    publisher_fingerprint: str


def generate_object_key() -> bytes:
    return secrets.token_bytes(OBJECT_KEY_BYTES)


def _ed25519_raw_public(public_pem: bytes) -> bytes:
    public = serialization.load_pem_public_key(public_pem)
    if not isinstance(public, Ed25519PublicKey):
        raise ObjectCryptoError("Recipient public key must be Ed25519")
    return public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def _ed25519_raw_secret(private_pem: bytes) -> bytes:
    private = serialization.load_pem_private_key(private_pem, password=None)
    if not isinstance(private, Ed25519PrivateKey):
        raise ObjectCryptoError("Device private key must be Ed25519")
    seed = private.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    return seed + public


def _curve_public_from_pem(public_pem: bytes) -> PublicKey:
    return PublicKey(crypto_sign_ed25519_pk_to_curve25519(_ed25519_raw_public(public_pem)))


def _curve_private_from_pem(private_pem: bytes) -> PrivateKey:
    return PrivateKey(crypto_sign_ed25519_sk_to_curve25519(_ed25519_raw_secret(private_pem)))


def wrap_object_key(object_key: bytes, recipient_public_pem: bytes) -> bytes:
    if len(object_key) != OBJECT_KEY_BYTES:
        raise ObjectCryptoError("Object key must be 32 bytes")
    try:
        return SealedBox(_curve_public_from_pem(recipient_public_pem)).encrypt(object_key)
    except (TypeError, ValueError, CryptoError) as exc:
        raise ObjectCryptoError("Cannot wrap object key for recipient") from exc


def unwrap_object_key(wrapped_key: bytes, recipient_private_pem: bytes) -> bytes:
    try:
        key = SealedBox(_curve_private_from_pem(recipient_private_pem)).decrypt(wrapped_key)
    except (TypeError, ValueError, CryptoError) as exc:
        raise ObjectCryptoError("Cannot unwrap object key for this device") from exc
    if len(key) != OBJECT_KEY_BYTES:
        raise ObjectCryptoError("Unwrapped object key has unexpected length")
    return key


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class ChunkAadContext:
    """Values bound into every secretstream chunk (review P3).

    The AAD is rebuilt on the recipient side from the values it EXPECTS (the
    ones it asked for), never from the received manifest, so ciphertext
    cannot be replayed under another object, project or version.
    """

    protocol: str
    project_id: str
    object_id: str
    version: int

    def for_chunk(self, index: int) -> bytes:
        """Canonical-JSON encoding of the binding — unambiguous (verifica F):
        field values cannot inject a separator, whatever characters they
        carry, so distinct (project, object, version, index) tuples always
        produce distinct additional data."""
        return canonical_manifest_bytes({
            "protocol": self.protocol,
            "project_id": self.project_id,
            "object_id": self.object_id,
            "version": self.version,
            "chunk": index,
        })


def encrypt_payload(
    plaintext: bytes,
    object_key: bytes,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    aad_context: ChunkAadContext,
) -> tuple[bytes, list[bytes]]:
    if len(object_key) != OBJECT_KEY_BYTES:
        raise ObjectCryptoError("Object key must be 32 bytes")
    if chunk_size < 1:
        raise ObjectCryptoError("Chunk size must be positive")

    def _push(state, piece: bytes, tag: int, index: int) -> bytes:
        return crypto_secretstream_xchacha20poly1305_push(
            state, piece, aad_context.for_chunk(index), tag
        )

    state = crypto_secretstream_xchacha20poly1305_state()
    header = crypto_secretstream_xchacha20poly1305_init_push(state, object_key)
    if len(header) != crypto_secretstream_xchacha20poly1305_HEADERBYTES:
        raise ObjectCryptoError("Unexpected secretstream header size")
    if not plaintext:
        final = _push(state, b"", crypto_secretstream_xchacha20poly1305_TAG_FINAL, 0)
        return header, [final]
    chunks: list[bytes] = []
    offset = 0
    while offset < len(plaintext):
        end = min(offset + chunk_size, len(plaintext))
        piece = plaintext[offset:end]
        offset = end
        tag = (
            crypto_secretstream_xchacha20poly1305_TAG_FINAL
            if offset >= len(plaintext)
            else crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
        )
        chunks.append(_push(state, piece, tag, len(chunks)))
    return header, chunks


def decrypt_payload(
    header: bytes,
    ciphertext_chunks: Sequence[bytes],
    object_key: bytes,
    *,
    aad_context: ChunkAadContext,
) -> bytes:
    if len(object_key) != OBJECT_KEY_BYTES:
        raise ObjectCryptoError("Object key must be 32 bytes")
    if not ciphertext_chunks:
        raise ObjectCryptoError("Ciphertext stream is empty")
    state = crypto_secretstream_xchacha20poly1305_state()
    try:
        crypto_secretstream_xchacha20poly1305_init_pull(state, header, object_key)
    except (TypeError, ValueError, CryptoError) as exc:
        raise ObjectCryptoError("Invalid secretstream header or key") from exc
    parts: list[bytes] = []
    for index, chunk in enumerate(ciphertext_chunks):
        try:
            message, tag = crypto_secretstream_xchacha20poly1305_pull(
                state, chunk, aad_context.for_chunk(index)
            )
        except (TypeError, ValueError, CryptoError) as exc:
            raise ObjectCryptoError(
                "Ciphertext rejected (corrupt, truncated or bound to another object)"
            ) from exc
        parts.append(message)
        is_last = index == len(ciphertext_chunks) - 1
        if is_last and tag != crypto_secretstream_xchacha20poly1305_TAG_FINAL:
            raise ObjectCryptoError("Ciphertext stream missing final tag")
        if not is_last and tag == crypto_secretstream_xchacha20poly1305_TAG_FINAL:
            raise ObjectCryptoError("Ciphertext stream ended early")
    return b"".join(parts)


def seal_object(
    plaintext: bytes,
    *,
    project_id: str,
    object_id: str,
    version: int,
    recipient_public_pems: Mapping[str, bytes],
    publisher_identity: DeviceIdentity,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    object_key: bytes | None = None,
) -> SealedObject:
    """Encrypt plaintext for the given device fingerprints and sign the
    manifest with the publishing device's key (protocol v2)."""
    if not project_id:
        raise ObjectCryptoError("project_id is required")
    if not object_id:
        raise ObjectCryptoError("object_id is required")
    if version < 1:
        raise ObjectCryptoError("version must be >= 1")
    if not recipient_public_pems:
        raise ObjectCryptoError("At least one recipient is required")
    key = object_key if object_key is not None else generate_object_key()
    aad_context = ChunkAadContext(
        protocol=PROTOCOL_ID,
        project_id=project_id,
        object_id=object_id,
        version=version,
    )
    header, cipher_chunks = encrypt_payload(
        plaintext, key, chunk_size=chunk_size, aad_context=aad_context
    )
    wraps: list[RecipientWrap] = []
    for fingerprint, public_pem in recipient_public_pems.items():
        expected = key_fingerprint(public_pem)
        if fingerprint != expected:
            raise ObjectCryptoError("Recipient fingerprint does not match public key")
        wrapped = wrap_object_key(key, public_pem)
        wraps.append(
            RecipientWrap(
                device_fingerprint=fingerprint,
                wrapped_key_b64=base64.b64encode(wrapped).decode("ascii"),
            )
        )
    descriptors = tuple(
        ChunkDescriptor(index=index, sha256=_sha256_hex(chunk), size=len(chunk))
        for index, chunk in enumerate(cipher_chunks)
    )
    manifest = TransferManifest(
        protocol=PROTOCOL_ID,
        project_id=project_id,
        object_id=object_id,
        version=version,
        chunk_size=chunk_size,
        header_b64=base64.b64encode(header).decode("ascii"),
        chunks=descriptors,
        recipients=tuple(wraps),
        publisher_fingerprint=publisher_identity.fingerprint,
        publisher_signature_b64="",
    )
    signature = sign_manifest(unsigned_manifest_dict(manifest), publisher_identity)
    manifest = replace(manifest, publisher_signature_b64=signature)
    return SealedObject(manifest=manifest, ciphertext_chunks=tuple(cipher_chunks))


def verify_chunk(manifest: TransferManifest, index: int, ciphertext: bytes) -> None:
    if index < 0 or index >= len(manifest.chunks):
        raise ObjectCryptoError("Chunk index out of range")
    expected = manifest.chunks[index]
    if len(ciphertext) != expected.size or _sha256_hex(ciphertext) != expected.sha256:
        raise ObjectCryptoError("Chunk hash mismatch")


def missing_chunk_indices(
    manifest: TransferManifest,
    present: Mapping[int, bytes],
) -> list[int]:
    """Return indices still needed. Present chunks must match the manifest hash."""
    missing: list[int] = []
    for descriptor in manifest.chunks:
        blob = present.get(descriptor.index)
        if blob is None:
            missing.append(descriptor.index)
            continue
        try:
            verify_chunk(manifest, descriptor.index, blob)
        except ObjectCryptoError:
            missing.append(descriptor.index)
    return missing


def open_object(
    manifest: TransferManifest | Mapping,
    ciphertext_chunks: Sequence[bytes],
    *,
    recipient_private_pem: bytes,
    recipient_fingerprint: str,
    trusted_publisher_pems: Mapping[str, bytes],
    expected_object_id: str,
    expected_version: int,
    expected_project_id: str,
    last_opened_version: int | None = None,
) -> OpenedObject:
    """Decrypt a sealed object for one authorized device.

    Security review P3: the recipient states the values it asked for
    (object, version, project); the manifest must match them and the
    secretstream additional data is rebuilt from THOSE values, so chunks
    cannot be replayed across objects or versions. `last_opened_version`
    (the recipient's own record, see ReceivedVersionLog) refuses anything
    older than what was already opened.

    The recipient only trusts publisher keys it knows from its replica
    snapshot: the manifest signature must verify against the key registered
    for `publisher_fingerprint`, otherwise the transfer is refused.
    """
    parsed = (
        manifest
        if isinstance(manifest, TransferManifest)
        else TransferManifest.from_dict(manifest)
    )
    if (
        parsed.object_id != expected_object_id
        or parsed.version != expected_version
        or parsed.project_id != expected_project_id
    ):
        raise ObjectCryptoError(
            "Manifest does not match the requested object, version or project",
            reason="object_transfer.manifest_mismatch",
        )
    if last_opened_version is not None and expected_version < last_opened_version:
        raise ObjectCryptoError(
            f"Version {expected_version} is older than the already opened"
            f" {last_opened_version} (possible rollback)",
            reason="object_transfer.version_rollback",
        )
    publisher_pem = trusted_publisher_pems.get(parsed.publisher_fingerprint)
    if publisher_pem is None:
        raise ObjectCryptoError(
            "Publisher device is not known or not active in the replica snapshot",
            reason="object_transfer.publisher_not_trusted",
        )
    verify_manifest_signature(parsed, publisher_pem)
    wrap = next(
        (
            item
            for item in parsed.recipients
            if item.device_fingerprint == recipient_fingerprint
        ),
        None,
    )
    if wrap is None:
        raise ObjectCryptoError("No wrapped key for this device")
    if len(ciphertext_chunks) != len(parsed.chunks):
        raise ObjectCryptoError("Incomplete ciphertext stream")
    for index, chunk in enumerate(ciphertext_chunks):
        verify_chunk(parsed, index, chunk)
    try:
        wrapped = base64.b64decode(wrap.wrapped_key_b64, validate=True)
        header = base64.b64decode(parsed.header_b64, validate=True)
    except (ValueError, TypeError) as exc:
        raise ObjectCryptoError("Manifest encoding is invalid") from exc
    object_key = unwrap_object_key(wrapped, recipient_private_pem)
    aad_context = ChunkAadContext(
        protocol=PROTOCOL_ID,
        project_id=expected_project_id,
        object_id=expected_object_id,
        version=expected_version,
    )
    plaintext = decrypt_payload(
        header, ciphertext_chunks, object_key, aad_context=aad_context
    )
    # Integrity is guaranteed by AEAD (secretstream) + the publisher signature
    # over the chunk ciphertext hashes; the plaintext hash never travels.
    return OpenedObject(
        plaintext=plaintext, publisher_fingerprint=parsed.publisher_fingerprint
    )


class ReceivedVersionLog:
    """Recipient-side record of the highest version opened per object.

    Feed `last_version` into open_object's last_opened_version and call
    `record` after a successful open: a host serving an older manifest is
    then refused (review P3 rollback protection).

    Fail-closed (verifica E): a corrupt or malformed log raises a typed
    `object_transfer.version_log_corrupt` — restarting silently from `{}`
    would disable rollback protection, so nothing is decrypted until the
    operator restores or removes the file.
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._versions: dict[str, int] = {}
        if not self._path.is_file():
            return
        corrupt = ObjectCryptoError(
            "Received-version log is corrupt; refusing to decrypt until"
            " it is restored or removed",
            reason="object_transfer.version_log_corrupt",
        )
        try:
            loaded = json.loads(self._path.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            raise corrupt from exc
        if not isinstance(loaded, dict):
            raise corrupt
        try:
            self._versions = {str(key): int(value) for key, value in loaded.items()}
        except (TypeError, ValueError) as exc:
            raise corrupt from exc

    def last_version(self, object_id: str) -> int | None:
        return self._versions.get(object_id)

    def record(self, object_id: str, version: int) -> None:
        current = self._versions.get(object_id)
        if current is not None and version <= current:
            return
        self._versions[object_id] = version
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self._versions, sort_keys=True, indent=2), encoding="utf-8"
        )
        tmp.replace(self._path)
