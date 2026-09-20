# F3.5 — Timeout, retry, then streaming

**Date:** 2026-09-18  
**Status:** accepted (slices A–E shipped)  
**Depends on:** F3.2–F3.4  

## Goal (full F3.5)

Streaming interrompibile, messaggio parziale marcato, timeout e retry limitato; tracciare tentativi e consumo senza dichiarare azioni mai eseguite.

## Slice A–C (done)

Timeout client, cancel/partial UI, SSE `/commands/stream` with display tokens, interpret retry×1.

## Slice D — UsageAttempt ledger (done)

`UsageAttempt` + `AttemptContext`; `GET /v1/models/usage-attempts`; Settings → Tentativi. Tokens null when unknown.

## Slice E — Provider / ModelPort token stream (done)

| Item | Choice |
|------|--------|
| OpenAI-compatible | HTTP `stream: true` SSE deltas; Ollama native NDJSON stream |
| Fake | Chunks from deterministic complete |
| ModelRegistry.stream | Delegates to `provider.stream`; records `last_stream_result.usage` |
| `/v1/models/chat/stream` | Live token yield (no full buffer before first event) |
| `/commands/stream` | After interpret, tokens via `stream_known_text` with `source: modelport` (no second LLM call) |

## Non-goals

- Budget reservations / F9.2 pricing
- Double LLM call to “echo” display through the provider
- Mem0 / F3.5a
