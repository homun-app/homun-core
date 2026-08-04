# Host Computer Control 03 Agent and Policy Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose host application control to Homun through one manager-level `use_computer` capability and an isolated recursive worker turn, with per-app grants, action approvals, privacy redaction, complete journaling, and no route around the existing engine capability chokepoint.

**Architecture:** The desktop gateway owns a singleton `HostComputerService`, grant store, approval classifier, and session coordinator. The manager sees only `use_computer`. That call launches a recursive engine turn with a host-only capability executor and granular computer schemas; no granular schema enters the manager prompt. The gateway authorizes every observation and mutation before the helper independently rechecks hard denials. State and events join the existing local-computer session read model and unified WebSocket.

**Tech Stack:** Rust, Axum, SQLite/rusqlite, existing Homun engine agent loop and capability registry, Serde JSON Schema, Tokio, unified WebSocket events.

---

**Depends on:** `2026-07-21-host-computer-02-native-control.md`

**Unblocks:** `2026-07-21-host-computer-04-ui-release.md`

## File map

- Modify `crates/local-computer-session/src/types.rs`: add `HostApps` surface and host-control event/read-model fields.
- Modify focused local-computer-session tests for compatibility and redaction.
- Create `crates/host-computer/src/grants.rs`: workspace/user/app grant persistence.
- Create `crates/host-computer/src/policy.rs`: deterministic action classification and authorization.
- Create `crates/host-computer/src/redaction.rs`: prompt/provider-safe snapshot projection.
- Create `crates/host-computer/src/session.rs`: serialized session, approval, takeover, and completion state machine.
- Modify `crates/host-computer/src/lib.rs`: export gateway-facing service types.
- Modify `crates/desktop-gateway/src/main.rs`: state, routes, schemas, recursive turn, executors, and events.
- Modify `crates/desktop-gateway/src/ws_gateway.rs`: reuse `computer.live` for the host read
  model and `app.event` for typed host audit transitions without creating a parallel socket.
- Create focused gateway test modules under `crates/desktop-gateway/src/host_computer_tests/`
  and include them from the existing `#[cfg(test)]` section in `main.rs`, so the binary
  crate's private gateway types remain directly testable.

### Task 1: Extend the local-computer session model compatibly

**Files:**
- Modify: `crates/local-computer-session/src/types.rs`
- Modify: `crates/local-computer-session/src/read_model.rs`
- Modify: `crates/local-computer-session/tests/session_lifecycle.rs`
- Modify: `crates/local-computer-session/tests/read_model_redaction.rs`
- Create: `crates/local-computer-session/tests/host_apps_compatibility.rs`

- [ ] **Step 1: Write failing compatibility and redaction tests**

Test deserializing old Browser/Shell/Files/Logs records, serializing the new `host_apps`
surface, mapping start/snapshot/action/approval/takeover/done events, and redacting text,
screenshot paths, tokens, secure values, and approval payload secrets.

```rust
#[test]
fn old_session_records_still_deserialize() {
    for value in ["browser", "shell", "files", "logs"] {
        let surface: SurfaceKind = serde_json::from_str(&format!("\"{value}\"")).unwrap();
        assert_ne!(surface, SurfaceKind::HostApps);
    }
}

#[test]
fn host_event_projection_never_contains_typed_text() {
    let event = host_action_event("type_text", json!({"text": "customer-secret"}));
    assert!(!project_event(event).to_string().contains("customer-secret"));
}
```

- [ ] **Step 2: Run local-session tests and verify RED**

Run:

```bash
cargo test -p local-first-local-computer-session
```

Expected: FAIL on missing `SurfaceKind::HostApps` and host event mappings.

- [ ] **Step 3: Implement additive session/read-model fields**

Add `HostApps` as an additive serde value. Represent host state with source, session ID,
app/window public metadata, phase (`observing`, `awaiting_approval`, `acting`,
`paused_by_user`, `suspended`, `done`, `failed`), last action category, screenshot artifact
reference, and timestamps. Persist action summaries and hashes, never typed content or AX
values. Unknown event fields remain forward-compatible.

- [ ] **Step 4: Run local-session suite for GREEN**

Run:

```bash
cargo test -p local-first-local-computer-session
cargo clippy -p local-first-local-computer-session --all-targets -- -D warnings
```

Expected: old and new session tests pass; clippy exits 0.

- [ ] **Step 5: Commit the additive session model**

```bash
git add crates/local-computer-session
git commit -m "feat(computer): model host app sessions"
```

### Task 2: Persist per-app grants with exact scope and revocation

