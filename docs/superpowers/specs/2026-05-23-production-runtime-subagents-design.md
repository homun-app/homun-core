# Production Runtime And Subagents Design

## Goal

Bring the local Gemma runtime and Rust subagent manager to the same production-ready standard as the memory component: local-first, auditable, cancellable, typed at public boundaries and testable without cloud services.

## Runtime Definition Of Done

The Python/MLX runtime is production-ready when:

- configuration is explicit and environment-driven.
- `/health` reports process, model, readiness and concurrency state.
- all endpoint failures use a stable error response shape.
- generation requests are serialized by a runtime lock and rejected when the runtime is busy unless the caller opts to wait.
- request deadlines are enforced before generation starts and reflected in errors.
- local image paths are validated and cannot escape allowed roots when an allowed root is configured.
- benchmark responses include aggregate metrics and per-case results.
- shutdown can be disabled for embedded/production mode.
- all behavior is covered by unit tests without loading the real model.

## Subagents Definition Of Done

The Rust subagent manager is production-ready when:

- public boundaries expose typed errors.
- task budget and timeout semantics are enforced by the runner.
- task cancellation is represented in state and can prevent execution before runtime call.
- orchestration persists workflow runs, not only individual results.
- UI-facing status APIs can report task state, latest result, recent failures and review status.
- memory access for `MemoryAgent` is explicit and goes through the memory facade contracts.
- audit is automatic for success, failure, timeout and cancellation.
- tests cover recovery, cancellation, timeout, invalid permissions and audit queries.

## Boundaries

The runtime remains a local Python sidecar. It does not decide autonomy, permissions, routing or tool execution. The Rust subagent crate owns task orchestration, permission checks, memory access envelopes and audit.

The runtime remains cloud-free and Ollama-free.

## Implementation Order

1. Harden the Python runtime first because the subagent runner depends on it.
2. Harden Rust subagents after runtime behavior is stable.
3. Connect `MemoryAgent` to the production memory facade after both runtime and subagent boundaries are stable.
