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

**Current checkpoint (2026-06-22):** local code is past the original Path B
implementation and now includes the approval provenance fix required by the
invalidated HTTP probe. The next Electron gate must validate the full persisted
chain: `MCP_CONFIRM` marker with `approval_id` → saved assistant card in
`chat_messages` → `remote_approvals.source_message_id` → Telegram callback →
tool execution → source card rewritten/done → resume without stale-context
contamination. The in-app approval branch passed. The first Telegram retry
proved callback execution (`status='executed'`) but failed the resume output:
the model answered with stale `path-b-gate/note.md`. Local fix: resume prompts
now include original user request + approved args + anti-memory/open-loop
guardrails. The second Telegram retry passed from HEAD: file, `executed` row,
and final assistant message all reference the approved path. Do not use direct
HTTP write probes for this gate.

- [x] **Step 1: Build and run**

Run:

```bash
cargo build -p local-first-desktop-gateway
cd apps/desktop && npm run electron:dev
```

- [x] **Step 2: Verify both policy branches plus persisted remote provenance**

Use Gemma in a chat assigned to a project workspace folder. Ask for `note.md` and `riepilogo.md` inside it: no MCP confirmation card may appear. Then request a filesystem write outside that root: a confirmation card must appear and remain needed.

For the outside-root branch, use the canonical prompt:

```text
Usa il tool MCP filesystem per creare /Users/fabio/Desktop/path-b-approval-bound.md con una riga: test.
```

Acceptance evidence:

- `/Users/fabio/Desktop/path-b-approval-bound.md` exists with `test`.
- `chat_messages` contains the source card with `approval_id` before Telegram execution.
- `remote_approvals` has `source_message_id` for that approval and ends in `executed`.
- No assistant continuation mentions or acts on older `path-b-gate/note.md` context.

Partial result (2026-06-22, in-app approval branch): prompt above created
`/Users/fabio/Desktop/path-b-approval-bound.md` with `test`. Evidence:
thread `thread_1782142399_1782142399448892000`; `chat_messages` records prompt,
`✓ MCP tool executed: mcp__filesystem__create`, and final success message; zero
`path-b-gate/note.md` mentions in the thread. The `remote_approvals` row
`approval_b7a4a02ae4944ead862ecb9ef8af02c4` is bound to
`source_message_id=browser_assistant_1782142417646` and ended `superseded`,
which proves the in-app execution invalidated the remote code. Still open:
Telegram callback execution branch ending `executed` **and** a final assistant
message anchored to the approved path. First retry created
`/Users/fabio/Desktop/path-b-telegram-bound.md` with `telegram-test` and
`remote_approvals.status='executed'`, but the resume message switched to stale
`path-b-gate/note.md`; this invalidates the UX/resume half of that gate.
Final result (2026-06-22, Telegram approval branch): after rebuild+restart,
prompt created `/Users/fabio/Desktop/path-b-telegram-bound-2.md` with
`telegram-test-2`; `remote_approvals` row
`approval_bf564060200f430fa6dd653ec585aa79` ended `executed` with
`source_message_id=browser_assistant_1782143967279`; thread
`thread_1782143941_1782143941578301000` records prompt, executed marker, and a
final message anchored to the approved path/content/byte count; zero
`path-b-gate/note.md` mentions in that thread. Gate closed.

Progress (2026-06-22): the Electron gateway was restarted from HEAD and the
`kimi-k2.6:cloud` gate passed in the `test-homun` project:
`mcp__filesystem__create` created
`/Users/fabio/Desktop/test-homun/path-b-gate/note.md` without an MCP card.
The exact user/assistant turn is persisted in
`thread_1782138001_1782138001354628000`. The prompt was then corrected so an
explicit outside-root path calls the tool and lets the runtime show its
confirmation card, rather than making the model claim that Filesystem MCP is
unavailable. Kimi produced that card in
`thread_1782139063_1782139063946466000`; a subsequent Telegram authorization
executed the write, as recorded in `tool_runs`. The visible-UI/Gemma repeat and
a controlled outside-root check that confirms the file is absent before
authorization remain open. A later end-to-end reproduction found an upstream
routing/compatibility failure, not a missing filesystem connection: Auto chose
the project's `coding` role (`glm-5.2`) while the composer displayed
`kimi-k2.6:cloud`; GLM rejected the tool-bearing round with `400/1210`, then
the agent loop generated a no-tool synthesis. The local fix makes the model
listing thread-aware, omits empty tool arrays, retries one tool-bearing `400`
through the configured orchestrator, and routes headless resume through the
same thread resolver. Gateway tests are 157 passed / 1 ignored and the desktop
build is green. The Electron gateway runtime proof used
`thread_1782140733_1782140733708101000`: Auto resolved `glm-5.2`, the fallback
activity occurred once, an MCP confirmation marker was emitted for
`/Users/fabio/Desktop/path-b-provider-fallback-1782140733.md`, and the file was
absent before authorization. This is NOT a valid closure: the raw HTTP probe
delivered a real Telegram approval while never persisting its source card in the
thread. Its later approval executed the probe and resumed a nearly empty thread,
which then contaminated the current task with the older
`path-b-gate/note.md` context. The thread/store chain proves the resume; active
streams are now empty. The durable fix is implemented locally: pending remote
approvals are stored in `remote_approvals`, card markers carry `approval_id`,
remote delivery is deferred until the assistant card is persisted and bound to a
`source_message_id`, and callback execution verifies approval_id+tool+args
against that saved card before claiming `pending→executing`. In-app approval
supersedes its remote code, and Composio now uses the same server-side card
verification. Gateway tests are 159 passed / 1 ignored. Next Path B gate:
restart Electron from HEAD and validate the in-app/Telegram chain only; do not
use the direct endpoint for live write testing.

- [x] **Step 3: Record only proven state**

Document the exact workspace path, in-root no-card evidence, out-of-root card evidence, test counts, and remaining work. Do not publish, tag, or push.
