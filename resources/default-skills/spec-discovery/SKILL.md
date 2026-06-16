---
name: spec-discovery
description: Use when starting creative feature work, ambiguous product changes, UX behavior changes, architecture choices, or any task where requirements, constraints, success criteria, or non-goals are not yet crisp
---

# Spec Discovery

## Overview

Before implementation, ambiguous work needs a crisp spec. This skill replaces vague brainstorming with a short discovery loop that captures intent, constraints, non-goals, risks, and acceptance criteria.

## Discovery Gate

Use this before coding when:

- the requested behavior is broad or creative;
- user intent has multiple plausible interpretations;
- UX, architecture, data model, security, performance, or pricing choices are involved;
- the implementation affects multiple folders or long-running project direction.

Skip this only when the task qualifies for `small-task-fast-path` or the user explicitly provides a complete spec.

## Required Output

Produce a concise spec before implementation:

```markdown
## Working Spec

Goal:
Non-goals:
Users / callers:
Current behavior:
Desired behavior:
Constraints:
Relevant decisions/sources:
Acceptance criteria:
Risks:
Open questions:
```

## User Loop

Ask for clarification when an open question changes architecture, data durability, security, cost, UX, or schedule. If the user asks to proceed autonomously, state assumptions and record them in the plan or wiki when durable.

## Completion Criteria

- Acceptance criteria are testable or verifiable.
- Non-goals prevent scope creep.
- External APIs, libraries, and known issues are routed through current-doc research.
- Durable assumptions are recorded in roadmap/wiki.
