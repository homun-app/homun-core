# AGENTS.md — Homun

This file is a map for coding agents, not a spec. The authoritative guidance
lives in the files it points to; when they disagree with anything here, the
linked file wins, and when a linked file disagrees with the code, the code
wins. Engineering docs under `docs/` are written in Italian.

## Where to start

| Read | What it gives you |
| --- | --- |
| [`docs/README.md`](docs/README.md) | Doc index plus **verified commands and ports** (gateway `127.0.0.1:18765`, vite `127.0.0.1:1420`) |
| [`docs/STATO.md`](docs/STATO.md) | Living state: where the project is, next work, restart prompts |
| [`docs/architecture/`](docs/architecture/) | As-built subsystem map, rewritten from the code |
| [`docs/decisions/`](docs/decisions/) | Immutable ADRs — historical "why", not current state |

Do **not** use `docs/archive/` (including
`docs/archive/2026-07-31-doc-reset/`) as a specification; it is history only.

## Verification and gates

Before claiming a change is done, run the smallest check that covers it. The
full baseline route is `make test` from the repo root (Rust workspace tests +
browser-automation runtime tests).

| Gate | Command | What it protects |
| --- | --- | --- |
| Pre-release gate | `python3 scripts/pre_release_gate.py` | Deterministic release-readiness checks (runs in CI on every PR) |
| Gateway ownership contract | `python3 scripts/check_gateway_main_contract.py` | Keeps extracted startup owners out of `crates/desktop-gateway/src/main.rs` |
| Kernel regression gate | `python3 scripts/kernel_regression_gate.py` | Per-owner turn-lifecycle / gateway / chat-runtime regression tests |

Supporting contracts:

- [`docs/testing/anti-regression-protocol.md`](docs/testing/anti-regression-protocol.md) —
  minimum gate before closing chat/runtime/UI regressions (fixture-per-owner-level rule).
- [`docs/testing/gateway-ownership-contracts.md`](docs/testing/gateway-ownership-contracts.md) —
  gateway owner boundaries and anti-monolith rules.
- [`docs/testing/kernel-contract-matrix.md`](docs/testing/kernel-contract-matrix.md) —
  owner/test/smoke matrix for live kernel contracts.

All three gates also run in the `validate` job of
[`.github/workflows/build.yml`](.github/workflows/build.yml); a non-zero exit
fails the PR. Do not re-add logic to the gateway `main.rs` monolith to make a
test pass — the contract check will reject it.

## Desktop convention: `.mjs`/`.ts` twins

In [`apps/desktop/src/lib`](apps/desktop/src/lib), pure logic ships as pairs:
a `.mjs` file holds the implementation (runnable directly by Node tests) and a
same-named `.ts` wrapper imports it and adds the types — see
`threadAttentionState.ts` for the canonical shape. Tests live beside them as
`*.test.mjs`. When changing this logic:

- edit the `.mjs` implementation (never duplicate logic into the `.ts` wrapper);
- run the paired test with `node --test <file>.test.mjs` from `apps/desktop/`;
- the umbrella desktop route is `npm test` (discovery script
  `apps/desktop/scripts/run-unit-tests.mjs`): it discovers every `*.test.mjs`
  under `src`, `tests`, `electron`, and `scripts` by convention, so new test
  files join it without editing any enumerated list. The release and kernel
  gates consume this same route — never re-add per-file `node --test`
  inventories to the gate scripts.

## Repo layout

- `crates/` — Rust workspace (gateway: `local-first-desktop-gateway`, task
  runtime, memory, orchestrator, capabilities, subagents).
- `apps/desktop/` — Electron + React app; build/dev scripts in its
  `package.json` (`npm run electron:dev` for local runs — no version bumps).
- `runtimes/` — sidecars (browser automation, contained computer, channel
  bridges, host computer service).
- `scripts/` — gates and tooling (Python/Node), each with a paired unit test.
- `resources/default-skills/` — bundled default skills.
