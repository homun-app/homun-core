# Electron Chat Rendering Field Report

Date: 2026-05-26

Scope: analyze the current Electron chat rendering path after the Tauri removal.
This is an analysis-only report. No application source code was changed.

Non-scope: fixing rendering behavior, adding a benchmark harness, or changing the
chat runtime/gateway architecture.

## Local Flow Map

- Electron shell starts in `apps/desktop/electron/main.cjs`. It loads
  `LOCAL_FIRST_DESKTOP_URL` or `http://127.0.0.1:1420/` into a `BrowserWindow`
  sized 1360x900 with `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, and `webSecurity: true`.
- Vite/React entry is `apps/desktop/src/main.tsx`, with app-level chat state in
  `apps/desktop/src/App.tsx`.
- `App.tsx` owns `chatThreads`, `activeThreadId`, and a per-thread
  `threadMessages` record. It initializes with the local mock ready message, then
  calls `coreBridge` for thread/message snapshots when threads change.
- Chat UI ownership is `apps/desktop/src/components/ChatView.tsx`.
  `threadMessages` is `optimisticMessages ?? messages`, so streaming can update
  only the chat view before committing back to app state.
- Submit path:
  `ChatView.submitPrompt` creates a local user message and empty assistant
  message, registers `coreBridge.listenChatStreamDelta`, and calls
  `coreBridge.submitChatPromptStream`.
- Current Electron stream path:
  `coreBridge.submitChatPromptStream` delegates to
  `submitBrowserRuntimeChatPromptStream` in `apps/desktop/src/lib/coreBridge.ts`.
  It calls `http://127.0.0.1:8765/generate_stream`, parses newline-delimited
  events from `ReadableStreamDefaultReader`, forwards deltas through
  `chatApi.notifyChatStreamDelta`, then commits the final result to the local
  in-memory chat store.
- Current thread persistence is temporary and local to the renderer:
  `apps/desktop/src/lib/chatApi.ts` stores `localThreads` and `localMessages`
  until the standalone Rust gateway is extracted.
- Streaming rendering:
  `ChatView` accumulates `streamedText` and schedules a single React state update
  per `requestAnimationFrame`. The visible streaming assistant message renders
  through `<RichMessage streaming />`.
- Streaming rich rendering is intentionally bypassed:
  `RichMessage.tsx` returns `StreamingTextMessage`, a single text node with
  `white-space: pre-wrap`, while `streaming` is true.
- Completed rich rendering:
  `RichMessage.tsx` lazy-loads `RichMessageRenderer` only when text needs rich
  Markdown. `RichMessageRenderer.tsx` normalizes Markdown/Rust-like code, then
  renders with `react-markdown`, `remark-gfm`, `rehype-sanitize`, code block
  controls, and completion-only Mermaid rendering.
- Transcript layout is no longer virtualized in the current Electron base path:
  `ChatView.tsx` maps all `threadMessages` into `.thread-message-row` elements,
  and `apps/desktop/src/styles.css` stacks `.thread-message-list` with normal
  flex document flow.
- Scroll path uses `.thread-scroll` with `overflow: auto` and CSS
  `scroll-behavior: smooth`; streaming code requests `scrollTo(..., "auto")`
  when pinned/near bottom.
- Runtime/native boundary is now browser networking to the local Gemma runtime
  on port 8765. Electron has no preload or IPC bridge yet for chat.
- Historical docs still contain Tauri and virtualizer assumptions. Current ADR
  `docs/decisions/0005-electron-desktop-shell.md` supersedes Tauri for desktop,
  while `docs/plans/2026-05-26-chat-rendering-performance.md` is partially stale
  because it describes a virtualized Tauri-era path.

## Observability And Logging Plan

