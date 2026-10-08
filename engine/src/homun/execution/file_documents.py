"""Bounded text extraction for workspace reads. No OCR is invented."""
from __future__ import annotations

import io
import zipfile
from xml.etree import ElementTree

from homun.domain.errors import ValidationError

_W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
_PDF = {'.pdf'}
_DOCX = {'.docx'}


def extract(name: str, data: bytes) -> dict:
    """Return extracted text or an explicit unavailable/failed status."""
    extension = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    suffix = f'.{extension}' if extension else ''
    if suffix in _PDF:
        return _pdf(data)
    if suffix in _DOCX:
        return _docx(data)
    if suffix in {'.xlsx', '.pptx'}:
        from homun.materials.extract import extract_text
        result = extract_text(data, filename=name)
        status = result.status if result.status in {'extracted', 'failed'} else 'unavailable'
        return {'status': status, 'text': result.text,
                'reason': f'{suffix} text extraction: {status}; formulas and visual layout are not evaluated'}
    if suffix in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.sqlite', '.db'}:
        return {'status': 'unavailable', 'text': '',
                'reason': f'{suffix} text extraction is not available in this workspace read'}
    raise ValidationError('Not an extracted document')


def _pdf(data: bytes) -> dict:
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        parts = [chunk.strip() for page in reader.pages if (chunk := page.extract_text() or '').strip()]
    except Exception as exc:  # noqa: BLE001 — extraction failure is data, not a crash.
        return {'status': 'failed', 'text': '', 'reason': f'PDF text extraction failed: {type(exc).__name__}'}
    if not parts:
        return {'status': 'unavailable', 'text': '',
                'reason': 'PDF has no extractable text. Scanned pages are not transcribed.'}
    return {'status': 'extracted', 'text': '\n\n'.join(parts), 'reason': 'Extracted PDF text, not the original bytes.'}


def _xml(payload: bytes):
    folded = payload.upper()
    if b'<!DOCTYPE' in folded or b'<!ENTITY' in folded:
        raise ValueError('DTD is not allowed in a workspace document')
    return ElementTree.fromstring(payload)


def _docx(data: bytes) -> dict:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            from homun.materials.office_archive import validate_archive, read_xml
            validate_archive(package)
            root = read_xml(package, 'word/document.xml')
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError, OSError, ValueError) as exc:
        return {'status': 'failed', 'text': '', 'reason': f'DOCX text extraction failed: {type(exc).__name__}'}
    lines = []
    for paragraph in root.iter(f'{_W}p'):
        guides = {node for ruby in paragraph.iter(f'{_W}rt') for node in ruby.iter()}
        text = ''.join((node.text or '') for node in paragraph.iter(f'{_W}t') if node not in guides)
        lines.append(text)
    if not any(line.strip() for line in lines):
        return {'status': 'unavailable', 'text': '', 'reason': 'DOCX contains no extractable text'}
    return {'status': 'extracted', 'text': '\n'.join(lines), 'reason': 'Extracted DOCX paragraph text, not the original package.'}
