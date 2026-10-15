"""Shared error catalog (contracts/i18n) read from the engine.

Single source for engine AND client (docs/development/2026-10-15-errori-multilingua.md):
one entry per stable `reason`, one generic sentence per `code`, `{param}`
placeholders, English fallback for missing languages/entries.
"""
import ast
import json
import re
from pathlib import Path

import pytest

from homun.i18n import SUPPORTED_LANGUAGES, code_text, format_message, user_text

ENGINE_SRC = Path(__file__).resolve().parents[1] / "src"
CONTRACTS = Path(__file__).resolve().parents[2] / "contracts" / "i18n"


def test_user_text_renders_params_in_both_languages():
    it = user_text("comparison.csv.not_utf8", {"side": "comparison.previous"}, language="it")
    en = user_text("comparison.csv.not_utf8", {"side": "comparison.previous"}, language="en")
    assert "listino precedente" in it
    assert "UTF-8" in it
    assert "previous price list" in en and en != it


def test_unknown_language_falls_back_to_english():
    text = user_text("comparison.csv.not_utf8", {"side": "comparison.previous"}, language="fr")
    assert text == user_text("comparison.csv.not_utf8", {"side": "comparison.previous"}, language="en")


def test_missing_reason_returns_none_and_every_code_has_copy():
    assert user_text("no.such.reason", None, language="it") is None
    for language in SUPPORTED_LANGUAGES:
        assert code_text("validation_error", language=language)
        assert code_text("unknown", language=language)


def test_format_message_fills_params_and_keeps_missing_visible():
    assert format_message("Il file {source} deve essere UTF-8", {"source": "x.csv"}) == (
        "Il file x.csv deve essere UTF-8"
    )
    assert format_message("Limite {max_mb}", {}) == "Limite {max_mb}"


def test_catalog_files_exist_for_every_language_with_matching_keys():
    keys = {}
    for language in SUPPORTED_LANGUAGES:
        path = CONTRACTS / f"errors.{language}.json"
        assert path.exists(), f"missing catalog {path}"
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["language"] == language
        keys[language] = data["errors"]
    assert set(keys["it"]) == set(keys["en"]), "reason keys must match across languages"
    assert set(keys["it"]), "catalog is empty"


def _catalog_placeholder_params():
    """Every {param} used in the catalog must be provided by the matching raise."""
    data = json.loads((CONTRACTS / "errors.it.json").read_text(encoding="utf-8"))
    return {key: set(re.findall(r"\{(\w+)\}", value)) for key, value in data["errors"].items()}


def _raise_sites_with_reason():
    """Literal `reason=` raise sites in engine sources (AST, like the census)."""
    for path in ENGINE_SRC.rglob("homun/**/*.py"):
        if "__pycache__" in str(path):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Raise) or not isinstance(node.exc, ast.Call):
                continue
            for kw in node.exc.keywords:
                if kw.arg != "reason" or not isinstance(kw.value, ast.Constant):
                    continue
                params = {}
                for pkw in node.exc.keywords:
                    if pkw.arg == "params" and isinstance(pkw.value, ast.Dict):
                        for k in pkw.value.keys:
                            if isinstance(k, ast.Constant):
                                params[k.value] = None
                yield kw.value.value, set(params)


def test_raise_params_never_look_like_absolute_paths_or_secrets():
    """Wave-1 guarantee: params carry simple display values only."""
    forbidden_key = re.compile(r"password|secret|token|api[_-]?key|credential|path|dir", re.I)
    absolute_path = re.compile(r"^(?:/|[A-Za-z]:\\)|\.\./")
    checked = 0
    for _path, tree in _iter_engine_trees():
        for node in ast.walk(tree):
            if not isinstance(node, ast.Raise) or not isinstance(node.exc, ast.Call):
                continue
            if not any(kw.arg == "reason" for kw in node.exc.keywords):
                continue
            for kw in node.exc.keywords:
                if kw.arg != "params" or not isinstance(kw.value, ast.Dict):
                    continue
                for key, value in zip(kw.value.keys, kw.value.values):
                    assert isinstance(key, ast.Constant)
                    assert not forbidden_key.search(str(key.value)), (
                        f"param key `{key.value}` looks sensitive"
                    )
                    if isinstance(value, ast.Constant) and isinstance(value.value, str):
                        assert not absolute_path.search(value.value), (
                            f"param `{key.value}` carries an absolute path: {value.value!r}"
                        )
                    checked += 1
    assert checked > 0, "no params found — the scan is broken"


