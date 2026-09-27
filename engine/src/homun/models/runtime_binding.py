"""Validate the selected transport instance against approved nonsecret identity."""
from homun.domain.errors import ConflictError


def bound_provider(provider, connection_id, expected):
    if expected is None:
        return provider
    actual_endpoint = getattr(provider, 'base_url', None)
    if actual_endpoint:
        actual_endpoint = actual_endpoint.rstrip('/')
    if (expected.get('connection_id') != connection_id
            or expected.get('endpoint') != actual_endpoint
            or expected.get('kind') != getattr(provider, 'provider_id', None)):
        raise ConflictError('Selected model transport differs from the approved runtime')
    # Callers use this same instance. Configuration updates replace providers,
    # while this instance still resolves credentials from the live secret store.
    return provider
