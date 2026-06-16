---
name: observability-logging
description: Use when diagnosing bugs, performance issues, production behavior, flaky systems, or any task where logs, metrics, traces, profiles, or structured runtime evidence are needed before choosing a fix
---

# Observability Logging

## Overview

No serious diagnosis should rely only on static code reading when runtime behavior matters. Before selecting a fix, check what the system logs, measures, traces, and profiles. If the data is missing, propose the smallest useful instrumentation before committing to a root cause.

## Required Gate

For non-trivial runtime, performance, integration, or production issues:

1. Identify existing logs, metrics, traces, profiles, reports, and debug flags.
2. State what each signal proves and what it cannot prove.
3. Identify missing signals needed to distinguish hypotheses.
4. Add or propose minimal instrumentation when the missing signal blocks diagnosis.
5. Define privacy and noise limits.
6. Prefer structured logs and metrics over raw transcript dumps or broad console spam.

## Observability Plan Shape

```markdown
## Observability And Logging Plan

| Signal | Source | Proves | Gap | Action |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

Privacy/noise limits:

Minimum instrumentation before fix:
```

## Good Signals

- Structured logs with request/task/message IDs.
- Timing spans around suspected slow paths.
- Counters for retries, errors, queue depth, dropped events, cache hits, and render counts.
- Performance profiles for UI/rendering issues.
- Persistent benchmark reports for performance claims.
- Correlated frontend/backend/native IDs for cross-layer flows.

## Bad Signals

- Raw secrets, API keys, personal data, prompts, or full chat transcripts.
- Console spam without IDs or timestamps.
- Logs that prove only that a function ran, not how long it took or what state mattered.
- Metrics that cannot be tied back to a hypothesis.

## Completion Criteria

Before claiming a diagnosis is strong:

- Say which runtime signals were checked.
- Say which signals were missing.
- Say whether missing instrumentation blocks the conclusion.
- Add the instrumentation task to the plan when needed.
