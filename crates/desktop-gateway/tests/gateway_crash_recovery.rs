use local_first_task_runtime::{
    AgentRunStatus, NewAgentRun, NewBrowserCheckpoint, ObjectiveMode, RetryPolicy, TaskId,
    TaskStatus, TaskStore, TurnEventKind, UserId, WorkspaceId,
};
use reqwest::blocking::{Client, Response};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use time::OffsetDateTime;
use uuid::Uuid;

const TOKEN: &str = "gateway-crash-recovery-test-token";
const USER_ID: &str = "crash-user";
const WORKSPACE_ID: &str = "crash-workspace";
const REQUEST_ID: &str = "crash-recovery-request";
const RUN_ID: &str = "agent-run-before-crash";
const TARGET_ID: &str = "booking";

struct GatewayProcess {
    child: Child,
}

impl GatewayProcess {
    fn hard_kill(mut self) {
        self.child.kill().expect("hard-kill gateway");
        self.child.wait().expect("reap killed gateway");
    }
}

impl Drop for GatewayProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

struct IsolatedDir(PathBuf);

impl IsolatedDir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("homun-gateway-crash-recovery-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create isolated gateway dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for IsolatedDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn unused_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .expect("bind ephemeral port")
        .local_addr()
        .expect("read ephemeral port")
        .port()
}

fn start_gateway(data_dir: &Path, port: u16) -> GatewayProcess {
    let log =
        File::create(data_dir.join(format!("gateway-{port}.log"))).expect("create gateway log");
    let child = Command::new(env!("CARGO_BIN_EXE_local-first-desktop-gateway"))
        .env("HOMUN_DATA_DIR", data_dir)
        .env("HOMUN_DESKTOP_GATEWAY_TOKEN", TOKEN)
        .env("HOMUN_DESKTOP_GATEWAY_PORT", port.to_string())
        .env("HOMUN_USER_ID", USER_ID)
        .env("HOMUN_WORKSPACE_ID", WORKSPACE_ID)
        .env("HOMUN_TASK_EXECUTOR_WORKER", "off")
        .env("HOMUN_TASK_WORKER_COUNT", "1")
        .env(
            "HOMUN_VAULT_WRAP_KEY",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        )
        .env("RUST_LOG", "warn")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().expect("clone gateway log")))
        .stderr(Stdio::from(log))
        .spawn()
        .expect("start gateway binary");
    let mut process = GatewayProcess { child };
    wait_until_ready(&mut process, port, data_dir);
    process
}

fn client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build HTTP client")
}

fn authorized(request: reqwest::blocking::RequestBuilder) -> reqwest::blocking::RequestBuilder {
    request.bearer_auth(TOKEN)
}

