"""Persistent language preferences: the person first, the workspace as default.

Stored in the workspace ``meta`` table (schema v1 unchanged: free-form
key/value) — ``language`` for the workspace, ``language:person:<id>`` for each
person (F5: a workspace already holds several people and engine-generated
texts go to a specific person). Resolution chain, documented in
docs/development/2026-10-15-errori-multilingua.md §3: **person → workspace →
English**. The engine reads the resolved language ONLY for texts it generates
by itself — HTTP error bodies stay neutral and the client translates them.
"""
from __future__ import annotations

from homun.domain.errors import ValidationError
from homun.i18n import DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES

_WORKSPACE_KEY = "language"
_PERSON_KEY_PREFIX = "language:person:"


def _read(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row and row[0] in SUPPORTED_LANGUAGES else None


def _write(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def _require_supported(language: str) -> str:
    if language not in SUPPORTED_LANGUAGES:
        raise ValidationError(
            f"Unsupported language: {language}; supported: {', '.join(SUPPORTED_LANGUAGES)}",
            reason="preferences.language_invalid",
            params={"language": language},
        )
    return language


def workspace_language(ctx) -> str | None:
    """The workspace preference as stored (None when never set)."""
    with ctx.repository.locked() as conn:
        return _read(conn, _WORKSPACE_KEY)


def set_workspace_language(ctx, language: str) -> None:
    _require_supported(language)
    with ctx.repository.locked() as conn:
        _write(conn, _WORKSPACE_KEY, language)
        conn.commit()


def person_language(ctx, person_id: str) -> str | None:
    """The person's own preference (None when never set)."""
    with ctx.repository.locked() as conn:
        return _read(conn, _PERSON_KEY_PREFIX + person_id)


def set_person_language(ctx, person_id: str, language: str) -> None:
    _require_supported(language)
    with ctx.repository.locked() as conn:
        _write(conn, _PERSON_KEY_PREFIX + person_id, language)
        conn.commit()


def resolve_language(ctx, requested: str | None = None, *, person_id: str | None = None) -> str:
    """person → workspace → English; an explicit per-request language wins."""
    if isinstance(requested, str) and requested.strip():
        return requested
    if person_id is not None:
        person = person_language(ctx, person_id)
        if person is not None:
            return person
    workspace = workspace_language(ctx)
    if workspace is not None:
        return workspace
    return DEFAULT_LANGUAGE
