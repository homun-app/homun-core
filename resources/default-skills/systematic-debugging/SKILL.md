---
name: systematic-debugging
description: Use when encountering bugs, failing tests, build failures, regressions, flaky behavior, or unexpected runtime behavior
---

# Systematic Debugging

## Overview

Find root cause before fixing. Guessing creates churn and pollutes memory with false explanations.

## Debugging Flow

1. Read the full error and relevant logs.
2. Reproduce the issue.
3. Check recent changes.
4. Compare broken behavior with nearby working patterns.
5. Check whether logs, metrics, traces, profiles, or benchmark reports can distinguish likely hypotheses.
6. If observability is missing and blocks diagnosis, add or propose minimal instrumentation before fixing.
7. For non-trivial field issues, use `field-engineering-depth` before fixing.
8. Form one hypothesis.
9. Test the smallest change or diagnostic.
10. Add a regression test when practical.
11. Fix root cause.
12. Verify and update memory if the bug teaches a durable lesson.

## Stop Conditions

Stop and re-investigate when:

- The issue is not reproducible.
- The fix would be speculative.
- The needed runtime evidence is missing and no instrumentation plan exists.
- Two attempted fixes failed.
- A new architectural problem appears.
- The local flow crosses multiple layers and no field-depth report exists.

## Required Record

For non-trivial bugs, record in the plan or wiki:

- Symptom.
- Root cause.
- Verification command.
- Logs/metrics/traces/profiles checked, or instrumentation needed.
- Regression test or reason it was not practical.
- Field-depth report path for non-trivial issues.
- Any recurring pattern learned.
