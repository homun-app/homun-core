"""Tolerant extraction of a JSON object from model output.

Thinking models often wrap JSON in prose or emit trailing commentary; the
intake parser survived this first (2026-09-21) and the interpret parser hit
the same failure, so the extractor now lives here for both.
"""
from __future__ import annotations

import json


def extract_json_payload(text: str) -> str:
    """Code fences first; thinking models may prepend or append prose.

    Scans every opening brace and returns the first complete JSON object,
    ignoring anything the model wrote after it (a second block, commentary).
    """
    raw = text.strip()
    if raw.startswith('```'):
        raw = raw.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    try:
        json.loads(raw)
        return raw
    except ValueError:
        pass
    decoder = json.JSONDecoder()
    for start, char in enumerate(raw):
        if char != '{':
            continue
        try:
            value, end = decoder.raw_decode(raw, start)
        except ValueError:
            continue
        if isinstance(value, dict) and value:
            return raw[start:end]
    raise ValueError('No JSON object found in model response')