fn wait_until_ready(process: &mut GatewayProcess, port: u16, data_dir: &Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(status) = process.child.try_wait().expect("poll gateway") {
            panic!(
                "gateway exited before readiness with {status}; log: {}",
                data_dir.join(format!("gateway-{port}.log")).display()
            );
        }
        if authorized(client().get(format!("http://127.0.0.1:{port}/api/chat/threads")))
            .send()
            .is_ok_and(|response| response.status().is_success())
        {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    panic!(
        "gateway did not become ready; log: {}",
        data_dir.join(format!("gateway-{port}.log")).display()
    );
}

fn checked_json(response: Response, expected: u16) -> Value {
    assert_eq!(response.status().as_u16(), expected);
    response.json().expect("decode JSON response")
}

fn create_thread(port: u16) -> String {
    let response = authorized(
        client()
            .post(format!("http://127.0.0.1:{port}/api/chat/threads"))
            .json(&json!({})),
    )
    .send()
    .expect("create thread");
    checked_json(response, 200)["thread_id"]
        .as_str()
        .expect("thread id")
        .to_string()
}

fn enqueue_turn(port: u16, thread_id: &str) -> String {
    let response = authorized(
        client()
            .post(format!("http://127.0.0.1:{port}/api/chat/turns"))
            .json(&json!({
                "thread_id": thread_id,
                "request_id": REQUEST_ID,
                "prompt": "Continue the existing booking without submitting it."
            })),
    )
    .send()
    .expect("enqueue turn");
    checked_json(response, 201)["turn_id"]
        .as_str()
        .expect("turn id")
        .to_string()
}

fn turn(port: u16, turn_id: &str) -> Value {
    let response =
        authorized(client().get(format!("http://127.0.0.1:{port}/api/chat/turns/{turn_id}")))
            .send()
            .expect("read turn");
    checked_json(response, 200)
}

fn messages(port: u16, thread_id: &str) -> Vec<Value> {
    let response = authorized(client().get(format!(
        "http://127.0.0.1:{port}/api/chat/threads/{thread_id}/messages"
    )))
    .send()
    .expect("read messages");
    checked_json(response, 200)["messages"]
        .as_array()
        .expect("messages array")
        .clone()
}

fn seed_active_attempt(database: &Path, thread_id: &str, turn_id: &str) -> u64 {
    let store = TaskStore::open(database).expect("open task store");
    let generation = store.get_process_generation().expect("read generation");
    assert_eq!(generation, 1, "first gateway owns generation one");

    let user = UserId::new(USER_ID);
    let workspace = WorkspaceId::new(WORKSPACE_ID);
    let task_id = TaskId::new(turn_id);
    let mut task = store
        .get_task(&task_id, &user, &workspace)
        .expect("load enqueued task")
        .expect("enqueued task exists");
    assert_eq!(task.status, TaskStatus::Queued);
    task.status = TaskStatus::Running;
    task.last_heartbeat_at = Some(OffsetDateTime::now_utc());
    task.lease_owner = Some(format!("{generation}:desktop-gateway-background-worker-0"));
    task.lease_expires_at = Some(OffsetDateTime::now_utc() + time::Duration::minutes(5));
    task.lease_fencing_token = Some(41);
    task.retry_policy = RetryPolicy {
        max_attempts: 1,
        backoff_seconds: 0,
    };
    task.checkpoint_json = Some(json!({
        "kind": "execution_started",
        "task_id": turn_id,
        "worker_id": "desktop-gateway-background-worker-0"
    }));
    store
        .insert_chat_turn(&task, thread_id, REQUEST_ID, "interactive", "full")
        .expect("persist active turn");
    store
        .reserve_resources(&task, task.lease_owner.as_deref().expect("lease owner"))
        .expect("reserve browser resource");

    store
        .create_agent_run(&NewAgentRun {
            run_id: RUN_ID.into(),
            turn_id: turn_id.into(),
            thread_id: thread_id.into(),
            user_id: USER_ID.into(),
            workspace_id: WORKSPACE_ID.into(),
            model: Some("provider-before-crash".into()),
            provider: Some("test-observation".into()),
            prompt_fingerprint: Some("sha256:before-crash".into()),
        })
        .expect("create active run");
    store
        .append_agent_checkpoint(
            RUN_ID,
            3,
            &json!({"round": 3, "safe": "checkpoint-before-crash"}),
            "sha256:agent-checkpoint",
            true,
        )
        .expect("persist agent checkpoint");
    let objective = store
        .upsert_objective_contract(
            USER_ID,
            WORKSPACE_ID,
            thread_id,
            &format!("local_user_{REQUEST_ID}"),
            "Continue the existing booking without submitting it.",
            ObjectiveMode::Mixed,
            &json!({"thread_id": thread_id}),
            &json!(["browser"]),
            &json!({"kind": "browser_done"}),
            "active",
        )
        .expect("persist objective");
    store
        .upsert_browser_checkpoint(&NewBrowserCheckpoint {
            checkpoint_id: "browser-checkpoint-before-crash".into(),
            user_id: USER_ID.into(),
            workspace_id: WORKSPACE_ID.into(),
            thread_id: thread_id.into(),
            target_id: TARGET_ID.into(),
            objective_revision: objective.revision,
            schema_version: 1,
            url: "https://rail.example/checkout".into(),
            origin: "https://rail.example".into(),
            browser_epoch: "contained-browser-epoch-1".into(),
            cdp_target_id: Some("CDP-target-before-crash".into()),
            generation: 76,
            draft_secret_ref: None,
            draft_control_count: 0,
            omitted_sensitive_count: 1,
            omitted_bounded_count: 0,
            expires_at: (OffsetDateTime::now_utc() + time::Duration::hours(1)).unix_timestamp(),
        })
        .expect("persist browser checkpoint");

    let assistant_id = task.input_json["assistant_message_id"]
        .as_str()
        .expect("assistant message id");
    let connection = Connection::open(database).expect("open chat database");
    let updated = connection
        .execute(
            "UPDATE chat_messages
                SET text = '', delivery_state = 'streaming'
              WHERE id = ?1 AND thread_id = ?2 AND role = 'assistant'",
            params![assistant_id, thread_id],
        )
        .expect("mark assistant placeholder streaming");
    assert_eq!(
        updated, 1,
        "broker owns one canonical assistant placeholder"
    );
    connection
        .execute(
            "UPDATE chat_threads SET active_leaf_id = ?1 WHERE thread_id = ?2",
            params![assistant_id, thread_id],
        )
        .expect("advance thread leaf");
    generation
}

fn assert_recovered(database: &Path, port: u16, thread_id: &str, turn_id: &str) {
    let store = TaskStore::open(database).expect("reopen task store");
    assert_eq!(store.get_process_generation().expect("new generation"), 2);
    let task = store
        .get_task(
            &TaskId::new(turn_id),
            &UserId::new(USER_ID),
            &WorkspaceId::new(WORKSPACE_ID),
        )
        .expect("read recovered task")
        .expect("recovered task exists");
    assert_eq!(task.status, TaskStatus::Queued);
    assert_eq!(
        task.blocked_reason.as_deref(),
        Some("recovered at boot (stale lease)")
    );
    assert!(task.lease_owner.is_none());
    assert!(task.last_heartbeat_at.is_none());
    assert!(task.lease_expires_at.is_none());
    assert!(task.lease_fencing_token.is_none());
    assert_eq!(turn(port, turn_id)["status"], "queued");

    let events = store
        .read_turn_events(turn_id, 0)
        .expect("read turn events");
    let aborted = events
        .iter()
        .filter(|event| event.kind == TurnEventKind::Aborted)
        .collect::<Vec<_>>();
    assert_eq!(aborted.len(), 1);
    assert_eq!(aborted[0].payload["reason"], "lease_expired_at_boot");
    assert!(events.iter().all(|event| !matches!(
        event.kind,
        TurnEventKind::Done | TurnEventKind::Error | TurnEventKind::Cancelled
    )));

    let runs = store
        .list_agent_runs_for_turn(turn_id, USER_ID, WORKSPACE_ID)
        .expect("read recovered runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, AgentRunStatus::Aborted);
    assert_eq!(runs[0].terminal_reason.as_deref(), Some("gateway_restart"));
    assert!(
        store
            .latest_agent_checkpoint(RUN_ID, USER_ID, WORKSPACE_ID)
            .expect("read agent checkpoint")
            .is_some()
    );

    let browser = store
        .load_active_browser_checkpoint(USER_ID, WORKSPACE_ID, thread_id, TARGET_ID)
        .expect("read browser checkpoint")
        .expect("browser checkpoint survives restart");
    assert_eq!(browser.checkpoint_id, "browser-checkpoint-before-crash");
    assert_eq!(browser.generation, 76);
    assert_eq!(
        browser.cdp_target_id.as_deref(),
        Some("CDP-target-before-crash")
    );

    let connection = Connection::open(database).expect("inspect recovered database");
    let reservations: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM resource_reservations WHERE task_id = ?1",
            params![turn_id],
            |row| row.get(0),
        )
        .expect("count reservations");
    assert_eq!(reservations, 0);
    let assistant_id = format!("local_assistant_{REQUEST_ID}");
    let assistant_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM chat_messages
             WHERE thread_id = ?1 AND id = ?2 AND role = 'assistant'",
            params![thread_id, assistant_id],
            |row| row.get(0),
        )
        .expect("count assistant placeholders");
    assert_eq!(assistant_count, 1);
    let delivery: Option<String> = connection
        .query_row(
            "SELECT delivery_state FROM chat_messages WHERE thread_id = ?1 AND id = ?2",
            params![thread_id, assistant_id],
            |row| row.get(0),
        )
        .optional()
        .expect("read assistant delivery");
    assert_eq!(delivery.as_deref(), Some("retrying"));
    let visible_assistants = messages(port, thread_id)
        .into_iter()
        .filter(|message| message["role"] == "assistant" && message["id"] == assistant_id)
        .count();
    assert_eq!(visible_assistants, 1);
}

