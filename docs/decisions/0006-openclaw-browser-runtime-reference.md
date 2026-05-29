# Decision 0006: OpenClaw As Browser Runtime Reference

Date: 2026-05-28

## Status

Accepted.

## Context

The local-first assistant needs reliable browser automation for real tasks:
booking flows, form filling, source inspection, screenshots, shell/browser
computer activity, and long-running task execution.

Our first generic browser loop could open pages and act on snapshots, but direct
tests on Trenitalia and ItaloTreno exposed the weak point: the model repeated
ineffective actions, lost form state, and did not have a strict enough browser
contract.

OpenClaw has a mature browser methodology that matches the product direction:

- one coherent browser tool contract;
- snapshot before action;
- stable target/tab handles;
- Playwright AI/aria snapshots and refs;
- narrow actions;
- snapshot after state-changing actions;
- stale-ref recovery;
- explicit blockers for login, captcha, permissions, dialogs and unsafe gates;
- visible computer as an observation surface, not the automation primitive.

The checked OpenClaw repository is MIT licensed. We can reuse architecture and,
when useful, adapt code as long as license attribution is preserved for copied
substantial portions.

## Decision

Use OpenClaw as the primary implementation reference for the browser automation
runtime.

This means:

- port the methodology and contracts deliberately;
- prefer OpenClaw-compatible browser actions and snapshot semantics;
- keep our local-first Rust/Electron/Python architecture;
- avoid importing the whole OpenClaw plugin system;
- record attribution if we copy or closely adapt substantial code.

## Scope To Port

- Browser tool contract:
  - `status`, `profiles`, `tabs`, `open`, `navigate`, `snapshot`, `act`,
    `screenshot`, `dialog`, and later upload/download/PDF when needed.
- Snapshot contract:
  - Playwright AI snapshot first;
  - stable refs from the latest snapshot;
  - optional visible links via `urls=true`;
  - compact/interactive snapshots for model context.
- Action contract:
  - atomic actions;
  - canonical OpenClaw action names (`fill`, `select`, `press`,
    `scrollIntoView`, `clickCoords`, `evaluate`, `batch`) with legacy aliases
    kept only for compatibility;
  - bounded timeouts;
  - snapshot after action;
  - stale-ref recovery path.
- Loop contract:
  - observe -> decide -> act -> observe -> verify;
  - no-progress guard;
  - live checkpoints;
  - completion only after success criteria.
- Safety:
  - domain approval once/always;
  - headless/visible/auto choice;
  - explicit gates for submit, login, personal data, payments, purchases,
    uploads/downloads and destructive actions.

## Non-Scope

- Do not copy OpenClaw's entire plugin/runtime ecosystem.
- Do not switch to Chrome MCP as the first path.
- Do not rely on site-specific regex as the main strategy.
- Do not add Docker/noVNC before the controlled Playwright loop is stable.

## Consequences

Positive:

- We stop reinventing low-level browser-agent patterns.
- The browser work gets a clear production target.
- Tests can compare our contract against the OpenClaw-style behavior.

Risks:

- Blind code copying could import complexity we intentionally removed from
  Homun.
- OpenClaw's abstractions are broader than our current product slice.
- MIT attribution must be maintained when copying substantial code.

Mitigation:

- Port one bounded slice at a time.
- Keep behavior covered by local fixtures before testing real sites.
- Prefer our existing crate/module boundaries unless an OpenClaw structure
  clearly reduces risk.
