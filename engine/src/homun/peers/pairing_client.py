"""Client di pairing e chiamate remote (lato peer, F5 fetta 2).

Il peer — un'installazione Homun su un'altra macchina — si presenta allo
spazio host con l'invito ricevuto e la propria chiave di dispositivo;
dopo la conferma conserva la connessione (host, persona, token dispositivo)
e la usa per ogni chiamata remota."""
from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Any

from homun.peers.device_identity import DeviceIdentity, load_device_identity

PROTOCOL_VERSION = 1


class RemoteConnection:
    def __init__(self, host: str, workspace_id: str, person_id: str,
                 device_id: str, device_token: str, key_fingerprint: str) -> None:
        self.host = host.rstrip("/")
        self.workspace_id = workspace_id
        self.person_id = person_id
        self.device_id = device_id
        self.device_token = device_token
        self.key_fingerprint = key_fingerprint

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.__dict__, indent=2))
        path.chmod(0o600)

    @classmethod
    def load(cls, path: Path) -> "RemoteConnection":
        return cls(**json.loads(path.read_text()))


def _post(url: str, payload: dict[str, Any], bearer: str | None = None,
          timeout: float = 15.0) -> dict[str, Any]:
    request = urllib.request.Request(url, method="POST",
                                     data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json",
                                              **({"Authorization": f"Bearer {bearer}"} if bearer else {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def _get(url: str, bearer: str, timeout: float = 15.0) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {bearer}"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def pair_with_host(host: str, invite_token: str, display_name: str,
                   device_name: str, key_path: Path) -> RemoteConnection:
    """I due passaggi del pairing con prova di possesso della chiave."""
    identity: DeviceIdentity = load_device_identity(key_path)
    present = _post(f"{host.rstrip('/')}/v1/remote/pair", {
        "invite_token": invite_token,
        "display_name": display_name,
        "device_name": device_name,
        "public_key": identity.public_b64,
        "protocol_version": PROTOCOL_VERSION,
    })
    confirm = _post(f"{host.rstrip('/')}/v1/remote/pair/confirm", {
        "pairing_id": present["pairing_id"],
        "signature": identity.sign(present["nonce"]),
    })
    return RemoteConnection(
        host=host, workspace_id=confirm["workspace_id"],
        person_id=confirm["person_id"], device_id=confirm["device_id"],
        device_token=confirm["device_token"],
        key_fingerprint=confirm["key_fingerprint"],
    )


def remote_request(connection: RemoteConnection, path: str,
                   method: str = "GET", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{connection.host}{path}"
    if method == "GET":
        return _get(url, connection.device_token)
    return _post(url, payload or {}, bearer=connection.device_token)
