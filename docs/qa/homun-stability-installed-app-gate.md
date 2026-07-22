# Homun stability — installed app gate

Date: 2026-07-22  
Bundle: `apps/desktop/dist-installers/mac-arm64/homun.app`  
Version: `0.1.1` (`app.homun.desktop`, arm64)  
Commit: `9e483a5ae6b73002ef51220e1351c5aff73d1aed`

This gate keeps installed-app evidence separate from unit, integration and build evidence. A row is
`PASS` only when its stated evidence level actually ran; skipped provider tests are not counted as
green live coverage.

| Requirement | Level | Result | Evidence |
| --- | --- | --- | --- |
| Signed installable bundle | Installed bundle | PASS | Deep strict `codesign` verification; Developer ID `MQ5CGAH889`; `artifacts/qa/installed-package.json` |
| Stale terminal resource recovery on restart | Installed bundle + real profile | PASS | A cancelled turn's orphan `browser_session` reservation was removed at boot, its lease cleared, and the previously waiting turn resumed to `completed` |
| Cancel a running chat without leaking its browser slot | Installed bundle + real provider | PASS | Reservation observed before cancellation; terminal `cancelled`; reservation count reached zero; `artifacts/qa/installed-cancellation.json` |
| Three independently queued chats settle | Installed bundle + real provider | PASS | A, B and C all `completed` in 34.394 s; `artifacts/qa/installed-stability-soak.json` |
| Background completion never changes the open chat | Installed bundle + renderer | PASS | B remained the durable and visible selection after A, B and C settled; the privacy-safe wide screenshot shows B selected and C still unread after A was opened for the cursor test |
| Exactly one terminal and one assistant response per turn | Installed bundle + real provider | PASS | Each of A/B/C has `terminal_count=1` and `assistant_count=1` |
| Raw reasoning absent from the conversation | Installed bundle + renderer + logs | PASS | Soak violation set empty; visible DOM and desktop/gateway logs contain zero configured reasoning markers |
| Completion indicator is fixed Homun teal | Installed renderer | PASS | Computed dot color `rgb(21, 122, 110)`, `animation-name: none`; `artifacts/qa/installed-stability-wide.png` |
| Opening one unread chat clears only that chat | Installed renderer, real click | PASS | Opening the newest A changed completed-unread dot count 5 -> 4; no other unread cursor regressed |
| Compact layout remains usable | Installed renderer, 900x700 | PASS | No document overflow; composer remains inside viewport; `artifacts/qa/installed-stability-compact.png` |
| noVNC readiness and connected viewer | Live contained computer | PASS | Prior live connected session from this branch; `artifacts/qa/novnc-readiness.png` |
| Publisher-aware skills, proactive source/freshness, bounded browser failure | Automated release gate + earlier live checks | PASS | Covered by `artifacts/qa/pre-release-gate.log` and targeted UI/runtime tests; not re-clicked in this installed-app pass |

## Visual review

At the launched 1360x900 renderer, the sidebar, active conversation and composer are fully visible.
The selected row is stable, completed background rows are announced and visibly marked, the
conversation has one readable assistant response, and no reasoning trace is present. At 900x700 the
sidebar collapses to the intended compact header without horizontal or vertical document overflow;
the composer remains reachable.

Negative checks: no auto-navigation, duplicate assistant bubble, duplicate terminal, pulsing
completion dot, raw reasoning marker, shell overflow or leaked resource reservation was observed in
the final installed bundle.

## Deliberate exclusions

- The three turns were accepted together but completed A -> B -> C because the conservative shared
  browser governor intentionally allows one `BrowserSession` at a time. Out-of-order completion was
  not forced; selection monotonicity is additionally covered by the attention-state tests.
- Six explicit live-Ollama tests remain ignored in the full gateway suite; they are not represented
  as passing live evidence. The installed run used the configured Deepseek provider.
- `qwen3.5:2b` is not an accepted privacy-guard default: it failed the versioned benchmark.
  `qwen3.5:4b` is the smallest qualified local guard; the conversation provider shown in the
  screenshot is a separate role.
- The directory bundle is Developer-ID signed but not notarized. Notarization credentials/options
  must be configured before distribution outside the development machine.
