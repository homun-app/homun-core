"""Validate the selected transport instance against approved nonsecret identity."""
from homun.domain.errors import ConflictError


def bound_provider(provider, connection_id, expected):
    if expected is None:
        return provider
    actual_endpoint = getattr(provider, 'base_url', None)
    if actual_endpoint:
        actual_endpoint = actual_endpoint.rstrip('/')
    actual_kind = getattr(provider, 'provider_id', None)
    # Trasporto derivato composto ("connessione:modello"): il provider porta
    # l'id della connessione base; la kind approvata resta quella della base.
    derived_compound = (':' in connection_id
                        and connection_id.split(':', 1)[0] == actual_kind)
    if (expected.get('connection_id') != connection_id
            or expected.get('endpoint') != actual_endpoint
            or (expected.get('kind') != actual_kind and not derived_compound)):
        raise ConflictError('Selected model transport differs from the approved runtime')
    # Callers use this same instance. Configuration updates replace providers,
    # while this instance still resolves credentials from the live secret store.
    return provider
