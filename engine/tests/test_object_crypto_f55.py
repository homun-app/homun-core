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


def _seal(publisher, plaintext, *, project_id="proj_x", object_id="obj_s", version=1,
          recipients=None, chunk_size=4096, object_key=None):
    from homun.peers.object_crypto import seal_object

    wraps = recipients if recipients is not None else {
        key_fingerprint(publisher.public_pem): publisher.public_pem,
    }
    return seal_object(
        plaintext,
        project_id=project_id,
        object_id=object_id,
        version=version,
        recipient_public_pems=wraps,
        publisher_identity=publisher,
        chunk_size=chunk_size,
        object_key=object_key,
    )


def _open(sealed, recipient, *, trusted, last_opened_version=None):
    """Open with the publisher identities the recipient trusts (replica snapshot)."""
    from homun.peers.object_crypto import open_object

    publishers = (
        trusted
        if isinstance(trusted, dict)
        else {trusted.fingerprint: trusted.public_pem}
    )
    return open_object(
        sealed.manifest,
        sealed.ciphertext_chunks,
        recipient_private_pem=recipient.private_pem,
        recipient_fingerprint=recipient.fingerprint,
        trusted_publisher_pems=publishers,
        expected_object_id=sealed.manifest.object_id,
        expected_version=sealed.manifest.version,
        expected_project_id=sealed.manifest.project_id,
        last_opened_version=last_opened_version,
    )


def test_authorized_recipient_decrypts_roundtrip():
    owner, peer, _ = _devices()
    plaintext = "listino v3 — prezzi riservati\n".encode() + b"x" * 90_000
    sealed = _seal(
        owner,
        plaintext,
        project_id="proj_catalog",
        object_id="obj_catalog",
        version=3,
        recipients={
            key_fingerprint(owner.public_pem): owner.public_pem,
            key_fingerprint(peer.public_pem): peer.public_pem,
        },
        chunk_size=4096,
    )
    assert sealed.manifest.protocol == "homun-object-transfer/v2"
    assert len(sealed.ciphertext_chunks) > 1
    opened = _open(sealed, peer, trusted=owner)
    assert opened.plaintext == plaintext
    assert opened.publisher_fingerprint == owner.fingerprint


def test_unauthorized_device_cannot_open():
    owner, peer, stranger = _devices()
    sealed = _seal(
        owner,
        b"secret payload",
        object_id="obj_a",
        recipients={
            key_fingerprint(owner.public_pem): owner.public_pem,
            key_fingerprint(peer.public_pem): peer.public_pem,
        },
    )
    with pytest.raises(ObjectCryptoError, match="No wrapped key"):
        _open(sealed, stranger, trusted=owner)


def test_relay_material_alone_cannot_decrypt():
    """Manifest + ciphertext without a matching private key stay opaque."""
    _owner, peer, stranger = _devices()
    sealed = _seal(
        peer,
        b"payload for peer only",
        object_id="obj_b",
        recipients={peer.fingerprint: peer.public_pem},
    )
    # Stranger steals wrap blob but has the wrong private key. Rewriting the
    # recipients also breaks the publisher signature: both must be refused.
    stolen_wrap = sealed.manifest.recipients[0].wrapped_key_b64
    forged = sealed.manifest.to_dict()
    forged["recipients"] = [{
        "device_fingerprint": stranger.fingerprint,
        "wrapped_key_b64": stolen_wrap,
    }]
    with pytest.raises(ObjectCryptoError, match="signature|unwrap|wrapped key"):
        open_object(
            forged,
            sealed.ciphertext_chunks,
            recipient_private_pem=stranger.private_pem,
            recipient_fingerprint=stranger.fingerprint,
            trusted_publisher_pems={peer.fingerprint: peer.public_pem},
            expected_object_id="obj_b",
            expected_version=1,
            expected_project_id="proj_x",
        )


@pytest.mark.parametrize("mutate", ["corrupt", "truncate", "drop_last"])
def test_corrupt_or_truncated_ciphertext_rejected(mutate):
    owner, _, _ = _devices()
    sealed = _seal(
        owner,
        b"0123456789" * 800,
        object_id="obj_c",
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
            trusted_publisher_pems={owner.fingerprint: owner.public_pem},
            expected_object_id="obj_c",
            expected_version=1,
            expected_project_id="proj_x",
        )


