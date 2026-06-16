---
name: coding-standards
description: Use when creating, modifying, splitting, reviewing, or documenting project code structure and module boundaries
---

# Coding Standards

## Overview

Default standards guide code shape, but local project patterns win when they are clear and documented.

## Defaults

- One clear responsibility per file.
- Prefer small modules with explicit boundaries.
- Treat 250-400 lines as a review threshold.
- Split because responsibilities are mixed, not because a file crossed a number.
- Public contracts need types, tests, and documentation.
- New dependencies require a recorded reason in wiki memory.

## Before Changing Structure

1. Inspect nearby files and folder docs.
2. Identify the local pattern.
3. Record deviations in the plan.
4. Update `docs/wiki/code-standards.md` when a new durable standard emerges.

## File Size Gate

When a touched file is over the threshold, ask:

- Does it still have one responsibility?
- Are there separable helpers, adapters, or UI/state concerns?
- Would splitting reduce cognitive load for future tasks?

If yes, include the split in the plan. If no, document why it remains intact.

## Common Mistakes

- Applying generic architecture over a clear local convention.
- Splitting files mechanically without improving boundaries.
- Adding dependencies for convenience without recording tradeoffs.

