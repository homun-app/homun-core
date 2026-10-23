"""Persistent person preferences: language (the person first, the workspace as
default) and the autonomy mode of the chat.

Stored in the workspace ``meta`` table (schema v1 unchanged: free-form
key/value) — ``language`` for the workspace, ``language:person:<id>`` for each
person (F5: a workspace already holds several people and engine-generated
texts go to a specific person), ``language:conversation:<id>`` for the
language detected while talking with a person, and ``autonomy:person:<id>``
for the last autonomy mode the person chose in the chat (their default for new
conversations, kept in the engine so it survives any browser). Language
resolution chain, documented in docs/development/2026-10-15-errori-multilingua.md
§3: **person → conversation (detected) → workspace → English**. The engine
reads the resolved language ONLY for texts it generates by itself — HTTP error
bodies stay neutral and the client translates them.
"""
from __future__ import annotations

from homun.domain.errors import ValidationError
from homun.i18n import DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES

_WORKSPACE_KEY = "language"
_PERSON_KEY_PREFIX = "language:person:"
_CONVERSATION_KEY_PREFIX = "language:conversation:"
_PERSON_AUTONOMY_PREFIX = "autonomy:person:"

# The three chat modes, as the UI names them (conversation-preferences.ts).
AUTONOMY_LEVELS = ("autonomous", "guarded", "supervised")
# What the chat answers when the person has never chosen.
DEFAULT_AUTONOMY = "guarded"


def _read_value(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else None


def _read(conn, key: str) -> str | None:
    value = _read_value(conn, key)
    return value if value in SUPPORTED_LANGUAGES else None


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


def conversation_language(ctx, conversation_id: str) -> str | None:
    """The language detected while talking in this conversation (None when never detected)."""
    with ctx.repository.locked() as conn:
        return _read(conn, _CONVERSATION_KEY_PREFIX + conversation_id)


def remember_conversation_language(conn, conversation_id: str, language: str) -> None:
    """Remember a freshly detected language on a connection already inside an
    open transaction (no commit).

    The caller's transaction owns the commit: the detected language persists
    exactly when the rest of the turn does. Nothing happens for unusable values.
    """
    if language in SUPPORTED_LANGUAGES:
        _write(conn, _CONVERSATION_KEY_PREFIX + conversation_id, language)


def resolve_language(ctx, requested: str | None = None, *, person_id: str | None = None,
                     conversation_id: str | None = None) -> str:
    """person → conversation → workspace → English; an explicit per-request language wins."""
    if isinstance(requested, str) and requested.strip():
        return requested
    if person_id is not None:
        person = person_language(ctx, person_id)
        if person is not None:
            return person
    if conversation_id is not None:
        conversation = conversation_language(ctx, conversation_id)
        if conversation is not None:
            return conversation
    workspace = workspace_language(ctx)
    if workspace is not None:
        return workspace
    return DEFAULT_LANGUAGE


def person_autonomy(ctx, person_id: str) -> str | None:
    """The last autonomy mode the person chose (None when never chosen)."""
    with ctx.repository.locked() as conn:
        value = _read_value(conn, _PERSON_AUTONOMY_PREFIX + person_id)
    return value if value in AUTONOMY_LEVELS else None


def set_person_autonomy(ctx, person_id: str, level: str) -> None:
    if level not in AUTONOMY_LEVELS:
        raise ValidationError(
            f"Unsupported autonomy level: {level}; supported: {', '.join(AUTONOMY_LEVELS)}",
            reason="preferences.autonomy_invalid",
            params={"level": level},
        )
    with ctx.repository.locked() as conn:
        _write(conn, _PERSON_AUTONOMY_PREFIX + person_id, level)
        conn.commit()
