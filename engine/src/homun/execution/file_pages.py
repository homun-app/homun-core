"""Line pages and read coverage for owned workspace files."""
from __future__ import annotations

import hashlib

from homun.domain.errors import ValidationError
from homun.execution.file_documents import extract
from homun.execution.files import WorkspaceFiles

PAGE_CHARS = 6000
DEFAULT_LINES = 200
MAX_LINES = 400
_DOCUMENTS = {'.pdf', '.docx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.xlsx', '.pptx', '.sqlite', '.db'}


def _lines(text: str) -> tuple[list[str], bool]:
    if text == '':
        return [], False
    parts = text.split('\n')
    if parts[-1] == '':
        parts.pop()
        return parts, True
    return parts, False


def page(files: WorkspaceFiles, path: str, *, offset: int = 1, limit: int = DEFAULT_LINES) -> dict:
    """Return one model-visible line page plus a compact coverage record."""
    if not 1 <= offset or not 1 <= limit <= MAX_LINES:
        raise ValidationError('Invalid line page')
    data = files.read(path)
    digest = hashlib.sha256(data).hexdigest()
    suffix = '.' + path.rsplit('.', 1)[-1].lower() if '.' in path else ''
    if suffix in _DOCUMENTS:
        return _document(path, data, digest, offset, limit)
    try:
        text = data.decode('utf-8')
        if '\x00' in text:
            raise UnicodeError()
    except UnicodeError:
        return {'path': path, 'sha256': digest, 'byte_size': len(data), 'binary': True,
                'representation': 'binary',
                'file_coverage': {'path': path, 'sha256': digest, 'complete': False, 'representation': 'binary'}}
    return _text_page(path, text, digest, len(data), offset, limit, 'utf-8')


def _document(path: str, data: bytes, digest: str, offset: int, limit: int) -> dict:
    found = extract(path, data)
    base = {'path': path, 'sha256': digest, 'byte_size': len(data), 'binary': True,
            'representation': 'extracted_text' if found['status'] == 'extracted' else 'binary',
            'extraction_status': found['status'], 'extraction_reason': found['reason']}
    coverage = {'path': path, 'sha256': digest, 'complete': False, 'representation': base['representation']}
    if found['status'] != 'extracted':
        return {**base, 'file_coverage': coverage}
    viewed = _text_page(path, found['text'], digest, len(data), offset, limit, 'extracted_text')
    viewed.update(binary=True, extraction_status='extracted', extraction_reason=found['reason'])
    viewed['file_coverage'] = coverage
    return viewed


def _text_page(path: str, text: str, digest: str, size: int, offset: int, limit: int, representation: str) -> dict:
    lines, _final_newline = _lines(text)
    total = len(lines)
    if offset > total and total:
        raise ValidationError(f'Line offset {offset} is past the end ({total} lines)')
    start = offset
    chosen, used, clamped = [], 0, False
    index = start
    while index <= total and len(chosen) < limit:
        line = lines[index - 1]
        if used + len(line) > PAGE_CHARS and chosen:
            break
        if len(line) > PAGE_CHARS - used:
            line = line[:PAGE_CHARS - used]
            clamped = True
        chosen.append({'number': index, 'text': line})
        used += len(line)
        index += 1
        if clamped:
            break
    end = chosen[-1]['number'] if chosen else offset - 1
    next_line = index if index <= total else None
    complete = representation == 'utf-8' and total == 0 or (
        representation == 'utf-8' and start == 1 and next_line is None and not clamped)
    return {'path': path, 'sha256': digest, 'byte_size': size, 'binary': False,
            'representation': representation, 'line_start': start if chosen else None,
            'line_end': end if chosen else None, 'total_lines': total, 'next_line': next_line,
            'line_clamped': clamped, 'lines': chosen,
            'file_coverage': {'path': path, 'sha256': digest, 'line_start': start if chosen else 1,
                              'line_end': end if chosen else 0, 'total_lines': total,
                              'complete': complete, 'representation': representation}}
