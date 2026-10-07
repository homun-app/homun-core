"""F5 fetta 4 — invio comandi dal peer all'host, con outbox onesto.

Il peer invia comandi con command_id deduplicato ed expected_version;
l'host risponde con l'esito del dominio (ACK ricevuto ≠ accettato ≠
completato: la risposta distingue la consegna dall'esito). Le bozze non
consegnate vivono nell'outbox del peer: host assente = «in attesa di
consegna», mai «salvato»."""
from __future__ import annotations

from typing import Any

from homun.domain.models import Actor

# I comandi che un peer può inoltrare: contribuisci alla conversazione e
# revisionare il proprio contributo. Niente creazione di run, grant o
# progetti da remoto in questa fetta: perimetro minimo del pilot.
REMOTE_ALLOWED_COMMANDS = {
    "conversation.post_message",
    "conversation.rename",
}


def submit_remote_command(ctx, actor: Actor, body: dict[str, Any]) -> dict[str, Any]:
    """Inoltra un comando del peer al dominio, come persona autenticata.

    La risposta separa la consegna (received) dall'esito del dominio:
    un conflitto di versione è una consegna riuscita con esito conflict."""
    from homun.domain.errors import DomainError
    command_type = str(body.get("type") or "")
    if command_type not in REMOTE_ALLOWED_COMMANDS:
        from homun.domain.errors import ValidationError
        raise ValidationError(
            f"Remote peers may not submit: {command_type} (allowed: {sorted(REMOTE_ALLOWED_COMMANDS)})")
    payload = body.get("payload")
    if not isinstance(payload, dict):
        from homun.domain.errors import ValidationError
        raise ValidationError("Command payload is required")
    command_id = str(body.get("command_id") or "")
    if not command_id:
        from homun.domain.errors import ValidationError
        raise ValidationError("command_id is required")

    try:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                result = ctx.service.for_store(store).apply(
                    actor, command_id, command_type, payload)
            ctx.service.store = store
        return {"received": True, "command_id": command_id,
                "outcome": {"status": "accepted", "result": result}}
    except DomainError as exc:
        # consegna avvenuta, esito del dominio: il peer lo vede e decide
        return {"received": True, "command_id": command_id,
                "outcome": {"status": exc.code if hasattr(exc, "code") else "rejected",
                            "message": str(exc)}}
