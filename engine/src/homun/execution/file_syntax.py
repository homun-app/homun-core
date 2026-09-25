"""In-process syntax delta for workspace edits.

Syntax and lint delta verification rule
(MIT, Nous Research): report errors introduced by an edit, and refuse JSON/TOML
that does not parse. Homun does not run a language server or a shell linter.
"""
from __future__ import annotations

import ast
import json
import tomllib
from pathlib import PurePosixPath

FAIL_CLOSED = frozenset({'.json', '.toml'})


def _python(content: str) -> list[str]:
    try:
        ast.parse(content)
    except SyntaxError as exc:
        place = f' (line {exc.lineno}, column {exc.offset})' if exc.lineno else ''
        return [f'SyntaxError: {exc.msg}{place}']
    return []


def _json(content: str) -> list[str]:
    try:
        json.loads(content)
    except json.JSONDecodeError as exc:
        return [f'JSONDecodeError: {exc.msg} (line {exc.lineno}, column {exc.colno})']
    return []


def _toml(content: str) -> list[str]:
    try:
        tomllib.loads(content)
    except Exception as exc:  # TOMLDecodeError is a ValueError.
        return [f'{type(exc).__name__}: {exc}']
    return []


_CHECKERS = {'.py': _python, '.json': _json, '.toml': _toml}


def delta(path: str, before: str | None, after: str) -> dict:
    """Syntax findings for one edit. ``lsp`` is always unavailable."""
    extension = PurePosixPath(path).suffix.lower()
    checker = _CHECKERS.get(extension)
    base = {'lsp': 'unavailable'}
    if checker is None:
        reason = 'No in-process syntax check for this file'
        if extension in {'.yaml', '.yml', '.ts', '.tsx', '.js', '.go', '.rs'}:
            reason = f'{extension} diagnostics are not available; Homun does not run a language server or external linter'
        return {**base, 'checked': False, 'introduced': [], 'reason': reason}
    introduced_after = checker(after)
    if extension in FAIL_CLOSED and introduced_after:
        return {**base, 'checked': True, 'blocked': True, 'introduced': introduced_after,
                'reason': 'Refusing to write invalid JSON or TOML. The file was not modified.'}
    if not introduced_after:
        return {**base, 'checked': True, 'blocked': False, 'introduced': []}
    previous = checker(before) if before is not None else []
    fresh = [item for item in introduced_after if item not in set(previous)]
    if not fresh:
        return {**base, 'checked': True, 'blocked': False, 'introduced': [], 'preexisting': True,
                'note': 'Pre-existing syntax errors remain; this edit introduced none.'}
    return {**base, 'checked': True, 'blocked': False, 'introduced': fresh,
            'note': 'Syntax errors introduced by this edit.'}