#[test]
fn hard_restart_recovers_one_browser_capable_turn_without_duplicate_ownership() {
    let data_dir = IsolatedDir::new();
    let database = data_dir.path().join("homun.sqlite");

    let first_port = unused_port();
    let first = start_gateway(data_dir.path(), first_port);
    let thread_id = create_thread(first_port);
    let turn_id = enqueue_turn(first_port, &thread_id);
    assert_eq!(turn_id, format!("turn_{REQUEST_ID}"));
    seed_active_attempt(&database, &thread_id, &turn_id);
    assert_eq!(turn(first_port, &turn_id)["status"], "running");
    first.hard_kill();

    let second_port = unused_port();
    let second = start_gateway(data_dir.path(), second_port);
    assert_recovered(&database, second_port, &thread_id, &turn_id);
    second.hard_kill();

    let third_port = unused_port();
    let third = start_gateway(data_dir.path(), third_port);
    assert_eq!(turn(third_port, &turn_id)["status"], "queued");
    let store = TaskStore::open(&database).expect("inspect second restart");
    assert_eq!(store.get_process_generation().expect("third generation"), 3);
    let aborted_count = store
        .read_turn_events(&turn_id, 0)
        .expect("read idempotent recovery events")
        .into_iter()
        .filter(|event| event.kind == TurnEventKind::Aborted)
        .count();
    assert_eq!(aborted_count, 1, "queued turns are not recovered twice");
    third.hard_kill();
}
