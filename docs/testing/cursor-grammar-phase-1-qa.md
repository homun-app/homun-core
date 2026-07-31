# Cursor Grammar Phase 1 QA

Date: 2026-07-31

Visual scope commits: `b11a181b..c1ea6f14`

Runtime: Electron dev on `127.0.0.1:1420`, gateway on `127.0.0.1:18765`

## Deterministic gates

The following commands completed with exit code `0`:

```bash
cargo fmt --check
cargo test -p local-first-task-runtime
cargo test -p local-first-engine
cargo test -p local-first-desktop-gateway

cd apps/desktop
npm run test:cursor-grammar
npm run test:ui-contract
npm run test:electron
npm run typecheck
npm run build
npm run package:prepare
```

Observed totals include 92 cursor-grammar tests, 152 Electron tests, 87 task-runtime unit tests,
170 engine unit tests, and 1088 gateway unit tests. The gateway suite kept 6 live-provider fixtures
ignored by design. Package preparation produced the gateway, contained computer, PDFium, default
skills, Telegram and WhatsApp bridges, and browser-automation resources. `npm audit` reported zero
vulnerabilities during preparation.

## Real Electron scenarios

The old dev owners of ports `1420` and `18765` were stopped and the current checkout was launched
with `npm run electron:dev`. `GET /api/health` returned `200`, `ok: true`, no recovered stores, and no
projection worker error.

| Scenario | Result |
|---|---|
| Existing presentation task with generated artifacts | Transcript, prompt and capability rail rendered without overlap |
| Activity rail section | Opened from collapsed state and displayed durable activity evidence |
| Artifacts rail section | Replaced Activity directly; selecting an artifact opened the inspector |
| Inspector coexistence | Adaptive rail yielded to the real sibling inspector column |
| Runtime & Context | Dialog exposed effective model/provider/role/context fields and kept unknown values unavailable |
| Composer Add menu | Compact searchable root opened; Models, Capabilities and Connectors were reachable |
| Nested Models menu | Opened beside Add; first Escape returned to Add, second Escape closed the chain |
| Sidebar filters | Compact root and nested Project menu opened without clipping |
| Themes | Cold and Dark surfaces rendered cleanly; Dark was restored after the check |

The adaptive island was left collapsed and the preferred Dark theme restored. This is source/dev QA,
not proof of a signed or installed release; installer, upgrade-profile and cross-platform checks remain
owned by `release-candidate-matrix.md`.
