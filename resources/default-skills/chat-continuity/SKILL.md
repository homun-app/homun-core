---
name: chat-continuity
description: Use when starting a new chat, resuming work from another chat, handing off work, or preserving project context across conversations
---

# Chat Continuity

## Overview

Chat history is not durable project memory. Each meaningful chat must leave a concise handoff that the next chat can read without reconstructing the conversation.

## Start Gate

At the start of a new chat or when the user says "continue":

1. Read `docs/wiki/session-state.md`.
2. Read `docs/wiki/thread-ledger.md` if present.
3. Read the active plan and roadmap entries referenced there.
4. State current goal, last completed step, open decisions, blockers, and next action.

## Handoff Gate

Before ending meaningful work, update `docs/wiki/thread-ledger.md` with:

- Date and chat purpose.
- User intent.
- Files changed.
- Decisions made.
- Verification run.
- Current blocker or next action.
- Links to plans, benchmark results, or wiki pages.

## Ledger Entry

```markdown
## YYYY-MM-DD: Short Chat Title

**Intent:** ...
**Completed:** ...
**Changed:** ...
**Decisions:** ...
**Verification:** ...
**Next:** ...
```

## Common Mistakes

- Depending on the same long chat forever.
- Writing transcripts instead of durable summaries.
- Updating only roadmap but not the handoff ledger.
- Starting a new chat without reading the previous ledger entry.

