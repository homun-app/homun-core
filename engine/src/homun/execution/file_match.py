"""Fuzzy replacement for model edits.

Fuzzy line matching implementation applying the exact rule
Homun applies the
same ordered strategies on text already read from an owned workspace; it does
not shell out and it does not write.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Callable

Span = tuple[int, int]

IDENTICAL = (
    'No edit was applied because old_string and new_string are identical. '
    'Provide the existing text in old_string and the replacement in new_string.')

UNICODE_MAP = {
    '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'",
    '\u2014': '--', '\u2013': '-', '\u2026': '...', '\u00a0': ' ', '\u2212': '-',
    '\u2000': ' ', '\u2001': ' ', '\u2002': ' ', '\u2003': ' ', '\u2004': ' ',
    '\u2005': ' ', '\u2006': ' ', '\u2007': ' ', '\u2008': ' ', '\u2009': ' ',
    '\u200a': ' ', '\u202f': ' ', '\u205f': ' ', '\u3000': ' ',
}
SIMILARITY = frozenset({'block_anchor', 'context_aware'})


def _unicode(text: str) -> str:
    for char, repl in UNICODE_MAP.items():
        text = text.replace(char, repl)
    return text


def _line_span(lines: list[str], start: int, end: int, length: int) -> Span:
    start_pos = sum(len(line) + 1 for line in lines[:start])
    end_pos = sum(len(line) + 1 for line in lines[:end]) - 1
    return start_pos, min(length, end_pos)


def _windows(content: str, lines: list[str], count: int, accept: Callable[[int], bool]) -> list[Span]:
    return [_line_span(lines, i, i + count, len(content))
            for i in range(len(lines) - count + 1) if accept(i)]


def _match_lines(content: str, pattern: str, transform: Callable[[list[str]], list[str]]) -> list[Span]:
    lines = content.split('\n')
    wanted = transform(pattern.split('\n'))
    count = len(wanted)
    return _windows(content, lines, count, lambda i: transform(lines[i:i + count]) == wanted)


def _strip_boundary(lines: list[str]) -> list[str]:
    lines = list(lines)
    lines[0] = lines[0].strip()
    if len(lines) > 1:
        lines[-1] = lines[-1].strip()
    return lines


def _orig_to_norm(original: str) -> list[int]:
    result, pos = [], 0
    for char in original:
        result.append(pos)
        pos += len(UNICODE_MAP.get(char, char))
    result.append(pos)
    return result


def _norm_end(orig_to_norm: list[int], start: int, norm_end: int) -> int:
    end = start
    while end < len(orig_to_norm) - 1 and orig_to_norm[end] < norm_end:
        end += 1
    return end


def _map_unicode(original: str, spans: list[Span]) -> list[Span]:
    mapping = _orig_to_norm(original)
    inverse: dict[int, int] = {}
    for origin, norm in enumerate(mapping[:-1]):
        inverse.setdefault(norm, origin)
    mapped = []
    for start, end in spans:
        if start in inverse:
            origin = inverse[start]
            mapped.append((origin, _norm_end(mapping, origin, end)))
    return mapped


def _map_whitespace(original: str, normalized: str, spans: list[Span]) -> list[Span]:
    orig_to_norm, origin, norm = [], 0, 0
    while origin < len(original) and norm < len(normalized):
        orig_to_norm.append(norm)
        if original[origin] == normalized[norm]:
            origin += 1
            norm += 1
        elif original[origin] in ' \t' and normalized[norm] == ' ':
            origin += 1
            if origin < len(original) and original[origin] not in ' \t':
                norm += 1
        else:
            origin += 1
    orig_to_norm.extend([len(normalized)] * (len(original) - origin))
    starts, ends = {}, {}
    for origin, norm in enumerate(orig_to_norm):
        starts.setdefault(norm, origin)
        ends[norm] = origin
    mapped = []
    for start, end in spans:
        origin = starts.get(start, min(i for i, n in enumerate(orig_to_norm) if n >= start))
        finish = ends[end - 1] + 1 if end - 1 in ends else origin + (end - start)
        if end < len(normalized) and normalized[end - 1] == ' ':
            while finish < len(original) and original[finish] in ' \t':
                finish += 1
        mapped.append((origin, min(finish, len(original))))
    return mapped


def _exact(content: str, pattern: str) -> list[Span]:
    return [match.span() for match in re.finditer(re.escape(pattern), content)]


def _whitespace(content: str, pattern: str) -> list[Span]:
    def collapse(value: str) -> str:
        return re.sub(r'[ \t]+', ' ', value)
    found = _exact(collapse(content), collapse(pattern))
    return _map_whitespace(content, collapse(content), found) if found else []


def _escaped(content: str, pattern: str) -> list[Span]:
    expanded = pattern.replace('\\n', '\n').replace('\\t', '\t').replace('\\r', '\r')
    return [] if expanded == pattern else _exact(content, expanded)


def _unicode_match(content: str, pattern: str) -> list[Span]:
    normal_content, normal_pattern = _unicode(content), _unicode(pattern)
    if normal_content == content and normal_pattern == pattern:
        return []
    found = _exact(normal_content, normal_pattern) or _match_lines(normal_content, normal_pattern, lambda lines: [line.strip() for line in lines])
    return _map_unicode(content, found) if found else []


def _block(content: str, pattern: str) -> list[Span]:
    wanted = _unicode(pattern).split('\n')
    if len(wanted) < 2:
        return []
    lines = _unicode(content).split('\n')
    count = len(wanted)
    first, last = wanted[0].strip(), wanted[-1].strip()
    middle = '\n'.join(wanted[1:-1])
    candidates = {i for i in range(len(lines) - count + 1)
                  if lines[i].strip() == first and lines[i + count - 1].strip() == last}
    threshold = 0.50 if len(candidates) == 1 else 0.70

    def accept(index: int) -> bool:
        if index not in candidates:
            return False
        if count <= 2:
            return True
        actual = '\n'.join(lines[index + 1:index + count - 1])
        return SequenceMatcher(None, actual, middle).ratio() >= threshold

    return _windows(content, content.split('\n'), count, accept)


def _context(content: str, pattern: str) -> list[Span]:
    wanted, lines = pattern.split('\n'), content.split('\n')
    count = len(wanted)
    if count > len(lines):
        return []

    def similar(left: str, right: str) -> float:
        return 1.0 if left == right else SequenceMatcher(None, left, right).ratio()

    def accept(index: int) -> bool:
        block = lines[index:index + count]
        if similar(wanted[0].strip(), block[0].strip()) < 0.80:
            return False
        if similar(wanted[-1].strip(), block[-1].strip()) < 0.80:
            return False
        return all(not left.strip() or similar(left.strip(), right.strip()) >= 0.80
                   for left, right in zip(wanted, block))

    return _windows(content, lines, count, accept)


STRATEGIES: list[tuple[str, Callable[[str, str], list[Span]]]] = [
    ('exact', _exact),
    ('line_trimmed', lambda content, pattern: _match_lines(content, pattern, lambda lines: [line.strip() for line in lines])),
    ('whitespace_normalized', _whitespace),
    ('indentation_flexible', lambda content, pattern: _match_lines(content, pattern, lambda lines: [line.lstrip() for line in lines])),
    ('escape_normalized', _escaped),
    ('trimmed_boundary', lambda content, pattern: _match_lines(content, pattern, _strip_boundary)),
    ('unicode_normalized', _unicode_match),
    ('block_anchor', _block),
    ('context_aware', _context),
]


def already_applied(content: str, old: str, new: str) -> bool:
    """True when the replacement is already present and the old text is gone."""
    if not new or len(new.strip()) < 8 or new not in content:
        return False
    return old == new or old not in content


def _locations(content: str, matches: list[Span]) -> str:
    rows = []
    for start, _end in matches[:5]:
        line = content.count('\n', 0, start) + 1
        line_start = content.rfind('\n', 0, start) + 1
        line_end = content.find('\n', line_start)
        snippet = content[line_start:len(content) if line_end < 0 else line_end].strip()
        rows.append(f'  L{line}: {snippet[:77]}')
    if len(matches) > 5:
        rows.append(f'  ... and {len(matches) - 5} more')
    return '\n'.join(rows)


def _indent(line: str) -> str:
    return line[:len(line) - len(line.lstrip(' \t'))]


def _reindent(region: str, old: str, new: str) -> str:
    old_line = next((line for line in old.split('\n') if line.strip()), None)
    file_line = next((line for line in region.split('\n') if line.strip()), None)
    if old_line is None or file_line is None:
        return new
    old_indent, file_indent = _indent(old_line), _indent(file_line)
    if old_indent == file_indent:
        return new
    adjusted = []
    for line in new.split('\n'):
        if not line.strip():
            adjusted.append(line)
        elif _indent(line).startswith(old_indent):
            adjusted.append(file_indent + line[len(old_indent):])
        else:
            adjusted.append(file_indent + line.lstrip(' \t'))
    return '\n'.join(adjusted)


def _preserve_unicode(content: str, matches: list[Span], old: str, new: str) -> str:
    region = ''.join(content[start:end] for start, end in matches)
    if _unicode(old) != _unicode(region):
        return new
    mapping = _orig_to_norm(region)
    inverse: dict[int, int] = {}
    for origin, norm in enumerate(mapping[:-1]):
        inverse.setdefault(norm, origin)
    parts = []
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, _unicode(old), new).get_opcodes():
        if tag == 'equal':
            start = inverse.get(i1, 0)
            parts.append(region[start:_norm_end(mapping, start, i2)])
        elif tag != 'delete':
            parts.append(new[j1:j2])
    return ''.join(parts)


def _apply(content: str, matches: list[Span], new: str, old: str | None) -> str:
    result = content
    for start, end in sorted(matches, reverse=True):
        replacement = _reindent(content[start:end], old, new) if old is not None else new
        result = result[:start] + replacement + result[end:]
    return result


def _escape_drift(content: str, matches: list[Span], new: str) -> str | None:
    region = ''.join(content[start:end] for start, end in matches)
    if ("\\'" in new or '\\"' in new) and "\\'" not in region and '\\"' not in region:
        return ('new_string contains escaped quotes that are not in the matched text. '
                'Use the file\'s actual quotes. The file was not modified.')
    return None


def replace(content: str, old: str, new: str, *, replace_all: bool = False) -> tuple[str, int, str | None, str | None]:
    """Return new text, match count, strategy and error. The input is unchanged on error."""
    if not old:
        return content, 0, None, (
            'old_string is empty. Set it to the exact existing text to replace, '
            'or use write_workspace_file to create or rewrite a file. Do not resend this call unchanged.')
    if not old.strip():
        return content, 0, None, 'old_string is only whitespace. Provide the non-blank text to replace.'
    if old == new:
        return content, 0, None, IDENTICAL
    for name, strategy in STRATEGIES:
        matches = strategy(content, old)
        if not matches:
            continue
        if len(matches) > 1 and not replace_all:
            return content, 0, None, (
                f'Found {len(matches)} matches. Add surrounding context so old_string is unique, '
                f'or set replace_all for an exact replacement.\n{_locations(content, matches)}')
        if replace_all and len(matches) > 1 and name in SIMILARITY:
            return content, 0, None, (
                f'Found {len(matches)} approximate matches via {name}. replace_all is limited to exact '
                'or line-trimmed matches. The file was not modified.')
        if name != 'exact' and (drift := _escape_drift(content, matches, new)):
            return content, 0, None, drift
        replacement = new
        if name == 'unicode_normalized':
            replacement = _preserve_unicode(content, matches, old, new)
        return _apply(content, matches, replacement, None if name == 'exact' else old), len(matches), name, None
    return content, 0, None, 'Could not find a match for old_string in the file. Read the file again or search for the current text.'
