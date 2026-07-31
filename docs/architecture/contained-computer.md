# Contained Computer (as-built)

Verificato 2026-07-31. Runtime: `runtimes/contained-computer`.
Coordinator: `crates/desktop-gateway/src/setup_computer.rs`.
Client: `apps/desktop/src/lib/coreBridge.ts` (`electronPrepareSetupComputer` /
`electronSetupComputerStatus`).

Homun Computer is the isolated Docker environment for headed browser/shell work
and generated artifacts. First-run onboarding prepares it on Windows, macOS, and Linux
before the user selects a model.

## Setup API

The desktop renderer starts preparation with:

- `POST /api/setup/computer/prepare` — starts or joins the current preparation;
- `GET /api/setup/computer/status` — returns the latest observed phase.

Both return `phase`, `ready`, and an optional safe `error`. Stable phases:
`idle`, `checking_docker`, `preparing_image`, `starting_container`,
`verifying_browser`, `ready`, `failed` (`SetupComputerPhase` in
`setup_computer.rs`). A single coordinator generation fences late results from
older attempts.

Continue in onboarding is enabled only when the gateway reports `phase: ready`
and `ready: true`.

## Native lifecycle

The gateway drives Docker CLI directly (see sandbox/bootstrap helpers): resolve
Docker, hash packaged build inputs vs `homun.cc_hash`, build
`homun-contained-computer:local` when stale, recreate `homun-cc`, then verify
Chrome CDP and noVNC before marking ready.

`runtimes/contained-computer/up.sh` remains a developer helper, not the packaged
runtime path.

## Live view

UI surfaces (`ContainedComputerView`, chat computer panel, Settings) consume the
noVNC/view iframe with origin checks (`homun-novnc-state`, `event.origin` /
`event.source` guards). CDP and noVNC are the two readiness signals for the
container browser stack.
