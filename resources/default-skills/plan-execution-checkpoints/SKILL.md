---
name: plan-execution-checkpoints
description: Use when executing a written plan, resuming a multi-step implementation, coordinating checkpoints, deciding whether to continue, pause, revise the plan, or hand off remaining work
---

# Plan Execution Checkpoints

## Overview

A written plan is only useful if execution stays aligned with it. This skill adds checkpoint discipline between planning and completion.

## Execution Gate

Before executing a plan:

1. Read the active plan and roadmap next action.
2. Confirm scope, non-scope, acceptance criteria, and verification commands.
3. Check branch/workspace state.
4. Identify the next smallest checkpoint.

## Checkpoint Loop

For each checkpoint:

1. State the checkpoint goal.
2. Make the smallest coherent change.
3. Run the focused verification for that checkpoint.
4. Compare the result to the plan.
5. Decide: continue, revise plan, request clarification, or stop.

Revise the plan when implementation reality changes scope, risk, architecture, verification, or next action.

## Required Handoff

When pausing or handing off:

```markdown
## Execution Handoff

Completed checkpoints:
Current checkpoint:
Changed files:
Verification run:
Plan changes:
Blockers:
Next concrete action:
```

## Completion Criteria

- Every completed checkpoint has fresh verification.
- The active plan and roadmap still agree.
- Open blockers and next action are explicit.
- Memory is updated when execution changes durable state.
