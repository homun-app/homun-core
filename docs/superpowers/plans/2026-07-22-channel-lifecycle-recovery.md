# Channel Lifecycle Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make channel turns execute independently of the workspace selected in the UI and make a successful Telegram sidecar rebind restore canonical connected status.

**Architecture:** Move cross-workspace candidate discovery into `task-runtime`, then let the gateway apply its existing recovery/resource/dependency sweeps to every non-terminal task scope before selecting one globally ordered task. Make Telegram rebind validate the live bot identity and persist status through a state-owned status path so the lifecycle is deterministic and testable without real credentials.

**Tech Stack:** Rust 2024, rusqlite, Tokio, Axum, reqwest, frankenstein Telegram client, existing Homun task scheduler/lease/resource governor.

---

## File Map

- `crates/task-runtime/src/store.rs` — enumerate a user's workspace scopes that still contain non-terminal tasks.
- `crates/task-runtime/src/scheduler.rs` — select ready tasks across those scopes using the existing priority/age/id order.
- `crates/task-runtime/tests/store.rs` — store-level scope discovery regression.
- `crates/task-runtime/tests/scheduler.rs` — cross-workspace ordering regression.
- `crates/desktop-gateway/src/main.rs` — apply worker maintenance to every task scope and acquire the selected task using its persisted workspace.
- `runtimes/channel-telegram/src/main.rs` — make rebind refresh bot identity and persist status before success.
- `runtimes/channel-telegram/Cargo.toml` — add test-only temporary-directory support.
- `docs/superpowers/specs/2026-07-22-channel-lifecycle-recovery-design.md` — update final verification status only after implementation gates pass.

### Task 1: Discover and order runnable tasks across workspaces

**Files:**
- Modify: `crates/task-runtime/src/store.rs:961`
- Modify: `crates/task-runtime/src/scheduler.rs:1-55`
- Test: `crates/task-runtime/tests/store.rs`
- Test: `crates/task-runtime/tests/scheduler.rs`

- [ ] **Step 1: Write the failing store test**

Append a test that inserts queued personal work, waiting project work, and terminal-only archived work:

```rust
#[test]
fn store_lists_only_workspace_scopes_with_non_terminal_tasks() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let personal = WorkspaceId::new("local-workspace");
    let project = WorkspaceId::new("workspace_project");
    let archived = WorkspaceId::new("workspace_archived");

    store.insert_task(&TaskRecord::new(
        "channel_turn", user.clone(), personal.clone(), "chat_turn", "Reply", json!({}),
    )).unwrap();

    let mut waiting = TaskRecord::new(
        "project_wait", user.clone(), project.clone(), "capability.call", "Wait", json!({}),
    );
    waiting.status = TaskStatus::WaitingResource;
    store.insert_task(&waiting).unwrap();

    let mut completed = TaskRecord::new(
        "archived", user.clone(), archived, "chat_turn", "Done", json!({}),
    );
    completed.status = TaskStatus::Completed;
    store.insert_task(&completed).unwrap();

    assert_eq!(
        store.non_terminal_workspace_ids(&user).unwrap(),
        vec![personal, project],
    );
}
```

- [ ] **Step 2: Run the store test and verify RED**

Run:

```bash
cargo test -p local-first-task-runtime --test store store_lists_only_workspace_scopes_with_non_terminal_tasks -- --nocapture
```

Expected: compile failure because `TaskStore::non_terminal_workspace_ids` does not exist.

- [ ] **Step 3: Implement the minimal store query**

Add beside `list_tasks`:

```rust
pub fn non_terminal_workspace_ids(
    &self,
    user_id: &UserId,
) -> TaskRuntimeResult<Vec<WorkspaceId>> {
    let mut statement = self.connection.prepare(
        "SELECT DISTINCT workspace_id
         FROM tasks
         WHERE user_id = ?1
           AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')
         ORDER BY workspace_id ASC",
    )?;
    let rows = statement.query_map(params![user_id.as_str()], |row| {
        row.get::<_, String>(0)
    })?;
    rows.map(|row| Ok(WorkspaceId::new(row?))).collect()
}
```

