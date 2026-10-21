"""Constrained structured-output fallback for providers without native tools.

When a provider rejects a request carrying ``tools`` with a capability
rejection (not a schema complaint), the front-door turn makes ONE call whose
output is bound to the JSON Schema of a discriminated union of its actions —
``response_format: json_schema`` on OpenAI-compatible endpoints, ``format``
on Ollama's native API. The engine rules stay exactly the same: only the
transport of the decision changes.

The module also keeps a process-level memo of (route, model, mode) triples
that already rejected a mode, so a route known to refuse ``tools`` never burns
another guaranteed-fail round-trip (and vice versa). Inspired by Hermes'
auxiliary structured-output memo, re-written for Homun's transports: no
imports from Hermes.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from homun.models.json_payload import extract_json_payload
from homun.models.native_errors import INVALID_REQUEST, NativeModelError, classify_transport
from homun.models.native_turn import project_messages
from homun.models.types import UsageEntry

TOOLS_MODE = 'tools'
STRUCTURED_MODE = 'structured'

# (route key, model, mode) triples this process saw rejected by the provider.
_REJECTED_MODES: set[tuple[str, str, str]] = set()

# Rejections that speak to the route/model's capability, not this request's shape.
_CAPABILITY_REJECTION_MARKERS = (
    'does not support', "doesn't support", 'not supported', 'unsupported parameter',
    'unsupported_parameter', 'unknown parameter', 'unknown field', 'unrecognized request argument',
    'unrecognized parameter', 'extra inputs are not permitted', 'is unavailable',
    'tools is not supported', 'no such tool', 'tool use', 'tool_choice',
)


def endpoint_key(base_url: str | None) -> str:
    """Host:port of the endpoint (a base_url override changes the route)."""
    return (urlparse(str(base_url or '')).netloc or '').lower()


def route_key(provider) -> str:
    """What identifies a model route for the memo: the endpoint host when the
    provider has one, otherwise the provider itself (the fake has no endpoint)."""
    return endpoint_key(getattr(provider, 'base_url', None)) or str(getattr(provider, 'provider_id', '') or '')


def mode_rejected(route: str, model_id: str, mode: str) -> bool:
    return (route, str(model_id or ''), mode) in _REJECTED_MODES


def remember_mode_rejected(route: str, model_id: str, mode: str) -> None:
    _REJECTED_MODES.add((route, str(model_id or ''), mode))


def reset_mode_memory() -> None:
    """Test seam: the memo is process state, tests start clean."""
    _REJECTED_MODES.clear()


def is_tools_rejection(exc: BaseException | None) -> bool:
    """Whether a provider rejection names the tools capability (memoisable)
    rather than this request's payload."""
    text = str(exc or '').lower()
    if 'invalid schema' in text:
        return False
    if not isinstance(exc, NativeModelError) or exc.code != INVALID_REQUEST:
        return False
    return 'tool' in text and any(marker in text for marker in _CAPABILITY_REJECTION_MARKERS)


@dataclass
class StructuredResult:
    """The model's constrained decision, parsed, with its provider usage."""

    payload: dict[str, Any]
    usage: UsageEntry


def complete_structured(provider, messages, *, schema: dict[str, Any], model_id: str | None = None,
                        max_output_tokens: int = 8192) -> StructuredResult:
    """One constrained call: the model must answer with the union schema.

    Returns the parsed decision payload; the caller projects it onto the same
    message shape a native tool turn produces.
    """
    from homun.models.native_transport import usage_from_response

    key = provider._api_key()
    if not key:
        raise RuntimeError('OpenAI-compatible provider has no credentials')
    model = model_id or provider.default_model
    ollama = provider._ollama_native_root() is not None
    payload: dict[str, Any] = {'model': model, 'messages': project_messages(messages, ollama=ollama),
                               'stream': False}
    if ollama:
        # Ollama /api/chat: `format` accepts a JSON Schema the backend turns
        # into a grammar constraining the whole response.
        payload['format'] = schema
        payload.update(think=False, options={'temperature': 0, 'num_predict': max_output_tokens})
    else:
        payload['response_format'] = {
            'type': 'json_schema',
            'json_schema': {'name': 'front_door_decision', 'strict': False, 'schema': schema},
        }
        payload.update(temperature=0, max_tokens=max_output_tokens)
    try:
        if ollama:
            response = provider._post_ollama_chat(payload)
        else:
            response = provider._post('/chat/completions', payload, api_key=key)
    except Exception as exc:  # noqa: BLE001 — classified below
        raise classify_transport(exc) from exc
    usage = usage_from_response(response, provider_id=provider.provider_id, model_id=model,
                                ollama=ollama)
    body = response if isinstance(response, dict) else {}
    content = ''
    if ollama:
        message = body.get('message')
        content = str(message.get('content') or '') if isinstance(message, dict) else ''
    else:
        choices = body.get('choices')
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            entry = choices[0].get('message')
            content = str(entry.get('content') or '') if isinstance(entry, dict) else ''
    try:
        parsed = json.loads(extract_json_payload(content))
        if not isinstance(parsed, dict):
            raise ValueError('structured decision is not an object')
    except (ValueError, TypeError) as exc:
        error_usage = usage.model_copy(update={'status': 'error', 'error_code': 'agent_model_malformed'})
        raise NativeModelError('agent_model_malformed',
                               f'Structured output was not valid JSON: {exc}', usage=error_usage) from exc
    return StructuredResult(payload=parsed, usage=usage)