def _iter_engine_trees():
    for path in ENGINE_SRC.rglob("homun/**/*.py"):
        if "__pycache__" not in str(path):
            yield path, ast.parse(path.read_text(encoding="utf-8"))


def test_raise_reasons_exist_in_catalog_with_superset_params():
    placeholders = _catalog_placeholder_params()
    seen = 0
    for reason, param_keys in _raise_sites_with_reason():
        seen += 1
        assert reason in placeholders, f"reason `{reason}` raised but missing from catalog"
        missing = placeholders[reason] - param_keys
        assert not missing, (
            f"reason `{reason}`: catalog needs params {sorted(missing)} "
            "the raise does not provide"
        )
    assert seen > 0, "census found no raise with reason= — the AST scan is broken"


@pytest.mark.parametrize("language", list(SUPPORTED_LANGUAGES))
def test_catalog_entries_are_sentences_with_known_params_only(language):
    data = json.loads((CONTRACTS / f"errors.{language}.json").read_text(encoding="utf-8"))
    for key, value in data["errors"].items():
        assert isinstance(value, str) and value.strip(), f"{key}: empty entry"
        assert re.search(r"[.!?»]$", value.strip()) or key.startswith("intake."), (
            f"{key}: not a finished sentence"
        )
        for name in re.findall(r"\{(\w+)\}", value):
            assert re.fullmatch(r"\w+", name)


def _sample_params() -> dict:
    return json.loads((CONTRACTS / "errors.samples.json").read_text(encoding="utf-8"))["params"]


# A user-facing sentence is entirely in the user's language: no internal enum
# values, no 'left'/'right' sides, no engine-generated actor ids, no raw
# catalog keys left unresolved (docs/development/2026-10-15-errori-multilingua.md).
_FORBIDDEN_IN_ITALIAN = [
    "left", "right", "Material", "Grant",
    "note", "link", "file_ref", "active", "archived",
    "draft", "ready", "running", "waiting_input", "waiting_approval", "paused",
    "review", "completed", "failed", "cancelled",
]
_FORBIDDEN_PATTERNS = [
    re.compile(r"\b(person|agent)_[A-Za-z0-9_-]+\b"),   # internal actor ids
    re.compile(r"\b(comparison|materials\.kind|work\.status|policy\.entity)\.\w"),  # raw label keys
    re.compile(r"\{\w+"),                                # unresolved placeholder
]


def test_label_placeholders_resolve_from_the_shared_labels_section():
    """`{param@label}`: the param value is a key of the catalog `labels`
    section, resolved in the current language by the same mechanism the
    client uses (formatErrorPlaceholders)."""
    it = user_text("comparison.csv.not_utf8",
                   {"side": "comparison.previous"}, language="it")
    en = user_text("comparison.csv.not_utf8",
                   {"side": "comparison.previous"}, language="en")
    assert it == "«listino precedente»: il CSV deve essere salvato in UTF-8."
    assert en == "“previous price list”: the CSV must be saved as UTF-8."


def test_labels_section_has_matching_keys_in_every_language():
    sections = {}
    for language in SUPPORTED_LANGUAGES:
        data = json.loads((CONTRACTS / f"errors.{language}.json").read_text(encoding="utf-8"))
        assert isinstance(data.get("labels"), dict) and data["labels"], (
            f"{language}: missing labels section"
        )
        sections[language] = data["labels"]
    assert set(sections["it"]) == set(sections["en"]), "label keys must match across languages"


def test_every_italian_sentence_composes_without_internal_labels_or_ids():
    samples = _sample_params()
    data = json.loads((CONTRACTS / "errors.it.json").read_text(encoding="utf-8"))
    assert data["errors"], "catalog is empty"
    for reason in data["errors"]:
        params = samples.get(reason, {})
        sentence = user_text(reason, params, language="it")
        assert sentence is not None, f"{reason}: missing from it catalog"
        for token in _FORBIDDEN_IN_ITALIAN:
            assert not re.search(rf"\b{re.escape(token)}\b", sentence), (
                f"{reason}: internal label `{token}` leaked into the italian sentence: {sentence}"
            )
        for pattern in _FORBIDDEN_PATTERNS:
            assert not pattern.search(sentence), (
                f"{reason}: pattern {pattern.pattern} leaked into: {sentence}"
            )


def test_every_english_sentence_composes_with_translated_labels():
    samples = _sample_params()
    data = json.loads((CONTRACTS / "errors.en.json").read_text(encoding="utf-8"))
    for reason in data["errors"]:
        sentence = user_text(reason, samples.get(reason, {}), language="en")
        assert sentence is not None and "{" not in sentence, (
            f"{reason}: unresolved placeholder in: {sentence}"
        )