- [ ] **Step 4: Run the store test and verify GREEN**

Run the command from Step 2.

Expected: `1 passed; 0 failed` for the filtered test.

- [ ] **Step 5: Write the failing cross-workspace scheduler test**

Add to `crates/task-runtime/tests/scheduler.rs`:

```rust
#[test]
fn scheduler_selects_ready_tasks_across_workspaces_with_global_ordering() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let personal = WorkspaceId::new("local-workspace");
    let project = WorkspaceId::new("workspace_project");

    let mut older_personal = task("channel_turn", &user, &personal)
        .with_priority(TaskPriority::High);
    older_personal.created_at = OffsetDateTime::from_unix_timestamp(100).unwrap();
    older_personal.updated_at = older_personal.created_at;
    store.insert_task(&older_personal).unwrap();

    let mut newer_project = task("project_turn", &user, &project)
        .with_priority(TaskPriority::High);
    newer_project.created_at = OffsetDateTime::from_unix_timestamp(200).unwrap();
    newer_project.updated_at = newer_project.created_at;
    store.insert_task(&newer_project).unwrap();

    let ready = TaskScheduler::new()
        .ready_tasks_for_user(&store, &user, OffsetDateTime::now_utc(), 10)
        .unwrap();

    assert_eq!(
        ready.iter().map(|task| task.task_id.as_str()).collect::<Vec<_>>(),
        vec!["channel_turn", "project_turn"],
    );
    assert_eq!(ready[0].workspace_id, personal);
}
```

- [ ] **Step 6: Run the scheduler test and verify RED**

Run:

```bash
cargo test -p local-first-task-runtime --test scheduler scheduler_selects_ready_tasks_across_workspaces_with_global_ordering -- --nocapture
```

Expected: compile failure because `TaskScheduler::ready_tasks_for_user` does not exist.

- [ ] **Step 7: Implement global ready-task selection**

Extract the existing sort expression into a private helper and reuse it from both scheduler methods:

```rust
fn sort_ready_tasks(candidates: &mut [TaskRecord]) {
    candidates.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.created_at.cmp(&right.created_at))
            .then_with(|| left.task_id.as_str().cmp(right.task_id.as_str()))
    });
}
```

Add:

```rust
pub fn ready_tasks_for_user(
    &self,
    store: &TaskStore,
    user_id: &UserId,
    now: OffsetDateTime,
    limit: usize,
) -> TaskRuntimeResult<Vec<TaskRecord>> {
    let mut candidates = Vec::new();
    for workspace_id in store.non_terminal_workspace_ids(user_id)? {
        candidates.extend(self.ready_tasks(store, user_id, &workspace_id, now, limit)?);
    }
    sort_ready_tasks(&mut candidates);
    candidates.truncate(limit);
    Ok(candidates)
}
```

- [ ] **Step 8: Run focused and package tests**

Run:

```bash
cargo test -p local-first-task-runtime --test scheduler scheduler_selects_ready_tasks_across_workspaces_with_global_ordering -- --nocapture
cargo test -p local-first-task-runtime --lib
cargo test -p local-first-task-runtime --test scheduler
```

Expected: all commands green. Do not claim the unrelated stale schema-version assertion is green.

- [ ] **Step 9: Commit Task 1**

```bash
git add crates/task-runtime/src/store.rs crates/task-runtime/src/scheduler.rs crates/task-runtime/tests/store.rs crates/task-runtime/tests/scheduler.rs
git commit -m "fix(runtime): schedule tasks across workspaces"
```

