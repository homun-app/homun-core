# Chat Rendering Performance Field Report

Date: 2026-05-26

## Goal

Analyze why the desktop chat can freeze or become slow with long messages,
streaming tokens, Markdown/code blocks and large scrollback, then choose a
measured architecture path.

## Local Flow Map

- UI ownership starts in `apps/desktop/src/App.tsx`; current work memory says
  startup now loads only the active thread messages, with other threads loaded
  on demand.
- Chat render path is `apps/desktop/src/components/ChatView.tsx`.
  `threadMessages` is `optimisticMessages ?? messages`.
- The transcript is now virtualized with `@tanstack/react-virtual` in
  `ChatView.tsx`: `useVirtualizer`, dynamic `estimateSize`, `getItemKey`,
  `measureElement`, and `getTotalSize`.
- During streaming, React no longer re-renders Markdown per token. Deltas are
  accumulated in refs and painted with `requestAnimationFrame` into
  `streamingTextRef`.
- The streaming row is resized with `messageVirtualizer.resizeItem` after text
  grows by about 220 characters.
- Auto-scroll reads `scrollHeight` and writes `scrollTo` during stream paint
  only when `shouldStickToBottomRef` says the user is near the bottom.
- Completed messages render through `RichMessage`; rich content lazy-loads
  `RichMessageRenderer`.
- `RichMessageRenderer` normalizes the full text, then runs `react-markdown`,
  `remark-gfm`, `rehype-sanitize`, code block UI, and Mermaid rendering after
  completion.
- Chat transport is `apps/desktop/src/lib/chatApi.ts` and
  `apps/desktop/src-tauri/src/gateway.rs`: stream tokens use a local WebSocket
  endpoint `/api/chat/stream/ws`; HTTP/NDJSON stream endpoints remain as
  fallback/debug.
- Rust Core owns persisted chat state in `apps/desktop/src-tauri/src/state.rs`
  and prompt streaming in `prompt_submission.rs`; the gateway does not own
  product policy.
- Existing diagnostics cover type contracts and transport/runtime latency, but
  there is no committed UI render benchmark script yet.

## Primary Hypotheses

1. **Completed-message Markdown parse/layout is now the top local suspect.**
   Evidence: streaming bypasses Markdown, but final commit replaces the
   streaming text node with a completed assistant message rendered through
   normalization, Markdown, GFM, sanitize, code block controls and Mermaid.
   Long code/tables/diagrams can block at stream completion or thread reopen.
   Counter-evidence: plain text messages bypass rich rendering. Falsify with a
   benchmark comparing final commit of 30k chars plain text vs code-heavy
   Markdown.

2. **Virtualization is present but not yet proven under chat-specific dynamic
   height stress.** Evidence: `ChatView` uses TanStack Virtual, but dynamic
   rows contain code blocks, Mermaid SVG, attachments and action bars. The
   streaming row also combines `measureElement` with manual `resizeItem` for
   the same index, which TanStack docs warn can be unpredictable. Falsify with
   DOM node count, scroll-jump and frame-time measurements on 1,000 messages.

3. **Scroll/layout work during streaming can still jank on large or unstable
   rows.** Evidence: each animation frame can append text, resize the virtual
   row and scroll to `scrollHeight`; CSS also sets `scroll-behavior: smooth` on
   `.thread-scroll`, while JS sometimes requests `auto`. Falsify with
   `requestAnimationFrame` p95 and Long Task data while already at bottom and
   while user scrolled up.

4. **Platform WebView variability is a multiplier, not yet proven as the
   primary root cause.** Evidence: direct gateway WebSocket testing in work
   memory showed token delivery was smooth, while Tauri WebView rendering was
   the remaining symptom. Tauri uses different engines per OS. Falsify by
   running the same benchmark in browser preview, macOS Tauri WKWebView,
   Windows WebView2 and Linux WebKitGTK after frontend bottlenecks are reduced.

5. **Transport buffering is lower probability after current fixes.** Evidence:
   the app moved from Tauri invoke/events to local gateway, then WebSocket; work
   memory records a gateway WebSocket probe with no multi-second gaps. Keep the
   HTTP fallback in benchmarks, but do not treat transport as the primary issue
   unless UI and gateway traces diverge again.

## Secondary Bottlenecks

- `ChatView` still contains many unrelated states and inline callbacks; any
  state that changes in the parent component can invalidate the whole
  virtualized viewport unless rows are split and memoized.
- `findPreviousUserMessage(threadMessages, displayMessage.id)` runs while
  rendering every visible assistant row.
- Action menu state lives inside `MessageActionBar`; virtualized unmount/remount
  can reset transient menu state and force remount work.
