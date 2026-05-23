# MCP Capability Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first MCP-backed Capability Provider adapter while keeping live MCP process management behind a transport boundary.

**Architecture:** Implement `McpCapabilityProvider` in `crates/capabilities` using a synchronous `McpTransport` trait. Tests use an in-memory transport to verify MCP `tools/list` and `tools/call` mapping without starting external servers.

**Tech Stack:** Rust 2024, serde_json, MCP JSON-RPC concepts from the official MCP specification.

---

## Task 1: MCP Provider Adapter

**Files:**
- Create: `crates/capabilities/src/mcp.rs`
- Modify: `crates/capabilities/src/lib.rs`
- Test: `crates/capabilities/tests/mcp_provider.rs`

- [x] Add failing tests for mapping MCP `tools/list` into `CapabilityTool`.
- [x] Add failing tests for invoking MCP `tools/call` through `CapabilityProvider::call_tool`.
- [x] Add failing tests for initialized notification tracking.
- [x] Run `cargo test -p local-first-capabilities --test mcp_provider` and verify missing API failures.
- [x] Implement `McpTransport`, `McpCapabilityProvider`, `McpToolPolicy`, and `InMemoryMcpTransport`.
- [x] Run `cargo test -p local-first-capabilities --test mcp_provider`.
- [x] Commit as `Add MCP capability provider`.

## Task 2: Verification And Memory

**Files:**
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-mcp-capability-provider.md`

- [x] Mark completed plan items.
- [x] Update work memory with MCP provider boundary.
- [x] Run `make test`.
- [x] Commit as `Document MCP capability provider`.
