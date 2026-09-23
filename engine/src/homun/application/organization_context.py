"""Bounded, actor-owned background shared by intake, chat and execution."""
from homun.application.organization import _state


def organization_background(store, actor):
    if actor.kind != 'person':
        return {}
    state = _state(store, actor)
    if not state['revision']:
        return {}
    return {'revision': state['revision'],
            'context': {key: value[:2000] for key, value in state['context'].items() if isinstance(value, str) and value}}
