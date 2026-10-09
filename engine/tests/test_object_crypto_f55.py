"""F5 fetta 5 — object crypto and resumable transfer (first vertical slice).

Covers the distribution-doc §5 proofs that apply at the library layer:
corrupt/truncated ciphertext rejected; unauthorized device has no wrap;
relay material alone cannot decrypt; resume after missing chunks.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from homun.peers.device_identity import generate_device_keypair, key_fingerprint
from homun.peers.object_crypto import (
    ObjectCryptoError,
    TransferManifest,
    assert_no_credentials_in_transfer,
    missing_chunk_indices,
    open_object,
    seal_object,
    verify_chunk,
)


def _devices():
    owner = generate_device_keypair()
    peer = generate_device_keypair()
    stranger = generate_device_keypair()
    return owner, peer, stranger


def test_authorized_recipient_decrypts_roundtrip():
    owner, peer, _ = _devices()
    plaintext = "listino v3 — prezzi riservati\n".encode() + b"x" * 90_000
    sealed = seal_object(
        plaintext,
        object_id="obj_catalog",
        version=3,
        recipient_public_pems={
            key_fingerprint(owner.public_pem): owner.public_pem,
            key_fingerprint(peer.public_pem): peer.public_pem,
        },
        chunk_size=4096,
    )
    assert sealed.manifest.protocol == "homun-object-transfer/v1"
    assert len(sealed.ciphertext_chunks) > 1
    recovered = open_object(
        sealed.manifest.to_dict(),
        sealed.ciphertext_chunks,
        recipient_private_pem=peer.private_pem,
        recipient_fingerprint=peer.fingerprint,
    )
    assert recovered == plaintext


def test_unauthorized_device_cannot_open():
    owner, peer, stranger = _devices()
    sealed = seal_object(
        b"secret payload",
        object_id="obj_a",
        version=1,
        recipient_public_pems={
            key_fingerprint(owner.public_pem): owner.public_pem,
            key_fingerprint(peer.public_pem): peer.public_pem,
        },
    )
    with pytest.raises(ObjectCryptoError, match="No wrapped key"):
        open_object(
            sealed.manifest,
            sealed.ciphertext_chunks,
            recipient_private_pem=stranger.private_pem,
            recipient_fingerprint=stranger.fingerprint,
        )


def test_relay_material_alone_cannot_decrypt():
    """Manifest + ciphertext without a matching private key stay opaque."""
    _owner, peer, stranger = _devices()
    sealed = seal_object(
        b"payload for peer only",
        object_id="obj_b",
        version=1,
        recipient_public_pems={peer.fingerprint: peer.public_pem},
    )
    # Stranger steals wrap blob but has the wrong private key.
    stolen_wrap = sealed.manifest.recipients[0].wrapped_key_b64
    forged = sealed.manifest.to_dict()
    forged["recipients"] = [{
        "device_fingerprint": stranger.fingerprint,
        "wrapped_key_b64": stolen_wrap,
    }]
    with pytest.raises(ObjectCryptoError, match="unwrap|wrapped key"):
        open_object(
            forged,
            sealed.ciphertext_chunks,
            recipient_private_pem=stranger.private_pem,
            recipient_fingerprint=stranger.fingerprint,
        )


@pytest.mark.parametrize("mutate", ["corrupt", "truncate", "drop_last"])
def test_corrupt_or_truncated_ciphertext_rejected(mutate):
    owner, _, _ = _devices()
    sealed = seal_object(
        b"0123456789" * 800,
        object_id="obj_c",
        version=1,
        recipient_public_pems={owner.fingerprint: owner.public_pem},
        chunk_size=256,
    )
    chunks = list(sealed.ciphertext_chunks)
    if mutate == "corrupt":
        chunks[0] = bytes([chunks[0][0] ^ 0xFF]) + chunks[0][1:]
    elif mutate == "truncate":
        chunks[0] = chunks[0][:-3]
    else:
        chunks = chunks[:-1]
    with pytest.raises(ObjectCryptoError):
        open_object(
            sealed.manifest,
            chunks,
            recipient_private_pem=owner.private_pem,
            recipient_fingerprint=owner.fingerprint,
        )


def test_resume_skips_verified_chunks_and_redownloads_bad_ones():
    owner, _, _ = _devices()
    sealed = seal_object(
        b"ABCDEFGH" * 2000,
        object_id="obj_d",
        version=2,
        recipient_public_pems={owner.fingerprint: owner.public_pem},
        chunk_size=512,
    )
    present = {0: sealed.ciphertext_chunks[0], 2: b"tampered"}
    missing = missing_chunk_indices(sealed.manifest, present)
    assert 0 not in missing
    assert 2 in missing
    assert set(missing) == set(range(len(sealed.ciphertext_chunks))) - {0}

    completed = {
        index: sealed.ciphertext_chunks[index]
        for index in range(len(sealed.ciphertext_chunks))
    }
    assert missing_chunk_indices(sealed.manifest, completed) == []
    for index, blob in completed.items():
        verify_chunk(sealed.manifest, index, blob)
    assert open_object(
        sealed.manifest,
        [completed[i] for i in range(len(completed))],
        recipient_private_pem=owner.private_pem,
        recipient_fingerprint=owner.fingerprint,
    ) == b"ABCDEFGH" * 2000


def test_empty_plaintext_roundtrip():
    peer = generate_device_keypair()
    sealed = seal_object(
        b"",
        object_id="obj_empty",
        version=1,
        recipient_public_pems={peer.fingerprint: peer.public_pem},
    )
    assert open_object(
        sealed.manifest,
        sealed.ciphertext_chunks,
        recipient_private_pem=peer.private_pem,
        recipient_fingerprint=peer.fingerprint,
    ) == b""


@pytest.mark.parametrize(
    "field",
    ["api_key", "credentials", "secret", "secret_store", "workspace_key", "token"],
)
def test_manifest_rejects_credential_fields(field):
    owner, _, _ = _devices()
    sealed = seal_object(
        b"benign",
        object_id="obj_cred",
        version=1,
        recipient_public_pems={owner.fingerprint: owner.public_pem},
    )
    tainted = sealed.manifest.to_dict()
    tainted[field] = "sk-should-never-travel"
    with pytest.raises(ObjectCryptoError, match="[Cc]redential|Unsupported manifest"):
        TransferManifest.from_dict(tainted)


def test_assert_no_credentials_blocks_secret_store_field_name():
    with pytest.raises(ObjectCryptoError, match="Credentials must not appear"):
        assert_no_credentials_in_transfer(
            {"project_id": "p", "secret_store": {"k": "v"}},
            allowed_keys=frozenset({"project_id", "secret_store"}),
            label="transfer meta",
        )


def test_object_crypto_module_does_not_import_secret_store():
    import homun.peers.object_crypto as oc
    import homun.identity.object_transfer as ot

    for module in (oc, ot):
        source = Path(module.__file__).read_text(encoding="utf-8")
        assert "SecretStore" not in source
        assert "models.secrets" not in source
        assert "MemorySecretStore" not in source
        assert "FileSecretStore" not in source
