---
name: code-review-discipline
description: Use when requesting code review, reviewing completed work, receiving review feedback, evaluating reviewer suggestions, or deciding whether a change is ready after implementation
---

# Code Review Discipline

## Overview

Code review is a verification surface, not a social ritual. Use it to catch correctness, maintainability, security, testing, and documentation gaps before work is considered complete.

## Requesting Review

When asking another agent or reviewer to review work, provide:

- Goal and non-goals.
- Relevant plan or requirements.
- Files changed or diff range.
- Key decisions and constraints.
- Sources and known limitations.
- Verification already run.
- Specific review focus.

Ask the reviewer to return findings ordered by severity:

- `Blocking`: correctness, data loss, security, broken build, missing required verification.
- `Important`: likely regression, brittle design, missing test for changed behavior, confusing ownership.
- `Minor`: style, naming, small cleanup.

## Receiving Review

Before implementing feedback:

1. Read all items.
2. Restate unclear items or ask for clarification.
3. Verify each claim against the codebase.
4. Accept, reject, or defer with technical reasoning.
5. Fix one logical group at a time.
6. Re-run relevant verification.

Do not blindly implement external suggestions. Push back when a suggestion breaks existing behavior, conflicts with a recorded decision, violates YAGNI, or cannot be verified.

## Required Review Output

When completing a review pass, report:

```markdown
## Review Result

| Severity | Finding | Evidence | Decision | Verification |
| --- | --- | --- | --- | --- |
|  |  |  | accept/reject/defer |  |

Residual risk:
```

If no issues are found, say that explicitly and state remaining test gaps.

## Completion Criteria

- Review findings are grounded in file paths, diffs, tests, or docs.
- Blocking and Important findings are fixed or explicitly accepted by the user as deferred.
- Verification is fresh after fixes.
- Durable decisions or recurring review lessons are added to memory when relevant.
