---
name: small-task-fast-path
description: Use when a task is tiny, local, low-risk, docs-only, formatting-only, mechanical, or answerable with a direct command, and full roadmap/research ceremony would add more overhead than value
---

# Small Task Fast Path

## Overview

HomunCoder should be strict where rigor matters and lightweight where ceremony would slow the work without improving correctness. Use this skill to keep small tasks fast while preserving basic evidence and memory hygiene.

## Fast Path Criteria

A task can use the fast path when all of these are true:

- Scope is one small answer, one command, docs-only, formatting-only, or a narrow mechanical edit.
- No new external API, library, runtime, dependency, security boundary, or data migration is involved.
- No architectural decision or durable project direction changes.
- No dirty-worktree risk or unrelated user change conflict.
- Verification is obvious and cheap.

If any condition is false, use the normal roadmap/research/planning workflow.

## Required Minimal Gate

Even on the fast path:

1. Check the immediate context needed for the task.
2. Avoid stale claims for volatile facts.
3. Run the direct command, focused check, or `git diff --check` when files change.
4. State what was verified.
5. Update memory only if the task creates a durable decision, changes next action, or reveals a recurring pattern.

## Skip Rules

You may skip a written plan when the task is small enough that the plan would be longer than the work. Say the task is using the fast path if the normal workflow would otherwise be expected.

Do not use the fast path to avoid:

- documentation lookup for external APIs;
- a failing test for testable behavior changes;
- branch/workspace checks for risky work;
- observability for runtime diagnosis;
- memory updates after durable decisions.

## Completion Report

For small file changes, report:

```markdown
Fast path used:
- Scope:
- Verification:
- Memory update:
```

For direct answers or commands, a one-line verification note is enough.