- If the streaming row unmounts while the user scrolls away, `streamingTextRef`
  can be recreated empty. The current append-only logic tracks painted length in
  a ref, so a remounted node needs explicit hydration from the pending stream
  buffer.
- `scrollConversationToBottom` reads `scrollHeight`; even with virtualization,
  dynamic measurement and non-virtual inline cards below the virtual list can
  still cause layout work.
- Mermaid rendering uses `dangerouslySetInnerHTML` with Mermaid output after
  `securityLevel: "strict"`; it should remain completion-only and visible-row
  only.
- The WebSocket token is in the query string. It is loopback-only and local, but
  logs and dev tooling should avoid exposing it.

## Implementation Library Research

Date checked: 2026-05-26.

- Tauri official docs confirm WebView2/Chromium on Windows, WKWebView/WebKit on
  macOS and WebKitGTK on Linux; macOS WebKit updates come with OS updates:
  <https://v2.tauri.app/reference/webview-versions/>.
- Tauri process model docs also confirm the platform engine split:
  <https://v2.tauri.app/concept/process-model/>.
- Tauri issue #3988, opened 2022-04-27 and closed, reports Linux/WebKitGTK lag
  with many DOM elements where Firefox, Electron and Windows were fine:
  <https://github.com/tauri-apps/tauri/issues/3988>.
- Tauri issue #10102, opened 2024-06-23 and still open in search results,
  reports high memory growth and lag while resizing on Linux in v1/v2:
  <https://github.com/tauri-apps/tauri/issues/10102>.
- Tauri issue #13498, opened 2025 and still triage/open in search results,
  reports random Linux WebView freezing with Tauri 2.5.1/wry 0.51.2:
  <https://github.com/tauri-apps/tauri/issues/13498>.
- Tauri issue #13141, opened 2025-04-04 and open in search results, reports
  macOS Intel WebView oddities affecting React state/form behavior:
  <https://github.com/tauri-apps/tauri/issues/13141>.
- TanStack Virtual docs support dynamic measurement and warn not to manually
  change the size of an item while `measureElement` is also measuring that same
  item. Current code should avoid using both for the streaming row or isolate
  the streaming row from dynamic measurement:
  <https://tanstack.com/virtual/latest/docs/api/virtualizer>.
- Virtuoso Message List is chat-specific and virtualized, but the dedicated
  message-list package is commercial. Core React Virtuoso remains a fallback,
  but a switch should be benchmark-driven:
  <https://virtuoso.dev/message-list/>.
- Electron official docs confirm Chromium-style multi-process rendering and
  recommend profiling actual app code; Electron can reduce WebKit variability,
  but it does not remove React/DOM/Markdown costs:
  <https://www.electronjs.org/docs/latest/tutorial/process-model> and
  <https://www.electronjs.org/docs/latest/tutorial/performance>.
- Wails v3 docs confirm it also uses the OS native WebView, so it is not an
  escape hatch for WebKitGTK/WKWebView rendering limits:
  <https://v3.wails.io/concepts/architecture/>.
- Flutter official docs confirm native desktop targets for Windows, macOS and
  Linux. It is the credible non-WebView fallback, but it implies a frontend
  rewrite and Rust bridge work:
  <https://docs.flutter.dev/platform-integration/desktop>.

## Options Compared

### Option A: Optimize Current Tauri/Web Frontend

Benefits:

- Lowest churn and preserves the Rust Core/gateway architecture.
- Addresses costs that would also exist in Electron.
- Current code already has the first structural fix: virtualized transcript and
  append-only streaming text.

Risks:

- The current virtualizer implementation is not yet benchmarked.
- Dynamic height rows can still jump or remeasure too often.
- Markdown final commit can still freeze.
- WebKitGTK/WKWebView platform quirks remain.

Mitigation:

- Add a render benchmark harness first.
- Split `ThreadViewport`, `MessageRow`, `StreamingMessageRow`,
  `CompletedRichMessage`.
- Memoize rows and precompute render-derived booleans.
- Avoid `resizeItem` and `measureElement` on the same streaming row index.
- Hydrate streaming text ref when remounted.
- Add a Markdown render cache keyed by immutable message id and text hash.

Expected effort:

- 2-4 days for benchmark harness and row split.
- 3-7 more days for Markdown cache, scroll policy and cross-platform smoke.

How to verify:

- DOM node count below threshold.
- React commit duration and Long Task measurements.
- Frame-time p95 during 4k-token stream.
- Final Markdown commit duration.
- Manual Tauri macOS smoke, then Windows/Linux smoke.

### Option B: Keep Tauri But Change Rendering Architecture

Benefits:

- Keeps local-first Rust/Tauri shell.
- Treats chat as a specialized viewport, not a normal React message map.
- Allows worker preprocessing for Markdown normalization and chunk metadata.
- Can defer rich rendering until rows are visible and stable.

