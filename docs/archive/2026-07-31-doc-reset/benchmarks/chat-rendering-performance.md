# Chat Rendering Performance Benchmark Notes

Date: 2026-05-26

Status update, 2026-05-26:

- `ChatView` now uses `@tanstack/react-virtual` for the transcript, so the
  benchmark must validate the current virtualized path rather than only proving
  that full scrollback rendering is bad.
- The current hot areas to measure are dynamic-height row measurement,
  streaming row resize/remount behavior, final Markdown commit cost, Mermaid
  completion cost and scroll anchoring.
- No `bench:chat-render` script is committed yet.

## Purpose

Measure the desktop chat rendering path separately from model latency. The
existing `scripts/chat_latency_probe.py` measures Gemma stream timing; it does
not measure React render time, WebView frame time, DOM size, Markdown parse
cost, scroll anchoring or memory growth.

## Metrics To Capture

- Time to first visible assistant text.
- Delta receive rate vs visible paint rate.
- React commit duration for the thread viewport.
- Long tasks over 50 ms and over 100 ms.
- `requestAnimationFrame` p50/p95/max frame interval during streaming.
- DOM node count under `.thread-scroll`.
- Mounted message row count vs total message count.
- Final Markdown commit duration.
- Mermaid render duration and failure count.
- Scroll position correctness: at-bottom follow, user scrolled up, load older.
- Heap/memory after initial render, after stream, after scrollback, after idle.

## Synthetic Profiles

- `tiny`: 20 messages, plain text, 1 short stream.
- `long-markdown`: 40 messages, 5 answers with 30k characters, tables and code.
- `large-scrollback`: 1,000 messages, mixed short/long, actions and metrics.
- `streaming-4k`: one assistant stream with 4,096 generated-token-sized chunks.
- `code-heavy`: 50 code blocks with copy buttons and long lines.
- `mermaid-heavy`: 20 completed Mermaid blocks plus malformed diagrams.

## Required Harness

Add a deterministic local route or story-like screen inside the Vite app that
can mount `ChatView` or a factored `ThreadViewport` with generated data. It must
run in:

- browser preview;
- Tauri macOS WKWebView;
- later Windows WebView2;
- later Linux WebKitGTK.

The harness should write JSON reports under `reports/chat-render/` and include:

- environment: OS, WebKit/WebView2/Chromium version when available;
- commit hash or dirty marker;
- package versions;
- benchmark profile and seed;
- all metrics above.

## Proposed Commands

```bash
cd apps/desktop && npm run bench:chat-render -- --profile=tiny
cd apps/desktop && npm run bench:chat-render -- --profile=long-markdown
cd apps/desktop && npm run bench:chat-render -- --profile=large-scrollback
cd apps/desktop && npm run bench:chat-render -- --profile=streaming-4k
cd apps/desktop && npm run bench:chat-render -- --profile=code-heavy
cd apps/desktop && npm run bench:chat-render -- --profile=mermaid-heavy
```

## Acceptance Thresholds

- 1,000-message scrollback with 20 rich messages: below 350 mounted DOM nodes.
- Initial render p95 below 250 ms in production build.
- Streaming p95 frame interval below 24 ms; no long task above 100 ms.
- Final 30k-character Markdown commit below 150 ms or not on critical paint.
- Auto-follow scroll writes below 16 ms p95 when already at bottom.
- Memory growth after idle below 15 percent from post-render baseline.

## Prototype Sequence

1. Baseline current virtualized implementation.
2. Split row/component boundaries and memoize rows; compare React commit
   duration.
3. Fix streaming row measurement/remount behavior; compare frame intervals and
   scroll correctness.
4. Add Markdown cache; compare final commit duration and thread reopen time.
5. Run macOS Tauri, then Windows WebView2 and Linux WebKitGTK smoke.
6. Compare Tauri vs Electron only after steps 1-5 produce clean numbers.

## Current Gaps

- Need deterministic generated fixtures inside the Vite app.
- Need PerformanceObserver and React Profiler capture.
- Need a way to run the same profile in browser preview and Tauri.
- Need JSON report writer under `reports/chat-render/`.
- Need a local check that mounted DOM nodes stay bounded under
  `.thread-scroll`.
