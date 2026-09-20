"""Extract readable text from supported formats; never invent OCR."""

from __future__ import annotations

import csv
import io
import mimetypes
from dataclasses import dataclass
from pathlib import PurePosixPath


EXTRACTED = "extracted"
UNSUPPORTED = "unsupported"
FAILED = "failed"
NONE = "none"

_TEXT_EXT = {".txt", ".md", ".csv", ".tsv", ".json", ".log"}
_PDF_EXT = {".pdf"}


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
