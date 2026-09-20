# MaterialVersion — slice B3

**Date:** 2026-09-18  
**Status:** accepted  
**Depends on:** AccessGrant B2

## Goal

Project-scoped **metadata** ledger for materials (`note` | `link` | `file_ref`).
No binary upload or sync in B3 — `file_ref` is a URI/path string only.

## Model

`MaterialVersion`: id, workspace_id, project_id, title, kind, text, source_uri,
content_hash, mime_type, version, status (`active` | `archived`), created_by.

## Commands

| Command | Behavior |
|---------|----------|
| `material.create` | Requires **write** on project |
| `material.update` | expected_version; write |
| `material.archive` | write |

## HTTP / UI

- `GET /projects/{id}/materials` — requires **read**; archived hidden by default
- `GET /materials/{id}` — requires read on owning project
- Settings → Progetti: list/add/archive materials when a project is selected

Materials do not auto-write memory; memory isolation via `project_id` is unchanged.

## Success criteria

1. Cannot create material without write grant.
2. Read grant can list; no grant → 403.
3. Archive hides from default list.
