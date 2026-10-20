"""Validate the selected transport instance against approved nonsecret identity.

L'identità approvata di un trasporto è (connection_id, endpoint, kind reale).
Il kind reale è ciò che il provider è (`transport_kind`, attributo di classe) —
mai `provider_id`, che per una connessione creata dalla persona porta l'id
scelto da lei (per esempio `golden_local`) e non è un kind.
"""
from homun.domain.errors import ConflictError


def bound_provider(provider, connection_id, expected):
    if expected is None:
        return provider
    actual_endpoint = getattr(provider, 'base_url', None)
    if actual_endpoint:
        actual_endpoint = actual_endpoint.rstrip('/')
    actual_kind = getattr(provider, 'transport_kind', None)
    if (expected.get('connection_id') != connection_id
            or expected.get('endpoint') != actual_endpoint
            or expected.get('kind') != actual_kind):
        raise ConflictError('Selected model transport differs from the approved runtime')
    # Callers use this same instance. Configuration updates replace providers,
    # while this instance still resolves credentials from the live secret store.
    return provider
