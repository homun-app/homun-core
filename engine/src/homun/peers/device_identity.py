"""Chiave del dispositivo (F5.1b): Ed25519 generata localmente, privata mai in rete."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


class DeviceIdentity:
    def __init__(self, private_pem: bytes, public_pem: bytes) -> None:
        self._private = serialization.load_pem_private_key(private_pem, password=None)
        self.public_pem = public_pem

    @property
    def public_b64(self) -> str:
        return base64.b64encode(self.public_pem).decode("ascii")

    @property
    def fingerprint(self) -> str:
        return key_fingerprint(self.public_pem)

    def sign(self, message: bytes | str) -> str:
        data = message.encode("utf-8") if isinstance(message, str) else message
        return base64.b64encode(self._private.sign(data)).decode("ascii")


def generate_device_keypair() -> DeviceIdentity:
    key = Ed25519PrivateKey.generate()
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_pem = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return DeviceIdentity(private_pem, public_pem)


def key_fingerprint(public_pem: bytes) -> str:
    """Sha256 del DER della pubblica: identificabile, non segreta."""
    from cryptography.hazmat.primitives import serialization as _s
    public = _s.load_pem_public_key(public_pem)
    der = public.public_bytes(_s.Encoding.DER, _s.PublicFormat.SubjectPublicKeyInfo)
    return "sha256:" + hashlib.sha256(der).hexdigest()


def sign_nonce(private_pem: bytes, nonce: str) -> str:
    identity = DeviceIdentity(private_pem, b"")
    return identity.sign(nonce.encode("utf-8"))


def load_device_identity(path: Path) -> DeviceIdentity:
    """Identità persistente del dispositivo; generata alla prima chiamata."""
    if path.exists():
        data = json.loads(path.read_text())
        return DeviceIdentity(data["private_pem"].encode(), data["public_pem"].encode())
    identity = generate_device_keypair()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "private_pem": identity._private.private_bytes(  # noqa: SLF001 - persistenza locale
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode(),
        "public_pem": identity.public_pem.decode(),
    }, indent=2))
    path.chmod(0o600)
    return identity
