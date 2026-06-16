---
name: test-first-development
description: Use when implementing behavior changes, bug fixes, regressions, refactors with observable behavior, or any code change where a focused failing test can be written before production code
---

# Test First Development

## Overview

Behavior changes should normally start with a failing test. HomunCoder uses a pragmatic version of TDD: strict when behavior is testable, explicit when it is not, and always tied to fresh verification.

## Required Gate

Before production code for a testable behavior change:

1. Identify the behavior or regression.
2. Find the smallest relevant test surface.
3. Write or update one focused failing test.
4. Run it and confirm the failure is meaningful.
5. Implement the smallest change that makes it pass.
6. Re-run the focused test.
7. Run the broader affected verification from the plan.

## Exceptions

You may skip test-first only when:

- The task is docs-only, comments-only, formatting-only, or generated output.
- The repo has no practical test harness for the affected behavior.
- The change is exploratory and the user explicitly accepts a spike.
- The first useful step is instrumentation or a benchmark harness.

When skipping, state why and define the substitute evidence: manual check, benchmark, static contract, smoke test, or follow-up test task.

## Completion Criteria

Before claiming done:

- Record the failing test command and observed failure, or the explicit reason test-first was skipped.
- Record the passing focused test command.
- Record broader verification.
- Update roadmap/wiki when the behavior changes future work.

## Common Mistakes

- Writing implementation first and then backfilling a passing test.
- Treating a syntax/type error as a meaningful red test.
- Skipping tests silently because the harness is inconvenient.
