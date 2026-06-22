# Telegram bridge rebind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Telegram approvals across desktop-gateway restart/update by reconfiguring a live bridge with the current callback credentials, or replacing a legacy/stale bridge safely.

**Architecture:** `channel-telegram` owns its callback URL and token in a shared, mutable loopback state. The desktop gateway first posts an authenticated rebind request to an occupied Telegram port. It retains a responsive compatible sidecar; any unsupported, unauthorized, or failed rebind follows the existing controlled stop-and-spawn path. The callback path emits only a redacted transport outcome.

**Tech Stack:** Rust 2024, Axum 0.7, Tokio, Reqwest, Frankenstein Telegram Bot API, existing desktop-gateway integration tests.

---

## File structure

- `runtimes/channel-telegram/src/main.rs`: loopback bridge API, mutable callback target, callback forwarding diagnostics and unit tests.
- `crates/desktop-gateway/src/main.rs`: Telegram sidecar lifecycle, rebind policy and startup timing, plus unit tests for the reuse/restart decision.
- `docs/DEVELOPMENT.md`: state and verification evidence for WS6 6.1b.
- `docs/plans/2026-06-22-batch-1042-artifacts-memory.md`: WS6 backlog state.

### Task 1: Make the Telegram callback target reconfigurable

**Files:**
- Modify: `runtimes/channel-telegram/src/main.rs:1-410`
- Test: `runtimes/channel-telegram/src/main.rs:546-570`

- [ ] **Step 1: Write the failing bridge-state tests**

Add a test-only target constructor and these tests in the existing `mod tests`:

```rust
#[test]
fn reconfigure_replaces_the_callback_target() {
    let state = BridgeState::for_test("bot-secret", GatewayTarget::new("http://127.0.0.1:18765", "old"));
    assert!(state.reconfigure("bot-secret", GatewayTarget::new("http://127.0.0.1:18765", "new")));
    assert_eq!(state.gateway_target().unwrap().token, "new");
}

#[test]
fn reconfigure_rejects_the_wrong_control_secret() {
    let state = BridgeState::for_test("bot-secret", GatewayTarget::new("http://127.0.0.1:18765", "old"));
    assert!(!state.reconfigure("wrong", GatewayTarget::new("http://127.0.0.1:18765", "new")));
    assert_eq!(state.gateway_target().unwrap().token, "old");
}
```

- [ ] **Step 2: Run the bridge tests and verify RED**

Run:

```bash
cargo test --manifest-path runtimes/channel-telegram/Cargo.toml reconfigure_
```

Expected: compilation failure because `BridgeState` and `GatewayTarget` do not exist.

- [ ] **Step 3: Add the smallest mutable bridge state and authenticated reconfigure route**

Replace the bare `Arc<Bot>` Axum state with:

```rust
#[derive(Clone)]
struct GatewayTarget { url: String, token: String }

#[derive(Clone)]
struct BridgeState {
    bot: Arc<Bot>,
    control_token: Arc<str>,
    target: Arc<std::sync::RwLock<Option<GatewayTarget>>>,
}
```

Add `POST /configure-gateway`. It requires `Authorization: Bearer <TG_BOT_TOKEN>`, validates that
`gateway_url` is loopback HTTP, replaces only the `target` value, returns `204 No Content`, and
never serializes or logs either token. Change `forward_inbound` and `forward_callback` to snapshot
`state.gateway_target()` immediately before their HTTP request. Build the `BridgeState` once in
`main` and pass it to `serve_http` and the polling loop.

- [ ] **Step 4: Run the bridge tests and verify GREEN**

Run:

```bash
cargo test --manifest-path runtimes/channel-telegram/Cargo.toml reconfigure_
```

Expected: both tests pass.

- [ ] **Step 5: Commit the bridge target change**

```bash
git add runtimes/channel-telegram/src/main.rs
git commit -m "feat: allow Telegram bridge gateway rebind"
```

### Task 2: Record redacted callback-forward outcomes

**Files:**
- Modify: `runtimes/channel-telegram/src/main.rs:278-298`
- Test: `runtimes/channel-telegram/src/main.rs:546-590`

- [ ] **Step 1: Write the failing diagnostic-redaction test**

```rust
#[test]
fn callback_outcome_label_never_contains_sensitive_values() {
    let label = callback_outcome_label(CallbackOutcome::HttpFailure(401));
    assert_eq!(label, "http_401");
    assert!(!label.contains("bot-secret"));
    assert!(!label.contains("gateway-token"));
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test --manifest-path runtimes/channel-telegram/Cargo.toml callback_outcome_label_never_contains_sensitive_values
```

Expected: compilation failure because `CallbackOutcome` and `callback_outcome_label` do not exist.

- [ ] **Step 3: Implement the minimal outcome classifier**

Add:

```rust
enum CallbackOutcome { Delivered, HttpFailure(u16), TransportFailure, Unconfigured }

fn callback_outcome_label(outcome: CallbackOutcome) -> String {
    match outcome {
        CallbackOutcome::Delivered => "delivered".into(),
        CallbackOutcome::HttpFailure(code) => format!("http_{code}"),
        CallbackOutcome::TransportFailure => "transport_failure".into(),
        CallbackOutcome::Unconfigured => "unconfigured".into(),
    }
}
```

Make `forward_callback` return this enum and emit exactly one line containing the label. It must
not include request URLs, headers, callback data, chat identifiers, or response bodies. Preserve
the existing polling behavior: the update is acknowledged and the next poll continues.

