# F3.5 UsageAttempt ledger — implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans.

**Goal:** Record interpret attempts with command context; never invent token zeros.

**Spec:** `docs/superpowers/specs/2026-09-18-f35-timeout-streaming-design.md` (slice D)

---

- [x] Spec slice D
- [x] `UsageAttempt` + `AttemptContext` types
- [x] Wire `run_interpret_with_retry` + domain post_message context
- [x] `GET /v1/models/usage-attempts` + Settings list
- [x] Tests
- [x] Docs / piano / roadmap
