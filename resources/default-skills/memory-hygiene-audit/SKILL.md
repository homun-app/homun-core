---
name: memory-hygiene-audit
description: Use when checking project wiki health, roadmap freshness, source ledger quality, decision drift, session-state continuity, or cross-chat handoff quality
---

# Memory Hygiene Audit

## Overview

Markdown memory is only useful when it is current, compact, and easy to trust. Audit it regularly so future chats do not inherit stale next actions, missing sources, duplicate decisions, or incomplete handoffs.

## When To Run

Run after:

- Meaningful roadmap or decision changes.
- Long research sessions.
- Multi-chat handoffs.
- Benchmark runs.
- Before claiming the project memory is reliable.
- When a future chat resumes from project memory.

## Diagnostic Command

From the plugin root:

```bash
./scripts/memory-audit.sh
```

## Checks

The audit should verify:

- Required wiki files exist.
- `docs/roadmap.md` has a `## Next Action`.
- `docs/wiki/session-state.md` has a `## Next Action`.
- `docs/wiki/sources.md` keeps source rows with enough table fields.
- `docs/wiki/decisions.md` has unique decision headings.
- `docs/wiki/thread-ledger.md` has complete handoff fields.
- Memory pages are not growing beyond review thresholds.
- No stale "pending final validation" markers remain.

## Output Rules

- Print actionable pass/fail/warn lines.
- Do not rewrite memory automatically.
- Do not dump full wiki pages.
- Treat warnings as review prompts, not automatic failures.

## Common Fixes

- Missing next action: update roadmap and session state with one concrete action.
- Incomplete source row: add version/date/conclusion.
- Duplicate decision heading: merge or rename the newer heading.
- Oversized page: summarize older entries into durable decisions and archive verbose history.
- Pending validation marker: replace it with actual command evidence.