### Task 2: Make the gateway worker use each task's persisted scope

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:36660-36720`
- Test: `crates/desktop-gateway/src/main.rs` test module near the existing task-executor tests

- [ ] **Step 1: Write the failing gateway worker-selection test**

Add a pure regression around a new helper named `next_ready_task_across_workspaces`:

```rust
#[test]
fn task_executor_finds_personal_channel_turn_while_project_is_active() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("local-user");
    let personal = WorkspaceId::new("local-workspace");
    let project = WorkspaceId::new("workspace_project");
    let channel = TaskRecord::new(
        "turn_channel_1",
        user.clone(),
        personal.clone(),
        "chat_turn",
        "Reply to channel",
        serde_json::json!({"source": "channel"}),
    );
    store.insert_task(&channel).unwrap();

    let governor = ResourceGovernor::new(ResourceLimits::conservative_defaults());
    let lease = LeaseManager::new(time::Duration::minutes(5));
    let selected = next_ready_task_across_workspaces(
        &store,
        &user,
        time::OffsetDateTime::now_utc(),
        &governor,
        &lease,
    ).unwrap().expect("personal task is visible");

    assert_eq!(selected.task_id.as_str(), "turn_channel_1");
    assert_eq!(selected.workspace_id, personal);
    assert_ne!(selected.workspace_id, project);
}
```

- [ ] **Step 2: Run the gateway test and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway task_executor_finds_personal_channel_turn_while_project_is_active -- --nocapture
```

Expected: compile failure because `next_ready_task_across_workspaces` does not exist.

- [ ] **Step 3: Extract the multi-scope preparation helper**

Add immediately before `run_next_task_once`:

```rust
fn next_ready_task_across_workspaces(
    store: &TaskStore,
    user: &UserId,
    now: OffsetDateTime,
    governor: &ResourceGovernor,
    lease_manager: &LeaseManager,
) -> local_first_task_runtime::TaskRuntimeResult<Option<TaskRecord>> {
    let scheduler = TaskScheduler::new();
    for workspace in store.non_terminal_workspace_ids(user)? {
        lease_manager.recover_stale_leases(store, user, &workspace, now)?;
        requeue_waiting_resource_tasks(store, user, &workspace, governor)?;
        scheduler.mark_blocked_by_terminal_dependencies(store, user, &workspace)?;
        scheduler.expire_overdue_tasks(store, user, &workspace, now)?;
    }
    Ok(scheduler
        .ready_tasks_for_user(store, user, now, 1)?
        .into_iter()
        .next())
}
```

Replace the active-workspace-only selection block in `run_next_task_once` with this helper.

- [ ] **Step 4: Acquire and watch the task in its own workspace**

Immediately after `let Some(task) = task`, bind the persisted scope:

```rust
let workspace = task.workspace_id.clone();
```

Use that `workspace` in `acquire_task_for_execution`, `spawn_lease_watchdog`, and every later lease ownership check. Remove the earlier `let workspace = gateway_workspace_id();` from worker selection. Do not change renderer workspace selection, channel thread placement, memory scope, or executor routing.

- [ ] **Step 5: Run the focused gateway regression and broker tests**

Run:

```bash
cargo test -p local-first-desktop-gateway task_executor_finds_personal_channel_turn_while_project_is_active -- --nocapture
cargo test -p local-first-desktop-gateway task_executor_ -- --nocapture
cargo test -p local-first-desktop-gateway channel_ -- --nocapture
```

Expected: focused regression and existing task/channel tests green.

