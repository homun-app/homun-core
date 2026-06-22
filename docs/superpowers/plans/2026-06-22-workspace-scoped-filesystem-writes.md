# Workspace-scoped filesystem writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove confirmation cards for declared `mcp:filesystem` writes inside an explicitly configured project root, while requiring a card/pending-approval proof everywhere else.

**Architecture:** A static manifest declares the provider, write tools, and JSON-pointer paths. `WorkspaceScoped` execution validates each declared path through a symlink-safe absolute jail. `Confirmed` and `RemoteConfirmed` are separate authorities; the former verifies the persisted card and the latter is created only by a consumed Telegram pending code.

**Tech Stack:** Rust 2024, serde_json JSON Pointer, Axum, existing MCP capability facade and gateway tests.

---

### Task 1: Declare and test workspace filesystem scope

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:6215-6285,30600-32300`

- [ ] **Step 1: Write failing scope tests**

```rust
#[test]
fn workspace_filesystem_manifest_allows_only_declared_write_tools() {
    assert!(workspace_filesystem_manifest("mcp:filesystem", "create").is_some());
    assert!(workspace_filesystem_manifest("mcp:filesystem", "view").is_none());
    assert!(workspace_filesystem_manifest("mcp:other", "create").is_none());
}

#[test]
fn absolute_jail_accepts_nested_new_path_and_rejects_escape() {
    let root = test_root();
    assert!(jail_absolute_in_root(&root, &root.join("nested/new.md")).is_ok());
    assert!(jail_absolute_in_root(&root, &root.join("../outside.md")).is_err());
}
```

- [ ] **Step 2: Verify RED**

Run: `cargo test -p local-first-desktop-gateway workspace_filesystem_manifest_ absolute_jail_`

Expected: compilation failure for missing manifest and absolute jail.

- [ ] **Step 3: Implement the declarative manifest and absolute jail**

```rust
struct WorkspaceScopedMcpManifest { provider: &'static str, tool: &'static str, paths: &'static [&'static str] }
const WORKSPACE_FILESYSTEM_WRITES: &[WorkspaceScopedMcpManifest] = &[/* filesystem/create|insert|str_replace -> /path */];

fn workspace_filesystem_manifest(provider: &str, tool: &str) -> Option<&'static WorkspaceScopedMcpManifest> { /* exact match */ }
fn jail_absolute_in_root(root: &Path, candidate: &Path) -> Result<PathBuf, String> { /* canonical root + deepest existing ancestor */ }
```

The jail requires an absolute candidate, rejects a lexical `..` component, and verifies the deepest existing ancestor remains under the canonical root. It does not inspect arbitrary argument keys: callers receive path locations from the manifest.

- [ ] **Step 4: Verify GREEN**

Run: `cargo test -p local-first-desktop-gateway workspace_filesystem_manifest_ absolute_jail_`

Expected: all new tests pass.

### Task 2: Require explicit execution authority

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:13342-13435,20913-20970,21253-21258,22387-22460,30600-32300`

- [ ] **Step 1: Write failing authority tests**

```rust
#[test]
fn workspace_authority_requires_root_and_all_manifest_paths_inside_it() { /* root/no root/in-root/out-of-root */ }

#[test]
fn confirmed_authority_rejects_a_card_with_different_arguments() {
    assert!(!mcp_confirm_matches(marker("create", json!({"path":"/a"})), "create", &json!({"path":"/b"})));
}
```

- [ ] **Step 2: Verify RED**

Run: `cargo test -p local-first-desktop-gateway workspace_authority_ confirmed_authority_`

Expected: compilation failure for authority types and marker matcher.

- [ ] **Step 3: Implement authority and card proof**

```rust
enum McpExecutionAuthority { WorkspaceScoped { thread_id: String }, Confirmed { thread_id: String, message_id: String }, RemoteConfirmed }
fn workspace_scoped_mcp_write(state: &AppState, thread_id: Option<&str>, provider: &ProviderId, tool: &str, args: &Value) -> bool { /* manifest + JSON pointers + jail */ }
fn mcp_confirm_matches(text: &str, tool: &str, args: &Value) -> bool { /* parse MCP_CONFIRM JSON; exact tool + Value equality */ }
```

Change `run_mcp_chat_tool` to receive authority. It authorizes `WorkspaceScoped` only through the scope predicate; it authorizes `Confirmed` only after `mcp_execute` loads and verifies the original message marker; `RemoteConfirmed` is passed only after `take_pending_approval` succeeds. Reject all other write execution before the MCP transport.

- [ ] **Step 4: Integrate dispatch without weakening existing confirmations**

In the agent loop, execute a declared in-root filesystem write with `WorkspaceScoped`; otherwise create the existing confirm card. In `mcp_execute`, verify `thread_id`, `message_id`, marker, tool, and arguments before constructing `Confirmed`. In `execute_pending_approval`, use `RemoteConfirmed`. Preserve reads and non-filesystem providers.

- [ ] **Step 5: Verify GREEN and full regression suite**

Run:

```bash
cargo test -p local-first-desktop-gateway workspace_authority_ confirmed_authority_
cargo test -p local-first-desktop-gateway
```

Expected: focused authority tests and the full gateway suite pass.

### Task 3: Validate Path B in Electron and update durable state

**Files:**
- Modify: `docs/DEVELOPMENT.md`
- Modify: `docs/plans/2026-06-22-batch-1042-artifacts-memory.md`

- [x] **Step 1: Build and run**

Run:

```bash
cargo build -p local-first-desktop-gateway
cd apps/desktop && npm run electron:dev
```

- [ ] **Step 2: Verify both policy branches**

Use Gemma in a chat assigned to a project workspace folder. Ask for `note.md` and `riepilogo.md` inside it: no MCP confirmation card may appear. Then request a filesystem write outside that root: a confirmation card must appear and remain needed.

Progress (2026-06-22): the Electron gateway was restarted from HEAD and the
`kimi-k2.6:cloud` gate passed in the `test-homun` project:
`mcp__filesystem__create` created
`/Users/fabio/Desktop/test-homun/path-b-gate/note.md` without an MCP card.
The exact user/assistant turn is persisted in
`thread_1782138001_1782138001354628000`. The visible-UI/Gemma repeat and the
outside-root card remain open.

- [x] **Step 3: Record only proven state**

Document the exact workspace path, in-root no-card evidence, out-of-root card evidence, test counts, and remaining work. Do not publish, tag, or push.