| Signal | Source | Proves | Gap | Action |
| --- | --- | --- | --- | --- |
| UI contract | `npm run test:ui-contract` | Electron-specific invariants exist: no Tauri invoke, no virtualizer in base path, streaming goes through React state and `RichMessage streaming` | String contract only; does not prove frame time or visual smoothness | Keep as regression guard, but do not treat as performance proof |
| TypeScript/build | `npm run typecheck`, `npm run build` | Current Electron/React code compiles and bundles | Build warns about large chunks; build does not prove runtime smoothness | Track bundle chunk warning in performance follow-up |
| Runtime health | `curl http://127.0.0.1:8765/health` | Local Gemma runtime was reachable, loaded, and local-first during this run | Does not measure per-token delivery or UI paint | Keep health as preflight for render benchmarks |
| Browser/Chromium inspection | Playwright against `http://127.0.0.1:1420/` | Same React renderer loaded, no console errors, prompt completed visually, no long tasks in a small Markdown/code sample | It is Chromium/Vite, not an automated Electron `BrowserWindow` trace | Add Electron-specific Playwright/Spectron-equivalent harness or DevTools protocol capture |
| Electron bootstrap | `LOCAL_FIRST_DESKTOP_URL=http://127.0.0.1:1420/ npx electron electron/main.cjs` | Electron process can launch the current shell against the active dev server without visible terminal errors | No automated screenshot/console/performance capture from Electron window | Add automated Electron launch/profile script |
| Existing latency probe | `python -m unittest tests/test_chat_latency_probe.py` | Probe parsing/tests pass | Unit test only; no fresh long runtime probe was run in this analysis | Run real `scripts/chat_latency_probe.py` for long prompts when diagnosing transport |
| In-page performance probe | Playwright-injected `PerformanceObserver`, `requestAnimationFrame`, mutation samples | Small Markdown/code prompt produced 0 long tasks; RAF p50 about 13.3 ms, p95 about 14.2 ms, max about 27.7 ms; final response had 3 rows and 1 code block | One sample, not production build, not Electron process, not large scrollback | Convert this into a deterministic benchmark harness |

Privacy/noise limits:

- Do not log full prompts, full chat transcripts, local paths, secrets, or raw
  tool payloads.
- Runtime/render probes should record request id, chunk counts, character
  counts, timings, DOM counts, frame intervals, long task durations, and redacted
  profile labels.
- Debug logs should be opt-in and bounded; no broad console spam in normal use.

Minimum instrumentation before fix:

- Add a deterministic chat-render benchmark harness that can run the same
  profiles in browser preview and Electron.
- Capture frame intervals, Long Task entries, mounted DOM node counts, final
  Markdown commit duration, scroll correctness, and heap/memory snapshots.
- Add Electron `BrowserWindow` console/performance capture so Chromium/Vite
  observations are not over-generalized as Electron proof.

Missing observability does not block the current conclusion that the small
Electron/Chromium path is functional. It does block strong claims about large
scrollback, long Markdown/code output, memory growth, and final production
performance.

## Primary Hypotheses

1. Current Electron streaming is likely smooth for small/medium responses.
   Evidence: streaming now uses React state throttled by `requestAnimationFrame`,
   `RichMessage streaming` is a single text node, the small runtime sample
   rendered a Markdown/code answer with no console errors and no observed long
   tasks. Counter-evidence: the sample was browser Chromium, not automated
   Electron, and was only about 1k visible assistant text. Falsification: run a
   4k-token stream inside Electron and observe p95 frame interval above 24 ms,
   long tasks above 100 ms, or delayed visible text.

2. Large scrollback remains the highest structural rendering risk.
   Evidence: current base path explicitly renders `threadMessages.map(...)` for
   every message row and the UI contract forbids old virtualizer usage. This is
   simpler and acceptable for a small active thread, but it scales DOM nodes with
   message count. Counter-evidence: current Electron decision may intentionally
   trade virtualization away after Chromium improved the primary streaming
   symptom. Falsification: a 1,000-message profile stays under DOM, memory, and
   frame thresholds without virtualization.

3. Final rich Markdown commit remains the likely hotspot after streaming ends.
   Evidence: streaming avoids rich rendering, but completion switches to
   `RichMessageRenderer`, which normalizes all text and renders Markdown/GFM,
   sanitize, code blocks, and possibly Mermaid. Build output also shows Mermaid
   and Markdown chunks are substantial, though lazy split. Counter-evidence: the
   small sample completed one code block without long tasks. Falsification:
   final commit of 30k characters with code/tables/Mermaid stays below 150 ms
   and produces no long task above 100 ms.

