# F4.2 Materials Ingest Implementation Plan

> **For agentic workers:** Execute task-by-task. Autonomy delivery — do not block on questions.

**Goal:** Blob archive + text extract + HTTP ingest + Settings/contribution UI for Homun materials.

**Architecture:** `homun.materials` owns blob IO and extract; DomainService creates/updates `MaterialVersion`; FastAPI multipart ingest; web client wires Settings upload and engine contribution.

**Tech Stack:** FastAPI UploadFile, hashlib, pypdf (text PDF), existing AccessGrant.

**Spec:** `docs/superpowers/specs/2026-09-19-f42-materials-ingest-design.md`

---

## Files

| Path | Role |
|------|------|
| `engine/src/homun/materials/` | blob + extract |
| `engine/src/homun/domain/models.py` | MaterialVersion fields |
| `engine/src/homun/domain/service.py` | ingest_bytes; provide_contribution material_ids |
| `engine/src/homun/routes/domain.py` | ingest / content / blob |
| `engine/pyproject.toml` | pypdf |
| `engine/tests/test_f42_materials_ingest.py` | extract + HTTP + contrib |
| `apps/web/src/lib/engine-projects-client.ts` | ingestMaterial |
| Settings + useEngineWorkspace / bridge | UI + engine contribute |

### Task 1: materials package + model
- [x] blob + extract; MaterialVersion fields; pypdf + multipart

### Task 2: DomainService ingest + contribution materials
- [x] ingest_file; provide_contribution material_ids; ensure_project_for_work

### Task 3: HTTP + tests
- [x] ingest / content / blob; test_f42_materials_ingest.py

### Task 4: Web client + Settings + engine contribute
- [x] ingestEngineMaterial; Settings upload; fulfillContribution engine path

### Task 5: Docs / piano / roadmap / capabilities.materials=true
- [x] Done
