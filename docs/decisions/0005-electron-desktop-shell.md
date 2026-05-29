# Decision 0005 - Electron Desktop Shell

Date: 2026-05-26

Status: Accepted

## Context

The product experience depends on a smooth local chat. Multiple Tauri/WKWebView
iterations were measured:

- Python/MLX Gemma streamed correctly.
- The Rust client streamed correctly.
- The local gateway/WebSocket delivered deltas to JavaScript.
- The DOM text node grew during generation.
- The user still saw long freezes and then the final answer in one block.

An Electron benchmark shell loading the same React UI streamed smoothly.

## Decision

Remove Tauri from `apps/desktop` and use Electron as the only desktop shell.

The local-first architecture remains unchanged:

- inference stays local through Python/MLX Gemma;
- policy, orchestration and durable work stay in Rust crates;
- no cloud API and no Ollama are introduced;
- React remains the UI layer;
- a standalone Rust HTTP gateway becomes the backend boundary for read models,
  tasks, memory, browser automation, local computer sessions and artifacts.

## Security Rules

- Renderer uses `contextIsolation: true`.
- Renderer uses `sandbox: true`.
- Renderer has `nodeIntegration: false`.
- No Electron `<webview>` tag.
- External URLs open through the system browser.
- Product APIs stay on loopback with local auth once the Rust gateway is
  extracted.

## Immediate Consequences

- `apps/desktop/src-tauri` is removed.
- `@tauri-apps/api` and `@tauri-apps/cli` are removed.
- `npm run tauri` is removed.
- `npm run electron:dev` is the desktop dev entrypoint.
- `coreBridge.ts` no longer calls native `invoke`.
- The Rust gateway is now extracted in `crates/desktop-gateway`.
- Chat thread/message persistence, prompt building, stream/cancel and runtime
  controls go through the gateway.
- Electron owns gateway lifecycle in dev and packaged mode: it generates/passes
  the local bearer token via isolated preload config, starts the gateway when
  needed and stops the managed child on quit.
- Non-chat read models still use local UI-safe fallbacks until their gateway
  endpoints are connected.

## Migration Follow-Up

1. Move the remaining useful old desktop-core logic into reusable Rust crates or
   the new gateway.
2. Expose HTTP APIs for task queue/detail, approvals, memory dashboard,
   capability snapshots and Local Computer Session read models.
3. Package the gateway binary and Python/MLX runtime assets with the Electron
   app.
4. Add persistent redacted runtime logs with retention.
5. Remove temporary UI fallbacks once endpoints are available.

## Completed Follow-Up

1. Created `crates/desktop-gateway` as a standalone Rust process.
2. Exposed HTTP APIs for thread/message persistence, runtime process control,
   prompt building, chat stream/cancel and redacted runtime diagnostics.
3. Let Electron launch/discover the gateway and pass only loopback URLs/tokens
   to the renderer.