- [ ] **Step 6: Commit Task 2**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "fix(gateway): execute queued channel turns"
```

### Task 3: Refresh Telegram status on rebind

**Files:**
- Modify: `runtimes/channel-telegram/Cargo.toml`
- Modify: `runtimes/channel-telegram/src/main.rs:25-120`
- Modify: `runtimes/channel-telegram/src/main.rs:250-305`
- Test: `runtimes/channel-telegram/src/main.rs` test module

- [ ] **Step 1: Add test-only temporary path support**

Add:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Write the failing successful-rebind test**

Create a local fake Telegram API whose `POST /bot-test/getMe` returns a valid Telegram envelope. Build the bridge with `Bot::new_url`, invoke the real handler, and assert the file:

```rust
#[tokio::test]
async fn configure_gateway_refreshes_connected_status() {
    let app = Router::new().route(
        "/bot-test/getMe",
        post(|| async {
            Json(serde_json::json!({
                "ok": true,
                "result": {
                    "id": 42,
                    "is_bot": true,
                    "first_name": "Homun",
                    "username": "HomunBot_bot"
                }
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(axum::serve(listener, app));

    let temp = tempfile::tempdir().unwrap();
    let status_file = temp.path().join("telegram-status.json");
    let state = BridgeState::new(
        Arc::new(Bot::new_url(format!("http://{address}/bot-test"))),
        Arc::<str>::from("bot-secret"),
        Some(GatewayTarget::new("http://127.0.0.1:18765", "old")),
        status_file.clone(),
    );
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, "Bearer bot-secret".parse().unwrap());

    let response = configure_gateway_handler(
        State(state),
        headers,
        Json(ConfigureGatewayRequest {
            gateway_url: "http://127.0.0.1:18765".into(),
            gateway_token: "current".into(),
        }),
    ).await;

    assert_eq!(response, StatusCode::NO_CONTENT);
    let status: serde_json::Value = serde_json::from_slice(
        &std::fs::read(status_file).unwrap(),
    ).unwrap();
    assert_eq!(status["connected"], true);
    assert_eq!(status["bot_username"], "HomunBot_bot");
    assert_eq!(status["error"], serde_json::Value::Null);
}
```

- [ ] **Step 3: Run the Telegram success test and verify RED**

Run:

```bash
cargo test --manifest-path runtimes/channel-telegram/Cargo.toml configure_gateway_refreshes_connected_status -- --nocapture
```

Expected: compile failure because `BridgeState::new` has no status-path argument and the handler does not refresh status.

- [ ] **Step 4: Make status path part of bridge state**

Add `status_path: Arc<PathBuf>` to `BridgeState`, accept `impl Into<PathBuf>` in `BridgeState::new`, and pass `status_path()` from `main`. Replace global-only writes with:

```rust
fn write_status_to(path: &std::path::Path, status: &Status) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(status).map_err(std::io::Error::other)?;
    std::fs::write(path, json)
}
```

Keep the startup wrapper so initial `getMe` continues to write the same canonical file.

- [ ] **Step 5: Refresh live identity before rebind success**

After control-token and loopback validation, call `state.bot.get_me().await`. On success, update the target, write:

```rust
Status {
    connected: true,
    bot_username: response.result.username,
    error: None,
}
```

and return `204`. If the live identity probe fails, write:

```rust
Status {
    connected: false,
    bot_username: None,
    error: Some("getMe fallito durante il rebind".to_string()),
}
```

then return `502 Bad Gateway`. If status persistence itself fails, also return `502`. Do not include the underlying URL, token, or debug body in the persisted error.

- [ ] **Step 6: Verify the Telegram success test is GREEN**

Run the command from Step 3.

Expected: `1 passed; 0 failed`.

- [ ] **Step 7: Write and run the failing error-path test**

Use the same local server but return `401` with a Telegram error envelope. Assert `502`, `connected: false`, and that serialized status contains neither `bot-secret` nor `current`:

```rust
assert_eq!(response, StatusCode::BAD_GATEWAY);
let raw = std::fs::read_to_string(status_file).unwrap();
assert!(raw.contains("\"connected\": false"));
assert!(!raw.contains("bot-secret"));
assert!(!raw.contains("current"));
```

Run:

```bash
cargo test --manifest-path runtimes/channel-telegram/Cargo.toml configure_gateway_records_redacted_identity_failure -- --nocapture
```

Expected before the error branch: FAIL because the handler returns the wrong status or does not persist the disconnected state. After minimal implementation: PASS.

- [ ] **Step 8: Run all Telegram tests**

```bash
cargo test --manifest-path runtimes/channel-telegram/Cargo.toml
```

Expected: the original 6 tests plus the 2 new rebind tests all pass.

- [ ] **Step 9: Run the gateway rebind policy tests**

```bash
cargo test -p local-first-desktop-gateway telegram_rebind -- --nocapture
cargo test -p local-first-desktop-gateway telegram_bridge_action -- --nocapture
```

Expected: HTTP `502` remains classified as `Replace`; `204` remains `Keep`.

- [ ] **Step 10: Commit Task 3**

```bash
git add runtimes/channel-telegram/Cargo.toml runtimes/channel-telegram/src/main.rs
git commit -m "fix(telegram): refresh status on sidecar rebind"
```

### Task 4: Verify the integrated fix and document exact evidence

**Files:**
- Modify: `docs/superpowers/specs/2026-07-22-channel-lifecycle-recovery-design.md`

- [ ] **Step 1: Format the focused crates and check the gateway without collateral edits**

```bash
cargo fmt -p local-first-task-runtime
cargo fmt --manifest-path runtimes/channel-telegram/Cargo.toml
cargo fmt -p local-first-desktop-gateway -- --check
```

Use `cargo fmt -p local-first-task-runtime` to apply formatting to the small runtime
crate and `cargo fmt --manifest-path runtimes/channel-telegram/Cargo.toml` for the
standalone bridge. For the large gateway, use only the non-mutating check so
pre-existing formatting debt cannot rewrite unrelated modules.

Inspect `git diff --stat` and `git diff --name-only`; accept no unrelated formatting.

- [ ] **Step 2: Run targeted regression gates**

```bash
cargo test -p local-first-task-runtime --lib
cargo test -p local-first-task-runtime --test scheduler
cargo test -p local-first-task-runtime --test store store_lists_only_workspace_scopes_with_non_terminal_tasks
cargo test -p local-first-desktop-gateway task_executor_ -- --nocapture
cargo test -p local-first-desktop-gateway channel_ -- --nocapture
cargo test -p local-first-desktop-gateway telegram_ -- --nocapture
cargo test --manifest-path runtimes/channel-telegram/Cargo.toml
git diff --check
```

Expected: every listed gate green. Continue to report the unrelated schema-version test as excluded rather than calling the complete `task-runtime` suite green.

- [ ] **Step 3: Rebase or merge only after the logical-chat worktree is stable**

Before integration, inspect:

```bash
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/logical-chat-lifecycle status --short --branch
git log --oneline --left-right main...fabio/logical-chat-lifecycle
```

If that worktree still has uncommitted `main.rs` edits, do not overwrite or absorb them. Keep this branch isolated and report that live installed-app verification is pending a stable shared base.

- [ ] **Step 4: Perform live verification only on a stable merged/rebuilt app**

With Atlas selected:

1. send an allowlisted WhatsApp message;
2. verify the task row changes `queued -> running -> completed` in its original `local-workspace`;
3. verify a matching `agent_run`, assistant chat message, and `channel/whatsapp: reply mirrored` log;
4. verify the reply arrives in WhatsApp;
5. relocate the Telegram status file without deleting it, reconnect Telegram, and verify the status endpoint returns `connected: true` and the UI agrees;
6. restore the relocated file only if the new sidecar did not create a replacement.

Do not publish, tag, push, reset user data, or disconnect a working channel as part of this verification.

- [ ] **Step 5: Record the verification outcome in the spec**

Change the spec status to `Implemented` only if code gates pass. Add a short `Verification` section listing exact command outcomes and separately label live checks as `verified`, `pending`, or `blocked by shared-base integration`.

- [ ] **Step 6: Commit verification documentation**

```bash
git add docs/superpowers/specs/2026-07-22-channel-lifecycle-recovery-design.md
git commit -m "docs: record channel lifecycle verification"
```

## Final Review Checklist

- [ ] WhatsApp channel turns remain in `local-workspace`.
- [ ] UI workspace selection no longer gates background task discovery.
- [ ] Lease and resource operations use the selected task's persisted scope.
- [ ] Telegram rebind returns success only after live bot identity and status persistence succeed.
- [ ] Status and logs contain no bot token or gateway token.
- [ ] No code or uncommitted changes were copied from `fabio/logical-chat-lifecycle`.
- [ ] The stale schema-version assertion remains explicitly excluded from suite-level green claims.
- [ ] No publish, push, tag, install, or destructive data operation occurred without explicit approval.
