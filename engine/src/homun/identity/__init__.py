"""F5 fetta 1 — identità dello spazio: inviti monouso, persone, sessioni.

Il flusso: un admin emette un invito (token ``id.secret`` mostrato una
volta), la persona invitata lo riscatta su ``POST /v1/session/redeem`` e
riceve una sessione legata alla persona appena creata. Nessun accesso ai
dati è implicito: i permessi passano dagli AccessGrant esistenti.
"""
from homun.identity.invites import (
    issue_person_invite,
    list_people,
    list_invites,
    revoke_invite,
    revoke_person,
    revoke_device,
    redeem_invite,
)
from homun.identity.sessions import PersonSessionStore, person_session_table

__all__ = [
    "issue_person_invite", "list_people", "list_invites", "revoke_invite",
    "revoke_person", "revoke_device", "redeem_invite",
    "PersonSessionStore", "person_session_table",
]
