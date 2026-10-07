"""F5 — lato peer: chiave del dispositivo e pairing con uno spazio remoto.

Il peer è un'installazione Homun su un'altra macchina. La sua identità di
dispositivo è una chiave Ed25519 generata localmente: la pubblica viaggia
al pairing, la privata non lascia mai il dispositivo. Il token di sessione
del dispositivo è l'unica credenziale di trasporto (VPN/TLS per il canale).
"""
from homun.peers.device_identity import (
    generate_device_keypair,
    key_fingerprint,
    sign_nonce,
    load_device_identity,
    DeviceIdentity,
)
from homun.peers.replication import RemoteProjection, sync_remote_project
from homun.peers.pairing_client import (
    pair_with_host,
    remote_request,
    RemoteConnection,
    PROTOCOL_VERSION,
)

__all__ = [
    "RemoteProjection", "sync_remote_project",
    "generate_device_keypair", "key_fingerprint", "sign_nonce",
    "load_device_identity", "DeviceIdentity",
    "pair_with_host", "remote_request", "RemoteConnection", "PROTOCOL_VERSION",
]
