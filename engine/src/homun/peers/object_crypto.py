"""F5 fetta 5 — object/version encryption and resumable transfer manifests.

Uses existing primitives only (libsodium via PyNaCl):
- Random 32-byte object key per object/version
- Sealed-box wrap of that key for each authorized device (Ed25519 → X25519)
- XChaCha20-Poly1305 secretstream for authenticated payload chunks
- Manifest with per-chunk ciphertext hashes for resume after disconnect

Credentials and workspace keys are never placed in a transfer. A relay that
sees ciphertext + manifest cannot decrypt without a recipient wrap.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
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
from homun.peers.device_identity import key_fingerprint

PROTOCOL_ID = "homun-object-transfer/v1"
DEFAULT_CHUNK_SIZE = 65_536
OBJECT_KEY_BYTES = crypto_secretstream_xchacha20poly1305_KEYBYTES


class ObjectCryptoError(DomainError):
    code = "object_crypto_error"


@dataclass(frozen=True)
class ChunkDescriptor:
    index: int
    sha256: str
    size: int

    def to_dict(self) -> dict:
        return {"index": self.index, "sha256": self.sha256, "size": self.size}

    @classmethod
    def from_dict(cls, data: Mapping) -> ChunkDescriptor:
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
        return cls(
            device_fingerprint=str(data["device_fingerprint"]),
            wrapped_key_b64=str(data["wrapped_key_b64"]),
        )


@dataclass(frozen=True)
class TransferManifest:
    """Resumable transfer description. Ciphertext lives beside the manifest."""

    protocol: str
    object_id: str
    version: int
    plaintext_sha256: str
    plaintext_size: int
    chunk_size: int
    header_b64: str
    chunks: tuple[ChunkDescriptor, ...]
    recipients: tuple[RecipientWrap, ...]

    def to_dict(self) -> dict:
        return {
            "protocol": self.protocol,
            "object_id": self.object_id,
            "version": self.version,
            "plaintext_sha256": self.plaintext_sha256,
            "plaintext_size": self.plaintext_size,
            "chunk_size": self.chunk_size,
            "header_b64": self.header_b64,
            "chunks": [chunk.to_dict() for chunk in self.chunks],
            "recipients": [wrap.to_dict() for wrap in self.recipients],
        }

    @classmethod
    def from_dict(cls, data: Mapping) -> TransferManifest:
        if data.get("protocol") != PROTOCOL_ID:
            raise ObjectCryptoError("Unsupported object-transfer protocol")
        chunks = tuple(ChunkDescriptor.from_dict(item) for item in data.get("chunks", []))
        recipients = tuple(
            RecipientWrap.from_dict(item) for item in data.get("recipients", [])
        )
        return cls(
            protocol=PROTOCOL_ID,
            object_id=str(data["object_id"]),
            version=int(data["version"]),
            plaintext_sha256=str(data["plaintext_sha256"]),
            plaintext_size=int(data["plaintext_size"]),
            chunk_size=int(data["chunk_size"]),
            header_b64=str(data["header_b64"]),
            chunks=chunks,
            recipients=recipients,
        )


@dataclass(frozen=True)
class SealedObject:
    manifest: TransferManifest
    ciphertext_chunks: tuple[bytes, ...]


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


def encrypt_payload(
    plaintext: bytes,
    object_key: bytes,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> tuple[bytes, list[bytes]]:
    if len(object_key) != OBJECT_KEY_BYTES:
        raise ObjectCryptoError("Object key must be 32 bytes")
    if chunk_size < 1:
        raise ObjectCryptoError("Chunk size must be positive")
    state = crypto_secretstream_xchacha20poly1305_state()
    header = crypto_secretstream_xchacha20poly1305_init_push(state, object_key)
    if len(header) != crypto_secretstream_xchacha20poly1305_HEADERBYTES:
        raise ObjectCryptoError("Unexpected secretstream header size")
    if not plaintext:
        final = crypto_secretstream_xchacha20poly1305_push(
            state, b"", None, crypto_secretstream_xchacha20poly1305_TAG_FINAL
        )
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
        chunks.append(crypto_secretstream_xchacha20poly1305_push(state, piece, None, tag))
    return header, chunks


def decrypt_payload(header: bytes, ciphertext_chunks: Sequence[bytes], object_key: bytes) -> bytes:
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
            message, tag = crypto_secretstream_xchacha20poly1305_pull(state, chunk, None)
        except (TypeError, ValueError, CryptoError) as exc:
            raise ObjectCryptoError("Ciphertext rejected (corrupt or truncated)") from exc
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
    object_id: str,
    version: int,
    recipient_public_pems: Mapping[str, bytes],
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    object_key: bytes | None = None,
) -> SealedObject:
    """Encrypt plaintext for the given device fingerprints (public PEMs)."""
    if not object_id:
        raise ObjectCryptoError("object_id is required")
    if version < 1:
        raise ObjectCryptoError("version must be >= 1")
    if not recipient_public_pems:
        raise ObjectCryptoError("At least one recipient is required")
    key = object_key if object_key is not None else generate_object_key()
    header, cipher_chunks = encrypt_payload(plaintext, key, chunk_size=chunk_size)
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
        object_id=object_id,
        version=version,
        plaintext_sha256=_sha256_hex(plaintext),
        plaintext_size=len(plaintext),
        chunk_size=chunk_size,
        header_b64=base64.b64encode(header).decode("ascii"),
        chunks=descriptors,
        recipients=tuple(wraps),
    )
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
) -> bytes:
    """Decrypt a sealed object for one authorized device."""
    parsed = (
        manifest
        if isinstance(manifest, TransferManifest)
        else TransferManifest.from_dict(manifest)
    )
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
    plaintext = decrypt_payload(header, ciphertext_chunks, object_key)
    if len(plaintext) != parsed.plaintext_size or _sha256_hex(plaintext) != parsed.plaintext_sha256:
        raise ObjectCryptoError("Plaintext integrity check failed")
    return plaintext