**Files:**
- Create: `crates/host-computer/src/grants.rs`
- Modify: `crates/host-computer/src/lib.rs`
- Create: `crates/host-computer/tests/grant_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing grant-store tests**

Cover user/workspace isolation, real bundle-ID matching, code-signing identity change,
grant levels (`observe`, `control`), expiry, revoke, app removal, duplicate upsert, migration,
and factory-reset deletion. A display name must never authorize an app.

```rust
#[test]
fn same_named_app_with_different_signing_identity_is_not_granted() {
    let store = test_store();
    store.grant(scope("workspace-a"), app("com.example.Editor", "TEAM1"), GrantLevel::Control).unwrap();
    assert_eq!(store.resolve(scope("workspace-a"), app("com.example.Editor", "TEAM2")).unwrap(), None);
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cargo test -p local-first-host-computer --test grant_store
```

Expected: FAIL because the grant store is absent.

- [ ] **Step 3: Implement the SQLite grant store and read-only routes**

Create a versioned `host_computer_app_grants` table keyed by user ID, workspace ID, bundle
ID, signing team ID, and designated requirement hash. Store level, created/updated/expiry
timestamps, and last-resolved app metadata. Add gateway routes:

```text
GET    /api/host-computer/status
GET    /api/host-computer/apps
GET    /api/host-computer/grants
POST   /api/host-computer/permissions/present
POST   /api/host-computer/grants
DELETE /api/host-computer/grants/{grant_id}
```

Mutating grant routes require an authenticated local UI request and reject agent tool
calls. Resolve current code-signing identity through the helper before upsert. Revocation
immediately cancels active sessions for that app.

- [ ] **Step 4: Run grant and gateway tests for GREEN**

Run:

```bash
cargo test -p local-first-host-computer --test grant_store
cargo test -p local-first-desktop-gateway host_computer_grant
```

Expected: grant isolation, identity, revocation, and route tests pass.

- [ ] **Step 5: Commit grant persistence**

```bash
git add crates/host-computer crates/desktop-gateway
git commit -m "feat(computer): persist scoped host app grants"
```

### Task 3: Classify and authorize every action deterministically

**Files:**
- Create: `crates/host-computer/src/policy.rs`
- Create: `crates/host-computer/tests/policy_matrix.rs`
- Modify: `crates/host-computer/src/session.rs`

- [ ] **Step 1: Write the failing policy matrix**

Cover read-only inventory/state/screenshot; ordinary reversible UI actions; text entry;
file open/save/export; communication send; purchase/checkout; permission/settings change;
destructive action; credential/secure input; terminal input. Test observe/control grants,
per-action approval tokens, expiry, replay, scope mismatch, and hard denials.

```rust
#[test]
fn send_and_purchase_require_exact_single_use_approval() {
    for category in [ActionCategory::ExternalCommunication, ActionCategory::Purchase] {
        let decision = policy().decide(control_grant(), request(category), None);
        assert!(matches!(decision, PolicyDecision::ApprovalRequired(_)));
    }
}

#[test]
fn terminal_input_is_denied_even_with_control_and_approval() {
    assert_eq!(policy().decide(control_grant(), terminal_request(), valid_approval()), PolicyDecision::Denied(HardDeny::TerminalInput));
}
```

- [ ] **Step 2: Run the policy suite and verify RED**

Run:

```bash
cargo test -p local-first-host-computer --test policy_matrix
```

Expected: FAIL because the policy classifier is absent.

- [ ] **Step 3: Implement the policy lattice and approval tokens**

Classify from resolved app identity, semantic action, target role, target label, and action
parameters. The deterministic order is: hard deny; grant requirement; approval category;
allowed. Observe grants permit list/state/screenshot only. Control grants permit ordinary
reversible actions. Text entry requires a visible one-time approval unless workspace
policy explicitly enables low-risk typing; communication, purchases, destructive actions,
file writes/exports, and system settings always require one-time approval with an exact
human-readable summary. Tokens are random, hashed at rest, scoped to session/app/action
digest, expire after five minutes, and are consumed atomically.

- [ ] **Step 4: Run policy and session tests for GREEN**

Run:

```bash
cargo test -p local-first-host-computer --test policy_matrix
cargo test -p local-first-host-computer session
```

Expected: the entire decision matrix and token lifecycle pass.

- [ ] **Step 5: Commit policy enforcement**

```bash
git add crates/host-computer
git commit -m "feat(computer): enforce host action policy"
```

### Task 4: Project privacy-safe model snapshots

**Files:**
- Create: `crates/host-computer/src/redaction.rs`
- Create: `crates/host-computer/tests/redaction_contract.rs`
- Modify: `crates/host-computer/src/service.rs`

- [ ] **Step 1: Write failing redaction and disclosure tests**

Cover secure fields, values matching secret patterns, email/phone/account content, long
documents, filenames, browser URLs, screenshots, local-vs-remote provider modes, and a
workspace allowlist. Redaction must retain element indices and actionability.

```rust
#[test]
fn remote_projection_preserves_structure_but_redacts_private_values() {
    let projected = project(snapshot_with_private_values(), ProviderDisclosure::Remote, &policy());
    assert_eq!(projected.elements[4].index, 4);
    assert_eq!(projected.elements[4].value.as_deref(), Some("[redacted]"));
    assert!(projected.elements[4].actions.contains(&SemanticAction::Press));
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cargo test -p local-first-host-computer --test redaction_contract
```

Expected: FAIL because provider projection does not exist.

- [ ] **Step 3: Implement disclosure projection before prompt construction**

Always remove secure values, auth tokens, absolute artifact paths, clipboard contents, and
raw screenshots. For remote providers, redact private values by default and emit labels,
roles, safe short values, bounds, and available actions. Screenshots require the app grant
plus a separate workspace disclosure setting; otherwise the model receives the AX tree
only. Record what disclosure class was used, not the removed content. Fail closed when
provider locality is unknown.

- [ ] **Step 4: Run privacy and crate tests for GREEN**

Run:

```bash
cargo test -p local-first-host-computer --test redaction_contract
cargo test -p local-first-host-computer
```

Expected: redaction and all prior crate tests pass.

- [ ] **Step 5: Commit privacy projection**

```bash
git add crates/host-computer
git commit -m "feat(computer): redact host state before model use"
```

### Task 5: Register only the manager-level `use_computer` tool

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Create: `crates/desktop-gateway/src/host_computer_tests/tools.rs`

- [ ] **Step 1: Write failing schema-visibility tests**

Test that the normal manager registry contains `use_computer` only when macOS, feature
flag, helper, permissions, and at least one grant are available. Prove all granular
`computer_*` names are absent from the normal registry and serialized manager prompt.

```rust
#[test]
fn manager_sees_one_computer_tool_and_no_granular_actions() {
    let tools = manager_tools(host_ready_fixture());
    assert!(tools.iter().any(|tool| tool.name == "use_computer"));
    assert!(!tools.iter().any(|tool| tool.name.starts_with("computer_")));
}
```

- [ ] **Step 2: Run focused gateway tests and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway host_computer_tools
```

Expected: FAIL because no tool schema or availability rule exists.

- [ ] **Step 3: Add the manager schema and singleton state**

Initialize `Arc<HostComputerService>` once in `AppState`. Register:

```json
{
  "name": "use_computer",
  "description": "Use an approved application on this Mac to accomplish a bounded goal.",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["goal"],
    "properties": {
      "goal": { "type": "string", "minLength": 1, "maxLength": 2000 },
      "app": { "type": "string", "maxLength": 200 }
    }
  }
}
```

Gate it behind `HOMUN_HOST_COMPUTER=1`, `target_os = macos`, successful helper handshake,
both permissions, and a scoped app grant. Do not add a second engine capability trait;
keep interception in the existing `CapabilityExecutor::execute_tool` chokepoint alongside
`browse`.

- [ ] **Step 4: Run tool-visibility and gateway tests for GREEN**

Run:

```bash
cargo test -p local-first-desktop-gateway host_computer_tools
cargo test -p local-first-desktop-gateway use_computer_schema
```

Expected: manager visibility tests pass and no granular action leaks.

- [ ] **Step 5: Commit the manager capability**

```bash
git add crates/desktop-gateway
git commit -m "feat(computer): register bounded host capability"
```

### Task 6: Run an isolated host-computer recursive turn

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Create: `crates/desktop-gateway/src/host_computer_tests/subturn.rs`

- [ ] **Step 1: Write failing recursive-turn isolation tests**

Cover granular schema list, inability to call shell/browser/filesystem/normal plugins,
maximum steps, timeout, token budget, approval pause, user takeover, stale snapshot retry,
`computer_done`, and sanitized result returned to the manager.

Required worker-only tools:

```text
computer_list_apps
computer_list_windows
computer_get_app_state
computer_launch_app
computer_activate_window
computer_click
computer_drag
computer_scroll
computer_set_value
computer_select_text
computer_type_text
computer_press_key
computer_perform_secondary_action
computer_get_screenshot
computer_done
```

- [ ] **Step 2: Run subturn tests and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway host_computer_subturn
```

Expected: FAIL because the recursive worker and host-only executor do not exist.

- [ ] **Step 3: Implement the recursive worker using the existing agent loop**

Mirror the existing browse recursion structure with `GatewayHostComputerExecutor`,
`HostComputerOnlyCapabilityExecutor`, and `HostSubturnNoBrowserExecutor`. Call the same
`engine::agent_loop::run_turn`; supply only granular host schemas; reject every other tool
in the executor even if the model invents it. The worker system prompt requires fresh
state after mutations, semantic indices before coordinates, no protected targets, approval
respect, immediate stop on takeover/lock, and `computer_done` with a concise outcome.

Bound a session to 40 tool steps, ten minutes, one active session per desktop, and the
parent turn's remaining token/provider budget. Serialize mutations through the session
coordinator. On helper crash, perform at most one supervised restart, invalidate every
snapshot/session generation, force a full observation, and never replay the last mutation.
Return only `{status, summary, app, final_artifact_refs}` to the manager.

- [ ] **Step 4: Run isolation and relevant engine tests for GREEN**

Run:

```bash
cargo test -p local-first-desktop-gateway host_computer_subturn
cargo test -p local-first-engine
```

Expected: recursion succeeds through fakes, forbidden tools are denied, and engine tests
remain green.

- [ ] **Step 5: Commit the recursive worker**

```bash
git add crates/desktop-gateway
git commit -m "feat(computer): execute isolated host subturns"
```

### Task 7: Publish approvals, takeover, completion, and audit events

**Files:**
- Modify: `crates/desktop-gateway/src/ws_gateway.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Create: `crates/desktop-gateway/src/host_computer_tests/events.rs`
- Modify: `crates/host-computer/src/session.rs`

- [ ] **Step 1: Write failing event-sequence and replay tests**

Require ordered host transitions `started`, `state`, `approval_required`,
`approval_resolved`, `paused_by_user`, `resumed`, `action`, `done`, and `failed`. Test
reconnect replay, duplicate resolution, cancel, revocation during approval, and sanitized
persistence. Current state travels as `computer.live` with `source: host_apps`; transition
records travel as typed `app.event` payloads with names prefixed `host_computer.`.

```rust
#[tokio::test]
async fn approval_event_contains_summary_but_not_typed_text() {
    let event = approval_required_fixture("Send message", "private body");
    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("Send message"));
    assert!(!json.contains("private body"));
}
```

- [ ] **Step 2: Run focused event tests and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway host_computer_events
```

Expected: FAIL because host event publication and approval routes are absent.

- [ ] **Step 3: Implement WS events, approval routes, and journaling**

Add unified WS variants and routes:

```text
POST /api/host-computer/sessions/{session_id}/approve
POST /api/host-computer/sessions/{session_id}/deny
POST /api/host-computer/sessions/{session_id}/pause
POST /api/host-computer/sessions/{session_id}/resume
POST /api/host-computer/sessions/{session_id}/cancel
```

Require a local UI CSRF/session token and exact pending action digest. Journal session
metadata, app identity, decision, action category, outcome, timing, artifact references,
and redaction/disclosure class. Never journal typed text, AX values, screenshots, socket
paths, auth tokens, or approval tokens. Publish the read model after each state change.

- [ ] **Step 4: Run the integrated backend gate for GREEN**

Run:

```bash
cargo test -p local-first-host-computer
cargo test -p local-first-local-computer-session
cargo test -p local-first-desktop-gateway host_computer
cargo test -p local-first-engine
cargo clippy -p local-first-host-computer -p local-first-local-computer-session --all-targets -- -D warnings
git diff --check
```

Expected: all targeted backend tests pass; formatting check has no errors.

- [ ] **Step 5: Commit events and audit integration**

```bash
git add crates/desktop-gateway crates/host-computer
git commit -m "feat(computer): journal host control sessions"
```

## Phase completion gate

- [ ] The manager sees only `use_computer`; granular tools exist only inside the recursive worker.
- [ ] Every operation passes both gateway policy and the helper's local hard-denial firewall.
- [ ] App grants are workspace/user/signing-identity scoped and immediately revocable.
- [ ] Approval, takeover, cancel, lock, timeout, and completion state machines have deterministic tests.
- [ ] Remote-provider snapshots are privacy projected before prompt construction.
- [ ] Targeted host-computer, local-session, desktop-gateway, and engine tests pass.
- [ ] No UI or release claim is made before plan 04.
- [ ] `git diff --check` passes and the worktree is clean.
