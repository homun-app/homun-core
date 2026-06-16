---
name: global-memory
description: Use when a user asks to remember preferences, cross-project patterns, conventions, or durable lessons beyond the current repository
---

# Global Memory

## Overview

Global memory stores user-approved knowledge that should apply across projects. It must not contaminate a repository with personal preferences unless the user explicitly wants that.

## Location

Use `~/.codex/memory/wiki/`:

- `index.md`: overview and links.
- `preferences.md`: confirmed user preferences.
- `patterns.md`: reusable engineering patterns.
- `lessons.md`: cross-project lessons.
- `open-questions.md`: unresolved or conflicting global facts.

## Confirmation Gate

Ask before writing global memory for:

- Personal preferences.
- Long-lived coding conventions.
- Team or workflow rules.
- Lessons inferred from one project.

Do not ask for low-risk local project facts; those belong in repo wiki memory.

## Write Shape

```markdown
## YYYY-MM-DD: Title

**Status:** Confirmed
**Scope:** Global
**Source:** User instruction / repeated project evidence
**Memory:** ...
```

## Privacy Rules

Never store secrets, credentials, private customer data, or sensitive personal information.

