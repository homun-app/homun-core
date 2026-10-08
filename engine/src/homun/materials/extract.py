"""Extract readable text from supported formats; never invent OCR."""

from __future__ import annotations

import csv
import io
import mimetypes
from dataclasses import dataclass
from pathlib import PurePosixPath
from homun.materials.office_archive import validate_archive, read_xml, workbook_sheets


EXTRACTED = "extracted"
UNSUPPORTED = "unsupported"
FAILED = "failed"
NONE = "none"

_TEXT_EXT = {".txt", ".md", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml"}
_PDF_EXT = {".pdf"}
_DOCX_EXT = {".docx"}
_XLSX_EXT = {".xlsx"}
_PPTX_EXT = {".pptx"}


@dataclass(frozen=True)
class ExtractResult:
    status: str
    text: str
    mime_type: str | None


def guess_mime(filename: str, declared: str | None = None) -> str | None:
    if declared and declared.strip() and declared != "application/octet-stream":
        return declared.strip()
    guessed, _ = mimetypes.guess_type(filename)
    return guessed


def extract_text(data: bytes, *, filename: str, mime_type: str | None = None) -> ExtractResult:
    mime = guess_mime(filename, mime_type)
    ext = PurePosixPath(filename).suffix.lower()

    if ext in _TEXT_EXT or (mime and mime.startswith("text/")) or mime in {
        "application/json",
        "application/csv",
        "text/csv",
        "application/x-yaml",
        "text/yaml",
    }:
        try:
            text = _decode_text(data)
            if ext in {".csv", ".tsv"} or mime in {"text/csv", "application/csv"}:
                text = _normalize_csv(text, dialect="excel-tab" if ext == ".tsv" else "excel")
            return ExtractResult(status=EXTRACTED, text=text, mime_type=mime or "text/plain")
        except Exception:  # noqa: BLE001
            return ExtractResult(status=FAILED, text="", mime_type=mime)

    if ext in _PDF_EXT or mime == "application/pdf":
        return _extract_pdf(data, mime=mime or "application/pdf")

    if ext in _DOCX_EXT or mime == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return _extract_docx(data, mime=mime or "application/vnd.openxmlformats-officedocument.wordprocessingml.document")

    if ext in _XLSX_EXT or mime == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        return _extract_xlsx(data, mime=mime or "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    if ext in _PPTX_EXT or mime == "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        return _extract_pptx(data, mime=mime or "application/vnd.openxmlformats-officedocument.presentationml.presentation")

    return ExtractResult(status=UNSUPPORTED, text="", mime_type=mime or "application/octet-stream")


def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _normalize_csv(text: str, *, dialect: str) -> str:
    reader = csv.reader(io.StringIO(text), dialect=dialect)
    rows = [", ".join(cell.strip() for cell in row) for row in reader if any(cell.strip() for cell in row)]
    return "\n".join(rows)


def _extract_pdf(data: bytes, *, mime: str) -> ExtractResult:
    try:
        from pypdf import PdfReader
    except ImportError:
        return ExtractResult(status=FAILED, text="", mime_type=mime)
    try:
        reader = PdfReader(io.BytesIO(data))
        parts: list[str] = []
        for page in reader.pages:
            chunk = page.extract_text() or ""
            if chunk.strip():
                parts.append(chunk.strip())
        if not parts:
            # Empty extract usually means scanned/image PDF — do not claim OCR.
            return ExtractResult(status=UNSUPPORTED, text="", mime_type=mime)
        return ExtractResult(status=EXTRACTED, text="\n\n".join(parts), mime_type=mime)
    except Exception:  # noqa: BLE001
        return ExtractResult(status=FAILED, text="", mime_type=mime)


def _extract_docx(data: bytes, *, mime: str) -> ExtractResult:
    import xml.etree.ElementTree as ET
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            validate_archive(zf)
            if "word/document.xml" not in zf.namelist():
                return ExtractResult(status=UNSUPPORTED, text="", mime_type=mime)
            root = read_xml(zf, "word/document.xml")
        # XML namespace for WordprocessingML
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs = []
        for p in root.iterfind(".//w:p", ns):
            texts = [t.text for t in p.iterfind(".//w:t", ns) if t.text]
            if texts:
                paragraphs.append("".join(texts))

        text = "\n\n".join(paragraphs).strip()
        if not text:
            return ExtractResult(status=UNSUPPORTED, text="", mime_type=mime)
        return ExtractResult(status=EXTRACTED, text=text, mime_type=mime)
    except Exception:  # noqa: BLE001
        return ExtractResult(status=FAILED, text="", mime_type=mime)


def _extract_xlsx(data: bytes, *, mime: str) -> ExtractResult:
    import xml.etree.ElementTree as ET
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            validate_archive(zf)
            names = set(zf.namelist())
            # 1. Read shared strings if present
            shared_strings = []
            if "xl/sharedStrings.xml" in names:
                root_ss = read_xml(zf, "xl/sharedStrings.xml")
                ns_ss = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
                for si in root_ss.findall(".//main:si", ns_ss):
                    shared_strings.append(''.join(t.text or '' for t in si.findall('.//main:t', ns_ss)))

            sheet_names = workbook_sheets(zf)
            if not sheet_names:
                return ExtractResult(status=UNSUPPORTED, text='', mime_type=mime)
            ns_sheet = {'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            rows = []
            for sheet_name, sheet_title in sheet_names:
                root_sheet = read_xml(zf, sheet_name)
                rows.append(f'[{sheet_title}]')
                for row in root_sheet.findall('.//main:row', ns_sheet):
                    cells = []
                    for c in row.findall('main:c', ns_sheet):
                        v = c.find('main:v', ns_sheet)
                        val = v.text if v is not None and v.text else ''
                        if c.get('t') == 's' and val.isdigit():
                            idx = int(val)
                            val = shared_strings[idx] if idx < len(shared_strings) else val
                        elif c.get('t') == 'inlineStr':
                            val = ''.join(t.text or '' for t in c.findall('.//main:t', ns_sheet))
                        coordinate = c.get('r')
                        if coordinate:
                            val = f'{coordinate}={val}'
                        cells.append(val.strip())
                    if any(cells):
                        rows.append(', '.join(cells))

        text = "\n".join(rows).strip()
        if not text:
            return ExtractResult(status=UNSUPPORTED, text="", mime_type=mime)
        return ExtractResult(status=EXTRACTED, text=text, mime_type=mime)
    except Exception:  # noqa: BLE001
        return ExtractResult(status=FAILED, text="", mime_type=mime)


def _extract_pptx(data: bytes, *, mime: str) -> ExtractResult:
    import xml.etree.ElementTree as ET
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            validate_archive(zf)
            slide_names = sorted(
                [n for n in zf.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")],
                key=lambda x: int("".join(filter(str.isdigit, x)) or 0),
            )
            if not slide_names:
                return ExtractResult(status=UNSUPPORTED, text="", mime_type=mime)

            ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
            slides_text = []
            for i, sname in enumerate(slide_names, start=1):
                root = read_xml(zf, sname)
                texts = [t.text for t in root.iterfind(".//a:t", ns) if t.text]
                if texts:
                    slides_text.append(f"[Slide {i}]\n" + "\n".join(texts))

        text = "\n\n".join(slides_text).strip()
        if not text:
            return ExtractResult(status=UNSUPPORTED, text="", mime_type=mime)
        return ExtractResult(status=EXTRACTED, text=text, mime_type=mime)
    except Exception:  # noqa: BLE001
        return ExtractResult(status=FAILED, text="", mime_type=mime)