4. Current diagnostics are enough for regression checks but not for diagnosis.
   Evidence: `debugChatStream` currently delegates to `chatApi.debugChatStream`,
   which is a no-op in the local Electron fallback; the old gateway debug
   endpoint is gone from the current renderer path. Counter-evidence: browser
   DevTools can still manually profile. Falsification: add structured render
   metrics and show they distinguish transport, React render, Markdown commit,
   and scroll anchoring.

5. The temporary renderer-local chat store can hide production persistence and
   refresh costs.
   Evidence: `chatApi.ts` stores `localThreads`/`localMessages` in memory until
   the Rust gateway is extracted, and `coreBridge` talks directly to Gemma.
   Counter-evidence: rendering can be analyzed independently for the visible
   active thread. Falsification: standalone gateway extraction does not add
   expensive snapshot refresh, serialization, or large message reload costs.

## Secondary Bottlenecks

- `ChatView.tsx` remains a large component with many states. Any state update
  in the component can re-run message row render logic unless rows are factored
  and memoized.
- `threadMessages.map(...)` derives `contentKind`, incomplete status, previous
  user message availability, and action props during render. That is harmless at
  3 rows and risky at hundreds or thousands.
- Streaming `flushStreamingMessage` reconstructs `[
  ...promptMessages,
  { ...streamingMessage, text: streamedText }
]` every animation frame. Chromium handled the small sample, but long streams
  should be measured.
- CSS keeps `.thread-scroll { scroll-behavior: smooth; }`, while streaming code
  asks for `auto`. Browser behavior should be verified under rapid scroll writes
  and resize events.
- `PlainTextMessage` splits full text into paragraphs/lines on every completed
  render. It is simpler than Markdown, but still O(text length).
- `RichMessageRenderer` has Rust-biased normalization heuristics that may wrap
  non-Rust code incorrectly and increase final render work.
- Mermaid rendering imports and initializes a large library on demand. It is
  completion-only, which is correct, but needs benchmark coverage for many
  diagrams and malformed diagrams.
- Electron currently loads a remote dev URL in development. Production
  packaging and gateway discovery may change timing and security surfaces.
- Build output has large lazy chunks (`mermaid.core`, `wardley`, `cytoscape`,
  `vendor-markdown`, `vendor-katex`). That is not an immediate render bug, but
  it should be tracked because Electron startup and first rich-message render
  can be affected by module load.

## Implementation Library Research

Date checked: 2026-05-26.

- Electron official process-model docs confirm each `BrowserWindow` renders web
  content in a renderer process controlled by the main process, and renderer UI
  code follows web-platform behavior. This matches the current architecture:
  Electron hosts the Vite/React app and should be profiled like Chromium web UI.
  Source: https://www.electronjs.org/docs/latest/tutorial/process-model
- Electron official performance docs recommend measuring/profiling running code
  to find renderer bottlenecks and warn that Electron performance remains the
  app developer's responsibility. This supports adding a real benchmark harness
  before further rendering changes.
  Source: https://www.electronjs.org/docs/latest/tutorial/performance
- Electron sandbox/security docs support the current shell direction:
  `sandbox: true`, disabled Node integration, and context isolation reduce
  renderer privilege. Source:
  https://www.electronjs.org/docs/latest/tutorial/sandbox/ and
  https://www.electronjs.org/docs/latest/tutorial/security
- React official `lazy` docs support the current `RichMessageRenderer` split:
  the rich renderer is loaded only when rendered, which keeps streaming/plain
  messages lighter. Source: https://react.dev/reference/react/lazy
- `react-markdown` project docs describe the current plugin shape:
  `remark-gfm` for GitHub-flavored Markdown and `rehype-sanitize` for safer
  output. This fits assistant messages, but rich rendering should remain
  completion-only and measured.
  Source: https://github.com/remarkjs/react-markdown
- `rehype-sanitize` is the relevant sanitizer in the unified/rehype ecosystem.
  The current code applies it before rendering Markdown HTML output. Source:
  https://github.com/rehypejs/rehype-sanitize
- Mermaid docs expose `securityLevel`, and the current code uses `strict`. The
  performance risk is not security level itself, but import/init/render cost on
  completed messages. Source: https://mermaid.js.org/config/usage.html

