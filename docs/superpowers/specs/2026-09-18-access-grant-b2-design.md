# AccessGrant — slice B2

**Date:** 2026-09-18  
**Status:** accepted  
**Depends on:** Projects + Teams B1

## Goal

Deny-by-default project access via `AccessGrant`. Organizational membership
(`member_ids` / team links) is **not** a grant.

## Model

`AccessGrant`: id, workspace_id, subject_id, resource_type (`project` only in B2),
resource_id, capability (`read` | `write` | `admin`), issuer_id, status
(`active` | `revoked`), optional expires_at.

Capability ladder: admin ⊃ write ⊃ read. Only active non-expired grants count.

## Commands

| Command | Behavior |
|---------|----------|
| `grant.issue` | Issuer must have `admin` on the project |
| `grant.revoke` | Sets status=revoked; requires `admin` |

Bootstrap: `project.create` / `project.create_from_conversation` issues an
`admin` grant to the creating actor.

## Enforcement

`require_project_capability` in `homun.policy`:

- `GET /projects` filtered to readable projects (actor headers required)
- `GET /projects/{id}` requires read
- `project.update` / `project.archive` require write
- `grant.issue` / `grant.revoke` require admin

Teams stay listable within the workspace (org directory).

## Success criteria

1. Creator sees project; second actor without grant gets empty list / 403.
2. Issue read → visible; revoke → deny again.
3. Write without write grant fails update.
4. Settings → Progetti lists/issues/revokes grants on selected project.
