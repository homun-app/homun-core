"""F5 review P2 — device directory for signature checks.

Publisher verification needs the public key registered for a device
fingerprint. Pairing keeps the PEM in its challenge record (CommandRecord of
kind device.pairing); the PersonDevice row carries person + status. Peers
receive the same directory in the replica snapshot so they can verify
publisher signatures on their side.
"""
from __future__ import annotations

import base64
from typing import Any

from homun.identity.pairing import DEVICE_PAIRING_KIND
from homun.policy import has_project_capability


def device_public_pem(store, fingerprint: str) -> bytes | None:
    """PEM registered at pairing time for a device fingerprint, if any."""
    for record in store.commands.values():
        if record.type != DEVICE_PAIRING_KIND:
            continue
        result = record.result
        if result.get("key_fingerprint") != fingerprint:
            continue
        encoded = str(result.get("public_key") or "")
        if not encoded:
            continue
        try:
            return base64.b64decode(encoded)
        except (ValueError, TypeError):
            continue
    return None


def project_device_directory(store, project_id: str) -> list[dict[str, Any]]:
    """Devices of the people with an ACTIVE WRITE grant on the project.

    Verifica C: recipients may trust as authors only the confirmed devices of
    people who can actually publish (active write grant). A read-only member
    cannot publish, so a compromised host must not be able to present their
    key as a trusted publisher's. Only confirmed devices carry their public
    key: a revoked device stays visible (status) so recipients can see it is
    no longer trusted.
    """
    devices: list[dict[str, Any]] = []
    for device in sorted(store.person_devices.values(), key=lambda d: (d.person_id, d.id)):
        if not device.key_fingerprint:
            continue
        if not has_project_capability(store, device.person_id, project_id, "write"):
            continue
        entry: dict[str, Any] = {
            "person_id": device.person_id,
            "key_fingerprint": device.key_fingerprint,
            "status": device.status,
        }
        if device.status == "confirmed":
            pem = device_public_pem(store, device.key_fingerprint)
            if pem is not None:
                entry["public_key"] = base64.b64encode(pem).decode("ascii")
        devices.append(entry)
    return devices
