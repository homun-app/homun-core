"""Shared error catalog: user-facing sentences per language, single source.

The catalog lives in ``contracts/i18n/errors.<lang>.json`` and is read by the
engine AND the web client (docs/development/2026-10-15-errori-multilingua.md).
The engine uses it only for texts it generates by itself (channels, chat,
intake); HTTP error bodies stay neutral — the client composes them.

Resolution order for the catalog directory: PyInstaller bundle
(``sys._MEIPASS/contracts/i18n``, see ``engine/packaging/homun-engine.spec``)
then the repository checkout next to ``engine/``. A missing catalog is a
first-class failure, never a silent fallback to raw messages.
"""
from __future__ import annotations

import json
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

SUPPORTED_LANGUAGES = ("it", "en")
# Last step of the documented resolution chain: person → workspace → English
# (docs/development/2026-10-15-errori-multilingua.md §3).
DEFAULT_LANGUAGE = "en"
_CONTRACT_DIR = Path("contracts") / "i18n"
_PLACEHOLDER = re.compile(r"\{(\w+)(?:@(\w+))?\}")

# Function words only, high signal per language: they carry no topic, so their
# count says which language a sentence is written in, not what it is about.
_LANGUAGE_MARKERS = {
    "it": ("il", "lo", "la", "i", "gli", "le", "un", "una", "di", "del", "della", "che",
           "per", "con", "non", "sono", "sei", "cosa", "come", "quando", "grazie", "ciao",
           "prepara", "crea", "scrivi", "vorrei", "entro", "fino", "allego", "buongiorno"),
    "en": ("the", "a", "an", "of", "to", "in", "on", "for", "with", "is", "are", "do",
           "does", "what", "how", "when", "please", "thanks", "hello", "prepare",
           "create", "write", "would", "until", "attach", "review"),
}


def detect_language(text: str) -> str | None:
    """The language a piece of text is written in ('it'/'en'), from function
    words; None when the text carries no usable signal.

    Deterministic and free — it picks the prompt language of a first turn
    before any preference or conversation history exists, so prompts and
    engine texts can follow the language the person actually writes in.
    """
    counts = {language: 0 for language in _LANGUAGE_MARKERS}
    words = re.findall(r"[a-zA-ZàèéìòóùÀÈÉÌÒÓÙ']+", text or "")
    for word in words:
        lowered = word.lower()
        for language, markers in _LANGUAGE_MARKERS.items():
            if lowered in markers:
                counts[language] += 1
    best = max(counts, key=counts.get)
    top = counts[best]
    if top == 0:
        return None
    if counts["it"] == counts["en"]:
        return None
    return best if top >= 2 or len(words) <= 3 else None


class CatalogUnavailableError(RuntimeError):
    """The shared error catalog could not be located or read."""


def _candidate_roots() -> list[Path]:
    roots: list[Path] = []
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        roots.append(Path(bundle_root))
    # Editable install / repo checkout: homun/i18n.py -> src -> engine -> repo
    roots.append(Path(__file__).resolve().parents[3])
    return roots


@lru_cache(maxsize=len(SUPPORTED_LANGUAGES))
def _load(language: str) -> dict[str, Any]:
    tried: list[Path] = []
    for root in _candidate_roots():
        path = root / _CONTRACT_DIR / f"errors.{language}.json"
        tried.append(path)
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise CatalogUnavailableError(f"unreadable catalog {path}: {exc}") from exc
            if not isinstance(data.get("errors"), dict) or not isinstance(data.get("codes"), dict):
                raise CatalogUnavailableError(f"malformed catalog {path}: missing errors/codes")
            return data
    raise CatalogUnavailableError(
        "shared error catalog not found; looked in: " + ", ".join(str(p) for p in tried)
    )


def _catalog(language: str) -> dict[str, Any]:
    if language not in SUPPORTED_LANGUAGES:
        language = "en"
    return _load(language)


def format_message(template: str, params: dict[str, Any] | None,
                   *, language: str = DEFAULT_LANGUAGE) -> str:
    """Fill ``{param}`` placeholders; missing params stay visible as ``{param}``.

    ``{param@label}`` resolves the param value (a key of the catalog ``labels``
    section) in ``language`` — the single label mechanism shared with the client
    (``formatErrorPlaceholders``), so internal enum values never reach a sentence.
    """
    if not params:
        return template

    def _sub(match: re.Match[str]) -> str:
        name, mode = match.group(1), match.group(2)
        if name not in params:
            return match.group(0)
        value = str(params[name])
        return label_text(value, language=language) if mode == "label" else value

    return _PLACEHOLDER.sub(_sub, template)


def label_text(key: str, *, language: str = DEFAULT_LANGUAGE) -> str:
    """The translated label for a catalog ``labels`` key (English fallback,
    then the key itself so a missing entry stays visible and reportable)."""
    labels = _catalog(language).get("labels", {})
    entry = labels.get(key)
    if entry is None and language != "en":
        entry = _catalog("en").get("labels", {}).get(key)
    return entry if entry is not None else key


def user_text(reason: str, params: dict[str, Any] | None = None,
              *, language: str = DEFAULT_LANGUAGE) -> str | None:
    """The user-facing sentence for a stable ``reason``, or None if unknown."""
    entry = _catalog(language)["errors"].get(reason)
    if entry is None and language != "en":
        entry = _catalog("en")["errors"].get(reason)
    return format_message(entry, params, language=language) if entry is not None else None


def code_text(code: str, *, language: str = DEFAULT_LANGUAGE) -> str | None:
    """The generic sentence for an error ``code`` (fallback when no reason)."""
    entry = _catalog(language)["codes"].get(code)
    if entry is None and language != "en":
        entry = _catalog("en")["codes"].get(code)
    return entry
