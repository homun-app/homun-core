---
name: subagent-result-verification
description: Use when a subagent, parallel worker, reviewer, or separate agent reports completion or recommends changes
---

# Subagent Result Verification

## Overview

Never trust a subagent completion report by itself. Verify the diff, tests, requirements, and memory updates independently.

## Verification Gate

After a subagent returns:

1. Read the reported status and concerns.
2. Inspect changed files or diff.
3. Compare changes with the plan and acceptance criteria.
4. Run or inspect the stated verification.
5. Confirm roadmap/wiki/folder docs were updated when required.
6. Decide: accept, request fix, provide more context, or escalate.

## Reject Completion When

- Required verification was not run.
- External API work lacks a source ledger entry.
- Structural changes lack folder docs or architecture update.
- The implementation exceeds plan scope without explanation.
- The report says “done” but leaves blocking concerns.

## Required Controller Output

State what was independently verified and what remains unverified.