Risks:

- More code and more scroll anchoring complexity.
- Search, selection, copy, browser find and accessibility become harder with
  virtualization.
- Worker offload helps parse/preprocess, not DOM layout.
- A custom rendering pipeline can create regressions in code/Mermaid safety.

Mitigation:

- Use current TanStack Virtual as the base until benchmarks disprove it.
- Keep a plain-text streaming row and rich-render only completed visible rows.
- Cache measurements per message revision.
- Add focused tests for scroll anchoring, remount hydration and action bars.

Expected effort:

- 2-4 weeks for a robust implementation.

How to verify:

- Same benchmark harness plus scroll-up, load older, copy action, Mermaid and
  keyboard/focus scenarios.

### Option C: Switch To Electron

Benefits:

- Bundled Chromium gives more uniform behavior and likely improves Linux
  WebKitGTK-specific rendering issues.
- Strong DevTools/profiling and a mature renderer process model.
- Can reuse much of the frontend and keep the Rust gateway as local backend.

Risks:

- Does not fix React/DOM/Markdown architectural costs.
- Larger bundle and higher baseline memory.
- Requires new security hardening, preload/IPC decisions and packaging.
- Migration can distract from measurable frontend fixes.

Mitigation:

- Build only a minimal Electron shell prototype after the benchmark exists.
- Reuse the same built frontend and local gateway to isolate shell/runtime cost.
- Compare Electron only after current Tauri frontend has virtualization and
  Markdown-cache fixes.

Expected effort:

- 3-7 days for a useful prototype.
- 4-8 weeks for production migration if chosen.

How to verify:

- Same benchmark profiles and reports, same hardware, same built frontend.
- Switch only if Electron beats Tauri on p95 frame time/long tasks/memory after
  app-level bottlenecks are addressed.

### Option D: Flutter Desktop With Rust Core Bridge

Benefits:

- Removes WebView engine variability for the primary chat surface.
- Gives direct control over list virtualization and frame scheduling.
- Credible long-term path if chat becomes a native rendering product.

Risks:

- Frontend rewrite in Dart/Flutter.
- Markdown/code/Mermaid parity and safety must be rebuilt or embedded.
- Rust Core bridge, packaging, accessibility and design system all need new
  work.

Mitigation:

- Treat as fallback only if Tauri+optimized viewport fails thresholds.
- Prototype one chat screen fed by the same gateway before any migration plan.

Expected effort:

- 2-3 weeks for a meaningful prototype.
- 2-4 months for parity migration.

How to verify:

- Same benchmark thresholds plus feature-parity checklist.

### Option E: Wails Or Another Native-WebView Wrapper

Benefits:

- Smaller app model similar to Tauri.
- Familiar web frontend.

Risks:

- Does not solve the core problem because it also uses native OS WebViews.
- Would replace Rust/Tauri integration with Go/Wails integration for little
  rendering benefit.

Mitigation:

- Do not pursue unless there is a separate non-rendering product reason.

Expected effort:

- Not recommended.

How to verify:

- Only worth a spike if product constraints change.

## Recommendation

Choose Option B as the implementation direction, in a measured sequence: keep
Tauri and the local WebSocket gateway, but finish the chat-specific rendering
architecture and benchmark it before considering Electron. The strongest local
evidence now points to completed Markdown/rendering work, virtualizer
measurement behavior and scroll/layout costs, not primary token transport.

Electron should be a benchmark fallback, not the first move. Flutter is the
credible non-WebView fallback if the optimized Tauri chat still fails thresholds
on target platforms.

## Implementation Roadmap

1. Add the chat render benchmark harness before further UI changes.
2. Split the current monolithic render block into `ThreadViewport`,
   `MessageRow`, `StreamingMessageRow`, `CompletedRichMessage` and
   `MessageActionBar` boundaries.
3. Memoize visible rows by `message.id`, `message.text`, role, metrics,
   feedback/action status and streaming id.
4. Fix streaming-row virtualizer behavior:
   hydrate the text node on remount, and avoid combining `measureElement` with
   `resizeItem` for the same item.
5. Add Markdown preprocessing/cache keyed by message id plus text hash. Preserve
   sanitize and link safety; Mermaid stays completion-only and visible-row-only.
6. Add scroll anchoring policy and tests:
   at-bottom auto-follow, user-scrolled-up no-follow, load-older preserve,
   resize preserve when possible.
7. Run benchmark in browser preview and macOS Tauri. Only after thresholds pass
   locally, run Windows WebView2 and Linux WebKitGTK smoke.
8. If Tauri still fails only in WebView after frontend numbers are clean, build
   a minimal Electron shell prototype using the same frontend and gateway.

