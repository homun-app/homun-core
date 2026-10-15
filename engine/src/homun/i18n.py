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
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

SUPPORTED_LANGUAGES = ("it", "en")
DEFAULT_LANGUAGE = "it"
_CONTRACT_DIR = Path("contracts") / "i18n"


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


def format_message(template: str, params: dict[str, Any] | None) -> str:
    """Fill ``{param}`` placeholders; missing params stay visible as ``{param}``."""
    if not params:
        return template
    for key, value in params.items():
        template = template.replace("{" + key + "}", str(value))
    return template


def user_text(reason: str, params: dict[str, Any] | None = None,
              *, language: str = DEFAULT_LANGUAGE) -> str | None:
    """The user-facing sentence for a stable ``reason``, or None if unknown."""
    entry = _catalog(language)["errors"].get(reason)
    if entry is None and language != "en":
        entry = _catalog("en")["errors"].get(reason)
    return format_message(entry, params) if entry is not None else None


def code_text(code: str, *, language: str = DEFAULT_LANGUAGE) -> str | None:
    """The generic sentence for an error ``code`` (fallback when no reason)."""
    entry = _catalog(language)["codes"].get(code)
    if entry is None and language != "en":
        entry = _catalog("en")["codes"].get(code)
    return entry