No library replacement is recommended from this analysis. The first missing
piece is measurement, not another rendering dependency.

## Falsification Checks

- Hypothesis: streaming is smooth enough in Electron.
  Falsification check: run an Electron-controlled `streaming-4k` profile with
  frame and long-task capture. Disprove if p95 frame interval is above 24 ms,
  any long task above 100 ms occurs during visible streaming, or first visible
  text is delayed after deltas arrive.
- Hypothesis: full document flow is acceptable for active chat.
  Falsification check: load `large-scrollback` with 1,000 mixed messages.
  Disprove if mounted DOM nodes, memory, initial render, or scroll p95 exceed
  thresholds from `docs/benchmarks/chat-rendering-performance.md`.
- Hypothesis: final Markdown commit is the next hotspot.
  Falsification check: compare plain 30k text, code-heavy 30k text, table-heavy
  text, and Mermaid-heavy text. Disprove if rich commit duration stays below
  threshold and long tasks do not correlate with rich completion.
- Hypothesis: local renderer store is not hiding production cost.
  Falsification check: after gateway extraction, replay the same profiles with
  persisted thread snapshots. Disprove if snapshot fetch/serialization or
  refresh-after-submit dominates render timing.
- Hypothesis: current security settings are adequate for the current shell.
  Falsification check: inspect packaged Electron config/preload/gateway once
  added. Disprove if renderer gains Node, preload leaks broad APIs, or remote
  content can call privileged functionality.

## Affected Verification Matrix

| Slice | Command or inspection | Proves | Status |
| --- | --- | --- | --- |
| Frontend static | `cd apps/desktop && npm run typecheck` | React/TypeScript code compiles | pass |
| UI contract | `cd apps/desktop && npm run test:ui-contract` | Electron chat invariants are present | pass |
| Build | `cd apps/desktop && npm run build` | Production frontend bundles | pass, with large chunk warnings |
| Runtime health | `curl http://127.0.0.1:8765/health` | Local Gemma runtime reachable and loaded | pass |
| Browser runtime render | Playwright navigate to `http://127.0.0.1:1420/`, submit Markdown/code prompt, inspect console/performance samples | Same React renderer produces visible response; small sample had 0 long tasks and RAF p95 about 14.2 ms | pass with limitation: browser Chromium, not Electron window automation |
| Electron shell bootstrap | `LOCAL_FIRST_DESKTOP_URL=http://127.0.0.1:1420/ npx electron electron/main.cjs` | Electron shell launches against active dev server | pass for bootstrap; no automated visual trace |
| Backend/native | `python -m unittest tests/test_chat_latency_probe.py` | Existing latency probe tests pass | pass |
| Performance benchmark | Deterministic Electron chat-render harness | Large scrollback, final Markdown, Mermaid and memory behavior | missing |
| Docs/memory | This report and `docs/work-memory.md` update | Current Electron rendering findings are durable | pending until update committed |

## Decision And Next Step

Decision: keep the current Electron rendering path for now. The small live
sample supports that the current Chromium path is functional and visibly renders
Markdown/code without console errors or observed long tasks. Do not reintroduce
Tauri-era manual DOM streaming or virtualizer changes based only on old docs.

Main finding: the urgent problem is no longer "Electron cannot stream"; it is
"Electron rendering is not benchmarked under product-scale chat profiles." The
current base path intentionally renders the full active thread in normal
document flow, so large scrollback and final rich Markdown commits are the
highest-risk areas.

Next step:

1. Add a deterministic `bench:chat-render` harness for browser preview and
   Electron.
2. Measure `tiny`, `long-markdown`, `large-scrollback`, `streaming-4k`,
   `code-heavy`, and `mermaid-heavy`.
3. Only after measurements, decide whether to split/memoize message rows,
   introduce bounded virtualization, cache rich Markdown output, or move
   Markdown preprocessing off the hot path.
4. Add Electron-specific console/performance capture so future reports do not
   rely on browser preview as a proxy.

## Durable Memory Updates

- Added this report as the current Electron-specific field analysis.
- Updated `docs/work-memory.md` with a short phase entry summarizing the
  current findings, verification, and next benchmark step.