def test_resume_skips_verified_chunks_and_redownloads_bad_ones():
    owner, _, _ = _devices()
    sealed = _seal(
        owner,
        b"ABCDEFGH" * 2000,
        object_id="obj_d",
        version=2,
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
    assert _open(sealed, owner, trusted=owner).plaintext == b"ABCDEFGH" * 2000


def test_empty_plaintext_roundtrip():
    peer = generate_device_keypair()
    sealed = _seal(peer, b"", object_id="obj_empty")
    assert _open(sealed, peer, trusted=peer).plaintext == b""


@pytest.mark.parametrize(
    "field",
    ["api_key", "credentials", "secret", "secret_store", "workspace_key", "token"],
)
def test_manifest_rejects_credential_fields(field):
    owner, _, _ = _devices()
    sealed = _seal(owner, b"benign", object_id="obj_cred")
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


def test_manifest_is_signed_by_publisher_and_opens_with_identity():
    """Review P2: v2 manifests carry publisher_fingerprint + Ed25519 signature;
    the recipient learns who published and verifies the signature."""
    owner, peer, _ = _devices()
    sealed = _seal(
        owner,
        b"documento firmato",
        project_id="proj_firmato",
        object_id="obj_signed",
        version=4,
        recipients={
            owner.fingerprint: owner.public_pem,
            peer.fingerprint: peer.public_pem,
        },
    )
    assert sealed.manifest.protocol == "homun-object-transfer/v2"
    assert sealed.manifest.publisher_fingerprint == owner.fingerprint
    assert sealed.manifest.publisher_signature_b64

    opened = _open(sealed, peer, trusted=owner)
    assert opened.plaintext == b"documento firmato"
    assert opened.publisher_fingerprint == owner.fingerprint


def test_tampered_manifest_field_invalidates_signature():
    """Review P2: any field changed after signing must be rejected."""
    owner, _peer, _ = _devices()
    sealed = _seal(owner, b"originale", object_id="obj_tamper")
    tampered = sealed.manifest.to_dict()
    tampered["chunk_size"] = tampered["chunk_size"] + 1
    from homun.peers.object_crypto import TransferManifest, verify_manifest_signature

    parsed = TransferManifest.from_dict(tampered)
    with pytest.raises(Exception, match="signature"):
        verify_manifest_signature(parsed, owner.public_pem)


def test_signature_by_a_key_other_than_the_claimed_publisher_is_rejected():
    """Review P2: claiming someone else's fingerprint does not verify."""
    owner, attacker, _ = _devices()
    sealed = _seal(owner, b"contenuto della vittima", object_id="obj_claim")
    # The attacker re-signs the manifest with their own key while keeping
    # publisher_fingerprint = owner.
    from homun.peers.device_identity import DeviceIdentity
    from homun.peers.object_crypto import (
        TransferManifest,
        canonical_manifest_bytes,
        unsigned_manifest_dict,
    )

    forged = sealed.manifest.to_dict()
    forged["publisher_signature_b64"] = attacker.sign(
        canonical_manifest_bytes(unsigned_manifest_dict(forged))
    )
    parsed = TransferManifest.from_dict(forged)
    from homun.peers.object_crypto import verify_manifest_signature

    with pytest.raises(Exception, match="signature"):
        verify_manifest_signature(parsed, owner.public_pem)


def test_open_object_rejects_unknown_publisher_and_bad_signature():
    """Review P2: recipient only trusts publishers known from its replica
    snapshot; altered signatures never open."""
    owner, peer, stranger = _devices()
    sealed = _seal(
        owner,
        b"payload",
        object_id="obj_trust",
        recipients={peer.fingerprint: peer.public_pem},
    )
    # Publisher not in the trusted snapshot → rejected.
    with pytest.raises(Exception, match="not known|not active|not trusted"):
        _open(sealed, peer, trusted={stranger.fingerprint: stranger.public_pem})
    # Signature altered after sealing → rejected even for a trusted publisher.
    altered = sealed.manifest.to_dict()
    altered["publisher_signature_b64"] = sealed.manifest.publisher_signature_b64[:-8] + "AAAAAAAA"
    from homun.peers.object_crypto import TransferManifest, open_object

    with pytest.raises(Exception, match="signature"):
        open_object(
            TransferManifest.from_dict(altered),
            sealed.ciphertext_chunks,
            recipient_private_pem=peer.private_pem,
            recipient_fingerprint=peer.fingerprint,
            trusted_publisher_pems={owner.fingerprint: owner.public_pem},
            expected_object_id="obj_trust",
            expected_version=1,
            expected_project_id="proj_x",
        )


def test_v1_protocol_is_rejected_with_typed_error():
    """Review P2: v1 manifests (no publisher signature) are refused."""
    owner, _peer, _ = _devices()
    sealed = _seal(owner, b"v2 payload", object_id="obj_v2")
    legacy = sealed.manifest.to_dict()
    legacy["protocol"] = "homun-object-transfer/v1"
    from homun.peers.object_crypto import TransferManifest

    with pytest.raises(Exception, match="protocol"):
        TransferManifest.from_dict(legacy)


def _resign(publisher, manifest_dict):
    from homun.peers.object_crypto import canonical_manifest_bytes, unsigned_manifest_dict

    manifest_dict["publisher_signature_b64"] = publisher.sign(
        canonical_manifest_bytes(unsigned_manifest_dict(manifest_dict))
    )
    return manifest_dict


def test_chunks_cannot_be_relabelled_across_objects_or_versions():
    """Review P3: ciphertext chunks are bound to (protocol, project, object,
    version, chunk index) via secretstream additional data. A publisher or
    host cannot serve object A's chunks under object B's manifest — even with
    coherent hashes and a valid signature."""
    owner, peer, _ = _devices()
    from homun.peers.object_crypto import generate_object_key

    key = generate_object_key()
    sealed_a = _seal(
        owner,
        b"contenuto dell'oggetto A",
        project_id="proj_p",
        object_id="obj_a",
        version=1,
        recipients={peer.fingerprint: peer.public_pem},
        chunk_size=64,
        object_key=key,
    )
    sealed_v2 = _seal(
        owner,
        b"contenuto della versione 2",
        project_id="proj_p",
        object_id="obj_a",
        version=2,
        recipients={peer.fingerprint: peer.public_pem},
        chunk_size=64,
        object_key=key,
    )

    def _open_expect(manifest_dict, chunks, expected_object_id, expected_version):
        from homun.peers.object_crypto import open_object

        return open_object(
            manifest_dict,
            chunks,
            recipient_private_pem=peer.private_pem,
            recipient_fingerprint=peer.fingerprint,
            trusted_publisher_pems={owner.fingerprint: owner.public_pem},
            expected_object_id=expected_object_id,
            expected_version=expected_version,
            expected_project_id="proj_p",
        )

    # Same key, same recipients: only the AAD context (object_id) differs.
    forged = sealed_a.manifest.to_dict()
    forged["object_id"] = "obj_b"
    _resign(owner, forged)
    with pytest.raises(ObjectCryptoError, match="rejected|Ciphertext|AAD|additional"):
        _open_expect(forged, sealed_a.ciphertext_chunks, "obj_b", 1)

    # Chunks of v1 relabelled as v2 of the same object.
    forged_v2 = sealed_a.manifest.to_dict()
    forged_v2["version"] = 2
    _resign(owner, forged_v2)
    with pytest.raises(ObjectCryptoError, match="rejected|Ciphertext|AAD|additional"):
        _open_expect(forged_v2, sealed_a.ciphertext_chunks, "obj_a", 2)

    # Sanity: the honest v2 opens with the same expected values.
    honest = _open_expect(
        sealed_v2.manifest.to_dict(), sealed_v2.ciphertext_chunks, "obj_a", 2
    )
    assert honest.plaintext == b"contenuto della versione 2"


def test_manifest_must_match_requested_object_and_version():
    """Review P3: the recipient opens with the values it ASKED for; a host
    serving a different object or an older manifest is refused."""
    owner, peer, _ = _devices()
    sealed = _seal(
        owner,
        b"documento v1",
        project_id="proj_p",
        object_id="obj_doc",
        version=1,
        recipients={peer.fingerprint: peer.public_pem},
    )

    def _open_expect(expected_object_id, expected_version, expected_project_id="proj_p"):
        from homun.peers.object_crypto import open_object

        return open_object(
            sealed.manifest,
            sealed.ciphertext_chunks,
            recipient_private_pem=peer.private_pem,
            recipient_fingerprint=peer.fingerprint,
            trusted_publisher_pems={owner.fingerprint: owner.public_pem},
            expected_object_id=expected_object_id,
            expected_version=expected_version,
            expected_project_id=expected_project_id,
        )

    with pytest.raises(ObjectCryptoError, match="requested|expected|manifest"):
        _open_expect("obj_other", 1)
    with pytest.raises(ObjectCryptoError, match="requested|expected|manifest"):
        _open_expect("obj_doc", 2)
    with pytest.raises(ObjectCryptoError, match="requested|expected|manifest"):
        _open_expect("obj_doc", 1, expected_project_id="proj_altro")
    assert _open_expect("obj_doc", 1).plaintext == b"documento v1"


def test_rollback_to_previously_opened_version_is_rejected(tmp_path):
    """Review P3: the recipient remembers the highest version opened per
    object and refuses anything older (typed rollback error)."""
    owner, peer, _ = _devices()
    v1 = _seal(
        owner, b"v1", project_id="proj_p", object_id="obj_rb", version=1,
        recipients={peer.fingerprint: peer.public_pem},
    )
    v2 = _seal(
        owner, b"v2", project_id="proj_p", object_id="obj_rb", version=2,
        recipients={peer.fingerprint: peer.public_pem},
    )

    def _open(sealed, last_opened):
        from homun.peers.object_crypto import open_object

        return open_object(
            sealed.manifest,
            sealed.ciphertext_chunks,
            recipient_private_pem=peer.private_pem,
            recipient_fingerprint=peer.fingerprint,
            trusted_publisher_pems={owner.fingerprint: owner.public_pem},
            expected_object_id="obj_rb",
            expected_version=sealed.manifest.version,
            expected_project_id="proj_p",
            last_opened_version=last_opened,
        )

    assert _open(v1, None).plaintext == b"v1"
    assert _open(v2, 1).plaintext == b"v2"
    with pytest.raises(ObjectCryptoError, match="rollback|older|previous"):
        _open(v1, 2)

    # The persistent log the peer keeps behaves the same way.
    from homun.peers.object_crypto import ReceivedVersionLog

    log = ReceivedVersionLog(tmp_path / "received-versions.json")
    assert log.last_version("obj_rb") is None
    assert _open(v2, log.last_version("obj_rb")).plaintext == b"v2"
    log.record("obj_rb", 2)
    with pytest.raises(ObjectCryptoError, match="rollback|older|previous"):
        _open(v1, log.last_version("obj_rb"))
