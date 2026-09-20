# F4.2 — Materials ingest (blob + extract + contribution)

**Date:** 2026-09-19  
**Status:** accepted (autonomy delivery)  
**Depends on:** Materials B3, AccessGrant B2, F4.1 durable run (contribution wait)  
**Slice intent:** Quasi–PR-06 core — archive + extract + Settings ingest + contribute-with-files; OCR out; no folder sync

## Goal

1. Copy uploaded/imported files into Homun blob storage under `data_dir`
2. Record origin name/path, hash, mime, size, version on `MaterialVersion`
3. Extract text from TXT / CSV / text PDF; mark unsupported formats without claiming they were read
4. HTTP ingest + content/blob reads; Settings upload/folder flatten + text preview
5. Contribution delivery can attach new files and/or existing material ids (Fonte=motore)

## Non-goals

- OCR / scanned PDF reading
- Continuous folder sync
- Peer transfer / encryption (D-CRYPTO-01 / F5)
- Full materials search index (list + title/mime filter only)
- Artifact generation (F4.4)

## Model extensions (`MaterialVersion`)

| Field | Meaning |
|-------|---------|
| `origin_name` | Original filename or relative path from folder pick |
| `relative_path` | Optional path within imported folder |
| `storage_relpath` | Path under `data_dir` for original bytes (nullable for note/link) |
| `byte_size` | Original size |
| `extract_status` | `none` \| `extracted` \| `unsupported` \| `failed` |
| `text` | Extracted text (or note body); empty when unsupported |

`kind` for ingested files stays `file_ref`; `source_uri` may hold `homun-blob://{material_id}/v{version}` after ingest.

## Package

`engine/src/homun/materials/`:

| Module | Job |
|--------|-----|
| `blob.py` | Write/read originals under `{data_dir}/materials/{id}/v{n}/original` |
| `extract.py` | Detect mime; extract TXT/CSV/PDF text; else unsupported |

## Commands / HTTP

| Surface | Behavior |
|---------|----------|
| `POST .../projects/{id}/materials/ingest` | Multipart: `file` (+ optional `relative_path`, `title`); write grant; returns material |
| `GET .../materials/{id}/content` | Metadata + extract_status + text (read grant) |
| `GET .../materials/{id}/blob` | Raw original bytes (read grant); 404 if no blob |
| `work.provide_contribution` | `text` optional if `material_ids` non-empty; `material_ref` = first id for DBOS |

## UI

- Settings → Progetti → Materiali: file/folder upload, extract badge, expandable text preview
- Chat contribution (engine): upload files → ingest into work’s project (ensure project) → provide_contribution

## Success criteria

1. TXT/CSV/PDF text → `extract_status=extracted` and `text` populated
2. `.bin` / image → stored, `unsupported`, text empty; never labeled “read”
3. Ingest without write grant → 403
4. Contribution with file only (no text) resolves request when materials attached
5. `features.materials=true`
