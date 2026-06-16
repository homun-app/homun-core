---
name: llm-wiki-memory
description: Use when a task depends on project history, prior decisions, architecture, recurring patterns, or continuity across sessions
---

# LLM Wiki Memory

## Overview

Maintain a Markdown wiki that future agents can read without reconstructing the project from chat history. Memory is compiled knowledge, not a transcript dump.

## Read Before Work

Read relevant pages:

- `docs/wiki/index.md`
- `docs/wiki/session-state.md`
- `docs/wiki/thread-ledger.md`
- `docs/wiki/architecture.md`
- `docs/wiki/decisions.md`
- `docs/wiki/sources.md`
- `docs/wiki/code-standards.md`
- `docs/wiki/open-questions.md`

## Write Rules

Write durable knowledge only:

- Architecture and module responsibilities.
- Decisions and rejected alternatives.
- Source conclusions.
- Recurring bug patterns.
- Open questions and contradictions.
- Current session state and next action.
- Cross-chat handoff entries.

Do not store secrets, credentials, private personal data, or raw chat logs.

## Decision Entries

Use this shape:

```markdown
## YYYY-MM-DD: Decision Title

**Decision:** ...
**Context:** ...
**Alternatives:** ...
**Consequence:** ...
```

## Contradiction Handling

If new information conflicts with existing memory, do not silently overwrite. Add an entry to `open-questions.md` and continue only when the conflict does not block the task.
