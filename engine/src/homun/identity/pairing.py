"""F5 fetta 2 — pairing di un dispositivo remoto con questo spazio.

Due passaggi, prova di possesso della chiave prima di consumare l'invito:
1. ``present``: invito + chiave pubblica + versione protocollo → un dispositivo
   in stato ``pending`` con una nonce di sfida (scadenza breve). L'invito NON
   viene consumato: una presentazione con chiave altrui non lo brucia.
2. ``confirm``: firma della nonce con la privata → solo ora l'invito si consuma,
   persona e dispositivo passano a confermati e si apre la sessione di
   trasporto legata al dispositivo.

Lo stato di sfida vive in un CommandRecord (kind DEVICE_PAIRING_KIND):
niente tabelle nuove, deduplica e persistenza come tutto il resto."""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from homun.domain.ids import new_id
from homun.domain.models import Actor, utc_now

DEVICE_PAIRING_KIND = "device.pairing"
PROTOCOL_VERSION = 1
CHALLENGE_TTL_MINUTES = 10


def _challenge_record(store, pairing_id: str) -> Any:
    record = store.commands.get(pairing_id)
    if record is None or record.type != DEVICE_PAIRING_KIND:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Pairing challenge not found")
    return record


def _challenge_alive(result: dict[str, Any]) -> bool:
    if result.get("status") != "pending":
        return False
    try:
        return datetime.fromisoformat(str(result["expires_at"])) > datetime.now(timezone.utc)
    except (KeyError, ValueError):
        return False


def present_pairing(ctx, body: dict[str, Any]) -> dict[str, Any]:
    """Passo 1: il peer si presenta. Nessun invito consumato qui."""
    from homun.domain.errors import ValidationError
    version = int(body.get("protocol_version") or 0)
    if version != PROTOCOL_VERSION:
        raise ValidationError(
            f"Unsupported protocol version: {version} (host speaks {PROTOCOL_VERSION})")
    public_key = str(body.get("public_key") or "")
    if not public_key:
        raise ValidationError("Device public key is required")
    from homun.peers.device_identity import key_fingerprint
    import base64
    try:
        fingerprint = key_fingerprint(base64.b64decode(public_key))
    except Exception as exc:
        raise ValidationError(f"Invalid device public key: {exc}") from exc

    pairing_id = new_id("pair")
    nonce = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) +
                  timedelta(minutes=CHALLENGE_TTL_MINUTES)).isoformat()
    system_actor = Actor(id="homun_engine", workspace_id=ctx.workspace_id,
                         display_name="Homun", kind="agent")
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            store.commands[pairing_id] = _record(
                store.workspace_id, pairing_id, system_actor, {
                    "id": pairing_id, "kind": DEVICE_PAIRING_KIND,
                    "status": "pending", "nonce": nonce,
                    "invite_id": str(body.get("invite_token") or "").partition(".")[0],
                    "invite_token": str(body.get("invite_token") or ""),
                    "public_key": public_key, "key_fingerprint": fingerprint,
                    "device_name": str(body.get("device_name") or "")[:120],
                    "display_name": str(body.get("display_name") or "")[:120],
                    "protocol_version": version,
                    "expires_at": expires_at,
                    "created_at": utc_now().isoformat(),
                })
        ctx.service.store = store
    return {"pairing_id": pairing_id, "nonce": nonce, "expires_at": expires_at,
            "protocol_version": PROTOCOL_VERSION}


def confirm_pairing(ctx, body: dict[str, Any]) -> dict[str, Any]:
    """Passo 2: la firma giusta consuma l'invito e apre la sessione."""
    import base64
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from homun.domain.errors import PermissionDeniedError, ValidationError
    pairing_id = str(body.get("pairing_id") or "")
    signature = str(body.get("signature") or "")

    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            record = _challenge_record(store, pairing_id)
            challenge = record.result
            if not _challenge_alive(challenge):
                challenge["status"] = "expired"
                raise PermissionDeniedError("Pairing challenge expired or already used")
            try:
                public = serialization.load_pem_public_key(
                    base64.b64decode(challenge["public_key"]))
                if not isinstance(public, Ed25519PublicKey):
                    raise ValueError("not ed25519")
                public.verify(base64.b64decode(signature),
                              str(challenge["nonce"]).encode("utf-8"))
            except Exception:
                # firma sbagliata o chiave malformata: la sfida resta viva,
                # l'invito intatto — si può riprovare con la firma giusta
                raise PermissionDeniedError("Signature does not prove the device key")

            invite_token = str(challenge["invite_token"])
            person_id = new_id("person")
            device_id = new_id("pdev")
            system_actor = Actor(id="homun_engine", workspace_id=ctx.workspace_id,
                                 display_name="Homun", kind="agent")
            result = ctx.service.for_store(store).apply(
                system_actor, f"confirm:{pairing_id}", "person.confirm", {
                    "invite_id": challenge["invite_id"],
                    "secret": invite_token.partition(".")[2],
                    "person_id": person_id,
                    "display_name": challenge.get("display_name") or "Dispositivo remoto",
                    "device_id": device_id,
                    "device_name": challenge.get("device_name"),
                    "key_fingerprint": challenge["key_fingerprint"],
                })
            challenge["status"] = "confirmed"
            challenge["person_id"] = person_id
            challenge["device_id"] = device_id
        ctx.service.store = store

    from homun.identity.sessions import PersonSessionStore
    session_token = secrets.token_urlsafe(48)
    session = PersonSessionStore(ctx.repository.connection(), ctx.repository.lock).create(
        person_id=person_id, device_id=device_id, token=session_token,
        expires_delta_days=30)
    return {"person_id": person_id, "device_id": device_id,
            "role": result.get("role"), "workspace_id": ctx.workspace_id,
            "device_token": session_token, "expires_at": session["expires_at"],
            "key_fingerprint": challenge["key_fingerprint"]}


def _record(workspace_id: str, command_id: str, actor: Actor, result: dict[str, Any]):
    from homun.domain.models import CommandRecord
    return CommandRecord(
        command_id=command_id, type=DEVICE_PAIRING_KIND,
        request_fingerprint=None, actor_id=actor.id,
        workspace_id=workspace_id, result=result)
