---
name: context7-research
description: Use when a task depends on external libraries, SDKs, APIs, framework behavior, setup steps, or version-specific documentation
---

# Context7 Research

## Overview

Use current documentation before planning or coding against external APIs. Context7 is preferred when available; official documentation is the fallback.

## Research Order

1. If Context7 MCP tools are available, resolve the library and query docs for the exact task.
2. If the `ctx7` CLI is available, use `ctx7 library` and `ctx7 docs`.
3. If Context7 is unavailable or incomplete, use official online documentation.
4. If the choice affects architecture, runtime behavior, rendering, performance, deployment, security, or data durability, use `web-and-github-research` to check known issues and mitigations.
5. If broader web/project research is needed, use `web-and-github-research`.
6. If docs conflict with repo source or tests, inspect the repo and record the conflict.

## Source Ledger Gate

Before writing code that depends on external docs, update or prepare an entry for `docs/wiki/sources.md`:

| Date | Channel | Library/Topic | Version | URL or Context7 ID | Conclusion |
| --- | --- | --- | --- | --- | --- |

Record fallback reason when Context7 was not used.

## Required Output Before Planning

State:

- Library/API searched.
- Version or version assumption.
- Source channel used.
- Implementation-relevant conclusion.
- Known issue search performed or why it was unnecessary.
- Any uncertainty.

## Common Mistakes

- Using old training-data examples for current SDKs.
- Accepting a Context7 snippet without checking version relevance.
- Skipping source ledger updates.
- Treating community examples as official docs without labeling them.