- [ ] **Step 4: Run the focused test and all bridge tests**

Run:

```bash
cargo test --manifest-path runtimes/channel-telegram/Cargo.toml
```

Expected: all bridge tests pass.

- [ ] **Step 5: Commit the diagnostic change**

```bash
git add runtimes/channel-telegram/src/main.rs
git commit -m "fix: report redacted Telegram callback outcomes"
```

### Task 3: Rebind or replace the Telegram sidecar from the gateway

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:540-544,15765-16108,30602-32230`
- Test: `crates/desktop-gateway/src/main.rs:30602-32230`

- [ ] **Step 1: Write the failing lifecycle-decision tests**

Add a pure decision enum and tests in the existing gateway test module:

```rust
#[test]
fn telegram_rebind_keeps_a_compatible_sidecar() {
    assert_eq!(telegram_bridge_action(RebindResult::Configured), TelegramBridgeAction::Keep);
}

#[test]
fn telegram_rebind_replaces_legacy_or_failed_sidecars() {
    assert_eq!(telegram_bridge_action(RebindResult::Http(404)), TelegramBridgeAction::Replace);
    assert_eq!(telegram_bridge_action(RebindResult::Http(401)), TelegramBridgeAction::Replace);
    assert_eq!(telegram_bridge_action(RebindResult::Transport), TelegramBridgeAction::Replace);
}
```

- [ ] **Step 2: Run the focused gateway tests and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway telegram_rebind_
```

Expected: compilation failure because `RebindResult`, `TelegramBridgeAction`, and
`telegram_bridge_action` do not exist.

- [ ] **Step 3: Implement rebind policy and sidecar lifecycle**

Add:

```rust
#[derive(Debug, PartialEq, Eq)]
enum RebindResult { Configured, Http(u16), Transport }

#[derive(Debug, PartialEq, Eq)]
enum TelegramBridgeAction { Keep, Replace }

fn telegram_bridge_action(result: RebindResult) -> TelegramBridgeAction {
    if result == RebindResult::Configured { TelegramBridgeAction::Keep } else { TelegramBridgeAction::Replace }
}
```

Implement `rebind_telegram_bridge(state, bot_token)` with a short timeout POST to
`http://127.0.0.1:18767/configure-gateway`, bearer-authenticated with `bot_token`, and a JSON
body containing `gateway_url: http://127.0.0.1:<current port>` and
`gateway_token: state.auth_token`. Classify only `204` as `Configured`; do not log body or tokens.

Extract `stop_telegram_sidecar()` from `telegram_disconnect` and `spawn_telegram_sidecar()` from
`telegram_connect`. If the port is occupied, use rebind; on `Replace`, stop the tracked/orphan
listener and spawn with the current `state.auth_token`. Change `telegram_connect` to receive
`State(state)` and use this lifecycle instead of immediately returning `already_running`.

Make `reconnect_channels_on_startup` async and pass `AppState`. Invoke it with `tokio::spawn`
only after the gateway listener is bound, so callbacks cannot race a server that is not listening.
Its Telegram branch uses the same ensure/rebind lifecycle; its WhatsApp behavior remains unchanged.

- [ ] **Step 4: Run focused and full gateway tests**

Run:

```bash
cargo test -p local-first-desktop-gateway telegram_rebind_
cargo test -p local-first-desktop-gateway
```

Expected: focused lifecycle tests and the full gateway suite pass.

- [ ] **Step 5: Commit the gateway lifecycle change**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "fix: rebind stale Telegram sidecars on gateway startup"
```

### Task 4: Validate the real approval-resume path and record evidence

**Files:**
- Modify: `docs/DEVELOPMENT.md`
- Modify: `docs/plans/2026-06-22-batch-1042-artifacts-memory.md`

- [ ] **Step 1: Build both local binaries**

Run:

```bash
cargo build --manifest-path runtimes/channel-telegram/Cargo.toml
cargo build -p local-first-desktop-gateway
```

Expected: both commands exit 0.

- [ ] **Step 2: Reproduce the stale-sidecar case in Electron**

Run `cd apps/desktop && npm run electron:dev`. With an old bridge on `:18767`, verify the
gateway performs a successful rebind or controlled replacement. Create a Gemma chat, reset
`~/demo-piano`, send the existing demo-piano prompt, and approve the first MCP file write from
Telegram.

- [ ] **Step 3: Verify durable evidence**

Run:

```bash
find "$HOME/demo-piano" -maxdepth 1 -type f -print | sort
sqlite3 "$HOME/.homun/desktop-gateway.sqlite" \
  "SELECT role, text FROM chat_messages WHERE thread_id = '<new-thread-id>' ORDER BY timestamp;"
```

Expected: `note.md` and `riepilogo.md` exist; the thread contains the approved action plus a
persisted continuation/final result. Telegram receives a success result rather than a silent tap.

- [ ] **Step 4: Update durable state**

Replace the WS6 6.1b Telegram-block entry with the observed result, commit hashes, test commands,
and any remaining UX limitation. Do not mark 6.1b complete unless the filesystem and chat-store
evidence both pass.

- [ ] **Step 5: Commit the verification record**

```bash
git add docs/DEVELOPMENT.md docs/plans/2026-06-22-batch-1042-artifacts-memory.md
git commit -m "docs: record Telegram approval-resume gate"
```
