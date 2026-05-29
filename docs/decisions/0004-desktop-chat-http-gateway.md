# Decision 0004 - Desktop Chat HTTP Gateway

Date: 2026-05-26

Status: Superseded by Decision 0005 for the desktop shell; gateway boundary remains accepted

## Context

The desktop chat must feel immediate and continuous. Tauri `invoke` and event
IPC work well for short native commands, but they are the wrong primary channel
for long chat streams, generated artifacts and future multimodal payloads.

Recent streaming fixes improved some symptoms, but the approach stayed fragile:
React, WKWebView and Tauri IPC were still coupled to token cadence. The product
cannot depend on micro-tuning the frontend to hide transport limits.

The target remains local-first:

- Gemma runs locally through the Python/MLX runtime.
- The desktop core runs locally in Rust.
- No cloud API or Ollama is introduced by this decision.
- The UI must not gain policy or tool-selection authority.

## Decision

Move chat transport from Tauri `invoke` to a local Rust HTTP gateway owned by
the desktop core.

The gateway binds only to `127.0.0.1`, exposes product APIs under `/api/...`,
and streams chat responses through normal browser networking from the React
WebView. The first implementation used NDJSON over `fetch`; on macOS WKWebView
this can still buffer long responses. Chat token streaming therefore uses a
local WebSocket, while normal snapshot and action APIs remain HTTP JSON.

This decision was implemented inside the Tauri desktop shell first. Later
streaming diagnostics showed that WKWebView still did not provide acceptable
visual streaming even when tokens reached JavaScript and the DOM was updated.
Decision 0005 therefore removes Tauri as the desktop shell and keeps the
gateway boundary as a standalone Rust service target for Electron.

Chat, thread state, generated messages, streaming, cancellation, feedback,
message actions and future artifacts should use the local HTTP gateway.

## Gateway Responsibilities

- own chat thread and message APIs;
- proxy local Gemma requests and preserve runtime metrics;
- stream deltas to the UI without blocking the WebView event loop;
- persist final assistant messages only after completion;
- expose cancellation by request id;
- apply privacy redaction before returning activity, task or artifact data;
- enforce local auth token and strict CORS;
- keep raw local paths, secrets, env and unredacted tool payloads out of UI
  responses;
- provide a stable contract that can later serve browser, shell, MCP,
  connectors, memory and Local Computer artifacts.

## Initial API Contract

```text
GET    /api/health
GET    /api/chat/threads
POST   /api/chat/threads
GET    /api/chat/threads/{thread_id}/messages
PATCH  /api/chat/threads/{thread_id}
GET    /api/chat/stream/ws
POST   /api/chat/threads/{thread_id}/messages/stream        legacy fallback
POST   /api/chat/streams/{request_id}/cancel
POST   /api/chat/messages/{message_id}/continue/stream      legacy fallback
POST   /api/chat/messages/{message_id}/feedback
POST   /api/chat/messages/{message_id}/save-to-memory
POST   /api/chat/messages/{message_id}/create-task
POST   /api/chat/messages/{message_id}/create-automation
```

Initial stream event shape:

```json
{"type":"accepted","request_id":"req_...","message_id":"msg_..."}
{"type":"status","label":"Gemma locale","detail":"Sto preparando la risposta"}
{"type":"delta","text":"Ciao"}
{"type":"done","message":{"id":"msg_...","role":"assistant"},"metrics":{"elapsed_seconds":1.2}}
{"type":"error","code":"runtime_unavailable","message":"Gemma non raggiungibile","retryable":true}
```

## Security Rules

- bind to loopback only;
- use a per-app-session bearer token or equivalent local secret;
- reject requests without the token;
- restrict CORS to the Electron/localhost origins used by the app;
- never listen on LAN interfaces;
- keep the Python/MLX runtime behind the Rust gateway for product traffic;
- return only redacted read models to the UI;
- keep audit and task payloads policy-gated in the core.

## Consequences

- The frontend uses `fetch` and browser streams for chat instead of
  `invoke(...)`.
- The UI can be tested in the browser and in Electron through the same transport.
- Large artifacts and future Local Computer previews can move through HTTP
  endpoints instead of serialized IPC payloads.
- The Rust desktop core needs an embedded HTTP server, likely `axum` on
  `tokio`.
- The current Tauri chat streaming command becomes transitional and should be
  removed once the gateway path is stable.

## Migration Plan

1. Add a Rust desktop gateway module with `GET /api/health`, loopback binding,
   token auth and CORS.
   First implemented in the old Tauri app; must now be extracted into a
   standalone Rust gateway crate/process.
2. Inject `gatewayBaseUrl` and token into the React app through a small native
   bootstrap command or config file.
   Superseded: Electron should launch or discover the standalone gateway.
3. Move thread list and message snapshot reads to HTTP.
   Implemented through `chatApi.chatThreads`, `chatApi.chatMessages`,
   `chatApi.selectChatThread`, thread patch and delete endpoints.
4. Add `POST /messages/stream` with NDJSON streaming and cancellation.
   Implemented for thread-scoped chat submit, then demoted to fallback after
   WebSocket streaming was added.
5. Proxy local Gemma through the gateway and preserve metrics:
   `prompt_tokens`, `generation_tokens`, `prompt_tps`, `generation_tps`,
   `peak_memory_gb`, `elapsed_seconds`.
   Implemented by reusing the existing Rust Core chat submission path.
6. Replace `submitChatPromptStream` in `coreBridge.ts` with a dedicated
   `chatApi.ts` fetch client.
   Implemented in `apps/desktop/src/lib/chatApi.ts`.
7. Keep existing UI components, but remove Tauri chat streaming commands and
   typewriter workarounds after the HTTP stream is verified.
   Legacy Tauri event streaming commands are no longer registered in the app;
   typewriter cleanup remains a later UX simplification.
8. Add message-scoped continuation streaming for truncated outputs:
   `POST /api/chat/messages/{message_id}/continue/stream`.
   Implemented so long answers append to the existing assistant message instead
   of creating visible `Continua` user turns.
9. Add `GET /api/chat/stream/ws` for real-time token delivery in Tauri/WKWebView.
   Implemented as the primary chat streaming channel; HTTP stream endpoints are
   kept as fallback/debug surfaces.
10. Move artifact previews and Local Computer snapshots to HTTP endpoints in a
   later phase.

## Non-Goals

- No cloud inference.
- No Ollama.
- No browser automation implementation change in this decision.
- No full rewrite of the UI.
- No direct exposure of Gemma Python runtime as the public product API.
