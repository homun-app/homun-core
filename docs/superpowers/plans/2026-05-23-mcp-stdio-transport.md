# MCP Stdio Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent local stdio transport for MCP servers behind the existing `McpTransport` trait.

**Architecture:** Keep `McpCapabilityProvider` transport-agnostic. Add `McpStdioTransport` that spawns a local command, writes newline-delimited JSON-RPC 2.0 messages to stdin, reads JSON-RPC responses from stdout and keeps the process alive across requests.

**Tech Stack:** Rust 2024, std process/stdio, serde_json, local test fixture binary.

---

## Task 1: Stdio Transport

**Files:**
- Modify: `crates/capabilities/src/mcp.rs`
- Create: `crates/capabilities/src/bin/fake_mcp_stdio.rs`
- Test: `crates/capabilities/tests/mcp_stdio.rs`

- [ ] Add failing tests for persistent stdio request/response and initialized notification.
- [ ] Run `cargo test -p local-first-capabilities --test mcp_stdio` and verify missing API failures.
- [ ] Implement `McpStdioConfig` and `McpStdioTransport`.
- [ ] Run `cargo test -p local-first-capabilities --test mcp_stdio`.
- [ ] Commit as `Add MCP stdio transport`.

## Task 2: Verification And Memory

**Files:**
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-mcp-stdio-transport.md`

- [ ] Mark completed plan items.
- [ ] Update work memory with stdio transport boundary.
- [ ] Run `make test`.
- [ ] Commit as `Document MCP stdio transport`.
