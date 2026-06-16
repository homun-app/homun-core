---
name: subagent-execution-controller
description: Use when coordinating one or more subagents, parallel workers, reviewers, or separate agent sessions through task decomposition, context packets, checkpoints, result verification, and final integration
---

# Subagent Execution Controller

## Overview

Context packing and result verification are not enough for serious delegated work. The controller owns decomposition, worker boundaries, checkpoints, conflict handling, verification, and final memory updates.

## Delegation Gate

Use subagents only when delegation improves the task:

- independent files or concerns can be worked in parallel;
- one worker can research while another inspects code;
- review should be independent from implementation;
- a large task benefits from separate checkpoints.

Do not delegate when the task is tiny, highly sequential, security-sensitive without reviewer capacity, or would require giving a worker ambiguous authority over broad repository state.

## Controller Workflow

1. Load roadmap, active plan, decisions, sources, code standards, and relevant folder docs.
2. Split work into independent task packets.
3. For each worker, use `subagent-context-packing`.
4. Define per-worker acceptance criteria and verification commands.
5. Require checkpoint status before integration:
   - `DONE`
   - `DONE_WITH_CONCERNS`
   - `NEEDS_CONTEXT`
   - `BLOCKED`
6. Use `subagent-result-verification` on every worker result.
7. Integrate only accepted results.
8. Run global verification after integration.
9. Update roadmap/wiki/thread ledger and folder docs when durable state changes.

## Worker Packet Template

```markdown
## Worker Packet

Role:
Task:
Non-goals:
Context files:
Relevant decisions:
Relevant sources:
Expected changes:
Verification:
Required report:
- Status:
- Files changed:
- Tests/checks run:
- Memory/docs updated:
- Risks:
```

## Controller Result

```markdown
## Subagent Controller Result

| Worker | Status | Accepted | Evidence | Follow-up |
| --- | --- | --- | --- | --- |

Integrated changes:
Global verification:
Memory/docs updated:
Rejected or deferred work:
Residual risk:
```

## Rejection Rules

Reject or request fixes when:

- the worker exceeded scope;
- verification is missing or stale;
- source/version evidence is missing for external APIs;
- roadmap/wiki/folder docs were required but not updated;
- the result conflicts with decisions or user constraints;
- the worker says `DONE` while reporting blocking concerns.

## Completion Criteria

- Every delegated result has an accept/reject/defer decision.
- Integration diff is reviewed by the controller.
- Global verification is fresh.
- Durable context is flushed after integration.
