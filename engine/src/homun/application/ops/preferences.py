"""Persistent workspace language preference.

Stored in the workspace ``meta`` table (schema v1 unchanged: free-form
key/value). The client sets it when the user changes language; the engine
reads it ONLY for texts it generates by itself — HTTP error bodies stay
neutral and the client translates them (docs/development/2026-10-15-errori-multilingua.md §3).
"""
from __future__ import annotations

from homun.domain.errors import ValidationError
from homun.i18n import DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES

_LANGUAGE_KEY = "language"


def get_language(ctx) -> str:
    with ctx.repository.locked() as conn:
        row = conn.execute(
            "SELECT value FROM meta WHERE key=?", (_LANGUAGE_KEY,)
        ).fetchone()
    if row and row[0] in SUPPORTED_LANGUAGES:
        return row[0]
    return DEFAULT_LANGUAGE


def set_language(ctx, language: str) -> None:
    if language not in SUPPORTED_LANGUAGES:
        raise ValidationError(
            f"Unsupported language: {language}; supported: {', '.join(SUPPORTED_LANGUAGES)}",
            reason="preferences.language_invalid",
            params={"language": language},
        )
    with ctx.repository.locked() as conn:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (_LANGUAGE_KEY, language),
        )
        conn.commit()


def resolve_language(ctx, requested: str | None) -> str:
    """A per-request language wins; otherwise the workspace preference."""
    if isinstance(requested, str) and requested.strip():
        return requested
    return get_language(ctx)