## Benchmark Plan

Profiles:

- `tiny`: 20 messages, short plain text.
- `long-markdown`: 40 messages with 5 long answers around 30k characters.
- `large-scrollback`: 1,000 messages with mixed rich/plain content.
- `streaming-4k`: one assistant stream with 4,096 generated-token-sized chunks.
- `code-heavy`: 50 code blocks with long lines and copy controls.
- `mermaid-heavy`: 20 completed Mermaid blocks plus malformed diagrams.

Metrics:

- Time to first visible assistant text.
- Delta receive rate vs visible paint rate.
- React commit duration for thread viewport.
- Long Tasks over 50 ms and 100 ms.
- `requestAnimationFrame` p50/p95/max during streaming.
- DOM node count under `.thread-scroll`.
- Mounted message rows vs total messages.
- Final Markdown commit duration.
- Mermaid render duration and failure count.
- Scroll correctness for at-bottom, user scrolled up and load older.
- Heap/memory after render, stream, scrollback and idle.

Required new commands:

```bash
cd apps/desktop && npm run bench:chat-render -- --profile=tiny
cd apps/desktop && npm run bench:chat-render -- --profile=long-markdown
cd apps/desktop && npm run bench:chat-render -- --profile=large-scrollback
cd apps/desktop && npm run bench:chat-render -- --profile=streaming-4k
cd apps/desktop && npm run bench:chat-render -- --profile=code-heavy
cd apps/desktop && npm run bench:chat-render -- --profile=mermaid-heavy
```

Acceptance thresholds:

- 1,000-message scrollback with 20 long rich messages: below 350 mounted DOM
  nodes in steady state.
- Initial thread render p95 below 250 ms in production build.
- Streaming 4,096 tokens at 30-80 token/s: p95 animation frame below 24 ms,
  no long task above 100 ms.
- Final 30k-character Markdown commit below 150 ms or moved off the critical
  paint path with progressive completion.
- Scroll-to-bottom write below 16 ms p95 when already at bottom.
- Memory after 10 minutes of streaming/scrolling: no monotonic growth above
  15 percent after idle/GC opportunity.
- Cancel stream: visible stop under 200 ms and gateway cancellation requested.

## Falsification Checks

- If final Markdown commit is below 50 ms for long Markdown in Tauri, deprioritize
  Markdown cache and focus on scroll/virtualizer.
- If browser preview and macOS Tauri both show the same p95 frame spikes,
  prioritize frontend architecture over shell migration.
- If browser preview passes but macOS/Linux Tauri fails after virtualization and
  Markdown cache, prototype Electron.
- If DOM node count is already below 350 but frames still spike, inspect layout,
  row measurement and code/Mermaid render work rather than more virtualization.
- If gateway delta timestamps show multi-second gaps again, reopen transport
  analysis between Python runtime, Rust client and WebSocket.

## Affected Verification Matrix

| Slice | Command or inspection | Proves | Status |
| --- | --- | --- | --- |
| Frontend types | `cd apps/desktop && npm run typecheck` | Current TS compiles | pass 2026-05-26 |
| UI contracts | `cd apps/desktop && npm run test:ui-contract` | Current contract checks pass | pass 2026-05-26 |
| Runtime latency test | `python -m unittest tests/test_chat_latency_probe.py` | Probe parser/tests pass | pass 2026-05-26 |
| macOS WebKit version | `awk ... /System/Library/Frameworks/WebKit.framework/Resources/Info.plist` | Current local WKWebView baseline | `21624.2.5.11.4` |
| UI benchmark | `npm run bench:chat-render ...` | Rendering cost and thresholds | missing script |
| Field report validator | `./scripts/check-field-depth-report.sh ...` | CoderSteroids report shape | missing script |
| Cross-platform WebView | Windows WebView2 and Linux WebKitGTK smoke | Platform-specific jank | pending |
| Electron fallback | Same benchmark in minimal Electron shell | Shell/runtime delta | pending |

## Durable Memory Updates

- Update `docs/benchmarks/chat-rendering-performance.md` to say the virtualized
  transcript exists but is not benchmarked.
- Update `docs/work-memory.md` with this analysis and the next action.
- Update `docs/architecture/final-roadmap.md` so Phase 0.5 no longer says the
  main remaining issue is "non-virtualized scrollback".

## Remaining Risks

- WebKitGTK may still be the weakest platform even after frontend fixes.
- Dynamic-height virtualization can introduce scroll jumps with long code,
  Mermaid SVG and attachments.
- Virtualization makes search/find-in-page and text selection across offscreen
  messages harder.
- Markdown caching must not bypass sanitization.
- Electron migration remains possible but should be chosen only from benchmark
  evidence.
