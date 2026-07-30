# Decision 0028: Retire the unwired mistral.rs provider

Date: 2026-07-30

## Status

Accepted.

## Context

Decision 0007 selected mistral.rs as a possible in-process local inference
engine. An implementation remained behind the optional `local-mistralrs`
feature, but the production gateway no longer enabled or routed to it. The
active model resolver maps local providers, including the legacy `mistralrs`
label, onto the shared OpenAI-compatible transport.

Keeping the unreachable provider added a second inference transport contract,
hundreds of locked transitive dependencies, and three RustSec maintenance
warnings. It also made the documented architecture disagree with the shipped
runtime.

## Decision

Remove the in-process mistral.rs provider, its feature flags, and its standalone
smoke example. Local model runtimes integrate through the same
OpenAI-compatible provider contract used by the gateway. Rust continues to own
routing, privacy policy, capability checks, usage accounting, and audit.

The inference transport inventory rejects reintroducing the retired path
without an explicit architecture change.

## Consequences

- The shipped and documented inference paths now agree.
- The release lockfile no longer carries unused mistral.rs dependencies.
- Local runtimes remain replaceable behind one provider contract.
- Reintroducing an in-process engine requires a new decision, production router
  integration, cross-platform packaging evidence, and release-gate coverage.
