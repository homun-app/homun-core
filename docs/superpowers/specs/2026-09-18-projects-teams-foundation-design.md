# Projects + Teams foundation — slice B1

**Date:** 2026-09-18  
**Status:** accepted  
**Depends on:** F1 domain, F2 SQLite, Agents foundation

## Goal

Homun **Project** and **Team** as organizational objects: membership, optional coordinator, versioned commands, HTTP reads, Settings UI. No AccessGrant, no file materials.

## Objects

See plan. Key rule: team/project membership is organization only — does not invent AccessGrant.

## Success criteria

1. Domain tests: create/update/archive project and team; bad coordinator rejected.
2. HTTP list/get for both.
3. Settings → Progetti works when Fonte=motore; engine down → gate, no simulation fallback.
