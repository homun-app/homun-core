# Tool-trace parity goldens

These goldens are the reference `tool-trace.jsonl` output of the observation
harness in `crate::tool_trace_dump`, captured at the per-tool-call dispatch loop
boundary in `stream_chat_via_openai`. Their purpose is to prove that the
upcoming extraction of the ~3200-line dispatch if/else block into a standalone
function is **behavior-preserving**: the same fingerprints must be produced
before and after extraction.

## How goldens are produced (LIVE — not by this task)

Goldens are captured **live** by the coordinator, because they require the
running gateway plus a configured model (and, for some scenarios, external
sidecars/connectors). Capture procedure:

1. Set `HOMUN_TRACE_DUMP=1` in the gateway environment.
2. Drive the scenario end-to-end through a real chat turn.
3. Collect `<gateway_data_dir>/logs/tool-trace.jsonl`.
4. Save it here under the scenario name.

This task delivers ONLY the instrumentation (the `tool_trace_dump` module + the
gated record block wired at the loop boundary + unit tests). No live goldens are
captured here — the app cannot be run from this task's environment.

## Intended scenarios

| File            | Scenario                                   | Prerequisites                     | Status              |
| --------------- | ------------------------------------------ | --------------------------------- | ------------------- |
| `builtin.jsonl` | `write_file` → `read_file` round-trip      | none (always runnable)            | PENDING live capture |
| `browse.jsonl`  | web browse tool call                       | browser sidecar                   | PENDING live capture |
| `shot.jsonl`    | browser screenshot (image second-message)  | browser sidecar                   | PENDING live capture |
| `mcp.jsonl`     | MCP connector tool call                    | MCP/Composio connectors           | PENDING live capture |
| `card.jsonl`    | Composio capability card / confirm flow    | MCP/Composio connectors           | PENDING live capture |

All scenarios are **PENDING live capture**.

## Record shape

Each `.jsonl` line is one `ToolTraceRecord` (see
`crates/desktop-gateway/src/tool_trace_dump.rs`), normalized so fingerprints are
stable across machines/runs: the user's home dir is rewritten to `~`, ISO-8601
timestamps (including any fractional/timezone suffix) to `<TS>`, and UUIDs to
`<UUID>`. Hashes are a fully-specified 64-bit **FNV-1a** hex digest — stable
across processes AND across Rust toolchains, so committed goldens do not rot on a
compiler upgrade — not a crypto hash.
