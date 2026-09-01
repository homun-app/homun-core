// collapse_plan_markers moved to the engine (5.D2); the gateway no longer uses it in prod,
// only these unit tests do — import it here rather than re-exporting it at the crate root.
use local_first_engine::plan::{
    enforce_monotonic_plan_progress, plan_is_complete, plan_is_settled, plan_next_open,
};

use super::gateway_capability_execution::{
    authorize_managed_capability_tool, capability_call_completed_outcome,
    task_execution_outcome_from_executor_result,
};
use super::{
    AppState, ChannelSettings, CommandOutputError, ConnectorErrorKind, InboundAction,
    MAX_PLAN_STALL_RESUMES, MemoryBenchIngestRequest, MemoryBenchMessage, MemoryBenchSearchRequest,
    MemoryBenchSession, MemoryBenchStatusRequest, MemoryDataSensitivity, MemorySourceOverrideInput,
    MemorySourceUpsertRequest, ValidatedMemorySourceInput, WorkspaceRecord, WorkspacesFile,
    active_llm_concurrency, aggregate_session_state_from_counts, block_stalled_step,
    brain_budgets_for_context_window, browser_anti_loop_nudge, browser_capability_action_refusal,
    browser_error_indicates_dead_sidecar, browser_method_for_capability_tool,
    browser_snapshot_semantic_fingerprint, browser_snapshot_text, browser_targets_for_goal,
    browser_url_for_goal, build_browse_goal, build_memory_source_grant, build_plan_markdown,
    classify_connector_error, clawhub_origin, collect_member_counts, command_output_with_timeout,
    composio_tool_is_read, connector_error_hint, default_browser_headless_value,
    delegated_browse_tool_outcome, delete_workspace, earlier_browse_call_in_current_round,
    extract_source_urls, fonti_section, format_memory_block, gateway_memory_user_id,
    humanize_task_kind, inbound_action, is_internal_task_kind, is_low_value_source_url,
    is_semantic_duplicate, jail_in_root, llm_concurrency_view, mcp_error_hint, mcp_provider_slug,
    mcp_stdio_config_from_metadata, mcp_stdio_config_to_metadata, memory_bench_ingest,
    memory_bench_search, memory_bench_status, memory_facade, memory_source_candidates_from_records,
    memory_source_facade_error, memory_source_grant_views, memory_sources_flag,
    memorybench_workspace_id, merge_plan, next_plan_stall, next_ready_task_across_workspaces,
    normalize_for_dedup, parse_plan_marker, parse_review_suggestion, plan_done_count,
    plan_incomplete_reason, plan_stall_exhausted, plan_step_status,
    project_filesystem_mcp_instruction, prune_browser_history, redact_sensitive_text,
    repeated_browser_action_nudge, repeated_browser_failed_action_nudge,
    requeue_waiting_resource_tasks, response_language_instruction, rewrite_confirm_to_done,
    run_bash_unsandboxed_result, sanitize_dedup_key, scheduled_thread_sender_for_task_id,
    scheduled_thread_title, search_composio_catalog, should_try_tool_compatibility_fallback,
    strip_json_fences, suggestion_choices_json, task_effective_goal, task_goal_summary,
    task_queue_response, tool_touches_calendar, tool_touches_contacts, valid_catalog_owner,
    validate_memory_source_input, validate_memory_source_overrides,
    validate_memory_source_workspaces, workspace_write_roots,
};
use local_first_memory::{
    MemoryCandidate, hybrid_memory_score, memory_age_days, memory_auto_confirmable,
};

#[test]
fn gateway_main_tests_owner_smoke() {
    assert_eq!(2 + 2, 4);
}
use crate::browser_safety;
use crate::chat_store::{self, ChatStore};
use axum::Json;
use axum::extract::{Path, Query, State};
use local_first_engine::plan::collapse_plan_markers;
// 5.D1c.2: test-only engine helpers (not used by non-test gateway code, so imported here, not at
// the crate top where they'd read as unused).
use local_first_engine::browser::{PRUNED_SNAPSHOT_STUB, message_has_image_url};

#[cfg(unix)]
async fn wait_for_pid_file(path: &std::path::Path) -> Result<i32, tokio::time::error::Elapsed> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Ok(raw) = std::fs::read_to_string(path)
                && let Ok(pid) = raw.trim().parse::<i32>()
            {
                break pid;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
}

#[cfg(unix)]
#[tokio::test]
async fn aborting_project_command_kills_descendant_processes() {
    let mut sentinel = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("spawn external sentinel");
    let sentinel_pid = i32::try_from(sentinel.id()).expect("sentinel pid");
    let unique = format!(
        "homun-command-cancel-{}-{}",
        std::process::id(),
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    );
    let root = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&root).expect("create command test root");
    let child_pid_path = root.join("child.pid");
    let command = format!(
        "sh -c 'exec sleep 30' & child=$!; printf '%s' \"$child\" > '{}'; wait",
        child_pid_path.display()
    );
    let run_root = root.clone();
    let run = tokio::spawn(async move { run_bash_unsandboxed_result(&run_root, &command).await });

    let child_pid = match wait_for_pid_file(&child_pid_path).await {
        Ok(pid) => pid,
        Err(error) => {
            run.abort();
            let _ = run.await;
            let _ = sentinel.kill();
            let _ = sentinel.wait();
            let _ = std::fs::remove_dir_all(root);
            panic!("descendant pid is written: {error:?}");
        }
    };
    assert_eq!(unsafe { libc::kill(child_pid, 0) }, 0, "child must start");

    run.abort();
    let _ = run.await;

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if unsafe { libc::kill(child_pid, 0) } == -1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("aborting the command must terminate its descendants");
    assert_eq!(
        unsafe { libc::kill(sentinel_pid, 0) },
        0,
        "cancellation must not kill a process outside the command group"
    );
    let _ = sentinel.kill();
    let _ = sentinel.wait();
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn project_command_timeout_kills_descendant_processes() {
    let unique = format!(
        "homun-command-timeout-{}-{}",
        std::process::id(),
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    );
    let root = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&root).expect("create timeout test root");
    let child_pid_path = root.join("child.pid");
    let command = format!(
        "sh -c 'exec sleep 30' & child=$!; printf '%s' \"$child\" > '{}'; wait",
        child_pid_path.display()
    );
    let mut process = tokio::process::Command::new("bash");
    process.arg("-lc").arg(command).current_dir(&root);

    let run = tokio::spawn(async move {
        command_output_with_timeout(process, std::time::Duration::from_secs(1)).await
    });
    let child_pid = match wait_for_pid_file(&child_pid_path).await {
        Ok(pid) => pid,
        Err(error) => {
            run.abort();
            let _ = run.await;
            let _ = std::fs::remove_dir_all(root);
            panic!("descendant pid is written before timeout assertion: {error:?}");
        }
    };

    let result = run.await.expect("timeout command task joins");
    assert!(matches!(result, Err(CommandOutputError::TimedOut)));
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if unsafe { libc::kill(child_pid, 0) } == -1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("timeout must terminate command descendants");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn delivered_image_rejection_marks_outcome_delivered() {
    let outcome = super::gateway_agent_turn_outcomes::delivered_image_rejection_outcome(
        local_first_engine::TurnOutcome::default(),
        "The selected model cannot inspect this image.".to_string(),
    );
    assert_eq!(outcome.stop, local_first_engine::TurnStop::Completed);
    assert_eq!(
        outcome.memory_answer,
        "The selected model cannot inspect this image."
    );
}

#[tokio::test]
async fn deliver_image_rejection_emits_done_and_marks_outcome_delivered() {
    let transport = super::open_chat_stream_transport("image-rejection-test".to_string(), None);
    let entry = transport.sink.entry.clone();
    let mut receiver = transport.receiver;
    let outcome = super::gateway_agent_turn_outcomes::deliver_image_rejection(
        &transport.sink,
        local_first_engine::TurnOutcome::default(),
        "The selected model cannot inspect this image.".to_string(),
    )
    .await;
    let line = receiver
        .recv()
        .await
        .expect("done line is emitted")
        .expect("done line is valid bytes");
    let event: serde_json::Value = serde_json::from_slice(&line).expect("done line is valid json");

    assert_eq!(outcome.stop, local_first_engine::TurnStop::Completed);
    assert_eq!(
        outcome.memory_answer,
        "The selected model cannot inspect this image."
    );
    assert_eq!(
        event.get("text").and_then(|value| value.as_str()),
        Some("The selected model cannot inspect this image.")
    );
    assert!(entry.finished.load(std::sync::atomic::Ordering::Relaxed));
}

#[test]
fn clawhub_origin_is_publisher_specific_and_legacy_compatible() {
    assert_eq!(
        clawhub_origin("weather", Some("steipete")),
        "clawhub:@steipete/weather"
    );
    assert_eq!(clawhub_origin("weather", None), "clawhub:weather");
}

#[test]
fn catalog_owner_validation_rejects_path_or_query_injection() {
    assert!(valid_catalog_owner("legionspace-hackathon"));
    assert!(!valid_catalog_owner("../weather"));
    assert!(!valid_catalog_owner("owner&slug=other"));
}

#[test]
fn attachment_prompt_distinguishes_ready_content_from_extraction_issues() {
    let attachments = vec![
        chat_store::StoredAttachment {
            display_name: "analysis.odt".to_string(),
            mime_type: "application/vnd.oasis.opendocument.text".to_string(),
            text: Some("Actual document content".to_string()),
            images: Vec::new(),
        },
        chat_store::StoredAttachment {
            display_name: "scan.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            text: Some("(scanned PDF: pages provided as images for visual analysis)".to_string()),
            images: vec!["data:image/jpeg;base64,AA==".to_string()],
        },
        chat_store::StoredAttachment {
            display_name: "archive.bin".to_string(),
            mime_type: "application/octet-stream".to_string(),
            text: Some("⚠️ type not yet supported".to_string()),
            images: Vec::new(),
        },
    ];
    let mut prompt = "Summarize the attachment".to_string();

    let images = super::append_thread_attachment_context(&mut prompt, &attachments);

    assert!(prompt.contains("- analysis.odt (text)"));
    assert!(prompt.contains("- scan.pdf (images/scan)"));
    assert!(prompt.contains("- archive.bin (unavailable)"));
    let content = prompt
        .split("[Attachment extraction issues]")
        .next()
        .unwrap();
    assert!(content.contains("Actual document content"));
    assert!(!content.contains("⚠️ type not yet supported"));
    assert!(prompt.contains("[Attachment extraction issues]\n[archive.bin]"));
    assert!(prompt.contains("⚠️ type not yet supported"));
    assert_eq!(images, vec!["data:image/jpeg;base64,AA=="]);
}
// engine plan fn tested here directly (no longer re-used in gateway non-test code post-5.D2).
use local_first_browser_automation::BrowserAutomationError;
use local_first_browser_automation::BrowserMethod;
use local_first_capabilities::{CapabilityCallResult, ProviderId as CapProviderId};
use local_first_engine::plan::advance_plan_frontier;
use local_first_local_computer_session::SessionStatus;
use local_first_memory::WorkspaceId as MemoryWorkspaceId;
use local_first_task_runtime::{
    ApprovalPolicy, ApprovalRequest, Automation, AutomationSource, AutomationTrigger,
    ExecutorResult, ResourceClass, ResourceGovernor, ResourceLimits, ResourceRequirement, TaskId,
    TaskPriority, TaskQueueSnapshot, TaskRecord, TaskStatus, TaskStore, TaskUiItem, UserId,
    WorkspaceId,
};
use local_first_vault::VaultStore;
use std::collections::{BTreeSet, HashMap};
use std::sync::MutexGuard;

// Serializes tests that mutate PROCESS-GLOBAL state (`MEMORY_WORKSPACE`, `HOMUN_USER_ID`).
// Without this they race under the parallel test runner and flake. Poison-tolerant:
// if a holder panics we still hand out the guard (the global is restored per-test anyway).
static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// THE guard for tests that touch process-global env vars. Environment variables are shared by
// the whole test binary while cargo runs tests on parallel threads, so without one shared lock
// tests read each other's values.
//
// Two defects made the suite an unreliable gate before this existed as a single type. There
// were three near-identical guards holding TWO different locks, so a test serialized against
// some env users and raced the rest — `resolved_sandbox_mode_precedence…` even carried the
// comment "env-mutation under TEST_ENV_LOCK" while actually holding the data-dir lock. And
// tests restored their variables by hand AFTER their assertions, so the first real failure
// skipped its own cleanup and poisoned everything scheduled after it (observed: one genuine
// failure reported as eight). Restoring in `Drop` runs during unwind too, so a failing test
// now fails alone.
//
// Take it ONCE per test (the lock is not reentrant) and add variables with `TestEnv::set`.
thread_local! {
    /// How many `TestEnv` guards this thread holds. Tests legitimately COMPOSE guards (a data
    /// dir plus a feature flag), and `std::sync::Mutex` is not reentrant — taking it twice on
    /// one thread deadlocks. Only the outermost guard locks; inner ones ride it and still
    /// restore their own variables on drop (guards drop LIFO, so the original value wins).
    static ENV_LOCK_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

struct TestEnv {
    saved: std::cell::RefCell<Vec<(String, Option<String>)>>,
    // `None` on a nested guard — the outer one on this thread owns the lock and releases it last.
    _lock: Option<MutexGuard<'static, ()>>,
}

impl TestEnv {
    fn acquire() -> Self {
        let lock = ENV_LOCK_DEPTH.with(|depth| {
            let outermost = depth.get() == 0;
            depth.set(depth.get() + 1);
            // Poison-tolerant on purpose: a panicking test must not turn every later test into
            // a lock-poisoning failure. The guard has already restored what it changed.
            outermost.then(|| TEST_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner()))
        });
        Self {
            saved: std::cell::RefCell::new(Vec::new()),
            _lock: lock,
        }
    }

    /// `None` removes the variable. Records the value it displaced, so `Drop` puts it back.
    fn set(&self, key: &str, value: Option<&str>) -> &Self {
        self.saved
            .borrow_mut()
            .push((key.to_string(), std::env::var(key).ok()));
        // SAFETY: every env mutation in these tests happens under the lock this guard holds.
        unsafe {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        self
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        ENV_LOCK_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
        // Reverse order: a key set more than once is restored to the value it had on entry.
        for (key, previous) in self.saved.borrow().iter().rev() {
            // SAFETY: see `set` — still under this guard's lock.
            unsafe {
                match previous {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }
}

/// `HOMUN_DATA_DIR` pointed at a throwaway directory, on the shared env lock. Kept as a named
/// wrapper because most call sites want exactly this; reach for the inner [`TestEnv`] via
/// [`TestGatewayDataDir::env`] to set more variables without taking the lock twice.
struct TestGatewayDataDir {
    env: TestEnv,
}

impl TestGatewayDataDir {
    fn new(path: &std::path::Path) -> Self {
        let env = TestEnv::acquire();
        env.set("HOMUN_DATA_DIR", path.to_str());
        Self { env }
    }

    fn env(&self) -> &TestEnv {
        &self.env
    }
}

fn isolated_gateway_test_dir(prefix: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("homun-{prefix}-{}", uuid::Uuid::new_v4().simple()))
}

/// `HOMUN_MEMORYBENCH_ENABLED=1`, on the shared env lock. Thin wrapper over [`TestEnv`].
struct TestMemoryBenchFlag {
    _env: TestEnv,
}

impl TestMemoryBenchFlag {
    fn enabled() -> Self {
        let env = TestEnv::acquire();
        env.set("HOMUN_MEMORYBENCH_ENABLED", Some("1"));
        Self { _env: env }
    }
}

#[tokio::test]
async fn memorybench_routes_ingest_search_status_and_governed_clear() {
    let dir = isolated_gateway_test_dir("memorybench-routes");
    std::fs::create_dir_all(&dir).unwrap();
    let _flag = TestMemoryBenchFlag::enabled();
    let _data = TestGatewayDataDir::new(&dir);
    let state = AppState::for_tests();
    let container_tag = "route-contract".to_string();
    let workspace_id = memorybench_workspace_id(&container_tag);
    let ingest_request = || MemoryBenchIngestRequest {
        container_tag: container_tag.clone(),
        sessions: vec![MemoryBenchSession {
            session_id: "session-1".to_string(),
            messages: vec![MemoryBenchMessage {
                role: "user".to_string(),
                content: "The benchmark launch moved to Monday".to_string(),
                timestamp: None,
                speaker: None,
            }],
            metadata: serde_json::json!({}),
        }],
        metadata: serde_json::json!({}),
    };
    let ingest = memory_bench_ingest(State(state.clone()), Json(ingest_request()))
        .await
        .unwrap()
        .0;
    assert_eq!(ingest.workspace_id, workspace_id);
    assert_eq!(ingest.document_ids.len(), 1);
    let repeated = memory_bench_ingest(State(state.clone()), Json(ingest_request()))
        .await
        .unwrap()
        .0;
    assert_eq!(repeated.document_ids, ingest.document_ids);
    assert_eq!(
        memory_facade(&state)
            .list_memories_for_ui(
                &gateway_memory_user_id(),
                &MemoryWorkspaceId::new(workspace_id.clone()),
            )
            .unwrap()
            .len(),
        1
    );
    let secret = memory_bench_ingest(
        State(state.clone()),
        Json(MemoryBenchIngestRequest {
            container_tag: container_tag.clone(),
            sessions: vec![MemoryBenchSession {
                session_id: "secret-session".to_string(),
                messages: vec![MemoryBenchMessage {
                    role: "user".to_string(),
                    content: "OPENAI_API_KEY=sk-test-memorybench-must-not-leak".to_string(),
                    timestamp: None,
                    speaker: None,
                }],
                metadata: serde_json::json!({}),
            }],
            metadata: serde_json::json!({}),
        }),
    )
    .await;
    assert!(secret.is_err());

    let status = memory_bench_status(
        State(state.clone()),
        Json(MemoryBenchStatusRequest {
            container_tag: container_tag.clone(),
            document_ids: ingest.document_ids.clone(),
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(status.completed_ids, ingest.document_ids);
    assert!(status.failed_ids.is_empty());
    assert!(!status.pending);

    let search = memory_bench_search(
        State(state.clone()),
        Json(MemoryBenchSearchRequest {
            container_tag,
            workspace_id: workspace_id.clone(),
            query: "benchmark launch Monday".to_string(),
            limit: 10,
            threshold: 0.0,
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(search["results"].as_array().unwrap().len(), 1);
    assert_eq!(search["results"][0]["source_workspace_id"], workspace_id);

    let _ = delete_workspace(State(state.clone()), Path(workspace_id.clone()))
        .await
        .unwrap();
    assert!(
        memory_facade(&state)
            .list_memories_for_ui(
                &gateway_memory_user_id(),
                &MemoryWorkspaceId::new(workspace_id),
            )
            .unwrap()
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn memory_source_input_rejects_self_source_and_unknown_collection() {
    let request = MemorySourceUpsertRequest {
        source_workspace_id: "project-a".to_string(),
        collections: vec!["knowledge".to_string()],
        max_sensitivity: "private".to_string(),
        expires_at: None,
        overrides: Vec::new(),
    };
    assert_eq!(
        validate_memory_source_input("project-a", &request).unwrap_err(),
        "source_equals_consumer"
    );

    let request = MemorySourceUpsertRequest {
        source_workspace_id: "project-b".to_string(),
        collections: vec!["everything".to_string()],
        max_sensitivity: "private".to_string(),
        expires_at: None,
        overrides: vec![MemorySourceOverrideInput {
            memory_ref: "memory:local:owner:project-b:known".to_string(),
            effect: "deny".to_string(),
        }],
    };
    assert_eq!(
        validate_memory_source_input("project-a", &request).unwrap_err(),
        "collection_not_allowed"
    );
}

#[test]
fn memory_source_flag_defaults_on_and_only_off_variants_disable() {
    for enabled in [
        None,
        Some(""),
        Some("   "),
        Some("1"),
        Some("on"),
        Some("true"),
        Some("unknown"),
    ] {
        assert!(
            memory_sources_flag(enabled),
            "expected enabled: {enabled:?}"
        );
    }
    for disabled in [
        Some("0"),
        Some(" 0 "),
        Some("off"),
        Some("OFF"),
        Some("Off"),
    ] {
        assert!(
            !memory_sources_flag(disabled),
            "expected disabled: {disabled:?}"
        );
    }
}

#[test]
fn no_grants_are_created_for_existing_projects() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().expect("in-memory memory store"),
    );
    let grants = facade
        .list_memory_source_grants(
            &local_first_memory::UserId::new("owner"),
            &local_first_memory::WorkspaceId::new("legacy-project"),
        )
        .expect("legacy project should be readable without a grant migration");
    assert!(grants.is_empty());
}

#[test]
fn memory_source_input_rejects_empty_duplicate_and_unsafe_policy_values() {
    let valid = || MemorySourceUpsertRequest {
        source_workspace_id: "project-b".to_string(),
        collections: vec!["knowledge".to_string()],
        max_sensitivity: "private".to_string(),
        expires_at: None,
        overrides: Vec::new(),
    };

    let mut request = valid();
    request.collections.clear();
    assert_eq!(
        validate_memory_source_input("project-a", &request).unwrap_err(),
        "empty_source_policy"
    );

    let mut request = valid();
    request.collections.push("knowledge".to_string());
    assert_eq!(
        validate_memory_source_input("project-a", &request).unwrap_err(),
        "duplicate_collection"
    );

    let mut request = valid();
    request.max_sensitivity = "secret".to_string();
    assert_eq!(
        validate_memory_source_input("project-a", &request).unwrap_err(),
        "sensitivity_not_allowed"
    );

    let mut request = valid();
    request.overrides = vec![MemorySourceOverrideInput {
        memory_ref: "memory:local:owner:project-b:item".to_string(),
        effect: "maybe".to_string(),
    }];
    assert_eq!(
        validate_memory_source_input("project-a", &request).unwrap_err(),
        "override_effect_not_allowed"
    );

    let mut request = valid();
    request.overrides = vec![
        MemorySourceOverrideInput {
            memory_ref: "memory:local:owner:project-b:item".to_string(),
            effect: "deny".to_string(),
        },
        MemorySourceOverrideInput {
            memory_ref: "memory:local:owner:project-b:item".to_string(),
            effect: "allow".to_string(),
        },
    ];
    assert_eq!(
        validate_memory_source_input("project-a", &request).unwrap_err(),
        "duplicate_override_ref"
    );
}

#[test]
fn memory_source_input_requires_exact_collection_sensitivity_and_effect_tokens() {
    let request_for =
        |collection: &str, sensitivity: &str, effect: &str| MemorySourceUpsertRequest {
            source_workspace_id: "project-b".to_string(),
            collections: vec![collection.to_string()],
            max_sensitivity: sensitivity.to_string(),
            expires_at: None,
            overrides: vec![MemorySourceOverrideInput {
                memory_ref: "memory:local:owner:project-b:item".to_string(),
                effect: effect.to_string(),
            }],
        };

    for collection in [" knowledge", "knowledge ", "Knowledge"] {
        assert_eq!(
            validate_memory_source_input("project-a", &request_for(collection, "private", "allow"))
                .unwrap_err(),
            "collection_not_allowed"
        );
    }
    for sensitivity in [" private", "private ", "Private"] {
        assert_eq!(
            validate_memory_source_input(
                "project-a",
                &request_for("knowledge", sensitivity, "allow")
            )
            .unwrap_err(),
            "sensitivity_not_allowed"
        );
    }
    for effect in [" allow", "allow ", "Allow"] {
        assert_eq!(
            validate_memory_source_input("project-a", &request_for("knowledge", "private", effect))
                .unwrap_err(),
            "override_effect_not_allowed"
        );
    }
}

#[test]
fn memory_source_input_rejects_malformed_noncanonical_and_wrong_source_refs() {
    let request_for = |memory_ref: &str| MemorySourceUpsertRequest {
        source_workspace_id: "project-b".to_string(),
        collections: Vec::new(),
        max_sensitivity: "private".to_string(),
        expires_at: None,
        overrides: vec![MemorySourceOverrideInput {
            memory_ref: memory_ref.to_string(),
            effect: "deny".to_string(),
        }],
    };
    assert_eq!(
        validate_memory_source_input("project-a", &request_for("not-a-ref")).unwrap_err(),
        "invalid_memory_ref"
    );
    assert_eq!(
        validate_memory_source_input("project-a", &request_for("memory:local:owner:project-b:"))
            .unwrap_err(),
        "noncanonical_memory_ref"
    );
    assert_eq!(
        validate_memory_source_input(
            "project-a",
            &request_for("entity:local:owner:project-b:item")
        )
        .unwrap_err(),
        "invalid_override_kind"
    );
    assert_eq!(
        validate_memory_source_input(
            "project-a",
            &request_for("memory:local:owner:project-c:item")
        )
        .unwrap_err(),
        "override_outside_source"
    );
    assert_eq!(
        validate_memory_source_input(
            "project-a",
            &request_for("memory:local:owner:project-b:item ")
        )
        .unwrap_err(),
        "noncanonical_memory_ref"
    );
}

fn memory_source_test_workspace(id: &str, name: &str) -> WorkspaceRecord {
    WorkspaceRecord {
        id: id.to_string(),
        name: name.to_string(),
        folder: None,
        sandbox_mode: None,
        approval_policy: None,
        writable_roots: None,
        skill_confirmations: None,
    }
}

#[test]
fn memory_source_workspace_validation_uses_snapshot_and_allows_personal_source() {
    let file = WorkspacesFile {
        active: "project-a".to_string(),
        workspaces: vec![
            memory_source_test_workspace("project-a", "Alpha"),
            memory_source_test_workspace("project-b", "Beta"),
        ],
    };
    let project = validate_memory_source_workspaces(&file, "project-a", "project-b").unwrap();
    assert_eq!(project.consumer.name, "Alpha");
    assert!(project.source_available);

    let personal = validate_memory_source_workspaces(&file, "project-a", "__personal__").unwrap();
    assert!(personal.source_available);

    assert_eq!(
        validate_memory_source_workspaces(&file, "project-a", "deleted-project").unwrap_err(),
        "source_workspace_not_found"
    );
    assert_eq!(
        validate_memory_source_workspaces(&file, "__personal__", "project-b").unwrap_err(),
        "reserved_consumer_scope"
    );
}

#[test]
fn memory_source_workspace_validation_canonicalizes_the_base_workspace_as_personal() {
    let base = super::base_workspace_id();
    let file = WorkspacesFile {
        active: "project-a".to_string(),
        workspaces: vec![
            memory_source_test_workspace(&base, "Predefinito"),
            memory_source_test_workspace("project-a", "Alpha"),
        ],
    };

    assert_eq!(
        validate_memory_source_workspaces(&file, &base, "project-a").unwrap_err(),
        "reserved_consumer_scope"
    );
    let context = validate_memory_source_workspaces(&file, "project-a", &base).unwrap();
    assert_eq!(
        context.source_workspace_id.as_str(),
        local_first_memory::PERSONAL_WORKSPACE
    );

    let personal_ref = format!(
        "memory:local:owner:{}:item",
        local_first_memory::PERSONAL_WORKSPACE
    );
    let validated = validate_memory_source_input(
        "project-a",
        &MemorySourceUpsertRequest {
            source_workspace_id: base,
            collections: Vec::new(),
            max_sensitivity: "private".to_string(),
            expires_at: None,
            overrides: vec![MemorySourceOverrideInput {
                memory_ref: personal_ref,
                effect: "allow".to_string(),
            }],
        },
    )
    .unwrap();
    assert_eq!(
        validated.source_workspace_id.as_str(),
        local_first_memory::PERSONAL_WORKSPACE
    );
}

#[test]
fn memory_source_facade_conflicts_map_to_http_409() {
    let conflict = memory_source_facade_error(local_first_memory::MemoryError::Policy(
        "duplicate_active_source".to_string(),
    ));
    assert_eq!(conflict.status, axum::http::StatusCode::CONFLICT);
    assert_eq!(conflict.code, "memory_source_conflict");

    let malformed = memory_source_facade_error(local_first_memory::MemoryError::Validation(
        "invalid caller input".to_string(),
    ));
    assert_eq!(malformed.status, axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(malformed.code, "memory_source_invalid");
}

fn memory_source_test_record(
    key: &str,
    memory_type: &str,
    text: &str,
    sensitivity: local_first_memory::DataSensitivity,
    metadata: serde_json::Value,
) -> local_first_memory::MemorySourceCandidateProjection {
    let user = local_first_memory::UserId::new("owner");
    let workspace_id = local_first_memory::WorkspaceId::new("project-b");
    local_first_memory::MemorySourceCandidateProjection {
        reference: local_first_memory::MemoryRef::new(
            local_first_memory::MemoryRefKind::Memory,
            user,
            workspace_id,
            key,
        ),
        memory_type: memory_type.to_string(),
        text: text.to_string(),
        sensitivity,
        metadata,
    }
}

#[test]
fn memory_source_candidates_are_redacted_mapped_and_never_secret() {
    use local_first_memory::DataSensitivity;
    let records = vec![
        memory_source_test_record(
            "note",
            "note",
            "  useful   context  ",
            DataSensitivity::Internal,
            serde_json::json!({}),
        ),
        memory_source_test_record(
            "secret",
            "note",
            "hidden",
            DataSensitivity::Secret,
            serde_json::json!({}),
        ),
        memory_source_test_record(
            "vault",
            "note",
            "visible",
            DataSensitivity::Internal,
            serde_json::json!({"password": "hidden"}),
        ),
        memory_source_test_record(
            "unknown",
            "custom",
            "unmapped",
            DataSensitivity::Internal,
            serde_json::json!({}),
        ),
    ];
    let candidates = memory_source_candidates_from_records(&records);
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].summary, "useful context");
    assert_eq!(
        candidates[0].collection,
        local_first_memory::MemoryCollectionKey::Knowledge
    );
    let json = serde_json::to_string(&candidates).unwrap();
    assert!(!json.contains("hidden"));
    assert!(!json.contains("metadata"));
}

#[test]
fn memory_source_grant_views_keep_local_first_and_deleted_sources_revocable() {
    use local_first_memory::{
        DataSensitivity, MemoryCollectionKey, MemoryGrantOverrideEffect, MemoryRef, MemoryRefKind,
        MemorySourceGrant, UserId, WorkspaceId,
    };
    let consumer = memory_source_test_workspace("project-a", "Alpha");
    let workspaces = vec![consumer.clone()];
    let grant = MemorySourceGrant {
        id: "grant-deleted".to_string(),
        consumer_user_id: UserId::new("owner"),
        consumer_workspace_id: WorkspaceId::new("project-a"),
        source_user_id: UserId::new("owner"),
        source_workspace_id: WorkspaceId::new("deleted-project"),
        collections: [MemoryCollectionKey::Knowledge].into_iter().collect(),
        max_sensitivity: DataSensitivity::Private,
        overrides: HashMap::from([(
            MemoryRef::new(
                MemoryRefKind::Memory,
                UserId::new("owner"),
                WorkspaceId::new("deleted-project"),
                "explicit-deny",
            ),
            MemoryGrantOverrideEffect::Deny,
        )]),
        expires_at: None,
        revoked_at: None,
        policy_version: 1,
        created_by: "owner".to_string(),
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
    };
    let views = memory_source_grant_views(&consumer, &workspaces, vec![grant], |_| None);
    assert_eq!(views[0].source_workspace_id, "project-a");
    assert!(views[0].local);
    assert_eq!(views[1].id.as_deref(), Some("grant-deleted"));
    assert!(!views[1].source_available);
    assert!(views[1].read_only);
    let json = serde_json::to_string(&views).unwrap();
    assert!(json.contains(
            "\"overrides\":[{\"memory_ref\":\"memory:local:owner:deleted-project:explicit-deny\",\"effect\":\"deny\"}]"
        ));
    assert!(!json.contains("memory_text"));
    assert!(!json.contains("metadata"));
}

#[test]
fn memory_source_grant_views_fall_back_to_workspace_ids_for_blank_labels() {
    use local_first_memory::{
        DataSensitivity, MemoryCollectionKey, MemorySourceGrant, UserId, WorkspaceId,
    };
    let mut consumer = memory_source_test_workspace("project-a", "   ");
    let mut source = memory_source_test_workspace("project-b", "");
    let grant = MemorySourceGrant {
        id: "grant-project-b".to_string(),
        consumer_user_id: UserId::new("owner"),
        consumer_workspace_id: WorkspaceId::new("project-a"),
        source_user_id: UserId::new("owner"),
        source_workspace_id: WorkspaceId::new("project-b"),
        collections: [MemoryCollectionKey::Knowledge].into_iter().collect(),
        max_sensitivity: DataSensitivity::Private,
        overrides: HashMap::new(),
        expires_at: None,
        revoked_at: None,
        policy_version: 1,
        created_by: "owner".to_string(),
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
    };
    let views = memory_source_grant_views(
        &consumer,
        &[consumer.clone(), source.clone()],
        vec![grant.clone()],
        |_| None,
    );
    assert_eq!(views[0].source_label, "project-a");
    assert_eq!(views[1].source_label, "project-b");

    consumer.name = "  Alpha  ".to_string();
    source.name = "  Beta  ".to_string();
    let views =
        memory_source_grant_views(&consumer, &[consumer.clone(), source], vec![grant], |_| {
            None
        });
    assert_eq!(views[0].source_label, "Alpha");
    assert_eq!(views[1].source_label, "Beta");
}

#[test]
fn memory_source_grant_builder_starts_at_one_and_preserves_identity_on_update() {
    use local_first_memory::{MemoryCollectionKey, UserId, WorkspaceId};
    let owner = UserId::new("owner");
    let consumer = WorkspaceId::new("project-a");
    let input = ValidatedMemorySourceInput {
        source_workspace_id: WorkspaceId::new("project-b"),
        collections: [MemoryCollectionKey::Knowledge].into_iter().collect(),
        max_sensitivity: local_first_memory::DataSensitivity::Private,
        expires_at: None,
        overrides: Vec::new(),
    };
    let new_grant =
        build_memory_source_grant(&owner, &consumer, input.clone(), HashMap::new(), None, 100)
            .unwrap();
    assert_eq!(new_grant.policy_version, 1);
    assert_eq!(new_grant.created_at, "unix:100.000000000");
    assert_eq!(
        uuid::Uuid::parse_str(&new_grant.id).unwrap().to_string(),
        new_grant.id
    );

    let original_id = new_grant.id.clone();
    let original_creator = new_grant.created_by.clone();
    let original_created_at = new_grant.created_at.clone();
    let updated = build_memory_source_grant(
        &owner,
        &consumer,
        input,
        HashMap::new(),
        Some(new_grant),
        200,
    )
    .unwrap();
    assert_eq!(updated.id, original_id);
    assert_eq!(updated.created_by, original_creator);
    assert_eq!(updated.created_at, original_created_at);
    assert_eq!(updated.updated_at, "unix:200.000000000");
    assert_eq!(updated.policy_version, 2);
}

#[test]
fn memory_source_scoped_revoke_cannot_target_another_consumer() {
    use local_first_memory::{
        DataSensitivity, MemoryCollectionKey, MemoryFacade, MemorySourceGrant, SQLiteMemoryStore,
        UserId, WorkspaceId,
    };
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let owner = UserId::new("owner");
    let grant = MemorySourceGrant {
        id: "scoped-grant".to_string(),
        consumer_user_id: owner.clone(),
        consumer_workspace_id: WorkspaceId::new("project-a"),
        source_user_id: owner.clone(),
        source_workspace_id: WorkspaceId::new("project-b"),
        collections: [MemoryCollectionKey::Knowledge].into_iter().collect(),
        max_sensitivity: DataSensitivity::Private,
        overrides: HashMap::new(),
        expires_at: None,
        revoked_at: None,
        policy_version: 1,
        created_by: "owner".to_string(),
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
    };
    facade.upsert_memory_source_grant(&grant).unwrap();
    let error = facade
        .revoke_memory_source_grant(&owner, &WorkspaceId::new("project-c"), &grant.id, 2)
        .unwrap_err();
    assert!(matches!(
        error,
        local_first_memory::MemoryError::NotFound(_)
    ));
    assert!(
        facade
            .get_memory_source_grant(&owner, &WorkspaceId::new("project-a"), &grant.id)
            .unwrap()
            .unwrap()
            .revoked_at
            .is_none()
    );
}

fn create_memory_source_override_record(
    facade: &local_first_memory::MemoryFacade,
    sensitivity: local_first_memory::DataSensitivity,
    metadata: serde_json::Value,
) -> local_first_memory::MemoryRecord {
    let owner = local_first_memory::UserId::new("owner");
    let source = local_first_memory::WorkspaceId::new("project-b");
    facade
        .create_memory_candidate(local_first_memory::MemoryCreateRequest {
            request: local_first_memory::MemoryLifecycleRequest {
                actor_id: "test".to_string(),
                user_id: owner,
                workspace_id: source,
                purpose: "memory source override test".to_string(),
            },
            memory_type: "note".to_string(),
            text: "shareable context".to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            privacy_domain: local_first_memory::PrivacyDomain::new("personal"),
            sensitivity,
            evidence_refs: Vec::new(),
            metadata,
        })
        .unwrap()
}

#[test]
fn memory_source_override_validation_rejects_missing_wrong_owner_secret_and_vault() {
    use local_first_memory::{
        DataSensitivity, MemoryFacade, MemoryGrantOverrideEffect, MemoryRef, MemoryRefKind,
        SQLiteMemoryStore, UserId, WorkspaceId,
    };
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let owner = UserId::new("owner");
    let source = WorkspaceId::new("project-b");
    let validated_for = |reference: MemoryRef, effect| ValidatedMemorySourceInput {
        source_workspace_id: source.clone(),
        collections: BTreeSet::new(),
        max_sensitivity: DataSensitivity::Private,
        expires_at: None,
        overrides: vec![(reference, effect)],
    };

    let missing = validated_for(
        MemoryRef::new(
            MemoryRefKind::Memory,
            owner.clone(),
            source.clone(),
            "missing",
        ),
        MemoryGrantOverrideEffect::Deny,
    );
    assert_eq!(
        validate_memory_source_overrides(&facade, &owner, &missing)
            .unwrap_err()
            .code,
        "override_memory_not_found"
    );

    let wrong_owner = validated_for(
        MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("other"),
            source.clone(),
            "missing",
        ),
        MemoryGrantOverrideEffect::Deny,
    );
    assert_eq!(
        validate_memory_source_overrides(&facade, &owner, &wrong_owner)
            .unwrap_err()
            .code,
        "override_outside_source"
    );

    let secret = create_memory_source_override_record(
        &facade,
        DataSensitivity::Secret,
        serde_json::json!({}),
    );
    let secret_input = validated_for(secret.reference, MemoryGrantOverrideEffect::Deny);
    assert_eq!(
        validate_memory_source_overrides(&facade, &owner, &secret_input)
            .unwrap_err()
            .code,
        "override_memory_not_shareable"
    );

    let vault = create_memory_source_override_record(
        &facade,
        DataSensitivity::Internal,
        serde_json::json!({"password": "hidden"}),
    );
    let vault_input = validated_for(vault.reference, MemoryGrantOverrideEffect::Deny);
    assert_eq!(
        validate_memory_source_overrides(&facade, &owner, &vault_input)
            .unwrap_err()
            .code,
        "override_memory_not_shareable"
    );

    let confidential = create_memory_source_override_record(
        &facade,
        DataSensitivity::Confidential,
        serde_json::json!({}),
    );
    let allow_input = validated_for(
        confidential.reference.clone(),
        MemoryGrantOverrideEffect::Allow,
    );
    assert_eq!(
        validate_memory_source_overrides(&facade, &owner, &allow_input)
            .unwrap_err()
            .code,
        "override_above_max_sensitivity"
    );
    let deny_input = validated_for(confidential.reference, MemoryGrantOverrideEffect::Deny);
    assert_eq!(
        validate_memory_source_overrides(&facade, &owner, &deny_input)
            .unwrap()
            .len(),
        1
    );
}

/// `HOMUN_MEMORY_SOURCES`, on the shared env lock. Thin wrapper over [`TestEnv`].
struct TestMemorySourcesFlag {
    _env: TestEnv,
}

impl TestMemorySourcesFlag {
    fn set(value: Option<&str>) -> Self {
        let env = TestEnv::acquire();
        env.set("HOMUN_MEMORY_SOURCES", value);
        Self { _env: env }
    }
}

struct TestMemoryWorkspace {
    _env: TestEnv,
}

impl TestMemoryWorkspace {
    fn set(id: &str) -> Self {
        let env = TestEnv::acquire();
        super::set_memory_workspace(id);
        Self { _env: env }
    }

    fn switch(&self, id: &str) {
        super::set_memory_workspace(id);
    }
}

impl Drop for TestMemoryWorkspace {
    fn drop(&mut self) {
        super::set_memory_workspace(super::PERSONAL_WORKSPACE);
    }
}

async fn memory_source_response_code(response: axum::response::Response) -> Option<String> {
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&body)
        .ok()?
        .pointer("/error/code")?
        .as_str()
        .map(str::to_string)
}

fn memory_source_route_test_app(state: super::AppState) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/workspaces/{workspace_id}/memory-sources",
            axum::routing::get(super::memory_sources_list),
        )
        .route(
            "/api/workspaces/{workspace_id}/memory-sources/upsert",
            axum::routing::post(super::memory_source_upsert),
        )
        .route(
            "/api/workspaces/{workspace_id}/memory-sources/candidates",
            axum::routing::get(super::memory_source_candidates),
        )
        .route(
            "/api/workspaces/{workspace_id}/memory-sources/{grant_id}/revoke",
            axum::routing::post(super::memory_source_revoke),
        )
        .with_state(state)
}

fn memory_publication_route_test_app(state: super::AppState) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/memory/publications",
            axum::routing::post(super::memory_publication_create),
        )
        .route(
            "/api/memory/publications/{proposal_id}",
            axum::routing::get(super::memory_publication_get),
        )
        .route(
            "/api/memory/publications/{proposal_id}/edit",
            axum::routing::post(super::memory_publication_edit),
        )
        .route(
            "/api/memory/publications/{proposal_id}/approve",
            axum::routing::post(super::memory_publication_approve),
        )
        .route(
            "/api/memory/publications/{proposal_id}/reject",
            axum::routing::post(super::memory_publication_reject),
        )
        .with_state(state)
}

fn automation_route_test_app(state: super::AppState) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/automations/dry-run",
            axum::routing::post(super::automation_dry_run),
        )
        .with_state(state)
}

async fn memory_source_response_json(
    response: axum::response::Response,
) -> (axum::http::StatusCode, serde_json::Value) {
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    let json = serde_json::from_slice(&body)
        .unwrap_or_else(|error| panic!("memory source response must be JSON ({error}): {body:?}"));
    (status, json)
}

fn write_memory_source_workspaces(dir: &std::path::Path, include_base: bool) {
    let mut workspaces = vec![
        memory_source_test_workspace("project-a", "Alpha"),
        memory_source_test_workspace("project-b", "Beta"),
        memory_source_test_workspace("project-c", "Gamma"),
    ];
    if include_base {
        workspaces.push(memory_source_test_workspace(
            &super::base_workspace_id(),
            "Predefinito",
        ));
    }
    std::fs::write(
        dir.join("workspaces.json"),
        serde_json::to_vec(&WorkspacesFile {
            active: "project-a".to_string(),
            workspaces,
        })
        .unwrap(),
    )
    .unwrap();
}

fn create_publication_route_memory(
    facade: &local_first_memory::MemoryFacade,
    owner: local_first_memory::UserId,
    workspace: &str,
    text: &str,
    sensitivity: local_first_memory::DataSensitivity,
) -> local_first_memory::MemoryRecord {
    facade
        .create_memory_candidate(local_first_memory::MemoryCreateRequest {
            request: local_first_memory::MemoryLifecycleRequest {
                actor_id: "test".to_string(),
                user_id: owner,
                workspace_id: local_first_memory::WorkspaceId::new(workspace),
                purpose: "publication route test".to_string(),
            },
            memory_type: "preference".to_string(),
            text: text.to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            privacy_domain: local_first_memory::PrivacyDomain::new("personal"),
            sensitivity,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({}),
        })
        .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn memory_publication_routes_reload_local_source_require_decision_and_reject_foreign_actor() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let dir = isolated_gateway_test_dir("memory-publication-routes");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, true);
    let state = super::AppState::for_tests();
    let owner = super::gateway_memory_user_id();
    let facade = super::memory_facade(&state);
    let secret = create_publication_route_memory(
        facade,
        owner.clone(),
        "project-a",
        "hidden",
        local_first_memory::DataSensitivity::Secret,
    );
    let app = memory_publication_route_test_app(state.clone());
    let base = super::base_workspace_id();
    let secret_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/memory/publications")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "source_ref": secret.reference.to_string(),
                        "source_workspace_id": "project-a",
                        "destination_workspace_id": base,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, secret_body) = memory_source_response_json(secret_response).await;
    assert_eq!(status, axum::http::StatusCode::CONFLICT);
    assert_eq!(secret_body["error"]["code"], "secret_never_shareable");

    let source = create_publication_route_memory(
        facade,
        owner.clone(),
        "project-a",
        "Prefer Italian",
        local_first_memory::DataSensitivity::Private,
    );
    let created = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/memory/publications")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "source_ref": source.reference.to_string(),
                        "source_workspace_id": "project-a",
                        "destination_workspace_id": base
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, proposal) = memory_source_response_json(created).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let proposal_id = proposal["id"].as_str().unwrap();
    assert_eq!(proposal["proposed_text"], "Prefer Italian");
    assert_eq!(proposal["proposed_memory_type"], "preference");

    let edited = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/memory/publications/{proposal_id}/edit"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "expected_version": 1,
                        "edit": {
                            "proposed_text": "Prefer concise Italian",
                            "proposed_memory_type": "note"
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, proposal) = memory_source_response_json(edited).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(proposal["proposed_text"], "Prefer concise Italian");
    assert_eq!(proposal["proposed_memory_type"], "note");
    assert_eq!(proposal["proposal_version"], 2);

    // Reopening the publish surface uses the server-first create endpoint;
    // it must resume the edited pending review instead of returning a
    // conflict or generating a second draft.
    let reopened = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/memory/publications")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "source_ref": source.reference.to_string(),
                        "source_workspace_id": "project-a",
                        "destination_workspace_id": base,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, reopened) = memory_source_response_json(reopened).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(reopened["id"], proposal_id);
    assert_eq!(reopened["proposal_version"], 2);
    assert_eq!(reopened["proposed_text"], "Prefer concise Italian");

    for (suffix, body) in [
        (
            "edit",
            serde_json::json!({ "expected_version": 1, "edit": { "proposed_text": "stale" } }),
        ),
        ("reject", serde_json::json!({ "expected_version": 1 })),
        (
            "approve",
            serde_json::json!({ "expected_version": 1, "resolution": { "kind": "create_new" } }),
        ),
    ] {
        let stale = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/memory/publications/{proposal_id}/{suffix}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, stale) = memory_source_response_json(stale).await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(stale["error"]["code"], "publication_conflict");
    }

    let missing_decision = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/memory/publications/{proposal_id}/approve"))
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, missing_decision) = memory_source_response_json(missing_decision).await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(
        missing_decision["error"]["code"],
        "memory_publication_invalid"
    );

    let approved = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/memory/publications/{proposal_id}/approve"))
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"expected_version":2,"resolution":{"kind":"create_new"}}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, approved) = memory_source_response_json(approved).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(approved["proposal"]["status"], "approved");

    let rejected_source = create_publication_route_memory(
        facade,
        owner.clone(),
        "project-a",
        "Keep this local",
        local_first_memory::DataSensitivity::Private,
    );
    let rejected_created = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/memory/publications")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "source_ref": rejected_source.reference.to_string(),
                        "source_workspace_id": "project-a",
                        "destination_workspace_id": base,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (_, rejected_proposal) = memory_source_response_json(rejected_created).await;
    let rejected = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/memory/publications/{}/reject",
                    rejected_proposal["id"].as_str().unwrap()
                ))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"expected_version":1}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, rejected) = memory_source_response_json(rejected).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(rejected["status"], "rejected");
    assert!(
        facade
            .get_publication_link(&rejected_source.reference)
            .unwrap()
            .is_none()
    );

    let foreign_owner = local_first_memory::UserId::new("other-owner");
    let foreign_source = create_publication_route_memory(
        facade,
        foreign_owner.clone(),
        "project-b",
        "Foreign preference",
        local_first_memory::DataSensitivity::Private,
    );
    let foreign = facade
        .create_publication_proposal(
            &foreign_source,
            &local_first_memory::MemoryPublicationDestination::personal(foreign_owner),
            "other-owner",
        )
        .unwrap();
    let foreign_response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/memory/publications/{}", foreign.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, foreign_body) = memory_source_response_json(foreign_response).await;
    assert_eq!(status, axum::http::StatusCode::CONFLICT);
    assert_eq!(foreign_body["error"]["code"], "publication_actor_mismatch");
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "current_thread")]
async fn publication_rejects_active_revoked_and_expired_linked_sources() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let dir = isolated_gateway_test_dir("linked-publication-firewall");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, true);
    let state = super::AppState::for_tests();
    let owner = super::gateway_memory_user_id();
    let facade = super::memory_facade(&state);
    let source = create_publication_route_memory(
        facade,
        owner.clone(),
        "project-a",
        "Linked answer cannot be copied",
        local_first_memory::DataSensitivity::Private,
    );
    insert_test_source_grant(
        facade,
        &owner,
        &local_first_memory::WorkspaceId::new("project-b"),
        &local_first_memory::WorkspaceId::new("project-a"),
        "grant-linked-publication",
        local_first_memory::MemoryCollectionKey::Preferences,
    );
    let app = memory_publication_route_test_app(state.clone());
    let request_body = serde_json::json!({
        "source_ref": source.reference.to_string(),
        "source_workspace_id": "project-a",
        "destination_workspace_id": "project-b",
    })
    .to_string();

    for expected_state in ["active", "revoked"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/memory/publications")
                    .header("content-type", "application/json")
                    .body(Body::from(request_body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = memory_source_response_json(response).await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT, "{expected_state}");
        assert_eq!(body["error"]["code"], "linked_memory_read_only");
        if expected_state == "active" {
            facade
                .revoke_memory_source_grant(
                    &owner,
                    &local_first_memory::WorkspaceId::new("project-b"),
                    "grant-linked-publication",
                    2,
                )
                .unwrap();
        }
    }

    facade
        .upsert_memory_source_grant(&local_first_memory::MemorySourceGrant {
            id: "grant-expired-publication".to_string(),
            consumer_user_id: owner.clone(),
            consumer_workspace_id: local_first_memory::WorkspaceId::new("project-c"),
            source_user_id: owner.clone(),
            source_workspace_id: local_first_memory::WorkspaceId::new("project-a"),
            collections: [local_first_memory::MemoryCollectionKey::Preferences]
                .into_iter()
                .collect(),
            max_sensitivity: local_first_memory::DataSensitivity::Private,
            overrides: std::collections::HashMap::new(),
            expires_at: Some(1),
            revoked_at: None,
            policy_version: 1,
            created_by: owner.as_str().to_string(),
            created_at: "unix:1".to_string(),
            updated_at: "unix:1".to_string(),
        })
        .unwrap();
    let expired_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/memory/publications")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "source_ref": source.reference.to_string(),
                        "source_workspace_id": "project-a",
                        "destination_workspace_id": "project-c",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = memory_source_response_json(expired_response).await;
    assert_eq!(status, axum::http::StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "linked_memory_read_only");
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "current_thread")]
async fn memory_source_routes_return_disabled_before_body_or_query_parsing() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let _flag = TestMemorySourcesFlag::set(Some("off"));
    let app = memory_source_route_test_app(super::AppState::for_tests());
    let malformed_body = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/workspaces/project-a/memory-sources/upsert")
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        memory_source_response_code(malformed_body).await.as_deref(),
        Some("memory_sources_disabled")
    );

    let missing_query = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/workspaces/project-a/memory-sources/candidates")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        memory_source_response_code(missing_query).await.as_deref(),
        Some("memory_sources_disabled")
    );

    let malformed_query = app
        .oneshot(
            Request::builder()
                .uri(concat!(
                    "/api/workspaces/project-a/memory-sources/candidates?",
                    "source_workspace_id=a&source_workspace_id=b"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        memory_source_response_code(malformed_query)
            .await
            .as_deref(),
        Some("memory_sources_disabled")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn memory_source_routes_return_typed_input_errors_when_enabled() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let app = memory_source_route_test_app(super::AppState::for_tests());
    let malformed_body = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/workspaces/project-a/memory-sources/upsert")
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(malformed_body.status(), axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(
        memory_source_response_code(malformed_body).await.as_deref(),
        Some("memory_source_invalid_json")
    );

    let missing_query = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/workspaces/project-a/memory-sources/candidates")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_query.status(), axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(
        memory_source_response_code(missing_query).await.as_deref(),
        Some("memory_source_query_invalid")
    );

    let malformed_query = app
        .oneshot(
            Request::builder()
                .uri(concat!(
                    "/api/workspaces/project-a/memory-sources/candidates?",
                    "source_workspace_id=a&source_workspace_id=b"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        malformed_query.status(),
        axum::http::StatusCode::BAD_REQUEST
    );
    assert_eq!(
        memory_source_response_code(malformed_query)
            .await
            .as_deref(),
        Some("memory_source_query_invalid")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn memory_source_routes_list_only_local_when_disabled() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let _flag = TestMemorySourcesFlag::set(None);
    let dir = isolated_gateway_test_dir("memory-source-disabled-list");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);
    let app = memory_source_route_test_app(super::AppState::for_tests());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/workspaces/project-a/memory-sources")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = memory_source_response_json(response).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 1);
    assert_eq!(body[0]["source_workspace_id"], "project-a");
    assert_eq!(body[0]["local"], true);
    assert_eq!(body[0]["overrides"], serde_json::json!([]));
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "current_thread")]
async fn memory_source_list_route_roundtrips_typed_allow_and_deny_overrides() {
    use axum::{body::Body, http::Request};
    use local_first_memory::{
        DataSensitivity, MemoryCollectionKey, MemoryGrantOverrideEffect, MemoryRef, MemoryRefKind,
        MemorySourceGrant, UserId, WorkspaceId,
    };
    use tower::ServiceExt;

    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("memory-source-list-overrides");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);
    let state = super::AppState::for_tests();
    let owner = super::gateway_memory_user_id();
    let grant = MemorySourceGrant {
        id: "typed-overrides".to_string(),
        consumer_user_id: owner.clone(),
        consumer_workspace_id: WorkspaceId::new("project-a"),
        source_user_id: owner.clone(),
        source_workspace_id: WorkspaceId::new("project-b"),
        collections: [MemoryCollectionKey::Knowledge].into_iter().collect(),
        max_sensitivity: DataSensitivity::Private,
        overrides: HashMap::from([
            (
                MemoryRef::new(
                    MemoryRefKind::Memory,
                    UserId::new(owner.as_str()),
                    WorkspaceId::new("project-b"),
                    "allow-record",
                ),
                MemoryGrantOverrideEffect::Allow,
            ),
            (
                MemoryRef::new(
                    MemoryRefKind::Memory,
                    UserId::new(owner.as_str()),
                    WorkspaceId::new("project-b"),
                    "deny-record",
                ),
                MemoryGrantOverrideEffect::Deny,
            ),
        ]),
        expires_at: None,
        revoked_at: None,
        policy_version: 1,
        created_by: owner.as_str().to_string(),
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
    };
    super::memory_facade(&state)
        .upsert_memory_source_grant(&grant)
        .unwrap();
    let app = memory_source_route_test_app(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/workspaces/project-a/memory-sources")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, listed) = memory_source_response_json(response).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let linked = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|view| view["id"] == "typed-overrides")
        .unwrap();
    assert_eq!(
        linked["overrides"],
        serde_json::json!([
            {
                "memory_ref": format!("memory:local:{}:project-b:allow-record", owner.as_str()),
                "effect": "allow"
            },
            {
                "memory_ref": format!("memory:local:{}:project-b:deny-record", owner.as_str()),
                "effect": "deny"
            }
        ])
    );
    assert!(
        serde_json::to_string(linked)
            .unwrap()
            .contains("memory_ref")
    );
    assert!(!serde_json::to_string(linked).unwrap().contains("metadata"));
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "current_thread")]
async fn memory_source_list_route_exposes_last_scoped_access_timestamp_when_present() {
    use axum::{body::Body, http::Request};
    use local_first_memory::{
        DataSensitivity, MemoryCollectionKey, MemorySourceAccessEvent, MemorySourceAccessOutcome,
        MemorySourceGrant, WorkspaceId,
    };
    use tower::ServiceExt;

    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("memory-source-last-access");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);
    let state = super::AppState::for_tests();
    let owner = super::gateway_memory_user_id();
    let grant = MemorySourceGrant {
        id: "last-access-grant".to_string(),
        consumer_user_id: owner.clone(),
        consumer_workspace_id: WorkspaceId::new("project-a"),
        source_user_id: owner.clone(),
        source_workspace_id: WorkspaceId::new("project-b"),
        collections: [MemoryCollectionKey::Knowledge].into_iter().collect(),
        max_sensitivity: DataSensitivity::Private,
        overrides: HashMap::new(),
        expires_at: None,
        revoked_at: None,
        policy_version: 1,
        created_by: owner.as_str().to_string(),
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
    };
    super::memory_facade(&state)
        .upsert_memory_source_grant(&grant)
        .unwrap();
    let app = memory_source_route_test_app(state.clone());
    let listed_before = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/workspaces/project-a/memory-sources")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (_, listed_before) = memory_source_response_json(listed_before).await;
    assert_eq!(
        listed_before
            .as_array()
            .unwrap()
            .iter()
            .find(|view| view["id"] == "last-access-grant")
            .unwrap()["last_used_at"],
        serde_json::Value::Null,
    );

    super::memory_facade(&state)
        .record_memory_source_access(&MemorySourceAccessEvent {
            id: uuid::Uuid::new_v4().to_string(),
            consumer_user_id: owner.clone(),
            consumer_workspace_id: WorkspaceId::new("project-a"),
            source_workspace_id: WorkspaceId::new("project-b"),
            grant_id: Some(grant.id.clone()),
            policy_version: 1,
            turn_id: Some("turn-1".to_string()),
            outcome: MemorySourceAccessOutcome::Allow,
            reason: "allowed".to_string(),
            candidate_count: 1,
            injected_refs: Vec::new(),
            created_at: 1_700_000_001,
        })
        .unwrap();
    let listed_after = app
        .oneshot(
            Request::builder()
                .uri("/api/workspaces/project-a/memory-sources")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (_, listed_after) = memory_source_response_json(listed_after).await;
    assert_eq!(
        listed_after
            .as_array()
            .unwrap()
            .iter()
            .find(|view| view["id"] == "last-access-grant")
            .unwrap()["last_used_at"],
        serde_json::json!(1_700_000_001),
    );
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "current_thread")]
async fn memory_source_routes_persist_upsert_list_and_revoke() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("memory-source-route-lifecycle");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);
    let state = super::AppState::for_tests();
    let app = memory_source_route_test_app(state);

    let upsert = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/workspaces/project-a/memory-sources/upsert")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"source_workspace_id":"project-b","collections":["knowledge"],"max_sensitivity":"private","expires_at":null,"overrides":[]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    let (status, upserted) = memory_source_response_json(upsert).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let grant_id = upserted
        .as_array()
        .unwrap()
        .iter()
        .find(|view| view["source_workspace_id"] == "project-b")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let listed = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/workspaces/project-a/memory-sources")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, listed) = memory_source_response_json(listed).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(listed.as_array().unwrap().len(), 2);

    let revoked = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/workspaces/project-a/memory-sources/{grant_id}/revoke"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, revoked) = memory_source_response_json(revoked).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let linked = revoked
        .as_array()
        .unwrap()
        .iter()
        .find(|view| view["id"] == grant_id)
        .unwrap();
    assert!(linked["revoked_at"].as_i64().is_some());
    assert_eq!(linked["policy_version"], 2);

    let listed_again = app
        .oneshot(
            Request::builder()
                .uri("/api/workspaces/project-a/memory-sources")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (_, listed_again) = memory_source_response_json(listed_again).await;
    assert!(
        listed_again
            .as_array()
            .unwrap()
            .iter()
            .any(|view| view["id"] == grant_id && view["revoked_at"].as_i64().is_some())
    );
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "current_thread")]
async fn memory_source_routes_scope_revoke_and_missing_revoke_are_not_found() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("memory-source-revoke-scope");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);
    let state = super::AppState::for_tests();
    let owner = super::gateway_memory_user_id();
    let grant = local_first_memory::MemorySourceGrant {
        id: "scoped-route-grant".to_string(),
        consumer_user_id: owner.clone(),
        consumer_workspace_id: local_first_memory::WorkspaceId::new("project-a"),
        source_user_id: owner.clone(),
        source_workspace_id: local_first_memory::WorkspaceId::new("project-b"),
        collections: [local_first_memory::MemoryCollectionKey::Knowledge]
            .into_iter()
            .collect(),
        max_sensitivity: local_first_memory::DataSensitivity::Private,
        overrides: HashMap::new(),
        expires_at: None,
        revoked_at: None,
        policy_version: 1,
        created_by: owner.as_str().to_string(),
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
    };
    super::memory_facade(&state)
        .upsert_memory_source_grant(&grant)
        .unwrap();
    let app = memory_source_route_test_app(state);

    for uri in [
        "/api/workspaces/project-c/memory-sources/scoped-route-grant/revoke",
        "/api/workspaces/project-a/memory-sources/missing-grant/revoke",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = memory_source_response_json(response).await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "memory_source_grant_not_found");
    }
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "current_thread")]
async fn memory_source_routes_keep_unavailable_grants_listable_and_revocable() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("memory-source-unavailable");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);
    let state = super::AppState::for_tests();
    let owner = super::gateway_memory_user_id();
    super::memory_facade(&state)
        .upsert_memory_source_grant(&local_first_memory::MemorySourceGrant {
            id: "unavailable-grant".to_string(),
            consumer_user_id: owner.clone(),
            consumer_workspace_id: local_first_memory::WorkspaceId::new("project-a"),
            source_user_id: owner.clone(),
            source_workspace_id: local_first_memory::WorkspaceId::new("deleted-project"),
            collections: [local_first_memory::MemoryCollectionKey::Knowledge]
                .into_iter()
                .collect(),
            max_sensitivity: local_first_memory::DataSensitivity::Private,
            overrides: HashMap::new(),
            expires_at: None,
            revoked_at: None,
            policy_version: 1,
            created_by: owner.as_str().to_string(),
            created_at: "unix:1.000000000".to_string(),
            updated_at: "unix:1.000000000".to_string(),
        })
        .unwrap();
    let app = memory_source_route_test_app(state);

    let listed = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/workspaces/project-a/memory-sources")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (_, listed) = memory_source_response_json(listed).await;
    let unavailable = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|view| view["id"] == "unavailable-grant")
        .unwrap();
    assert_eq!(unavailable["source_available"], false);

    let revoked = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(concat!(
                    "/api/workspaces/project-a/memory-sources/",
                    "unavailable-grant/revoke"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, revoked) = memory_source_response_json(revoked).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert!(
        revoked
            .as_array()
            .unwrap()
            .iter()
            .any(|view| view["id"] == "unavailable-grant" && view["revoked_at"].as_i64().is_some())
    );
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "current_thread")]
async fn memory_source_routes_reject_oversized_enabled_body_and_invalid_pages() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("memory-source-input-bounds");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);
    let app = memory_source_route_test_app(super::AppState::for_tests());

    let oversized = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/workspaces/project-a/memory-sources/upsert")
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    "{{\"padding\":\"{}\"}}",
                    "x".repeat(70 * 1024)
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = memory_source_response_json(oversized).await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "memory_source_invalid_json");

    for query in ["offset=-1", "limit=0", "limit=101"] {
        let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!(
                            "/api/workspaces/project-a/memory-sources/candidates?source_workspace_id=project-b&{query}"
                        ))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
        let (status, body) = memory_source_response_json(response).await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "query {query}");
        assert_eq!(
            body["error"]["code"], "memory_source_query_invalid",
            "query {query}"
        );
    }
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "current_thread")]
async fn memory_source_routes_normalize_default_source_and_reject_default_consumer() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("memory-source-default-scope");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, true);
    let state = super::AppState::for_tests();
    let personal = local_first_memory::WorkspaceId::new(local_first_memory::PERSONAL_WORKSPACE);
    let owner = super::gateway_memory_user_id();
    let memory = super::memory_facade(&state)
        .create_memory_candidate(local_first_memory::MemoryCreateRequest {
            request: local_first_memory::MemoryLifecycleRequest {
                actor_id: "test".to_string(),
                user_id: owner.clone(),
                workspace_id: personal.clone(),
                purpose: "default source route test".to_string(),
            },
            memory_type: "note".to_string(),
            text: "personal candidate".to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            privacy_domain: local_first_memory::PrivacyDomain::new("personal"),
            sensitivity: local_first_memory::DataSensitivity::Internal,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({}),
        })
        .unwrap();
    let app = memory_source_route_test_app(state.clone());
    let base = super::base_workspace_id();

    let rejected_consumer = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/workspaces/{base}/memory-sources"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = memory_source_response_json(rejected_consumer).await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "reserved_consumer_scope");

    let upsert = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/workspaces/project-a/memory-sources/upsert")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "source_workspace_id": base,
                        "collections": ["knowledge"],
                        "max_sensitivity": "private",
                        "expires_at": null,
                        "overrides": [{
                            "memory_ref": memory.reference.to_string(),
                            "effect": "allow"
                        }]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, upserted) = memory_source_response_json(upsert).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let linked = upserted
        .as_array()
        .unwrap()
        .iter()
        .find(|view| !view["local"].as_bool().unwrap())
        .unwrap();
    assert_eq!(
        linked["source_workspace_id"],
        local_first_memory::PERSONAL_WORKSPACE
    );
    assert_eq!(linked["source_label"], "Personal");

    let persisted = super::memory_facade(&state)
        .list_memory_source_grants(&owner, &local_first_memory::WorkspaceId::new("project-a"))
        .unwrap();
    assert_eq!(persisted[0].source_workspace_id, personal);
    assert!(persisted[0].overrides.contains_key(&memory.reference));

    let candidates = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/workspaces/project-a/memory-sources/candidates?source_workspace_id={base}&offset=0&limit=10"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
    let (status, candidates) = memory_source_response_json(candidates).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(candidates.as_array().unwrap().len(), 1);
    assert_eq!(candidates[0]["ref"], memory.reference.to_string());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn workspace_write_roots_include_project_and_home_caches() {
    // ADR 0023: the workspace-write fence's writable roots = the project root
    // plus the standard HOME tool-cache dirs, so build tooling (npm/cargo/…)
    // keeps working while everything else stays denied.
    let project = std::path::Path::new("/Users/x/proj");
    let roots = workspace_write_roots(project, Some("/Users/x"));

    // The project root is always first.
    assert_eq!(roots.first(), Some(&project.to_path_buf()));

    // Each standard cache dir under HOME is present.
    for cache in [".cache", ".config", ".local", ".npm", ".cargo"] {
        let expected = std::path::Path::new("/Users/x").join(cache);
        assert!(
            roots.contains(&expected),
            "missing writable cache root {expected:?} in {roots:?}"
        );
    }
    // Exactly the project root + the five caches, nothing more.
    assert_eq!(roots.len(), 6, "unexpected extra writable roots: {roots:?}");

    // With no HOME, only the project root is writable.
    let no_home = workspace_write_roots(project, None);
    assert_eq!(no_home, vec![project.to_path_buf()]);
}

// Per-workspace policy (Fase 1): the new override fields on `WorkspaceRecord` default
// to `None` (absent in legacy workspaces.json → inherit the global default) and
// round-trip when present. Behavior-preserving on upgrade.
#[test]
fn workspace_record_policy_overrides_default_to_none_and_round_trip() {
    let legacy: super::WorkspaceRecord =
        serde_json::from_str(r#"{"id":"w1","name":"P","folder":"/tmp/p"}"#).unwrap();
    assert_eq!(legacy.sandbox_mode, None);
    assert_eq!(legacy.approval_policy, None);
    let with: super::WorkspaceRecord = serde_json::from_str(
        r#"{"id":"w1","name":"P","sandbox_mode":"read-only","approval_policy":"never"}"#,
    )
    .unwrap();
    assert_eq!(with.sandbox_mode.as_deref(), Some("read-only"));
    assert_eq!(with.approval_policy.as_deref(), Some("never"));
    let back = serde_json::to_string(&with).unwrap();
    assert!(back.contains("read-only"));
    assert!(back.contains("never"));
}

// Per-workspace resolution core (Fase 1): the pure precedence
// env > per-workspace override > global default > built-in, unit-tested without
// AppState wiring. The thin `resolved_*` wrappers only gather these three inputs.
#[test]
fn resolve_sandbox_mode_core_precedence_env_beats_workspace_beats_global() {
    use crate::tool_safety::SandboxMode;
    // No env, no workspace override → the global default wins.
    assert_eq!(
        super::resolve_sandbox_mode_core(None, None, "workspace-write"),
        SandboxMode::WorkspaceWrite
    );
    // Workspace override beats the global default.
    assert_eq!(
        super::resolve_sandbox_mode_core(None, Some("read-only"), "workspace-write"),
        SandboxMode::ReadOnly
    );
    // A blank workspace override is ignored (inherits the global default).
    assert_eq!(
        super::resolve_sandbox_mode_core(None, Some("  "), "workspace-write"),
        SandboxMode::WorkspaceWrite
    );
    // Env beats both the workspace override and the global default.
    assert_eq!(
        super::resolve_sandbox_mode_core(Some("danger"), Some("read-only"), "workspace-write"),
        SandboxMode::Danger
    );
    // A blank env is ignored (falls through to the workspace override).
    assert_eq!(
        super::resolve_sandbox_mode_core(Some("  "), Some("read-only"), "workspace-write"),
        SandboxMode::ReadOnly
    );
}

#[test]
fn resolve_approval_policy_core_precedence_env_beats_workspace_beats_global() {
    use crate::tool_safety::AskForApproval;
    assert_eq!(
        super::resolve_approval_policy_core(None, None, "on-request"),
        AskForApproval::OnRequest
    );
    assert_eq!(
        super::resolve_approval_policy_core(None, Some("never"), "on-request"),
        AskForApproval::Never
    );
    assert_eq!(
        super::resolve_approval_policy_core(None, Some("  "), "on-request"),
        AskForApproval::OnRequest
    );
    assert_eq!(
        super::resolve_approval_policy_core(Some("on-failure"), Some("never"), "on-request"),
        AskForApproval::OnFailure
    );
    assert_eq!(
        super::resolve_approval_policy_core(Some("  "), Some("never"), "on-request"),
        AskForApproval::Never
    );
}

// ADR 0023 (reconciled): the sandbox/approval resolvers — env-override > persisted
// RuntimeSettings > default. `TEST_ENV_LOCK` serializes the process-global env
// mutation; `TestGatewayDataDir` points the persisted file at an isolated temp dir.
// The persisted-vs-default+env axis is now covered by the pure core (`resolve_*_core`);
// the full `resolved_*` wrapper (with `None` thread → active workspace, no override)
// still exercises the env + on-disk `runtime-settings.json` path end-to-end.

#[test]
fn resolved_sandbox_mode_precedence_env_beats_persisted_beats_default() {
    use crate::tool_safety::SandboxMode;
    let _env = TestEnv::acquire();
    let dir = isolated_gateway_test_dir("sandbox-mode-precedence");
    std::fs::create_dir_all(&dir).expect("create temp data dir");
    let _data = TestGatewayDataDir::new(&dir);
    // No thread → the active (default) workspace, which carries no override → inherit
    // the global default. This keeps the env + on-disk `runtime-settings.json` coverage.
    let state = super::AppState::for_tests();
    _data.env().set("HOMUN_SANDBOX_MODE", None);

    // No env + no persisted file → the DEFAULT is workspace-write (NOT danger).
    assert_eq!(
        super::resolved_sandbox_mode(&state, None),
        SandboxMode::WorkspaceWrite
    );

    // Persist read-only → persisted beats default.
    std::fs::write(
        dir.join("runtime-settings.json"),
        r#"{"sandbox_mode":"read-only","approval_policy":"on-request"}"#,
    )
    .expect("write runtime settings");
    assert_eq!(
        super::resolved_sandbox_mode(&state, None),
        SandboxMode::ReadOnly
    );

    // Env override beats the persisted value.
    _data.env().set("HOMUN_SANDBOX_MODE", Some("danger"));
    assert_eq!(
        super::resolved_sandbox_mode(&state, None),
        SandboxMode::Danger
    );
    // A blank env var is ignored (falls through to persisted), not parsed as unknown.
    _data.env().set("HOMUN_SANDBOX_MODE", Some("  "));
    assert_eq!(
        super::resolved_sandbox_mode(&state, None),
        SandboxMode::ReadOnly
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn resolved_approval_policy_precedence_env_beats_persisted_beats_default() {
    use crate::tool_safety::AskForApproval;
    let _env = TestEnv::acquire();
    let dir = isolated_gateway_test_dir("approval-policy-precedence");
    std::fs::create_dir_all(&dir).expect("create temp data dir");
    let _data = TestGatewayDataDir::new(&dir);
    // No thread → the active (default) workspace, which carries no override → inherit
    // the global default. Keeps the env + on-disk `runtime-settings.json` coverage.
    let state = super::AppState::for_tests();
    // SAFETY: env-mutation under TEST_ENV_LOCK, restored at the end.
    _data.env().set("HOMUN_APPROVAL_POLICY", None);

    // No env + no persisted file → the DEFAULT is on-request.
    assert_eq!(
        super::resolved_approval_policy(&state, None),
        AskForApproval::OnRequest
    );

    // Persist `never` → persisted beats default.
    std::fs::write(
        dir.join("runtime-settings.json"),
        r#"{"sandbox_mode":"workspace-write","approval_policy":"never"}"#,
    )
    .expect("write runtime settings");
    assert_eq!(
        super::resolved_approval_policy(&state, None),
        AskForApproval::Never
    );

    // Env override beats the persisted value.
    _data.env().set("HOMUN_APPROVAL_POLICY", Some("on-failure"));
    assert_eq!(
        super::resolved_approval_policy(&state, None),
        AskForApproval::OnFailure
    );

    _data.env().set("HOMUN_APPROVAL_POLICY", None);
    std::fs::remove_dir_all(&dir).ok();
}

// Per-workspace chokepoint (Fase 1): the `write_project_file` read-only gate now honors
// the thread's WORKSPACE override, not just the global default. A thread in a workspace
// whose `sandbox_mode = read-only` is blocked; a thread in a workspace with no override
// inherits the global `workspace-write` and writes. Proves the resolver rewiring reaches
// the real file chokepoint.
#[test]
fn write_project_file_honors_per_workspace_read_only() {
    let _env = TestEnv::acquire();
    let dir = isolated_gateway_test_dir("per-workspace-write");
    std::fs::create_dir_all(&dir).expect("create temp data dir");
    let _data = TestGatewayDataDir::new(&dir);
    // SAFETY: env-mutation under TEST_ENV_LOCK; env must not shadow the workspace axis.

    // A real project folder both workspaces point at, so the inheriting workspace's
    // write actually lands on disk (the read-only one is blocked before the folder).
    let project = dir.join("project");
    std::fs::create_dir_all(&project).expect("create project folder");
    let project_str = project.to_string_lossy().replace('\\', "\\\\");

    // Global default = workspace-write; "ro" overrides to read-only, "rw" inherits.
    std::fs::write(
        dir.join("runtime-settings.json"),
        r#"{"sandbox_mode":"workspace-write","approval_policy":"on-request"}"#,
    )
    .expect("write runtime settings");
    std::fs::write(
        dir.join("workspaces.json"),
        format!(
            r#"{{"active":"rw","workspaces":[
                    {{"id":"ro","name":"RO","folder":"{project_str}","sandbox_mode":"read-only"}},
                    {{"id":"rw","name":"RW","folder":"{project_str}"}}
                ]}}"#
        ),
    )
    .expect("write workspaces file");

    let state = super::AppState::for_tests();
    let (t_ro, t_rw) = {
        let store = state.chat_store.lock().expect("lock chat store");
        (
            store
                .create_thread("ro")
                .expect("create ro thread")
                .thread_id,
            store
                .create_thread("rw")
                .expect("create rw thread")
                .thread_id,
        )
    };

    // Read-only workspace → blocked, nothing written.
    let blocked = super::write_project_file(&state, Some(&t_ro), "note.txt", "x");
    assert!(
        blocked.starts_with(super::READ_ONLY_BLOCKED_MARKER),
        "expected a read-only block, got: {blocked}"
    );

    // Inheriting workspace → global workspace-write applies → the write lands.
    let ok = super::write_project_file(&state, Some(&t_rw), "note.txt", "x");
    assert!(
        !ok.starts_with(super::READ_ONLY_BLOCKED_MARKER),
        "expected a successful write, got: {ok}"
    );
    assert!(
        project.join("note.txt").is_file(),
        "the inheriting workspace should have written the file"
    );

    std::fs::remove_dir_all(&dir).ok();
}

// ADR 0023: the read-only card must ride the PERSISTED text-marker channel (the bug was
// a non-persisted `tool_result` event → `event_parts_json` NULL → card never rendered on
// reload). `read_only_card_marker` is the pure shaper the emit fn appends to
// `effects.append_output`; assert the marker + parsed target are present for a block, and
// that a non-block result yields None (no spurious card).
#[test]
fn read_only_card_marker_wraps_target_for_a_block() {
    let blocked = super::read_only_write_blocked_msg("appunti.txt");
    let card =
        super::read_only_card_marker(&blocked).expect("a read-only block must produce a card");
    assert!(
        card.contains(super::SANDBOX_READONLY_OPEN) && card.contains(super::SANDBOX_READONLY_CLOSE),
        "card must be wrapped in the SANDBOX_READONLY marker, got: {card}"
    );
    assert!(
        card.contains("\"target\":\"appunti.txt\""),
        "card must carry the parsed target as JSON, got: {card}"
    );

    // A normal (non-blocked) tool result must NOT produce a card.
    assert!(
        super::read_only_card_marker("✅ Wrote appunti.txt").is_none(),
        "a successful write must not emit a read-only card"
    );
}

// Per-workspace policy endpoint (Fase 1): `merge_workspace_policy` overlays a PARTIAL
// patch onto a record — a control posting one axis must not clobber the sibling.
// `null` clears an override back to inherit; an unknown token is dropped to None (never
// stored as a spurious explicit override).
#[test]
fn merge_workspace_policy_is_partial_and_normalizes() {
    let cur = super::WorkspaceRecord {
        id: "w".into(),
        name: "W".into(),
        folder: None,
        sandbox_mode: Some("read-only".into()),
        approval_policy: Some("never".into()),
        writable_roots: None,
        skill_confirmations: None,
    };
    // Partial: only approval changes; sandbox override is preserved.
    let merged =
        super::merge_workspace_policy(&cur, &serde_json::json!({"approval_policy":"on-request"}));
    assert_eq!(merged.sandbox_mode.as_deref(), Some("read-only"));
    assert_eq!(merged.approval_policy.as_deref(), Some("on-request"));
    // `null` clears back to inherit (None).
    let cleared = super::merge_workspace_policy(&cur, &serde_json::json!({"sandbox_mode": null}));
    assert_eq!(cleared.sandbox_mode, None);
    assert_eq!(cleared.approval_policy.as_deref(), Some("never")); // untouched
    // Unknown token → dropped to None (not stored as an override).
    let garbage = super::merge_workspace_policy(&cur, &serde_json::json!({"sandbox_mode":"bogus"}));
    assert_eq!(garbage.sandbox_mode, None);
    // An absent key leaves both axes untouched.
    let noop = super::merge_workspace_policy(&cur, &serde_json::json!({}));
    assert_eq!(noop.sandbox_mode.as_deref(), Some("read-only"));
    assert_eq!(noop.approval_policy.as_deref(), Some("never"));
}

// Phase 3 (per-project skill confirmations): the global default lives on `RuntimeSettings`
// (`Vec<String>`) and the per-workspace override on `WorkspaceRecord`
// (`Option<Vec<String>>`, None = inherit). Both `#[serde(default)]`. The pure precedence
// core parses tokens to `SensitiveCategory` (forgiving, unknown dropped); a per-workspace
// override REPLACES the global default.
#[test]
fn skill_confirmations_fields_and_resolution() {
    use crate::skills::SensitiveCategory;
    // Legacy files (no field) → empty / None.
    let rs0: super::RuntimeSettings = serde_json::from_str("{}").unwrap();
    assert!(rs0.skill_confirmations.is_empty());
    let wr0: super::WorkspaceRecord = serde_json::from_str(r#"{"id":"w","name":"W"}"#).unwrap();
    assert_eq!(wr0.skill_confirmations, None);
    // Present fields round-trip.
    let rs: super::RuntimeSettings =
        serde_json::from_str(r#"{"skill_confirmations":["delete","financial"]}"#).unwrap();
    assert_eq!(
        rs.skill_confirmations,
        vec!["delete".to_string(), "financial".to_string()]
    );
    let wr: super::WorkspaceRecord =
        serde_json::from_str(r#"{"id":"w","name":"W","skill_confirmations":["medical"]}"#).unwrap();
    assert_eq!(
        wr.skill_confirmations.as_deref(),
        Some(&["medical".to_string()][..])
    );
    // Pure precedence core: ws override REPLACES global; None inherits; unknown dropped; deduped.
    assert_eq!(
        super::resolve_skill_confirmations_core(
            Some(&["medical".to_string()]),
            &["delete".to_string()]
        ),
        vec![SensitiveCategory::Medical]
    );
    assert_eq!(
        super::resolve_skill_confirmations_core(None, &["financial".to_string()]),
        vec![SensitiveCategory::Financial]
    );
    assert_eq!(
        super::resolve_skill_confirmations_core(
            Some(&[
                "bogus".to_string(),
                "delete".to_string(),
                "delete".to_string()
            ]),
            &[]
        ),
        vec![SensitiveCategory::Delete]
    );
}

// Phase 2 (per-project writable_roots): the global default lives on `RuntimeSettings`
// (`Vec<String>`, empty = just the project root) and the per-workspace override on
// `WorkspaceRecord` (`Option<Vec<String>>`, None = inherit). Both `#[serde(default)]` so
// legacy files without the field deserialize cleanly; a present field round-trips.
#[test]
fn writable_roots_fields_default_and_round_trip() {
    let rs: super::RuntimeSettings = serde_json::from_str("{}").unwrap();
    assert!(rs.writable_roots.is_empty());
    let wr: super::WorkspaceRecord =
        serde_json::from_str(r#"{"id":"w","name":"W","writable_roots":["/tmp/extra"]}"#).unwrap();
    assert_eq!(
        wr.writable_roots.as_deref(),
        Some(&["/tmp/extra".to_string()][..])
    );
}

// Phase 2 precedence core: a per-workspace override REPLACES the global default (a
// project that declares its own extra-roots list OWNS it — no merge), and `None`
// inherits the global default. IO-free so the precedence is unit-testable.
#[test]
fn resolve_extra_roots_override_replaces_global() {
    assert_eq!(
        super::resolve_extra_roots(Some(&["/a".to_string()]), &["/g".to_string()]),
        vec!["/a".to_string()]
    );
    assert_eq!(
        super::resolve_extra_roots(None, &["/g".to_string()]),
        vec!["/g".to_string()]
    );
    // An explicit EMPTY override still replaces (shrinks to just the project root).
    assert!(super::resolve_extra_roots(Some(&[]), &["/g".to_string()]).is_empty());
}

// Phase 2 endpoint: `merge_workspace_policy` also carries the per-project `writable_roots`
// list. An ARRAY sets the override, `null` clears it back to inherit (None), and a partial
// patch must never clobber the mode/approval axes (nor vice versa).
#[test]
fn merge_workspace_policy_handles_writable_roots() {
    let cur = super::WorkspaceRecord {
        id: "w".into(),
        name: "W".into(),
        folder: None,
        sandbox_mode: Some("read-only".into()),
        approval_policy: Some("never".into()),
        writable_roots: None,
        skill_confirmations: None,
    };
    // Array sets the override; mode/approval are untouched.
    let m = super::merge_workspace_policy(
        &cur,
        &serde_json::json!({"writable_roots": ["/tmp/a", " /tmp/b "]}),
    );
    assert_eq!(
        m.writable_roots.as_deref(),
        Some(&["/tmp/a".to_string(), "/tmp/b".to_string()][..])
    );
    assert_eq!(m.sandbox_mode.as_deref(), Some("read-only"));
    assert_eq!(m.approval_policy.as_deref(), Some("never"));
    // `null` clears back to inherit (None), leaving the other axes untouched.
    let cur2 = super::WorkspaceRecord {
        writable_roots: Some(vec!["/x".to_string()]),
        ..cur.clone()
    };
    let cleared =
        super::merge_workspace_policy(&cur2, &serde_json::json!({"writable_roots": null}));
    assert_eq!(cleared.writable_roots, None);
    assert_eq!(cleared.sandbox_mode.as_deref(), Some("read-only"));
    // An absent writable_roots key leaves the existing override untouched.
    let noop = super::merge_workspace_policy(&cur2, &serde_json::json!({"sandbox_mode": "danger"}));
    assert_eq!(
        noop.writable_roots.as_deref(),
        Some(&["/x".to_string()][..])
    );
}

// Phase 3 endpoint: `merge_workspace_policy` also carries the per-project
// `skill_confirmations` list. Array sets, `null` clears, and a partial patch must not
// clobber the sibling axes (mode / approval / writable_roots).
#[test]
fn merge_workspace_policy_handles_skill_confirmations() {
    let cur = super::WorkspaceRecord {
        id: "w".into(),
        name: "W".into(),
        folder: None,
        sandbox_mode: Some("read-only".into()),
        approval_policy: Some("never".into()),
        writable_roots: Some(vec!["/x".to_string()]),
        skill_confirmations: None,
    };
    // Array sets the override; the other axes are untouched.
    let m = super::merge_workspace_policy(
        &cur,
        &serde_json::json!({"skill_confirmations": ["delete", "financial"]}),
    );
    assert_eq!(
        m.skill_confirmations.as_deref(),
        Some(&["delete".to_string(), "financial".to_string()][..])
    );
    assert_eq!(m.sandbox_mode.as_deref(), Some("read-only"));
    assert_eq!(m.writable_roots.as_deref(), Some(&["/x".to_string()][..]));
    // `null` clears back to inherit (None); siblings untouched.
    let cur2 = super::WorkspaceRecord {
        skill_confirmations: Some(vec!["medical".to_string()]),
        ..cur.clone()
    };
    let cleared =
        super::merge_workspace_policy(&cur2, &serde_json::json!({"skill_confirmations": null}));
    assert_eq!(cleared.skill_confirmations, None);
    assert_eq!(cleared.approval_policy.as_deref(), Some("never"));
    // An absent key leaves the existing override untouched.
    let noop = super::merge_workspace_policy(&cur2, &serde_json::json!({"sandbox_mode": "danger"}));
    assert_eq!(
        noop.skill_confirmations.as_deref(),
        Some(&["medical".to_string()][..])
    );
}

// ADR 0023 UI: each Settings control (sandbox / approval) POSTs only
// its own field. `set_runtime_settings` must MERGE the partial patch so saving one
// control does not reset the others to their serde defaults — otherwise the three
// selectors silently clobber each other. Pure test over the merge helper.
#[test]
fn set_runtime_settings_merges_partial_updates() {
    let current = super::RuntimeSettings {
        sandbox_mode: "danger".to_string(),
        approval_policy: "never".to_string(),
        writable_roots: Vec::new(),
        skill_confirmations: Vec::new(),
        local_computer_autostart: true,
        mac_apps_beta_enabled: false,
    };
    // Patch only sandbox_mode → the other axes are preserved.
    let merged = super::merge_runtime_settings(
        &current,
        &serde_json::json!({ "sandbox_mode": "read-only" }),
    );
    assert_eq!(merged.sandbox_mode, "read-only", "sandbox_mode updated");
    assert_eq!(merged.approval_policy, "never", "approval_policy preserved");
    assert!(merged.local_computer_autostart, "autostart preserved");

    // local_computer_autostart: defaults ON for legacy files, toggles via a partial patch,
    // and a patch to another field must NOT reset it.
    let legacy: super::RuntimeSettings = serde_json::from_str("{}").unwrap();
    assert!(
        legacy.local_computer_autostart,
        "default ON on legacy files"
    );
    let toggled = super::merge_runtime_settings(
        &current,
        &serde_json::json!({ "local_computer_autostart": false }),
    );
    assert!(!toggled.local_computer_autostart, "autostart toggled off");
    let after = super::merge_runtime_settings(
        &toggled,
        &serde_json::json!({ "approval_policy": "on-request" }),
    );
    assert!(
        !after.local_computer_autostart,
        "autostart preserved through other patch"
    );

    // Unknown tokens normalize to the safe default; extra keys are ignored.
    let merged3 = super::merge_runtime_settings(
        &current,
        &serde_json::json!({ "sandbox_mode": "bogus", "unrelated": 1 }),
    );
    assert_eq!(
        merged3.sandbox_mode, "workspace-write",
        "unknown → safe default"
    );
}

#[test]
fn mac_apps_beta_is_off_for_legacy_settings_and_survives_partial_patches() {
    let legacy: super::RuntimeSettings = serde_json::from_str("{}").unwrap();
    assert!(!legacy.mac_apps_beta_enabled);

    let enabled = super::merge_runtime_settings(
        &legacy,
        &serde_json::json!({ "mac_apps_beta_enabled": true }),
    );
    assert!(enabled.mac_apps_beta_enabled);

    let after_unrelated_patch = super::merge_runtime_settings(
        &enabled,
        &serde_json::json!({ "sandbox_mode": "read-only" }),
    );
    assert!(after_unrelated_patch.mac_apps_beta_enabled);
}

#[test]
fn runtime_settings_discard_retired_adaptive_floor_field() {
    let settings: super::RuntimeSettings = serde_json::from_str(
        r#"{"adaptive_floor":"on","sandbox_mode":"read-only","approval_policy":"never"}"#,
    )
    .expect("legacy runtime settings remain readable");
    let serialized = serde_json::to_value(settings).expect("serialize runtime settings");
    assert!(
        serialized.get("adaptive_floor").is_none(),
        "the retired adaptive_floor field must not remain in the public contract"
    );
}

#[test]
fn effective_approval_forces_never_only_when_autonomous() {
    use crate::tool_safety::AskForApproval;
    // Autonomous runs never prompt, whatever the resolved policy.
    assert_eq!(
        super::effective_approval(true, AskForApproval::OnRequest),
        AskForApproval::Never
    );
    assert_eq!(
        super::effective_approval(true, AskForApproval::UnlessTrusted),
        AskForApproval::Never
    );
    // Non-autonomous sees the resolved policy verbatim.
    assert_eq!(
        super::effective_approval(false, AskForApproval::OnRequest),
        AskForApproval::OnRequest
    );
    assert_eq!(
        super::effective_approval(false, AskForApproval::Never),
        AskForApproval::Never
    );
}

#[test]
fn sensitive_skill_forces_confirm_only_on_effectful() {
    use super::skill_policy_forces_confirm;
    use crate::skills::SensitiveCategory;
    // ADR 0023 Step 5 (Fase 0.3): an active sensitive-declared skill forces a
    // confirmation on EFFECTFUL actions, even under a permissive approval
    // policy — but never gates reads, and never fires when nothing is active.
    let active = [SensitiveCategory::Financial];
    assert!(skill_policy_forces_confirm(&active, true)); // effectful + active → confirm
    assert!(!skill_policy_forces_confirm(&active, false)); // read + active → no
    assert!(!skill_policy_forces_confirm(&[], true)); // effectful + none active → no
    assert!(!skill_policy_forces_confirm(&[], false)); // read + none active → no
}

// Phase 3 compose: a per-project category must force a confirm on an effectful action
// even with NO sensitive skill active — i.e. `merged_sensitive([], project)` seeds the
// gate. `merged_sensitive` also dedups the union and never drops the skill categories.
#[test]
fn project_skill_confirmations_force_confirm_with_no_skill_active() {
    use super::{merged_sensitive, skill_policy_forces_confirm};
    use crate::skills::SensitiveCategory;
    // No skill active, project requires `delete` → effectful action is gated.
    let merged = merged_sensitive(&[], &[SensitiveCategory::Delete]);
    assert!(
        skill_policy_forces_confirm(&merged, true),
        "project category forces confirm"
    );
    assert!(
        !skill_policy_forces_confirm(&merged, false),
        "still never gates reads"
    );
    // Neither skill nor project → nothing is forced.
    assert!(!skill_policy_forces_confirm(
        &merged_sensitive(&[], &[]),
        true
    ));
    // Union dedups; skill category is preserved and not duplicated.
    let both = merged_sensitive(
        &[SensitiveCategory::Financial],
        &[SensitiveCategory::Financial, SensitiveCategory::Delete],
    );
    assert_eq!(
        both,
        vec![SensitiveCategory::Financial, SensitiveCategory::Delete]
    );
}

#[test]
fn estimate_tokens_counts_serialized_chars_over_four() {
    use super::estimate_tokens;
    let messages = vec![
        serde_json::json!({"role": "system", "content": "You are helpful."}),
        serde_json::json!({"role": "user", "content": "Summarize this."}),
    ];
    let expected: usize = messages.iter().map(|m| m.to_string().len()).sum::<usize>() / 4;
    assert_eq!(estimate_tokens(&messages), expected);
    assert!(estimate_tokens(&messages) > 0);
}

#[test]
fn needs_context_compaction_respects_threshold_and_unknown_window() {
    use super::needs_context_compaction;
    assert!(needs_context_compaction(800, Some(1000), 0.75)); // > 750
    assert!(!needs_context_compaction(700, Some(1000), 0.75)); // < 750
    assert!(!needs_context_compaction(999_999, None, 0.75)); // unknown window → never
    assert!(!needs_context_compaction(800, Some(0), 0.75)); // degenerate window → never
}

#[test]
fn context_compaction_span_preserves_head_tail_and_avoids_orphan_tool() {
    use super::context_compaction_span;
    // Too short (len <= keep_head + keep_tail_min) → None.
    assert_eq!(
        context_compaction_span(&["system", "user", "assistant", "user"], 2, 2),
        None
    );
    // Normal: collapse the middle, keep head(2) + tail(>=2).
    let roles = ["system", "user", "a", "tool", "a", "tool", "a", "user"];
    assert_eq!(context_compaction_span(&roles, 2, 2), Some((2, 6)));
    // Tail boundary lands on a `tool` result → move earlier so a kept tool
    // result is never orphaned from its assistant tool_calls.
    let roles2 = [
        "system", "user", "a", "tool", "a", "tool", "a", "tool", "a", "user",
    ];
    assert_eq!(context_compaction_span(&roles2, 2, 3), Some((2, 6)));
}

#[test]
fn compaction_evidence_retains_structured_tool_results_verbatim() {
    let messages = vec![
        serde_json::json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "ollama_call_0",
                "type": "function",
                "function": {"name": "find_capability", "arguments": "{}"}
            }]
        }),
        serde_json::json!({
            "role": "tool",
            "tool_call_id": "ollama_call_0",
            "content": "browse is now callable"
        }),
        serde_json::json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "ollama_call_0",
                "type": "function",
                "function": {"name": "browse", "arguments": "{}"}
            }]
        }),
        serde_json::json!({
            "role": "tool",
            "tool_call_id": "ollama_call_0",
            "content": "{\"found\":true,\"status\":\"partial\",\"answer\":\"Example Domain\"}"
        }),
    ];

    let evidence = super::render_compaction_tool_evidence(&messages);

    assert!(evidence.contains("tool find_capability:\nbrowse is now callable"));
    assert!(evidence.contains("tool browse:\n{\"found\":true"));
    assert!(evidence.contains("\"status\":\"partial\""));
    assert!(evidence.contains("Example Domain"));
}

#[test]
fn danger_mode_resolves_to_danger_full_access_but_the_os_fence_is_separate() {
    // The APP-LEVEL resolver yields DangerFullAccess under `danger`. This asserts the
    // app-level verdict ONLY — the OS kernel fence around subprocesses is resolved
    // elsewhere and is UNCONDITIONAL (tests/linux_sandbox.rs). Nothing here disables
    // it; there is no code path a mode can take to unsandbox a subprocess.
    use crate::tool_safety::{SandboxMode, SandboxPolicy};
    let root = std::path::PathBuf::from("/proj");
    assert_eq!(
        SandboxMode::Danger.resolve(Some(&root)),
        SandboxPolicy::DangerFullAccess
    );
    assert_eq!(
        SandboxMode::parse("danger-full-access").resolve(None),
        SandboxPolicy::DangerFullAccess
    );
}

#[test]
fn read_only_mode_refuses_write_project_file_without_writing() {
    let _env = TestEnv::acquire();
    let dir = isolated_gateway_test_dir("read-only-refuses-write");
    let project = dir.join("proj");
    std::fs::create_dir_all(&project).expect("create project dir");
    let _data = TestGatewayDataDir::new(&dir);
    // Register the temp project as the active workspace's folder so, absent the
    // sandbox gate, the write WOULD land under `project` (proving the block is the
    // MODE, not a missing project).
    std::fs::write(
            dir.join("workspaces.json"),
            format!(
                r#"{{"active":"local-workspace","workspaces":[{{"id":"local-workspace","name":"t","folder":{}}}]}}"#,
                serde_json::to_string(&project.to_string_lossy().to_string()).unwrap()
            ),
        )
        .expect("write workspaces file");
    super::set_active_workspace("local-workspace");

    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let state = test_app_state_for_brief(facade);
    let probe = project.join("probe.txt");

    // read-only → refuse with the structured marker, and NO bytes written.
    // SAFETY: env-mutation under TEST_ENV_LOCK.
    _data.env().set("HOMUN_SANDBOX_MODE", Some("read-only"));
    let blocked = super::write_project_file(&state, None, "probe.txt", "data");
    assert!(
        blocked.starts_with(super::READ_ONLY_BLOCKED_MARKER),
        "expected read-only marker, got: {blocked}"
    );
    assert!(!probe.exists(), "read-only must not write any bytes");

    // workspace-write (same inputs) → the write succeeds, proving the block above was
    // the sandbox mode and not the test setup.
    _data
        .env()
        .set("HOMUN_SANDBOX_MODE", Some("workspace-write"));
    let ok = super::write_project_file(&state, None, "probe.txt", "data");
    assert!(
        ok.starts_with("✅ Wrote "),
        "workspace-write should write: {ok}"
    );
    assert_eq!(std::fs::read_to_string(&probe).unwrap(), "data");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn build_browse_goal_parses_goal_and_folds_hints() {
    // ADR 0025: the manager's browse args → the sub-turn goal string. Bare goal passes through;
    // hints (url/container) fold into the text since the browser sub-prompt has no separate hint slot.
    assert_eq!(build_browse_goal(r#"{"goal":"BTC price"}"#), "BTC price");
    let hinted = build_browse_goal(
        r#"{"goal":"Serie A standings","hints":{"url":"https://x.com","container":"wikipedia"}}"#,
    );
    assert!(hinted.contains("Serie A standings"));
    assert!(hinted.contains("Starting page: https://x.com"));
    assert!(hinted.contains("already opened"));
    assert!(hinted.contains("Do not search"));
    assert!(hinted.contains("Preferred source/container: wikipedia"));
    // Missing/blank goal → empty (the caller refuses the call); malformed JSON is safe.
    assert_eq!(build_browse_goal(r#"{"hints":{"url":"https://x"}}"#), "");
    assert_eq!(build_browse_goal(r#"{"goal":"   "}"#), "");
    assert_eq!(build_browse_goal("not json"), "");
}

#[test]
fn build_browse_goal_marks_direct_url_as_already_opened() {
    let goal = build_browse_goal(
        r#"{"goal":"Apri https://www.selenium.dev/selenium/web/web-form.html e compila Text input con smoke."}"#,
    );

    assert!(goal.contains("https://www.selenium.dev/selenium/web/web-form.html"));
    assert!(
        goal.contains("already opened"),
        "direct URL browse goals must tell the subagent that pre-navigation already happened: {goal}"
    );
    assert!(
        goal.to_ascii_lowercase().contains("do not search"),
        "direct URL browse goals must keep the subagent on the opened page: {goal}"
    );
    assert!(
        goal.contains("browser_act"),
        "form-fill goals must steer the subagent toward acting on the opened page: {goal}"
    );
}

#[test]
fn build_browse_user_goal_includes_initial_pre_navigation_observation() {
    let request = super::parse_browse_request(
        r#"{"goal":"Apri https://www.selenium.dev/selenium/web/web-form.html e compila Text input con smoke."}"#,
    );
    let goal = super::build_browse_user_goal(
        &request,
        None,
        Some(
            "Page opened (https://www.selenium.dev/selenium/web/web-form.html). Snapshot:\n- textbox \"Text input\" [ref=e7]",
        ),
    );

    assert!(goal.contains("Initial browser observation"));
    assert!(goal.contains("Use these [ref=...] values for browser_act"));
    assert!(goal.contains("textbox \"Text input\" [ref=e7]"));
}

#[test]
fn build_browse_user_goal_includes_contract_item_shape_hint() {
    let request = super::parse_browse_request(
        r#"{"goal":"Cerca 3 notizie tech","result_contract":{"kind":"list","minimum_items":3,"fields":[{"name":"title","required":true},{"name":"source","required":true},{"name":"summary","required":true}]}}"#,
    );
    let goal = super::build_browse_user_goal(&request, None, None);

    assert!(goal.contains("browser_done item shape"));
    assert!(goal.contains("Required item keys: title, source, summary"));
    assert!(goal.contains("Put the data in `items`"));
    assert!(goal.contains("at least 3 item(s)"));
    assert!(goal.contains("use those listing rows directly"));
    assert!(goal.contains("\"title\":\"<title>\""));
    assert!(goal.contains("\"source\":\"<source>\""));
    assert!(goal.contains("\"summary\":\"<summary>\""));
}

#[test]
fn browse_subagent_prompt_extracts_list_contracts_from_discovery_pages() {
    let prompt = super::browse_subagent_system_prompt(false);

    assert!(prompt.contains("LIST / DISCOVERY PAGES"));
    assert!(prompt.contains("extract those rows directly"));
    assert!(prompt.contains("Do NOT open every individual article/result"));
}

#[test]
fn browse_schema_accepts_result_contract_and_hints() {
    let schema = super::browse_tool_schema();
    let params = schema.pointer("/function/parameters/properties").unwrap();
    assert!(params.get("goal").is_some());
    assert!(params.get("hints").is_some());
    assert!(params.get("result_contract").is_some());
    assert!(
        params["result_contract"]["properties"]["kind"]["description"]
            .as_str()
            .is_some_and(|description| description.contains("Several fields"))
    );
    assert!(
            params["result_contract"]["properties"]["minimum_items"]["description"]
                .as_str()
                .is_some_and(
                    |description| description.contains("never the number of requested fields")
                )
        );
}

// A completed `browse` used to leave the manager with no rule for "and now book the first
// one", so it reached for Python/shell — which cannot carry the site's session. Both
// manager-facing surfaces (the always-present guidance block and the `browse` description
// read at call time) must state that the continuation of a web task is another `browse`.
#[test]
fn manager_browser_guidance_continues_web_work_with_browse_not_with_scripts() {
    let guidance = super::manager_browser_guidance();
    // The manager's browser surface is the delegated `browse`, not the granular sub-agent tools.
    assert!(guidance.contains("`browse`"));
    for granular in [
        "browser_navigate",
        "browser_snapshot",
        "browser_act",
        "browser_screenshot",
    ] {
        assert!(
            !guidance.contains(granular),
            "manager guidance must not teach the granular tool {granular} it cannot call"
        );
    }
    // The continuation rule, and the interpreters it must NOT fall back to.
    assert!(guidance.contains("CONTINUATION"));
    for forbidden in [
        "run_in_sandbox",
        "run_in_project",
        "shell",
        "Python",
        "curl",
        "HTTP request",
    ] {
        assert!(
            guidance.contains(forbidden),
            "the continuation rule must name {forbidden} as a non-continuation"
        );
    }
    // The warm per-thread session is why a follow-up is a goal on what is already open.
    assert!(guidance.contains("warm browser session"));
    assert!(guidance.contains("already open"));
    // The payment gate stays fail-closed: card first, no work-arounds.
    assert!(guidance.contains("PAYMENT_APPROVAL"));
    assert!(guidance.contains("payment_approval_id"));
    assert!(guidance.contains("work around"));
}

#[test]
fn browse_description_tells_the_manager_to_continue_web_tasks_with_browse() {
    let description = super::browse_tool_schema()
        .pointer("/function/description")
        .and_then(serde_json::Value::as_str)
        .expect("browse description")
        .to_string();
    assert!(description.contains("warm browser session"));
    assert!(description.contains("ANOTHER browse call"));
    for forbidden in [
        "shell",
        "Python",
        "run_in_project",
        "run_in_sandbox",
        "curl",
        "HTTP request",
    ] {
        assert!(
            description.contains(forbidden),
            "the browse description must rule out continuing a web task with {forbidden}"
        );
    }
}

#[test]
fn browser_act_schema_accepts_flat_action_bundles() {
    let schema = super::browser_act_tool_schema();
    let props = schema.pointer("/function/parameters/properties").unwrap();
    assert!(props.get("actions").is_some());
    assert!(schema.to_string().contains("at most four"));
}

#[test]
fn browser_act_bundle_items_have_a_real_schema() {
    let schema = super::browser_act_tool_schema();
    let items = &schema["function"]["parameters"]["properties"]["actions"]["items"];
    let kinds = items["properties"]["kind"]["enum"]
        .as_array()
        .expect("kind enum");
    assert!(kinds.iter().any(|k| k == "click"));
    assert!(
        items["required"]
            .as_array()
            .expect("required")
            .iter()
            .any(|r| r == "kind")
    );
}

#[test]
fn browser_done_schema_is_structured_terminal() {
    let schema = super::browser_done_tool_schema(None);
    assert_eq!(
        schema
            .pointer("/function/name")
            .and_then(serde_json::Value::as_str),
        Some("browser_done")
    );
    assert!(schema.to_string().contains("completed"));
    assert!(schema.to_string().contains("fields_missing"));
    let required = schema
        .pointer("/function/parameters/required")
        .and_then(serde_json::Value::as_array)
        .expect("top-level browser_done fields are required");
    for field in [
        "status",
        "answer",
        "items",
        "fields_missing",
        "sources",
        "evidence",
    ] {
        assert!(required.iter().any(|required| required == field));
    }
    assert!(
        schema
            .pointer("/function/description")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|description| description.contains("one object for a fact"))
    );
}

#[test]
fn browser_done_schema_carries_required_contract_fields_into_items() {
    let contract = local_first_engine::browse::BrowseResultContract {
        kind: local_first_engine::browse::BrowseResultKind::Fact,
        minimum_items: None,
        fields: vec![
            local_first_engine::browse::BrowseResultField {
                name: "document_title".into(),
                required: true,
            },
            local_first_engine::browse::BrowseResultField {
                name: "optional_note".into(),
                required: false,
            },
        ],
        boundary: None,
    };

    let schema = super::browser_done_tool_schema(Some(&contract));
    let item_schema = schema
        .pointer("/function/parameters/properties/items/items")
        .expect("items schema");
    assert!(item_schema["properties"].get("document_title").is_some());
    assert!(item_schema["properties"].get("optional_note").is_some());
    assert_eq!(
        item_schema["required"],
        serde_json::json!(["document_title"])
    );
}

#[test]
fn browser_done_parser_normalizes_equivalent_single_fact_shapes() {
    let payload = super::parse_browser_done_payload(
        r#"{
                "status":"Completed",
                "answer":"Example Domain",
                "items":{"document_title":"Example Domain"},
                "fields_missing":null,
                "sources":"https://example.com/",
                "evidence":"title: Example Domain"
            }"#,
    )
    .expect("equivalent browser terminal shape");

    assert_eq!(
        payload.status,
        local_first_engine::browse::BrowserDoneStatus::Completed
    );
    assert_eq!(payload.items.len(), 1);
    assert_eq!(payload.sources, vec!["https://example.com/"]);
    assert_eq!(payload.evidence, vec!["title: Example Domain"]);
    assert!(payload.fields_missing.is_empty());
}

#[test]
fn browser_done_parser_unwraps_provider_text_wrapped_items() {
    let payload = super::parse_browser_done_payload(
            r#"{
                "status":"completed",
                "answer":"Example Domain",
                "items":[{"$text":"{\"document_title\":\"Example Domain\",\"h1_text\":\"Example Domain\"}"}],
                "sources":["https://example.com/"]
            }"#,
        )
        .expect("provider-wrapped fact item");

    assert_eq!(payload.items[0]["document_title"], "Example Domain");
    assert_eq!(payload.items[0]["h1_text"], "Example Domain");
}

#[test]
fn browser_done_parser_unwraps_provider_stringified_items_array() {
    let payload = super::parse_browser_done_payload(
            r#"{
                "status":"completed",
                "answer":"Stripe payment controls were detected",
                "items":"[{\"type\":\"payment_demo_present\",\"description\":\"Demo pubblico di checkout Stripe Elements rilevato\"},{\"type\":\"payment_control_detected\",\"description\":\"Rilevato pulsante di pagamento\"}]",
                "sources":["https://stripe.com/payments/elements"]
            }"#,
        )
        .expect("provider stringified item array");

    assert_eq!(payload.items.len(), 2);
    assert_eq!(payload.items[0]["type"], "payment_demo_present");
    assert_eq!(payload.items[1]["type"], "payment_control_detected");
}

#[test]
fn browser_done_parser_repairs_provider_stringified_items_with_unquoted_keys() {
    let payload = super::parse_browser_done_payload(
            r#"{
                "status":"completed",
                "answer":"Stripe payment controls were detected",
                "items":"[{\"heading\":\"Demo 1 - Payment Element\", fields\":[\"Card number\",\"Security code\"], amount\":\"$175.00\", button\":\"Pay $175.00\", type\":\"static visual preview\"}]",
                "sources":["https://stripe.com/payments/elements"]
            }"#,
        )
        .expect("provider stringified item array with malformed keys");

    assert_eq!(payload.items.len(), 1);
    assert_eq!(payload.items[0]["heading"], "Demo 1 - Payment Element");
    assert_eq!(payload.items[0]["fields"][0], "Card number");
    assert_eq!(payload.items[0]["amount"], "$175.00");
    assert_eq!(payload.items[0]["button"], "Pay $175.00");
}

#[test]
fn browser_done_parser_unwraps_provider_text_wrapped_string_fields() {
    let payload = super::parse_browser_done_payload(
        r#"{
                "status":{"$text":"completed","type":"string"},
                "answer":{"$text":"Example Domain"},
                "items":[{"document_title":"Example Domain"}],
                "fields_missing":{"$text":"optional_price"},
                "sources":{"$text":"https://example.com/"},
                "evidence":[{"$text":"title: Example Domain","type":"string"}]
            }"#,
    )
    .expect("provider-wrapped string fields");

    assert_eq!(
        payload.status,
        local_first_engine::browse::BrowserDoneStatus::Completed
    );
    assert_eq!(payload.answer, "Example Domain");
    assert_eq!(payload.fields_missing, vec!["optional_price"]);
    assert_eq!(payload.sources, vec!["https://example.com/"]);
    assert_eq!(payload.evidence, vec!["title: Example Domain"]);
}

#[test]
fn browser_done_parser_preserves_evidence_without_status_as_partial() {
    let payload = super::parse_browser_done_payload(
        r#"{
                "answer":"Example Domain",
                "items":[{"document_title":"Example Domain"}],
                "sources":["https://example.com/"],
                "evidence":["title: Example Domain"]
            }"#,
    )
    .expect("missing status with evidence should be preserved");

    assert_eq!(
        payload.status,
        local_first_engine::browse::BrowserDoneStatus::Partial
    );
    assert_eq!(payload.answer, "Example Domain");
    assert_eq!(payload.items[0]["document_title"], "Example Domain");
    assert_eq!(payload.sources, vec!["https://example.com/"]);
    assert_eq!(payload.evidence, vec!["title: Example Domain"]);
}

#[test]
fn invalid_browser_done_payload_fails_closed() {
    assert!(super::parse_browser_done_payload("not json").is_err());
}

#[test]
fn browser_event_summary_redacts_page_text_and_keeps_metrics() {
    let event = super::browser_protocol_event_summary(
        "child_123",
        "action_bundle",
        serde_json::json!({
            "observation_chars": 6120,
            "refs": 42,
            "action_kinds": ["type", "click"],
            "stop_reason": "completed",
            "raw_page_text": "Departure 09:05 secret@example.com"
        }),
    );

    assert!(event.contains("child_123"));
    assert!(event.contains("observation_chars=6120"));
    assert!(event.contains("action_kinds=type,click"));
    assert!(!event.contains("secret@example.com"));
    assert!(!event.contains("Departure 09:05"));
}

#[test]
fn browser_protocol_journal_event_keeps_metrics_and_drops_page_text() {
    let metrics = serde_json::json!({
        "observation_chars": 5000, "refs": 12, "action_kinds": ["click","type"],
        "stop_reason": "completed", "generation": 8,
        "recovery_tier": "adopted_live_page", "draft_control_count": 2,
        "reason": "exact_target_adopted", "page_text": "SECRET STATION NAMES",
        "url": "https://private.example/path", "value": "Fabio Private"
    });
    let event = super::browser_protocol_journal_event("run_1", "action_bundle", &metrics);
    let (_kind, _round, value) = event.into_parts();
    assert_eq!(value["boundary"], "action_bundle");
    assert_eq!(value["stop_reason"], "completed");
    assert_eq!(value["generation"], 8);
    assert_eq!(value["recovery_tier"], "adopted_live_page");
    assert_eq!(value["draft_control_count"], 2);
    assert!(
        value.get("page_text").is_none(),
        "raw page text must not be journaled"
    );
    assert!(value.get("url").is_none());
    assert!(value.get("value").is_none());
}

#[test]
fn parse_browse_request_keeps_model_contract_without_keyword_inference() {
    let parsed = super::parse_browse_request(
        r#"{
            "goal":"Search the requested journey",
            "hints":{"url":"https://www.trenitalia.com/it.html"},
            "result_contract":{
                "kind":"list",
                "minimum_items":3,
                "fields":[
                    {"name":"departure","required":true},
                    {"name":"arrival","required":true},
                    {"name":"duration","required":true},
                    {"name":"price","required":false}
                ],
                "boundary":"Stop before booking or payment"
            }
        }"#,
    );

    assert_eq!(parsed.goal, "Search the requested journey");
    assert_eq!(
        parsed.hint_url.as_deref(),
        Some("https://www.trenitalia.com/it.html")
    );
    let contract = parsed.contract.unwrap();
    assert_eq!(contract.minimum_items, Some(3));
    assert_eq!(contract.fields[0].name, "departure");
}

#[test]
fn parse_browse_request_infers_checkout_approval_contract() {
    let parsed = super::parse_browse_request(
        r#"{
            "goal":"Apri https://checkout.stripe.dev/elements, leggi il checkout e chiedimi una Payment Approval Card senza premere Pay",
            "hints":{"url":"https://checkout.stripe.dev/elements"}
        }"#,
    );

    let contract = parsed
        .contract
        .as_ref()
        .expect("checkout approval goals need a browser result contract");
    assert_eq!(
        contract.kind,
        local_first_engine::browse::BrowseResultKind::Fact
    );
    assert_eq!(contract.minimum_items, Some(1));
    assert_eq!(
        contract.boundary.as_deref(),
        Some("Stop before submitting, paying, placing the order, or using a payment control.")
    );
    let required = contract
        .fields
        .iter()
        .filter(|field| field.required)
        .map(|field| field.name.as_str())
        .collect::<Vec<_>>();
    assert!(required.contains(&"merchant"));
    assert!(required.contains(&"domain"));
    assert!(required.contains(&"amount"));
    assert!(required.contains(&"currency"));
    assert!(required.contains(&"product_summary"));
    assert!(!required.contains(&"amount_minor"));
    assert!(!required.contains(&"payment_control_visible"));
    assert!(!required.contains(&"payment_not_submitted"));

    let goal = super::build_browse_user_goal(&parsed, None, None);
    assert!(goal.contains("Use status=`completed`"));
    assert!(goal.contains("Stripe Elements Demo"));
}

#[test]
fn parse_browse_request_enriches_partial_checkout_approval_contract() {
    let parsed = super::parse_browse_request(
        r#"{
            "goal":"Apri https://checkout.stripe.dev/elements e leggi SOLO i dati visibili del demo pubblico di checkout/pagamento: merchant, dominio, riepilogo prodotto e importo totale. NON compilare campi carta/CVV e NON premere Pay/Submit.",
            "result_contract":{
                "kind":"fact",
                "fields":[
                    {"name":"merchant","required":true},
                    {"name":"domain","required":true},
                    {"name":"product_summary","required":true},
                    {"name":"amount","required":true},
                    {"name":"currency","required":true}
                ]
            }
        }"#,
    );

    let contract = parsed
        .contract
        .expect("explicit checkout contracts must be enriched");
    assert_eq!(
        contract.kind,
        local_first_engine::browse::BrowseResultKind::Fact
    );
    assert_eq!(contract.minimum_items, Some(1));
    let required = contract
        .fields
        .iter()
        .filter(|field| field.required)
        .map(|field| field.name.as_str())
        .collect::<Vec<_>>();
    assert!(required.contains(&"merchant"));
    assert!(required.contains(&"amount"));
    assert!(required.contains(&"currency"));
    assert!(!required.contains(&"amount_minor"));
    assert!(!required.contains(&"payment_not_submitted"));
}

#[test]
fn browse_goal_dedup_is_scoped_to_the_normalized_goal() {
    let messages = vec![
        serde_json::json!({
            "role":"assistant",
            "tool_calls":[{
                "id":"ollama_call_0",
                "function":{
                    "name":"browse",
                    "arguments":"{\"goal\":\"Open https://example.com\"}"
                }
            }]
        }),
        serde_json::json!({"role":"tool","tool_call_id":"ollama_call_0","content":"done"}),
        serde_json::json!({
            "role":"assistant",
            "tool_calls":[{
                "id":"ollama_call_0",
                "function":{
                    "name":"browse",
                    "arguments":"{\"goal\":\"Open example.org\"}"
                }
            }]
        }),
    ];

    assert!(super::browse_goal_was_already_requested(
        &messages,
        "current_call",
        " open   https://example.com "
    ));
    assert!(!super::browse_goal_was_already_requested(
        &messages,
        "current_call",
        "Open example.net"
    ));
    assert!(super::browse_goal_was_already_requested(
        &messages,
        "current_call",
        "Read the title from https://example.com/ and return it"
    ));
}

#[test]
fn browse_turn_cap_allows_multiple_distinct_sources_but_stays_bounded() {
    assert!(super::browse_call_within_turn_cap(0));
    assert!(super::browse_call_within_turn_cap(1));
    assert!(!super::browse_call_within_turn_cap(2));
}

#[test]
fn browse_round_budget_scales_with_contract_shape() {
    use local_first_engine::browse::{BrowseResultContract, BrowseResultField, BrowseResultKind};
    let simple = BrowseResultContract {
        kind: BrowseResultKind::Fact,
        minimum_items: None,
        fields: vec![],
        boundary: None,
    };
    assert_eq!(super::browse_round_budget(&simple), 12);

    let list = BrowseResultContract {
        kind: BrowseResultKind::List,
        minimum_items: Some(5),
        fields: vec![
            BrowseResultField {
                name: "departure".into(),
                required: true,
            },
            BrowseResultField {
                name: "arrival".into(),
                required: true,
            },
            BrowseResultField {
                name: "duration".into(),
                required: true,
            },
            BrowseResultField {
                name: "price".into(),
                required: false,
            },
        ],
        boundary: None,
    };
    // BASE 12 + ceil(3 required / 2)=2 + (minimum_items>3 ? 1 : 0)=1 = 15
    assert_eq!(super::browse_round_budget(&list), 15);
}

#[test]
fn read_only_tool_names_are_not_mistaken_for_effectful_ones() {
    // The token list was matched as a SUBSTRING, so listings whose names merely embed a verb were
    // treated as mutations — and since a missing objective contract defaults to read-only analysis,
    // they were refused with a message that named no way to proceed.
    let no_composio = std::collections::BTreeSet::new();
    for name in [
        "SLACK_LIST_ALL_SAVED_ITEMS",
        "list_bookings",
        "LIST_REPOSITORY_UPDATES",
        "read_file",
        "search_memory",
    ] {
        assert!(
            !super::effectful_tool_name(name, &no_composio),
            "read-only tool must not be classified effectful: {name}"
        );
    }
    // Genuinely effectful names still match.
    for name in [
        "write_file",
        "edit_file",
        "create_automation",
        "send_message",
        "make_document",
        "record_decision",
        "cancel_scheduled_task",
    ] {
        assert!(
            super::effectful_tool_name(name, &no_composio),
            "effectful tool must still be classified effectful: {name}"
        );
    }
    // The authoritative connector set always wins, whatever the name looks like.
    let mut composio = std::collections::BTreeSet::new();
    composio.insert("SOME_CONNECTOR_ACTION".to_string());
    assert!(super::effectful_tool_name(
        "SOME_CONNECTOR_ACTION",
        &composio
    ));
}

#[test]
fn browse_hard_ceiling_stays_above_the_progress_relative_round_budget() {
    // Regression: both were set to the same `rounds`, so the raw `for round in 0..ceiling` bound
    // fired first and the progress-relative budget could never do its job — a browse that
    // succeeded on every action was still cut off at exactly `rounds` (observed: 8 rounds, ~47s,
    // every action completed, reported to the user as a timeout).
    for rounds in [5usize, 8, 10] {
        let ceiling = super::browse_hard_round_ceiling(rounds);
        assert!(
            ceiling > rounds,
            "hard ceiling ({ceiling}) must leave room above the round budget ({rounds})"
        );
        assert!(
            ceiling >= 24,
            "the backstop must stay generous, got {ceiling}"
        );
    }
}

#[test]
fn browse_hard_ceiling_does_not_triple_rich_browser_contracts() {
    for rounds in [16usize, 24] {
        let ceiling = super::browse_hard_round_ceiling(rounds);
        assert!(
            ceiling <= rounds + 8,
            "hard ceiling ({ceiling}) must be a tight backstop above the progress-relative budget ({rounds}), not a second long-running budget"
        );
    }
}

#[test]
fn browse_subturn_wall_clock_backstop_allows_slow_grounded_results_but_stays_bounded() {
    const {
        assert!(
            super::BROWSE_SUBTURN_MAX_ELAPSED_MS >= 240_000,
            "one delegated browse must leave enough wall clock for slow grounded result pages"
        );
        assert!(
            super::BROWSE_SUBTURN_MAX_ELAPSED_MS <= 300_000,
            "one delegated browse must still have a bounded interactive backstop"
        );
    }
}

#[tokio::test]
async fn delegated_browse_subturn_timeout_returns_control_to_manager() {
    let started = std::time::Instant::now();
    let outcome = super::await_browse_subturn_with_timeout(
        async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            "late"
        },
        10,
    )
    .await;

    assert!(outcome.is_err());
    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "timeout wrapper must bound a non-cooperative browse future"
    );
}

#[test]
fn delegated_browse_subturn_timeout_is_manager_no_progress() {
    let result = super::browse_subturn_timeout_result(
        "results page snapshot",
        vec!["https://example.test/search".to_string()],
        None,
    );
    assert_eq!(
        result.status,
        local_first_engine::browse::BrowserDoneStatus::Timeout
    );
    assert!(!result.found);

    let outcome = delegated_browse_tool_outcome(&result, None);

    assert!(outcome.effects.browser_activity_observed);
    assert_eq!(
        outcome.effects.outcome_hint,
        Some(local_first_engine::ToolOutcomeHint::NoProgress)
    );
}

#[test]
fn manager_wall_clock_stays_above_the_browse_subturn_it_delegates() {
    // Same shape of regression as `browse_hard_ceiling_...` above, one level up and on the
    // wall-clock axis: the manager turn and the `browse` sub-turn it delegates were BOTH capped
    // at 300s absolute. The manager doesn't browse, it delegates — and one browse can legitimately
    // spend the whole sub-turn budget (observed: a single browse round of 259s) — so any task
    // needing more than one browse was guaranteed to die. A real train booking did 4 successful
    // browses and was cut at 302s, then forced into an empty synthesis.
    //
    // The manager must be able to run SEVERAL full sub-turns end to end; what stops a stuck
    // manager is the stall window, which is progress-relative and deliberately left untouched.
    let subturn = super::BROWSE_SUBTURN_MAX_ELAPSED_MS;
    let manager = super::chat_manager_browser_budget();
    assert!(
        manager.max_elapsed_ms >= subturn.saturating_mul(4),
        "the manager wall clock ({}) must leave room for several full browse sub-turns ({subturn} each)",
        manager.max_elapsed_ms
    );
    // The floor holds even if the shared budget is configured SHORTER than a sub-turn: the manager
    // can never be given less rope than the thing it drives.
    for configured in [1_000u64, 60_000, subturn, 600_000] {
        assert!(
            super::manager_browser_max_elapsed_ms(configured) > subturn,
            "manager budget must outlive one sub-turn even when configured to {configured}ms"
        );
    }
    // The stall window (the PRIMARY, progress-relative control) must NOT have been widened —
    // widening the absolute backstop is only safe because a stuck manager still dies quickly.
    assert_eq!(
        manager.max_stall_ms,
        super::chat_browser_budget().max_stall_ms,
        "the progress-relative stall window must stay exactly as tight as before"
    );
}

#[test]
fn browse_round_budget_never_exceeds_cap() {
    use local_first_engine::browse::{BrowseResultContract, BrowseResultField, BrowseResultKind};
    let huge = BrowseResultContract {
        kind: BrowseResultKind::List,
        minimum_items: Some(10),
        fields: (0..12)
            .map(|i| BrowseResultField {
                name: format!("f{i}"),
                required: true,
            })
            .collect(),
        boundary: None,
    };
    assert_eq!(super::browse_round_budget(&huge), 19);
}

#[test]
fn built_in_browse_is_loaded_without_find_capability() {
    let turn_policy = super::ChatTurnPolicy {
        mode: "agent".to_string(),
        read_only: false,
        autonomous: false,
    };
    let contact_memory_perimeter = super::ContactMemoryPerimeter {
        contact_only: false,
        can_see_contacts: true,
        can_see_calendar: true,
        can_use_project_memory: true,
    };
    let base_tools =
        super::initial_manager_tool_schemas_for_test(&turn_policy, &contact_memory_perimeter);
    let names = base_tools
        .iter()
        .filter_map(|schema| {
            schema
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str)
        })
        .collect::<Vec<_>>();

    assert!(names.contains(&"browse"));
    assert!(names.iter().position(|name| *name == "browse").is_some());
}

/// The turn's live-vs-deferred partition, both directions. Regression: `browse` is not in
/// CORE_TOOL_NAMES, so the follow-up turn after a successful browse ("book the first one")
/// reached a manager that did not have `browse` at all — but did have run_in_project/read_file
/// — and continued the web task with Python/shell, which cannot carry the site's session.
#[test]
fn a_live_browser_session_keeps_browse_in_the_live_tool_set() {
    let offered = ["browse", "run_in_project", "run_in_sandbox"];
    let live: Vec<&str> = offered
        .into_iter()
        .filter(|name| super::tool_stays_live_this_turn(name, true))
        .collect();
    // `browse` joins the core for this turn; nothing else changes.
    assert_eq!(live, vec!["browse", "run_in_project"]);
}

#[test]
fn without_a_live_browser_session_browse_stays_deferred() {
    assert!(!super::tool_stays_live_this_turn("browse", false));
    // The signal only ever adds `browse`: the core set is identical either way.
    assert!(super::tool_stays_live_this_turn("run_in_project", false));
    assert!(super::tool_stays_live_this_turn("run_in_project", true));
    assert!(!super::tool_stays_live_this_turn("run_in_sandbox", false));
    assert!(!super::tool_stays_live_this_turn("run_in_sandbox", true));
}

/// The machine signal itself: present + within the idle window, probed WITHOUT consuming the
/// session (a probe is not a use, so it must neither remove it nor extend its idle window).
#[test]
fn thread_browser_session_liveness_is_read_only_and_respects_the_idle_window() {
    let state = super::AppState::for_tests();
    // No session at all → `browse` is deferred exactly as before.
    assert!(!super::thread_has_live_browser_session(&state, "thread-1"));

    // A stub sidecar: the probe only reads `last_used`, it never talks to the process.
    let session = super::ThreadBrowserSession {
        client: super::BrowserAutomationClient::new(
            super::BrowserSidecarSession::spawn("cat", &[]).expect("spawn stub sidecar"),
        ),
        last_used: std::time::Instant::now(),
    };
    state
        .browser_thread_sessions
        .lock()
        .expect("session map")
        .insert("thread-1".to_string(), session);
    assert!(super::thread_has_live_browser_session(&state, "thread-1"));
    // Probing twice must still see it: the session was not taken.
    assert!(super::thread_has_live_browser_session(&state, "thread-1"));
    assert_eq!(
        state
            .browser_thread_sessions
            .lock()
            .expect("session map")
            .len(),
        1
    );
    // Another thread's session is not this thread's.
    assert!(!super::thread_has_live_browser_session(&state, "thread-2"));

    // Past the idle window the session is stale — never resurrect its tool.
    let stale = std::time::Instant::now()
        .checked_sub(super::THREAD_BROWSER_SESSION_IDLE + std::time::Duration::from_secs(1))
        .expect("monotonic clock deep enough to age a session");
    state
        .browser_thread_sessions
        .lock()
        .expect("session map")
        .get_mut("thread-1")
        .expect("stored session")
        .last_used = stale;
    assert!(!super::thread_has_live_browser_session(&state, "thread-1"));
    assert!(!super::tool_stays_live_this_turn(
        "browse",
        super::thread_has_live_browser_session(&state, "thread-1")
    ));
}

#[test]
fn active_checkpoint_keeps_browser_continuation_live_without_a_warm_sidecar() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("checkpoint-workspace")
        .unwrap();
    let user_id = super::gateway_user_id();
    let store = state.task_store.lock().unwrap();
    let objective = store
        .upsert_objective_contract(
            user_id.as_str(),
            "checkpoint-workspace",
            &thread.thread_id,
            "message-1",
            "Continue the browser task",
            local_first_task_runtime::ObjectiveMode::Mixed,
            &serde_json::json!({}),
            &serde_json::json!(["read", "external_write"]),
            &serde_json::json!({"kind":"browser_done"}),
            "active",
        )
        .unwrap();
    assert!(
        store
            .upsert_browser_checkpoint(&local_first_task_runtime::NewBrowserCheckpoint {
                checkpoint_id: "checkpoint-1".into(),
                user_id: user_id.as_str().into(),
                workspace_id: "checkpoint-workspace".into(),
                thread_id: thread.thread_id.clone(),
                target_id: "booking".into(),
                objective_revision: objective.revision,
                schema_version: 1,
                url: "https://example.test/form".into(),
                origin: "https://example.test".into(),
                browser_epoch: "epoch-1".into(),
                cdp_target_id: Some("target-1".into()),
                generation: 4,
                draft_secret_ref: None,
                draft_control_count: 0,
                omitted_sensitive_count: 0,
                omitted_bounded_count: 0,
                expires_at: 2_000_000_000,
            })
            .unwrap()
    );
    drop(store);

    assert!(!super::thread_has_live_browser_session(
        &state,
        &thread.thread_id
    ));
    assert!(super::thread_has_browser_continuation(
        &state,
        &thread.thread_id
    ));
    assert!(super::tool_stays_live_this_turn("browse", true));
}

#[test]
fn defers_a_second_browse_call_until_the_manager_sees_the_first_result() {
    let messages = vec![serde_json::json!({
        "role": "assistant",
        "tool_calls": [
            {"id":"browse_1","function":{"name":"browse","arguments":"{\\\"goal\\\":\\\"Trenitalia\\\"}"}},
            {"id":"browse_2","function":{"name":"browse","arguments":"{\\\"goal\\\":\\\"Italo\\\"}"}}
        ]
    })];

    assert!(!earlier_browse_call_in_current_round(&messages, "browse_1"));
    assert!(earlier_browse_call_in_current_round(&messages, "browse_2"));
}

#[test]
fn delegated_browse_outcome_marks_browser_activity_and_structured_progress() {
    let found = local_first_engine::BrowseResult {
        found: true,
        answer: "dato verificato".to_string(),
        sources: vec!["https://example.test/source".to_string()],
        confidence: local_first_engine::browse::Confidence::High,
        note: None,
        status: local_first_engine::browse::BrowserDoneStatus::Completed,
        items: Vec::new(),
        fields_missing: Vec::new(),
        evidence: Vec::new(),
    };
    let found_outcome = delegated_browse_tool_outcome(&found, None);
    assert!(found_outcome.effects.browser_activity_observed);
    assert_eq!(
        found_outcome.effects.outcome_hint,
        Some(local_first_engine::ToolOutcomeHint::Success)
    );

    let missing = local_first_engine::BrowseResult::not_found("source unavailable");
    let missing_outcome = delegated_browse_tool_outcome(&missing, None);
    assert!(missing_outcome.effects.browser_activity_observed);
    assert_eq!(
        missing_outcome.effects.outcome_hint,
        Some(local_first_engine::ToolOutcomeHint::NoProgress)
    );

    let blocked = local_first_engine::BrowseResult {
        found: false,
        answer: "The browser could not resolve the requested page, so no title is available."
            .to_string(),
        sources: vec!["https://nonexistent-homun-validation-zzzz.invalid/dead-page".to_string()],
        confidence: local_first_engine::browse::Confidence::Low,
        note: Some("blocked".to_string()),
        status: local_first_engine::browse::BrowserDoneStatus::Blocked,
        items: Vec::new(),
        fields_missing: Vec::new(),
        evidence: vec!["DNS resolution failed".to_string()],
    };
    let blocked_outcome = delegated_browse_tool_outcome(&blocked, None);
    assert!(blocked_outcome.effects.browser_activity_observed);
    assert_eq!(
        blocked_outcome.effects.outcome_hint,
        Some(local_first_engine::ToolOutcomeHint::Success),
        "terminal browser_done blocked is evidence the manager can report, not browse no-progress"
    );
}

#[test]
fn delegated_browse_outcome_treats_partial_contract_result_as_no_progress() {
    let partial = local_first_engine::BrowseResult {
        found: true,
        answer: "solo dati incompleti".to_string(),
        sources: vec!["https://example.test/source".to_string()],
        confidence: local_first_engine::browse::Confidence::Low,
        note: Some("minimum_items missing".to_string()),
        status: local_first_engine::browse::BrowserDoneStatus::Partial,
        items: Vec::new(),
        fields_missing: vec!["minimum_items".to_string()],
        evidence: Vec::new(),
    };

    let outcome = delegated_browse_tool_outcome(&partial, None);

    assert!(outcome.effects.browser_activity_observed);
    assert_eq!(
        outcome.effects.outcome_hint,
        Some(local_first_engine::ToolOutcomeHint::NoProgress),
        "partial browser_done did not satisfy the manager's browse contract"
    );
}

#[test]
fn delegated_browse_outcome_preserves_effect_suspension() {
    let receipt_ref = local_first_execution_protocol::EffectReceiptRef::from_store_id(
        "99999999999999999999999999999999",
    )
    .unwrap();
    let result = local_first_engine::BrowseResult::not_found("verification required");

    let outcome = delegated_browse_tool_outcome(&result, Some(receipt_ref.clone()));

    assert_eq!(outcome.effects.suspend_effect_receipt, Some(receipt_ref));
}

#[test]
fn browse_subagent_uses_a_tighter_navigation_cap_per_single_goal() {
    assert_eq!(super::bounded_browse_subagent_nav_cap(20), 8);
    assert_eq!(super::bounded_browse_subagent_nav_cap(5), 5);
}

#[test]
fn browse_subagent_list_contract_gets_extra_discovery_navigation_budget() {
    let contract = local_first_engine::browse::BrowseResultContract {
        kind: local_first_engine::browse::BrowseResultKind::List,
        minimum_items: Some(3),
        fields: vec![
            local_first_engine::browse::BrowseResultField {
                name: "title".into(),
                required: true,
            },
            local_first_engine::browse::BrowseResultField {
                name: "source".into(),
                required: true,
            },
            local_first_engine::browse::BrowseResultField {
                name: "summary".into(),
                required: true,
            },
        ],
        boundary: Some("read news results".into()),
    };

    assert_eq!(
        super::browse_subagent_nav_cap_for_contract(Some(&contract)),
        12
    );
    assert_eq!(super::browse_subagent_nav_cap_for_contract(None), 8);
}

/// Activity relay for the browse sub-turn (regression: island Activity panel stayed empty during
/// browsing). The sub browser executor must narrate ACT events on the REAL enclosing turn sink,
/// while the sub-turn's model output stays on the drain (ADR 0025 encapsulation).
#[tokio::test(flavor = "current_thread")]
async fn browse_subturn_relays_activity_to_the_turn_sink_and_keeps_model_output_drained() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let (mpsc_tx, mut mpsc_rx) = tokio::sync::mpsc::channel(16);
    let (broadcast_tx, _btx) = tokio::sync::broadcast::channel(16);
    let sink = super::StreamSink {
        mpsc: mpsc_tx,
        entry: std::sync::Arc::new(super::StreamEntry {
            lines: std::sync::Mutex::new(Vec::new()),
            tx: broadcast_tx,
            finished: std::sync::atomic::AtomicBool::new(false),
            last_event_at: std::sync::atomic::AtomicU64::new(super::now_epoch_secs()),
            thread_id: None,
            assistant_message_id: std::sync::Mutex::new(None),
            outcome: std::sync::Mutex::new(None),
            outcome_ready: tokio::sync::Notify::new(),
        }),
    };
    let browse = super::GatewayBrowseExecutor {
        state: &state,
        http: &state.http,
        tx: &sink,
        thread_id: None,
        prompt: "activity relay regression test",
        read_only: true,
        channel_owner: false,
        agent_run_id: None,
        execution_contract: None,
    };
    // The sub browser executor's narration port is the REAL turn sink (not the drain).
    let sub = browse.sub_browser_executor(
        super::agent_journal::GatewayJournal::Disabled,
        None,
        None,
        false,
        true,
    );
    assert!(std::ptr::eq(sub.tx, &sink));

    // An ACT narration delta crossing that port reaches the turn sink as an Activity event...
    super::emit_stream_event(
        sub.tx,
        super::GenerateStreamEvent::Delta {
            text: "‹‹ACT››🌐 Opening https://example.com‹‹/ACT››".to_string(),
        },
    )
    .await
    .expect("ACT narration reaches the turn sink");
    let lines = sink.entry.lines.lock().expect("sink lines").clone();
    assert!(
        lines
            .iter()
            .any(|line| line.contains("\"type\":\"activity\"")
                && line.contains("Opening https://example.com")),
        "expected an Activity event on the turn sink, got: {lines:?}"
    );
    // ...and the narration never closes the manager stream with a terminal event.
    assert!(!super::stream_entry_has_terminal_event(&sink.entry));
    // The live response tees the event too.
    let live = mpsc_rx
        .try_recv()
        .expect("live response receives the activity event");
    assert!(
        String::from_utf8_lossy(&live.expect("live event bytes")).contains("\"type\":\"activity\"")
    );

    // Model output stays encapsulated: a sub-turn delta emitted on a drain sink never reaches
    // the turn sink.
    let drain = super::drain_stream_sink();
    super::emit_stream_event(
        &drain,
        super::GenerateStreamEvent::Delta {
            text: "sub-agent model tokens must stay encapsulated".to_string(),
        },
    )
    .await
    .expect("drain swallows sub-turn model output");
    let lines_after = sink.entry.lines.lock().expect("sink lines").clone();
    assert_eq!(
        lines_after, lines,
        "drained sub-turn model output must not reach the turn sink"
    );
}

#[test]
fn navigate_failure_hint_escalates_to_search_pivot_on_repeat() {
    // First failure: a gentle suggestion to search.
    let first = super::browser_navigate_failure_hint("https://x.test/page", 1);
    assert!(first.to_lowercase().contains("search"));
    assert!(!first.contains("STOP"));
    // Repeat failure of the SAME url: a firm STOP + pivot to a search engine.
    let repeat = super::browser_navigate_failure_hint("https://x.test/page", 3);
    assert!(repeat.contains("STOP"));
    assert!(repeat.contains("google.com/search") || repeat.contains("duckduckgo"));
    assert!(repeat.contains("3 times"));
}

#[test]
fn strip_chat_markers_removes_app_only_markers_for_channels() {
    // Reasoning + plan markers are app-only; a channel (Telegram/WhatsApp) must get
    // clean text. The answer survives; the markers and their content are removed.
    let text = "‹‹REASONING››thinking hard‹‹/REASONING››\n‹‹PLAN››1/3‹‹/PLAN››\nThe answer.";
    assert_eq!(super::strip_chat_markers(text), "The answer.");
    // A reasoning-only message becomes empty (→ the channel mirror skips it).
    assert_eq!(
        super::strip_chat_markers("‹‹REASONING››only thinking‹‹/REASONING››"),
        ""
    );
    // Plain text is untouched.
    assert_eq!(super::strip_chat_markers("just text"), "just text");
}

#[test]
fn browser_tool_name_recovers_typos_and_leaves_others_untouched() {
    // Exact native names pass through.
    assert_eq!(
        super::resolve_browser_chat_tool_name("browser_navigate"),
        Some("browser_navigate")
    );
    // The observed hallucination recovers to the right native tool.
    assert_eq!(
        super::resolve_browser_chat_tool_name("browser_tavigate"),
        Some("browser_navigate")
    );
    assert_eq!(
        super::resolve_browser_chat_tool_name("browser_snapshot"),
        Some("browser_snapshot")
    );
    // Non-browser tool names are left untouched (NOT pulled into the browser namespace).
    assert_eq!(super::resolve_browser_chat_tool_name("web_search"), None);
    assert_eq!(
        super::resolve_browser_chat_tool_name("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"),
        None
    );
    // A `browser_`-prefixed name too far from any native tool does NOT mis-map.
    assert_eq!(
        super::resolve_browser_chat_tool_name("browser_make_me_a_sandwich"),
        None
    );
}

#[test]
fn cdp_wedge_matched_only_for_connect_over_cdp_timeout() {
    use local_first_browser_automation::{BrowserResponse, BrowserSidecarError};
    let err = |code: &str, message: &str| BrowserResponse::Error {
        id: "1".to_string(),
        ok: false,
        error: BrowserSidecarError {
            code: code.to_string(),
            message: message.to_string(),
            retryable: false,
            manual_action_required: false,
        },
    };
    // The wedge signature (Playwright English) → recover by recycling.
    assert!(super::browser_response_indicates_cdp_wedge(&err(
        "BROWSER_INTERNAL_ERROR",
        "browserType.connectOverCDP: Timeout 30000ms exceeded.",
    )));
    // An ordinary browser error (stale ref, action timeout) must NOT recycle the
    // whole container — only the connectOverCDP handshake wedge does.
    assert!(!super::browser_response_indicates_cdp_wedge(&err(
        "BROWSER_ACTION_TIMEOUT",
        "click timed out after 5000ms",
    )));
    assert!(!super::browser_response_indicates_cdp_wedge(&err(
        "BROWSER_STALE_REF",
        "stale ref e5; take a fresh snapshot",
    )));
    // Success is never a wedge.
    assert!(!super::browser_response_indicates_cdp_wedge(
        &BrowserResponse::Success {
            id: "2".to_string(),
            ok: true,
            result: serde_json::json!({}),
        }
    ));
}

#[test]
fn project_access_defaults_to_no_grants() {
    let temp = isolated_gateway_test_dir("project-access-empty");
    let _guard = TestGatewayDataDir::new(&temp);

    let access = super::load_project_access_file();
    assert!(access.grants.is_empty());
    assert!(super::list_project_access("workspace_alpha").is_empty());
}

#[test]
fn project_access_upsert_lists_and_removes_grants() {
    let temp = isolated_gateway_test_dir("project-access-upsert");
    let _guard = TestGatewayDataDir::new(&temp);

    super::upsert_project_access(super::ProjectAccessGrant {
        workspace_id: " workspace_alpha ".to_string(),
        contact_reference: " contact_123 ".to_string(),
        contact_name: " Elena ".to_string(),
        channel: " WhatsApp ".to_string(),
        can_trigger_automations: true,
        can_use_project_memory: true,
        can_receive_replies: true,
        can_receive_artifacts: false,
        capability_denies: vec![
            " browser ".to_string(),
            "browser".to_string(),
            String::new(),
        ],
        updated_at: 100,
    })
    .expect("upsert grant");

    let grants = super::list_project_access("workspace_alpha");
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].contact_reference, "contact_123");
    assert_eq!(grants[0].contact_name, "Elena");
    assert_eq!(grants[0].channel, "whatsapp");
    assert!(grants[0].can_trigger_automations);
    assert!(grants[0].can_use_project_memory);
    assert!(grants[0].can_receive_replies);
    assert!(!grants[0].can_receive_artifacts);
    assert_eq!(grants[0].capability_denies, vec!["browser"]);

    super::remove_project_access("workspace_alpha", "contact_123", "whatsapp")
        .expect("remove grant");
    assert!(super::list_project_access("workspace_alpha").is_empty());
}

#[test]
fn project_policy_denies_when_contact_not_authorized() {
    let temp = isolated_gateway_test_dir("project-policy-deny");
    let _guard = TestGatewayDataDir::new(&temp);

    let resolved = super::resolve_project_contact_policy(
        "workspace_alpha",
        "contact_missing",
        "whatsapp",
        &chat_store::StoredPerimeter::default(),
        false,
    );

    assert!(!resolved.authorized);
    assert!(!resolved.can_trigger_automations);
    assert!(!resolved.can_use_project_memory);
    assert!(resolved.denied_reason.contains("not authorized"));
}

#[test]
fn project_policy_allows_self_contact_without_project_grant() {
    let temp = isolated_gateway_test_dir("project-policy-self");
    let _guard = TestGatewayDataDir::new(&temp);

    let perimeter = chat_store::StoredPerimeter {
        memory_scope: "contact_only".to_string(),
        knowledge_folders: Vec::new(),
        tools_allowed: Vec::new(),
        tools_denied: vec!["browser".to_string(), "filesystem".to_string()],
        can_see_contacts: false,
        can_see_calendar: false,
    };

    let resolved = super::resolve_project_contact_policy(
        "workspace_alpha",
        "contact_self",
        "whatsapp",
        &perimeter,
        true,
    );

    assert!(resolved.authorized);
    assert!(resolved.can_trigger_automations);
    assert!(resolved.can_use_project_memory);
    assert!(resolved.can_receive_replies);
    assert!(resolved.can_receive_artifacts);
    assert!(resolved.tools_denied.is_empty());
    assert!(resolved.denied_reason.is_empty());
}

#[test]
fn project_policy_composes_grant_with_contact_perimeter_denies() {
    let temp = isolated_gateway_test_dir("project-policy-compose");
    let _guard = TestGatewayDataDir::new(&temp);

    super::upsert_project_access(super::ProjectAccessGrant {
        workspace_id: "workspace_alpha".to_string(),
        contact_reference: "contact_123".to_string(),
        contact_name: "Elena".to_string(),
        channel: "whatsapp".to_string(),
        can_trigger_automations: true,
        can_use_project_memory: true,
        can_receive_replies: true,
        can_receive_artifacts: true,
        capability_denies: vec!["browser".to_string()],
        updated_at: 100,
    })
    .expect("upsert grant");

    let perimeter = chat_store::StoredPerimeter {
        memory_scope: "contact_only".to_string(),
        knowledge_folders: Vec::new(),
        tools_allowed: Vec::new(),
        tools_denied: vec!["filesystem".to_string()],
        can_see_contacts: false,
        can_see_calendar: false,
    };

    let resolved = super::resolve_project_contact_policy(
        "workspace_alpha",
        "contact_123",
        "WhatsApp",
        &perimeter,
        false,
    );

    assert!(resolved.authorized);
    assert!(resolved.can_trigger_automations);
    assert!(resolved.can_use_project_memory);
    assert!(resolved.can_receive_replies);
    assert!(resolved.can_receive_artifacts);
    assert_eq!(resolved.tools_denied, vec!["browser", "filesystem"]);
}

fn bundled_python_with_pptx() -> Option<&'static str> {
    let python =
        "/Users/fabio/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
    if !std::path::Path::new(python).is_file() {
        eprintln!("skipping PPTX import test: bundled python unavailable");
        return None;
    }
    if std::process::Command::new(python)
        .args(["-c", "import pptx"])
        .status()
        .map(|status| !status.success())
        .unwrap_or(true)
    {
        eprintln!("skipping PPTX import test: python-pptx unavailable");
        return None;
    }
    Some(python)
}

#[test]
fn response_language_instruction_matches_latest_user_message_first() {
    let instruction = response_language_instruction("it");

    assert!(
        instruction.contains("same language as the user's latest message"),
        "{instruction}"
    );
    assert!(instruction.contains("Italiano"), "{instruction}");
    assert!(!instruction.contains("Reply in Italiano"), "{instruction}");
}

fn write_test_pptx(path: &std::path::Path, title: &str) -> bool {
    let Some(python) = bundled_python_with_pptx() else {
        return false;
    };
    let script = format!(
        r#"
from pptx import Presentation
from pathlib import Path
prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[0])
slide.shapes.title.text = {title:?}
slide.placeholders[1].text = "Template preview"
prs.save(Path({path:?}))
"#,
        title = title,
        path = path.to_string_lossy().to_string(),
    );
    let status = std::process::Command::new(python)
        .args(["-c", &script])
        .status()
        .expect("create pptx fixture");
    assert!(status.success(), "python-pptx fixture generation failed");
    true
}

#[test]
fn proactive_dedup_key_is_semantic_and_stable() {
    // kind + anchor → "{kind}:{slug}"; paraphrases of the SAME anchor collapse.
    assert_eq!(
        sanitize_dedup_key("Scadenza", "Contratto Acme"),
        "scadenza:contratto-acme"
    );
    assert_eq!(
        sanitize_dedup_key("scadenza", "il contratto  ACME!!!"),
        "scadenza:il-contratto-acme"
    );
    // Missing kind/anchor degrade gracefully, never empty.
    assert_eq!(sanitize_dedup_key("", "Idra"), "idra");
    assert_eq!(sanitize_dedup_key("progetto-fermo", ""), "progetto-fermo");
    assert_eq!(sanitize_dedup_key("", ""), "suggerimento");
}

#[test]
fn telegram_rebind_keeps_a_compatible_sidecar() {
    assert_eq!(
        super::telegram_bridge_action(super::RebindResult::Configured),
        super::TelegramBridgeAction::Keep,
    );
}

#[test]
fn telegram_rebind_replaces_legacy_or_failed_sidecars() {
    assert_eq!(
        super::telegram_bridge_action(super::RebindResult::Http(404)),
        super::TelegramBridgeAction::Replace,
    );
    assert_eq!(
        super::telegram_bridge_action(super::RebindResult::Http(401)),
        super::TelegramBridgeAction::Replace,
    );
    assert_eq!(
        super::telegram_bridge_action(super::RebindResult::Transport),
        super::TelegramBridgeAction::Replace,
    );
}

#[test]
fn telegram_rebind_waits_only_for_its_starting_child() {
    assert!(super::telegram_rebind_should_wait(true, false));
    assert!(!super::telegram_rebind_should_wait(false, false));
    assert!(!super::telegram_rebind_should_wait(true, true));
}

#[test]
fn telegram_retries_only_before_dispatch_for_text_and_buttons() {
    assert!(super::telegram_send_may_rebind(
        super::ChannelSendFailureKind::ConnectFailedBeforeDispatch
    ));
    assert!(!super::telegram_send_may_rebind(
        super::ChannelSendFailureKind::VerifiedRejection
    ));
    assert!(!super::telegram_send_may_rebind(
        super::ChannelSendFailureKind::UnknownRemoteOutcome
    ));
}

#[test]
fn sidecar_http_status_preserves_remote_outcome_uncertainty() {
    assert_eq!(
        super::channel_send_failure_kind_for_status(super::StatusCode::BAD_REQUEST),
        super::ChannelSendFailureKind::VerifiedRejection
    );
    assert_eq!(
        super::channel_send_failure_kind_for_status(super::StatusCode::BAD_GATEWAY),
        super::ChannelSendFailureKind::UnknownRemoteOutcome
    );
}

#[test]
fn browser_act_transport_errors_are_classified_conservatively() {
    use super::BrowserActFailureKind::*;
    // PRE-dispatch: the Act request never reached the sidecar read loop.
    assert_eq!(
        super::browser_act_failure_kind("sidecar:sidecar stdin closed"),
        ConnectFailedBeforeDispatch
    );
    assert_eq!(
        super::browser_act_failure_kind("sidecar:Broken pipe (os error 32)"),
        ConnectFailedBeforeDispatch
    );
    // PRE-dispatch: sidecar verified it never touched the page.
    assert_eq!(
        super::browser_act_failure_kind(
            "sidecar:BROWSER_NOT_STARTED:browser session is not started"
        ),
        ConnectFailedBeforeDispatch
    );
    assert_eq!(
        super::browser_act_failure_kind("sidecar:BROWSER_TAB_NOT_FOUND:tab not found: booking"),
        ConnectFailedBeforeDispatch
    );
    // AMBIGUOUS: anything after the sidecar could have accepted the Act request
    // stays uncertain (double-execution guard).
    assert_eq!(
        super::browser_act_failure_kind(super::BROWSER_SIDECAR_TIMEOUT_ERROR),
        UnknownRemoteOutcome
    );
    assert_eq!(
        super::browser_act_failure_kind("sidecar:sidecar closed unexpectedly"),
        UnknownRemoteOutcome
    );
    assert_eq!(
        super::browser_act_failure_kind("sidecar:sidecar unresponsive: no reply within 15s"),
        UnknownRemoteOutcome
    );
    assert_eq!(
        super::browser_act_failure_kind("sidecar:BROWSER_INTERNAL_ERROR:Target closed"),
        UnknownRemoteOutcome
    );
}

#[test]
fn ordinary_browser_action_ambiguity_is_low_risk_no_user_resolution() {
    let action = serde_json::json!({
        "kind": "click",
        "ref": "e184",
        "action_class": "ordinary"
    });
    let floor_refs = std::collections::HashSet::new();

    assert_eq!(
        super::browser_action_effect_risk(&action, &floor_refs, false),
        super::BrowserEffectRisk::Low
    );
    assert!(
        !super::browser_act_uncertain_failure_requires_user_resolution(
            super::BrowserEffectRisk::Low,
            super::BrowserActFailureKind::UnknownRemoteOutcome,
        ),
        "a read/search ordinary click timeout must become browser no-progress, not an effect_resolution card"
    );
}

#[test]
fn booking_account_and_payment_browser_actions_remain_high_risk() {
    let floor_refs = std::collections::HashSet::from(["pay-ref".to_string()]);
    for action in [
        serde_json::json!({"kind": "click", "ref": "e7", "action_class": "booking"}),
        serde_json::json!({"kind": "click", "ref": "e8", "action_class": "account"}),
        serde_json::json!({
            "kind": "click",
            "ref": "pay-ref",
            "action_class": "payment_commit",
            "payment_approval_id": "pay_1"
        }),
    ] {
        assert_eq!(
            super::browser_action_effect_risk(&action, &floor_refs, false),
            super::BrowserEffectRisk::High
        );
        assert!(
            super::browser_act_uncertain_failure_requires_user_resolution(
                super::BrowserEffectRisk::High,
                super::BrowserActFailureKind::UnknownRemoteOutcome,
            ),
            "high-risk browser ambiguity still needs human verification"
        );
    }
}

#[test]
fn browser_act_receipt_effect_class_follows_action_risk() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let (contract, sink) =
        browser_settlement_ctx_parts(&state, "execution-browser-act-effect-class");
    let journal = super::agent_journal::GatewayJournal::Disabled;
    let mut browser_used = false;
    let mut last_snapshot = String::new();
    let mut last_snapshot_semantic_fingerprint = String::new();
    let mut floor_refs = std::collections::HashMap::new();
    let mut payment_contexts = std::collections::HashMap::new();
    let mut pending_image = None;
    let mut tool_call_ids = std::collections::BTreeSet::new();
    let mut current_target = "booking".to_string();
    let mut opened_targets = Vec::new();
    let mut nav_failures = std::collections::HashMap::new();
    let mut suspend_receipt = None;
    let mut outcome_hint = None;
    let ctx = super::BrowserToolCtx {
        browser_used: &mut browser_used,
        last_snapshot: &mut last_snapshot,
        last_snapshot_semantic_fingerprint: &mut last_snapshot_semantic_fingerprint,
        payment_floor_refs: &mut floor_refs,
        payment_context_by_target: &mut payment_contexts,
        pending_browser_image: &mut pending_image,
        browser_tool_call_ids: &mut tool_call_ids,
        current_target: &mut current_target,
        opened_targets: &mut opened_targets,
        nav_failures: &mut nav_failures,
        state: &state,
        tx: &sink,
        thread_id: Some("thread-browser-settle"),
        prompt: "",
        read_only: false,
        channel_owner: false,
        journal: &journal,
        execution_contract: Some(&contract),
        effect_run_id: Some("run-browser-settle"),
        suspend_effect_receipt: &mut suspend_receipt,
        outcome_hint: &mut outcome_hint,
        model_supports_vision: true,
    };

    let ordinary_action = serde_json::json!({
        "target_id": "booking",
        "kind": "click",
        "ref": "e184",
        "action_class": "ordinary"
    });
    let super::effect_host::EffectDecision::Execute(ordinary) = super::begin_browser_action_effect(
        &ctx,
        "call-ordinary-read",
        ordinary_action,
        &std::collections::HashSet::new(),
        false,
    )
    .expect("ordinary browser act claims") else {
        panic!("ordinary browser act must execute first");
    };
    let ordinary_receipt_ref = ordinary.receipt_ref().clone();
    let ordinary_receipt = state
        .task_store
        .lock()
        .expect("task store")
        .effect_receipt(&ordinary_receipt_ref)
        .expect("load ordinary receipt")
        .expect("ordinary receipt");
    assert_eq!(
        ordinary_receipt.effect_class,
        local_first_execution_protocol::EffectClass::Read
    );
    super::release_browser_effect_not_applied(&ctx, &ordinary, "test_release", "test cleanup")
        .expect("release ordinary receipt");

    let booking_action = serde_json::json!({
        "target_id": "booking",
        "kind": "click",
        "ref": "e7",
        "action_class": "booking"
    });
    let super::effect_host::EffectDecision::Execute(booking) = super::begin_browser_action_effect(
        &ctx,
        "call-booking-write",
        booking_action,
        &std::collections::HashSet::new(),
        false,
    )
    .expect("booking browser act claims") else {
        panic!("booking browser act must execute first");
    };
    let booking_receipt_ref = booking.receipt_ref().clone();
    let booking_receipt = state
        .task_store
        .lock()
        .expect("task store")
        .effect_receipt(&booking_receipt_ref)
        .expect("load booking receipt")
        .expect("booking receipt");
    assert_eq!(
        booking_receipt.effect_class,
        local_first_execution_protocol::EffectClass::ExternalWrite
    );
    super::release_browser_effect_not_applied(&ctx, &booking, "test_release", "test cleanup")
        .expect("release booking receipt");
}

/// Builds the minimal browser tool context needed to settle an effect receipt:
/// an active execution contract allowing `ExternalWrite` plus fabricated
/// per-turn scratch state. Mirrors the effect_host `activate` helper.
fn browser_settlement_ctx_parts(
    state: &super::AppState,
    execution_id: &str,
) -> (
    local_first_execution_protocol::ValidatedExecutionContract,
    super::StreamSink,
) {
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace-browser-settle");
    let now = time::OffsetDateTime::now_utc();
    let mut task = local_first_task_runtime::TaskRecord::new(
        execution_id,
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "settle browser effect",
        serde_json::json!({"thread_id": "thread-browser-settle"}),
    );
    task.status = local_first_task_runtime::TaskStatus::Running;
    task.lease_owner = Some("worker-1".into());
    task.last_heartbeat_at = Some(now);
    task.lease_expires_at = Some(now + time::Duration::minutes(5));
    let mut raw = local_first_execution_protocol::ExecutionContract::new(
        execution_id,
        "chat_turn",
        local_first_execution_protocol::ExecutionScope {
            user_id: user.as_str().into(),
            workspace_id: workspace.as_str().into(),
            thread_id: Some("thread-browser-settle".into()),
        },
        serde_json::to_value(&task).expect("task"),
    );
    raw.fencing_token = u64::try_from(now.unix_timestamp_nanos()).expect("fence");
    raw.policy.allowed_effects = vec![
        local_first_execution_protocol::EffectClass::Read,
        local_first_execution_protocol::EffectClass::ExternalWrite,
    ];
    let contract: local_first_execution_protocol::ValidatedExecutionContract =
        raw.try_into().expect("contract");
    {
        let store = state.task_store.lock().expect("task store");
        store.insert_task(&task).expect("insert task");
        store.create_execution(&contract).expect("create execution");
        store
            .start_execution_attempt(
                &contract.as_ref().execution_id,
                contract.as_ref().revision,
                contract.as_ref().fencing_token,
                "worker-1",
            )
            .expect("start attempt");
    }
    let (mpsc, _rx) = tokio::sync::mpsc::channel(4);
    let (tx, _btx) = tokio::sync::broadcast::channel(4);
    let sink = super::StreamSink {
        mpsc,
        entry: std::sync::Arc::new(super::StreamEntry {
            lines: std::sync::Mutex::new(Vec::new()),
            tx,
            finished: std::sync::atomic::AtomicBool::new(false),
            last_event_at: std::sync::atomic::AtomicU64::new(super::now_epoch_secs()),
            thread_id: None,
            assistant_message_id: std::sync::Mutex::new(None),
            outcome: std::sync::Mutex::new(None),
            outcome_ready: tokio::sync::Notify::new(),
        }),
    };
    (contract, sink)
}

fn begin_browser_act_lease<'a>(
    ctx: &super::BrowserToolCtx<'a>,
    call_id: &str,
) -> super::effect_host::EffectLease<'a> {
    let super::effect_host::EffectDecision::Execute(lease) = super::begin_browser_action_effect(
        ctx,
        call_id,
        serde_json::json!({
            "target_id": "booking",
            "kind": "click",
            "ref": "e7",
            "action_class": "booking"
        }),
        &std::collections::HashSet::new(),
        false,
    )
    .expect("claim browser_act effect") else {
        panic!("first browser_act claim must execute");
    };
    lease
}

#[test]
fn browser_act_pre_dispatch_failure_releases_the_effect_without_suspension() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let (contract, sink) =
        browser_settlement_ctx_parts(&state, "execution-browser-act-pre-dispatch");
    let journal = super::agent_journal::GatewayJournal::Disabled;
    let mut browser_used = false;
    let mut last_snapshot = String::new();
    let mut last_snapshot_semantic_fingerprint = String::new();
    let mut floor_refs = std::collections::HashMap::new();
    let mut payment_contexts = std::collections::HashMap::new();
    let mut pending_image = None;
    let mut tool_call_ids = std::collections::BTreeSet::new();
    let mut current_target = "booking".to_string();
    let mut opened_targets = Vec::new();
    let mut nav_failures = std::collections::HashMap::new();
    let mut suspend_receipt = None;
    let mut outcome_hint = None;
    let ctx = super::BrowserToolCtx {
        browser_used: &mut browser_used,
        last_snapshot: &mut last_snapshot,
        last_snapshot_semantic_fingerprint: &mut last_snapshot_semantic_fingerprint,
        payment_floor_refs: &mut floor_refs,
        payment_context_by_target: &mut payment_contexts,
        pending_browser_image: &mut pending_image,
        browser_tool_call_ids: &mut tool_call_ids,
        current_target: &mut current_target,
        opened_targets: &mut opened_targets,
        nav_failures: &mut nav_failures,
        state: &state,
        tx: &sink,
        thread_id: Some("thread-browser-settle"),
        prompt: "",
        read_only: false,
        channel_owner: false,
        journal: &journal,
        execution_contract: Some(&contract),
        effect_run_id: Some("run-browser-settle"),
        suspend_effect_receipt: &mut suspend_receipt,
        outcome_hint: &mut outcome_hint,
        model_supports_vision: true,
    };
    let lease = begin_browser_act_lease(&ctx, "call-pre-dispatch");

    // Transport died before dispatch: receipt is released, NOT marked uncertain,
    // and the turn is NOT suspended (no verification card).
    let receipt = super::release_browser_effect_not_applied(
        &ctx,
        &lease,
        super::BrowserActFailureKind::ConnectFailedBeforeDispatch.as_str(),
        "sidecar stdin closed",
    )
    .expect("release receipt");
    assert_eq!(
        receipt.status,
        local_first_execution_protocol::EffectReceiptStatus::Prepared
    );
    assert!(
        ctx.suspend_effect_receipt.is_none(),
        "pre-dispatch failure must not suspend the turn"
    );
    drop(lease);

    // The engine stays free to retry: the same logical call claims a fresh
    // execution instead of resolving as uncertain.
    assert!(matches!(
        super::begin_browser_action_effect(
            &ctx,
            "call-pre-dispatch",
            serde_json::json!({
                "target_id": "booking",
                "kind": "click",
                "ref": "e7",
                "action_class": "booking"
            }),
            &std::collections::HashSet::new(),
            false,
        )
        .expect("retry claim"),
        super::effect_host::EffectDecision::Execute(_)
    ));
}

#[test]
fn browser_act_ambiguous_failure_stays_uncertain_and_suspends() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let (contract, sink) = browser_settlement_ctx_parts(&state, "execution-browser-act-ambiguous");
    let journal = super::agent_journal::GatewayJournal::Disabled;
    let mut browser_used = false;
    let mut last_snapshot = String::new();
    let mut last_snapshot_semantic_fingerprint = String::new();
    let mut floor_refs = std::collections::HashMap::new();
    let mut payment_contexts = std::collections::HashMap::new();
    let mut pending_image = None;
    let mut tool_call_ids = std::collections::BTreeSet::new();
    let mut current_target = "booking".to_string();
    let mut opened_targets = Vec::new();
    let mut nav_failures = std::collections::HashMap::new();
    let mut suspend_receipt = None;
    let mut outcome_hint = None;
    let mut ctx = super::BrowserToolCtx {
        browser_used: &mut browser_used,
        last_snapshot: &mut last_snapshot,
        last_snapshot_semantic_fingerprint: &mut last_snapshot_semantic_fingerprint,
        payment_floor_refs: &mut floor_refs,
        payment_context_by_target: &mut payment_contexts,
        pending_browser_image: &mut pending_image,
        browser_tool_call_ids: &mut tool_call_ids,
        current_target: &mut current_target,
        opened_targets: &mut opened_targets,
        nav_failures: &mut nav_failures,
        state: &state,
        tx: &sink,
        thread_id: Some("thread-browser-settle"),
        prompt: "",
        read_only: false,
        channel_owner: false,
        journal: &journal,
        execution_contract: Some(&contract),
        effect_run_id: Some("run-browser-settle"),
        suspend_effect_receipt: &mut suspend_receipt,
        outcome_hint: &mut outcome_hint,
        model_supports_vision: true,
    };
    let lease = begin_browser_act_lease(&ctx, "call-ambiguous");

    // Post-ack ambiguity keeps the existing behavior: receipt uncertain + turn
    // suspended so the user verifies the outcome (double-execution guard).
    let receipt = super::mark_browser_effect_uncertain(&mut ctx, &lease).expect("uncertain");
    assert_eq!(
        receipt.status,
        local_first_execution_protocol::EffectReceiptStatus::Uncertain
    );
    let lease_receipt_ref = lease.receipt_ref().clone();
    assert_eq!(
        ctx.suspend_effect_receipt.as_ref(),
        Some(&lease_receipt_ref),
        "ambiguous failure must suspend the turn on the uncertain receipt"
    );
    drop(lease);

    // An uncertain receipt never executes again: retry resolves, never re-dispatches.
    assert!(matches!(
        super::begin_browser_action_effect(
            &ctx,
            "call-ambiguous",
            serde_json::json!({
                "target_id": "booking",
                "kind": "click",
                "ref": "e7",
                "action_class": "booking"
            }),
            &std::collections::HashSet::new(),
            false,
        )
        .expect("resolve claim"),
        super::effect_host::EffectDecision::Resolve(_)
    ));
}

#[test]
fn recipient_fingerprint_is_stable_and_does_not_expose_the_recipient() {
    let first = super::recipient_fingerprint(" chat-id-123 ");
    let second = super::recipient_fingerprint("chat-id-123");

    assert_eq!(first, second);
    assert!(first.starts_with("sha256:"));
    assert!(!first.contains("chat-id-123"));
}

#[tokio::test]
async fn effect_resolution_is_single_flight_per_receipt() {
    let receipt_ref = "effect:v1:32:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let leader = super::begin_effect_resolution(receipt_ref).expect("first resolver is leader");

    assert!(super::begin_effect_resolution(receipt_ref).is_err());
    drop(leader);
    assert!(super::begin_effect_resolution(receipt_ref).is_ok());
}

#[test]
fn workspace_filesystem_manifest_allows_only_declared_write_tools() {
    assert!(super::workspace_filesystem_manifest("mcp:filesystem", "create").is_some());
    assert!(super::workspace_filesystem_manifest("mcp:filesystem", "view").is_none());
    assert!(super::workspace_filesystem_manifest("mcp:other", "create").is_none());
}

#[test]
fn absolute_jail_accepts_nested_new_path_and_rejects_escape() {
    let root = std::env::temp_dir().join(format!("homun-scope-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("root");
    assert!(super::jail_absolute_in_root(&root, &root.join("nested/new.md")).is_ok());
    assert!(super::jail_absolute_in_root(&root, &root.join("../outside.md")).is_err());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn workspace_scope_requires_a_root_and_an_in_root_manifest_path() {
    let root = std::env::temp_dir().join(format!("homun-scope-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("root");
    let args = serde_json::json!({ "path": root.join("note.md") });
    assert!(super::workspace_scoped_mcp_write_for_root(
        Some(&root),
        "mcp:filesystem",
        "create",
        &args
    ));
    assert!(!super::workspace_scoped_mcp_write_for_root(
        None,
        "mcp:filesystem",
        "create",
        &args
    ));
    assert!(!super::workspace_scoped_mcp_write_for_root(
        Some(&root),
        "mcp:filesystem",
        "view",
        &args
    ));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn mcp_confirm_match_requires_exact_tool_and_arguments() {
    let text = "I need your confirmation\n‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{\"path\":\"/tmp/a\",\"content\":\"x\"}}‹‹/MCP_CONFIRM››";
    let args = serde_json::json!({ "path": "/tmp/a", "content": "x" });
    assert!(super::mcp_confirm_matches(
        text,
        "mcp__filesystem__create",
        &args
    ));
    assert!(!super::mcp_confirm_matches(
        text,
        "mcp__filesystem__create",
        &serde_json::json!({ "path": "/tmp/b", "content": "x" })
    ));
    assert!(!super::mcp_confirm_matches(
        text,
        "mcp__filesystem__insert",
        &args
    ));
}

#[test]
fn remote_approval_requires_its_exact_persisted_card_id() {
    let text = "I need your confirmation\n‹‹MCP_CONFIRM››{\"approval_id\":\"approval-a\",\"tool\":\"mcp__filesystem__create\",\"arguments\":{\"path\":\"/tmp/a\",\"content\":\"x\"}}‹‹/MCP_CONFIRM››";
    let args = serde_json::json!({ "path": "/tmp/a", "content": "x" });
    assert!(super::mcp_confirm_matches_approval(
        text,
        "approval-a",
        "mcp__filesystem__create",
        &args
    ));
    assert!(!super::mcp_confirm_matches_approval(
        text,
        "approval-b",
        "mcp__filesystem__create",
        &args
    ));
    assert!(!super::mcp_confirm_matches_approval(
        "‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{\"path\":\"/tmp/a\",\"content\":\"x\"}}‹‹/MCP_CONFIRM››",
        "approval-a",
        "mcp__filesystem__create",
        &args
    ));
}

#[test]
fn persisted_remote_approval_event_part_authorizes_the_exact_card() {
    let approval_id = "approval-a";
    let tool = "mcp__filesystem__create";
    let args = serde_json::json!({ "path": "/tmp/a", "content": "x" });
    let mut message = super::channel_chat_message_with_id(
        "assistant",
        "Please approve this action.",
        "assistant-test",
    );
    message.event_parts.push(serde_json::json!({
        "type": "remote_approval",
        "protocol": "mcp",
        "approval_id": approval_id,
        "tool": tool,
        "arguments": args,
    }));

    assert!(super::remote_approval_matches_persisted_message(
        &message,
        approval_id,
        tool,
        &serde_json::json!({ "path": "/tmp/a", "content": "x" }),
    ));
    assert!(!super::remote_approval_matches_persisted_message(
        &message,
        "approval-b",
        tool,
        &serde_json::json!({ "path": "/tmp/a", "content": "x" }),
    ));
}

#[test]
fn actionable_cards_classify_local_confirms_and_native_waiting_cards() {
    let local_mcp = "Approve this. ‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{\"path\":\"/tmp/a\"}}‹‹/MCP_CONFIRM››";
    let local_composio = "Approve this. ‹‹COMPOSIO_CONFIRM››{\"tool\":\"GMAIL_SEND_EMAIL\",\"arguments\":{\"to\":\"a@example.test\"}}‹‹/COMPOSIO_CONFIRM››";
    let native = "‹‹FS_AUTHORIZE››{\"path\":\"/tmp\",\"op\":\"list\"}‹‹/FS_AUTHORIZE››\n‹‹SANDBOX_ESCALATE››{\"tool\":\"run_in_project\",\"arguments\":{\"command\":\"pwd\"}}‹‹/SANDBOX_ESCALATE››\n‹‹CONNECT_SUGGEST››{\"items\":[{\"name\":\"Drive\"}]}‹‹/CONNECT_SUGGEST››";

    let mcp_cards = super::actionable_cards_from_raw_text(local_mcp);
    let composio_cards = super::actionable_cards_from_raw_text(local_composio);
    let native_cards = super::actionable_cards_from_raw_text(native);

    assert!(mcp_cards.iter().any(|card| card.kind == "MCP_CONFIRM"));
    assert!(
        composio_cards
            .iter()
            .any(|card| card.kind == "COMPOSIO_CONFIRM")
    );
    assert_eq!(native_cards.len(), 3);
}

#[test]
fn malformed_actionable_marker_is_not_persisted_into_delivered_model_context() {
    let state = super::AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .find_or_create_channel_thread("project-a", "test", "malformed", "Malformed card")
        .unwrap();
    let assistant =
        super::channel_chat_message_with_id("assistant", "", "malformed_actionable_marker");
    super::lock_store(&state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();

    let raw = "Visible answer. ‹‹MCP_CONFIRM››{not valid json}‹‹/MCP_CONFIRM››";
    super::finalize_streamed_assistant_message(
        &state,
        "turn_malformed_actionable_marker",
        &thread.thread_id,
        &assistant.id,
        raw,
        &super::StreamMemoryReuseCollector::default(),
        local_first_desktop_gateway::MessageDeliveryState::Delivered,
    )
    .unwrap();

    let saved = super::lock_store(&state)
        .unwrap()
        .message(&thread.thread_id, &assistant.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        saved.delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Delivered
    );
    assert!(!saved.text.contains("MCP_CONFIRM"));
    let context = super::thread_context_for_model(&state, &thread.thread_id, &[], None)
        .expect("thread context");
    assert!(
        !context
            .iter()
            .any(|message| message.text.contains("MCP_CONFIRM"))
    );
}

#[test]
fn canonical_stream_finalization_does_not_project_hitl_from_markers() {
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("ws_canonical_marker")
        .expect("thread");
    let assistant =
        super::channel_chat_message_with_id("assistant", "", "canonical_marker_message");
    state
        .chat_store
        .lock()
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .expect("assistant message");
    let raw = r#"Pick one. ‹‹CHOICES››{"question":"Which?","options":["A","B"]}‹‹/CHOICES››"#;
    let cards = super::actionable_cards_from_raw_text(raw);
    let mut collector = super::StreamMemoryReuseCollector::default();
    collector.observe_actionable_cards(&cards);

    super::finalize_streamed_assistant_message(
        &state,
        "turn_canonical_stream_marker",
        &thread.thread_id,
        &assistant.id,
        raw,
        &collector,
        local_first_desktop_gateway::MessageDeliveryState::Streaming,
    )
    .expect("finalize canonical stream");

    assert!(
        state
            .chat_store
            .lock()
            .unwrap()
            .open_hitl_wait(&thread.thread_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn transcript_parts_render_after_reload_without_marker_text() {
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("transcript_parts_reload")
        .expect("thread");
    let assistant =
        super::channel_chat_message_with_id("assistant", "", "transcript_parts_assistant");
    state
        .chat_store
        .lock()
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .expect("assistant message");
    let raw = r#"Pick one. ‹‹CHOICES››{"question":"Which?","options":["A","B"]}‹‹/CHOICES››"#;
    let cards = super::actionable_cards_from_raw_text(raw);
    let mut collector = super::StreamMemoryReuseCollector::default();
    collector.observe_actionable_cards(&cards);

    super::finalize_streamed_assistant_message(
        &state,
        "turn_transcript_parts_reload",
        &thread.thread_id,
        &assistant.id,
        "Pick one.",
        &collector,
        local_first_desktop_gateway::MessageDeliveryState::Delivered,
    )
    .expect("finalize typed transcript parts");

    let saved = state
        .chat_store
        .lock()
        .unwrap()
        .message(&thread.thread_id, &assistant.id)
        .unwrap()
        .unwrap();

    assert_eq!(saved.text, "Pick one.");
    assert!(!saved.text.contains("CHOICES"));
    assert_eq!(saved.event_parts.len(), 1);
    assert_eq!(saved.event_parts[0]["type"], "actionable_card");
    assert_eq!(saved.event_parts[0]["kind"], "CHOICES");
    assert_eq!(saved.event_parts[0]["payload"]["question"], "Which?");
}

#[test]
fn payment_approval_turn_event_survives_stream_finalization_without_marker_text() {
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("payment_event_parts_reload")
        .expect("thread");
    let assistant = super::channel_chat_message_with_id("assistant", "", "payment_parts_assistant");
    state
        .chat_store
        .lock()
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .expect("assistant message");
    let turn_id = "turn_payment_event_parts_reload";
    let payload = serde_json::json!({
        "snapshot": {
            "approval_id": "pay_live_123",
            "merchant": "Stripe Elements Demo",
            "domain": "checkout.stripe.dev",
            "amount_minor": 12196,
            "currency": "USD",
            "product_summary": "Pure Glow Cream + The Pure Set",
            "payment_method_label": "Test card 4242",
            "checkout_fingerprint": "stripe-elements-demo-12196-usd"
        }
    });
    {
        let store = state.task_store.lock().unwrap();
        super::turn_executor::emit_turn_event(
            &state,
            &store,
            turn_id,
            local_first_task_runtime::TurnEventKind::PaymentApproval,
            payload.clone(),
        )
        .expect("payment event");
    }

    super::finalize_streamed_assistant_message(
        &state,
        turn_id,
        &thread.thread_id,
        &assistant.id,
        "Ti presento la richiesta di approvazione:\n\n",
        &super::StreamMemoryReuseCollector::default(),
        local_first_desktop_gateway::MessageDeliveryState::Delivered,
    )
    .expect("finalize typed payment part");

    let saved = state
        .chat_store
        .lock()
        .unwrap()
        .message(&thread.thread_id, &assistant.id)
        .unwrap()
        .unwrap();
    assert!(!saved.text.contains("PAYMENT_APPROVAL"));
    assert_eq!(saved.event_parts.len(), 1);
    assert_eq!(saved.event_parts[0]["type"], "payment_approval");
    assert_eq!(saved.event_parts[0]["payload"], payload);
}

#[test]
fn placeholder_payment_approval_marker_is_not_fanned_out_as_a_real_card() {
    let state = super::AppState::for_tests();
    let turn_id = "turn_payment_placeholder_filter";
    let placeholder = "‹‹PAYMENT_APPROVAL››{\"snapshot\":{\"approval_id\":\"pay_<uuid>\",\"merchant\":\"...\",\"domain\":\"...\",\"amount_minor\":5900,\"currency\":\"EUR\",\"product_summary\":\"...\",\"payment_method_label\":\"Visa 1111\",\"checkout_fingerprint\":\"...\"}}‹‹/PAYMENT_APPROVAL››";
    let real = "‹‹PAYMENT_APPROVAL››{\"snapshot\":{\"approval_id\":\"pay_real_123\",\"merchant\":\"Stripe Elements Demo\",\"domain\":\"checkout.stripe.dev\",\"amount_minor\":12196,\"currency\":\"USD\",\"product_summary\":\"Pure Glow Cream + The Pure Set\",\"payment_method_label\":\"Test card 4242\",\"checkout_fingerprint\":\"stripe-elements-demo-12196-usd\"}}‹‹/PAYMENT_APPROVAL››";

    super::fanout_legacy_card_markers_from_text(&state, turn_id, &format!("{placeholder}\n{real}"));

    let events = state
        .task_store
        .lock()
        .unwrap()
        .read_turn_events(turn_id, 0)
        .unwrap();
    let payment_events = events
        .iter()
        .filter(|event| event.kind == local_first_task_runtime::TurnEventKind::PaymentApproval)
        .collect::<Vec<_>>();
    assert_eq!(payment_events.len(), 1);
    assert_eq!(
        payment_events[0].payload["snapshot"]["approval_id"],
        "pay_real_123"
    );
}

#[test]
fn stream_terminal_events_do_not_persist_before_canonical_projection() {
    let state = super::AppState::for_tests();
    let turn_id = "turn_stream_terminal_guard";

    super::fanout_turn_event(
        &state,
        turn_id,
        r#"{"type":"done","text":"visible final text"}"#,
    );
    super::fanout_turn_event(
        &state,
        turn_id,
        r#"{"type":"error","code":"provider_error","message":"failed"}"#,
    );

    let events = state
        .task_store
        .lock()
        .unwrap()
        .read_turn_events(turn_id, 0)
        .unwrap();
    assert!(
        events.is_empty(),
        "stream fanout must not persist terminal events before task projection"
    );
}

#[test]
fn user_reply_resumes_the_suspended_chat_execution_in_place() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("workspace-resume")
        .unwrap();
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace-resume");
    let task = local_first_task_runtime::TaskRecord::new(
        "turn-resume-user",
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "choose",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "prompt": "Choose A or B",
            "request_id": "initial-request",
            "assistant_message_id": "assistant-resume-user",
            "workspace_id": workspace.as_str(),
        }),
    );
    let contract = local_first_execution_protocol::ValidatedExecutionContract::try_from(
        local_first_execution_protocol::ExecutionContract::new(
            task.task_id.as_str(),
            "chat_turn",
            local_first_execution_protocol::ExecutionScope {
                user_id: user.as_str().into(),
                workspace_id: workspace.as_str().into(),
                thread_id: Some(thread.thread_id.clone()),
            },
            serde_json::to_value(&task).unwrap(),
        ),
    )
    .unwrap();
    let wake = local_first_execution_protocol::WakeCondition::User {
        wait_ref: "turn-resume-user:1:user".into(),
    };
    let outcome = local_first_execution_protocol::ValidatedExecutionOutcome::new(
        local_first_execution_protocol::ExecutionOutcome::Suspended {
            wake: wake.clone(),
            checkpoint: local_first_execution_protocol::CheckpointEnvelope::new(
                task.task_id.as_str(),
                1,
                "chat_turn",
                1,
                local_first_execution_protocol::CheckpointDataRef::Public {
                    record_ref: local_first_execution_protocol::DurableDataRef::from_store_id(
                        "0123456789abcdef0123456789abcdef",
                    )
                    .unwrap(),
                },
            ),
        },
        &contract,
    )
    .unwrap();
    {
        let store = state.task_store.lock().unwrap();
        store.insert_task(&task).unwrap();
        store.create_execution(&contract).unwrap();
        store.commit_execution_outcome(&outcome).unwrap();
        store
            .insert_turn_event(
                task.task_id.as_str(),
                local_first_task_runtime::TurnEventKind::Suspended,
                serde_json::json!({"revision": 1}),
            )
            .unwrap();
    }
    let mut assistant =
        super::channel_chat_message_with_id("assistant", "Choose A or B", "assistant-resume-user");
    assistant.linked_task_id = Some(task.task_id.as_str().into());
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    state
        .chat_store
        .lock()
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();

    let input = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: thread.thread_id.clone(),
        request_id: "resume-request".into(),
        assistant_message_id: "unused-new-assistant".into(),
        prompt: "A".into(),
        visible_prompt: None,
        images: Vec::new(),
        attachments: None,
        mode: None,
        model: None,
        source: local_first_task_runtime::broker::ChatTurnSource::Interactive,
        approval: local_first_task_runtime::broker::TurnApproval::Full,
    };
    let resumed = super::resume_suspended_user_turn_core(&state, &input)
        .unwrap()
        .expect("suspended turn resumed");

    assert_eq!(resumed.execution_id, task.task_id.as_str());
    assert_eq!(resumed.revision, 2);
    assert_eq!(resumed.stream_from_seq, 1);
    let store = state.task_store.lock().unwrap();
    assert_eq!(
        store
            .execution_revision(task.task_id.as_str(), 2)
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .wake
            .as_ref()
            .unwrap()
            .payload["prompt"],
        "A"
    );
    assert_eq!(
        store
            .list_tasks(&user, &workspace)
            .unwrap()
            .into_iter()
            .filter(|candidate| candidate.kind == "chat_turn")
            .count(),
        1
    );
    drop(store);
    assert!(
        state
            .chat_store
            .lock()
            .unwrap()
            .message(&thread.thread_id, "local_user_resume-request")
            .unwrap()
            .is_some()
    );
}

#[test]
fn cancelled_suspended_turn_does_not_resurrect_on_next_user_message() {
    // Stop-flow regression: a turn cancelled while suspended used to keep its
    // pending wake, and the next user message delivered that wake, flipping the
    // Cancelled task back to queued and resurrecting the SAME execution.
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("workspace-cancelled-resume")
        .unwrap();
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace-cancelled-resume");
    let task = local_first_task_runtime::TaskRecord::new(
        "turn-cancelled-resume",
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "choose",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "prompt": "Choose A or B",
            "request_id": "initial-request",
            "assistant_message_id": "assistant-cancelled-resume",
            "workspace_id": workspace.as_str(),
        }),
    );
    let contract = local_first_execution_protocol::ValidatedExecutionContract::try_from(
        local_first_execution_protocol::ExecutionContract::new(
            task.task_id.as_str(),
            "chat_turn",
            local_first_execution_protocol::ExecutionScope {
                user_id: user.as_str().into(),
                workspace_id: workspace.as_str().into(),
                thread_id: Some(thread.thread_id.clone()),
            },
            serde_json::to_value(&task).unwrap(),
        ),
    )
    .unwrap();
    let wake = local_first_execution_protocol::WakeCondition::User {
        wait_ref: "turn-cancelled-resume:1:user".into(),
    };
    let outcome = local_first_execution_protocol::ValidatedExecutionOutcome::new(
        local_first_execution_protocol::ExecutionOutcome::Suspended {
            wake: wake.clone(),
            checkpoint: local_first_execution_protocol::CheckpointEnvelope::new(
                task.task_id.as_str(),
                1,
                "chat_turn",
                1,
                local_first_execution_protocol::CheckpointDataRef::Public {
                    record_ref: local_first_execution_protocol::DurableDataRef::from_store_id(
                        "0123456789abcdef0123456789abcdef",
                    )
                    .unwrap(),
                },
            ),
        },
        &contract,
    )
    .unwrap();
    {
        let store = state.task_store.lock().unwrap();
        store.insert_task(&task).unwrap();
        store.create_execution(&contract).unwrap();
        store.commit_execution_outcome(&outcome).unwrap();
        // Reproduce the PRE-FIX inconsistent state: the task was marked
        // Cancelled but the pending wake survived (old cancel path).
        store
            .update_task_status(
                &task.task_id,
                &user,
                &workspace,
                local_first_task_runtime::TaskStatus::Cancelled,
                None,
            )
            .unwrap();
        assert_eq!(
            store
                .pending_execution_wakes(user.as_str(), workspace.as_str(), Some(&thread.thread_id))
                .unwrap()
                .len(),
            1,
            "precondition: the stale pending wake survived the legacy cancel"
        );
    }

    let input = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: thread.thread_id.clone(),
        request_id: "after-cancel-request".into(),
        assistant_message_id: "unused-new-assistant".into(),
        prompt: "A".into(),
        visible_prompt: None,
        images: Vec::new(),
        attachments: None,
        mode: None,
        model: None,
        source: local_first_task_runtime::broker::ChatTurnSource::Interactive,
        approval: local_first_task_runtime::broker::TurnApproval::Full,
    };
    let resumed = super::resume_suspended_user_turn_core(&state, &input).unwrap();
    assert!(
        resumed.is_none(),
        "a terminal (cancelled) turn must never be resumed in place"
    );
    {
        let store = state.task_store.lock().unwrap();
        assert!(
            store
                .pending_execution_wakes(user.as_str(), workspace.as_str(), Some(&thread.thread_id))
                .unwrap()
                .is_empty(),
            "the stale wake is discarded so no later message resurrects the turn"
        );
        let cancelled = store
            .get_task(&task.task_id, &user, &workspace)
            .unwrap()
            .unwrap();
        assert_eq!(
            cancelled.status,
            local_first_task_runtime::TaskStatus::Cancelled,
            "the old turn stays cancelled"
        );
        // The same message now enqueues a brand-new turn instead of reviving
        // the cancelled one.
        let enqueued =
            local_first_task_runtime::broker::enqueue_chat_turn(&store, &user, &workspace, &input)
                .unwrap();
        assert_ne!(
            enqueued.task_id.as_str(),
            task.task_id.as_str(),
            "the new turn is a fresh task, not the cancelled execution"
        );
        let fresh = store
            .get_task(&enqueued.task_id, &user, &workspace)
            .unwrap()
            .unwrap();
        assert_eq!(fresh.status, local_first_task_runtime::TaskStatus::Queued);
    }
}

#[test]
fn cancel_after_resume_targets_the_server_turn_id_not_the_request_derived_one() {
    // After a resume, POST /turns answers with the EXISTING execution id while
    // the client holds a fresh requestId: a DELETE on `turn_{requestId}` hits
    // nothing (404), only the server-returned turn id cancels the turn.
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("workspace-cancel-after-resume")
        .unwrap();
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace-cancel-after-resume");
    let task = local_first_task_runtime::TaskRecord::new(
        "turn-cancel-after-resume",
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "choose",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "prompt": "Choose A or B",
            "request_id": "initial-request",
            "assistant_message_id": "assistant-cancel-after-resume",
            "workspace_id": workspace.as_str(),
        }),
    );
    let contract = local_first_execution_protocol::ValidatedExecutionContract::try_from(
        local_first_execution_protocol::ExecutionContract::new(
            task.task_id.as_str(),
            "chat_turn",
            local_first_execution_protocol::ExecutionScope {
                user_id: user.as_str().into(),
                workspace_id: workspace.as_str().into(),
                thread_id: Some(thread.thread_id.clone()),
            },
            serde_json::to_value(&task).unwrap(),
        ),
    )
    .unwrap();
    let wake = local_first_execution_protocol::WakeCondition::User {
        wait_ref: "turn-cancel-after-resume:1:user".into(),
    };
    let outcome = local_first_execution_protocol::ValidatedExecutionOutcome::new(
        local_first_execution_protocol::ExecutionOutcome::Suspended {
            wake: wake.clone(),
            checkpoint: local_first_execution_protocol::CheckpointEnvelope::new(
                task.task_id.as_str(),
                1,
                "chat_turn",
                1,
                local_first_execution_protocol::CheckpointDataRef::Public {
                    record_ref: local_first_execution_protocol::DurableDataRef::from_store_id(
                        "fedcba9876543210fedcba9876543210",
                    )
                    .unwrap(),
                },
            ),
        },
        &contract,
    )
    .unwrap();
    {
        let store = state.task_store.lock().unwrap();
        store.insert_task(&task).unwrap();
        store.create_execution(&contract).unwrap();
        store.commit_execution_outcome(&outcome).unwrap();
    }
    let mut assistant = super::channel_chat_message_with_id(
        "assistant",
        "Choose A or B",
        "assistant-cancel-after-resume",
    );
    assistant.linked_task_id = Some(task.task_id.as_str().into());
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    state
        .chat_store
        .lock()
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();

    let input = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: thread.thread_id.clone(),
        request_id: "resume-request".into(),
        assistant_message_id: "unused-new-assistant".into(),
        prompt: "A".into(),
        visible_prompt: None,
        images: Vec::new(),
        attachments: None,
        mode: None,
        model: None,
        source: local_first_task_runtime::broker::ChatTurnSource::Interactive,
        approval: local_first_task_runtime::broker::TurnApproval::Full,
    };
    let resumed = super::resume_suspended_user_turn_core(&state, &input)
        .unwrap()
        .expect("suspended turn resumed");
    assert_eq!(resumed.execution_id, task.task_id.as_str());

    let store = state.task_store.lock().unwrap();
    // The id the frontend used to derive (`turn_{requestId}`) matches no turn:
    // the cancel is a no-op (server-side it was a 404).
    let ghost = local_first_task_runtime::broker::cancel_chat_turn(
        &store,
        &user,
        &workspace,
        &local_first_task_runtime::TaskId::new("turn_resume-request"),
        &local_first_task_runtime::broker::NoopCancelNotify,
    )
    .unwrap();
    assert!(
        !ghost.cancelled,
        "the request-derived id must not cancel anything"
    );
    // The server-returned turn_id (the existing execution id) cancels the
    // resumed turn for real.
    let cancelled_outcome = local_first_task_runtime::broker::cancel_chat_turn(
        &store,
        &user,
        &workspace,
        &local_first_task_runtime::TaskId::new(&resumed.execution_id),
        &local_first_task_runtime::broker::NoopCancelNotify,
    )
    .unwrap();
    assert!(cancelled_outcome.cancelled);
    let cancelled = store
        .get_task(&task.task_id, &user, &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(
        cancelled.status,
        local_first_task_runtime::TaskStatus::Cancelled
    );
    assert!(
        store
            .pending_execution_wakes(user.as_str(), workspace.as_str(), Some(&thread.thread_id))
            .unwrap()
            .is_empty(),
        "cancel after resume also clears any pending wake"
    );
}

#[test]
fn approved_action_resumes_the_suspended_chat_execution_in_place() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("workspace-approval-resume")
        .unwrap();
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace-approval-resume");
    let thread_id = thread.thread_id.as_str();
    let task = local_first_task_runtime::TaskRecord::new(
        "turn-resume-approval",
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "send",
        serde_json::json!({"thread_id": thread_id, "prompt": "send it"}),
    );
    let contract = local_first_execution_protocol::ValidatedExecutionContract::try_from(
        local_first_execution_protocol::ExecutionContract::new(
            task.task_id.as_str(),
            "chat_turn",
            local_first_execution_protocol::ExecutionScope {
                user_id: user.as_str().into(),
                workspace_id: workspace.as_str().into(),
                thread_id: Some(thread_id.into()),
            },
            serde_json::to_value(&task).unwrap(),
        ),
    )
    .unwrap();
    let wake = local_first_execution_protocol::WakeCondition::Approval {
        approval_ref: "turn-resume-approval:1:approval:SEND".into(),
    };
    let outcome = local_first_execution_protocol::ValidatedExecutionOutcome::new(
        local_first_execution_protocol::ExecutionOutcome::Suspended {
            wake,
            checkpoint: local_first_execution_protocol::CheckpointEnvelope::new(
                task.task_id.as_str(),
                1,
                "chat_turn",
                1,
                local_first_execution_protocol::CheckpointDataRef::Public {
                    record_ref: local_first_execution_protocol::DurableDataRef::from_store_id(
                        "abcdef0123456789abcdef0123456789",
                    )
                    .unwrap(),
                },
            ),
        },
        &contract,
    )
    .unwrap();
    {
        let store = state.task_store.lock().unwrap();
        store.insert_task(&task).unwrap();
        store.create_execution(&contract).unwrap();
        store.commit_execution_outcome(&outcome).unwrap();
    }

    let resumed = super::resume_suspended_approval_turn_core(
        &state,
        thread_id,
        true,
        "SEND",
        "executed",
        Some(&serde_json::json!({"to": "user@example.test"})),
        "continue the original request",
    )
    .unwrap()
    .expect("approval wake resumed");

    assert_eq!(resumed.execution_id, task.task_id.as_str());
    assert_eq!(resumed.revision, 2);
    let resumed_contract = state
        .task_store
        .lock()
        .unwrap()
        .execution_revision(task.task_id.as_str(), 2)
        .unwrap()
        .unwrap()
        .contract;
    assert_eq!(
        resumed_contract.as_ref().wake.as_ref().unwrap().payload["approved"],
        true
    );
    assert_eq!(
        resumed_contract.as_ref().wake.as_ref().unwrap().payload["prompt"],
        "continue the original request"
    );
}

#[test]
fn declined_canonical_approval_delivers_a_negative_wake() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("workspace-declined-approval")
        .unwrap();
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace-declined-approval");
    let mut task = local_first_task_runtime::TaskRecord::new(
        "turn-declined-approval",
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "send",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "prompt": "send it",
            "assistant_message_id": "assistant-declined-approval",
        }),
    );
    task.status = local_first_task_runtime::TaskStatus::WaitingUserApproval;
    let contract = local_first_execution_protocol::ValidatedExecutionContract::try_from(
        local_first_execution_protocol::ExecutionContract::new(
            task.task_id.as_str(),
            "chat_turn",
            local_first_execution_protocol::ExecutionScope {
                user_id: user.as_str().into(),
                workspace_id: workspace.as_str().into(),
                thread_id: Some(thread.thread_id.clone()),
            },
            serde_json::to_value(&task).unwrap(),
        ),
    )
    .unwrap();
    let outcome = local_first_execution_protocol::ValidatedExecutionOutcome::new(
        local_first_execution_protocol::ExecutionOutcome::Suspended {
            wake: local_first_execution_protocol::WakeCondition::Approval {
                approval_ref: "turn-declined-approval:1:approval:SEND".into(),
            },
            checkpoint: local_first_execution_protocol::CheckpointEnvelope::new(
                task.task_id.as_str(),
                1,
                "chat_turn",
                1,
                local_first_execution_protocol::CheckpointDataRef::Public {
                    record_ref: local_first_execution_protocol::DurableDataRef::from_store_id(
                        "00112233445566778899aabbccddeeff",
                    )
                    .unwrap(),
                },
            ),
        },
        &contract,
    )
    .unwrap();
    {
        let store = state.task_store.lock().unwrap();
        store.insert_task(&task).unwrap();
        store.create_execution(&contract).unwrap();
        store.commit_execution_outcome(&outcome).unwrap();
    }
    let mut assistant = super::channel_chat_message_with_id(
        "assistant",
        "Approve. ‹‹MCP_CONFIRM››{\"tool\":\"SEND\",\"arguments\":{}}‹‹/MCP_CONFIRM››",
        "assistant-declined-approval",
    );
    assistant.linked_task_id = Some(task.task_id.as_str().into());
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    state
        .chat_store
        .lock()
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();

    super::resolve_actionable_source(
        &state,
        &thread.thread_id,
        &assistant.id,
        |text| super::actionable_source_terminal_text(text, "Action cancelled."),
        super::ActionableSourceResolution::Cancelled,
    )
    .unwrap();

    let store = state.task_store.lock().unwrap();
    let resumed = store
        .execution_revision(task.task_id.as_str(), 2)
        .unwrap()
        .unwrap();
    assert_eq!(
        resumed.contract.as_ref().wake.as_ref().unwrap().payload["approved"],
        false
    );
    assert_eq!(
        store
            .get_task(&task.task_id, &user, &workspace)
            .unwrap()
            .unwrap()
            .status,
        local_first_task_runtime::TaskStatus::Queued
    );
    drop(store);
    assert_eq!(
        state
            .chat_store
            .lock()
            .unwrap()
            .message(&thread.thread_id, &assistant.id)
            .unwrap()
            .unwrap()
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Retrying
    );
}

#[test]
fn resumed_visible_turn_reopens_the_existing_assistant_stream() {
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("ws")
        .unwrap();
    super::start_visible_conversation_turn(
        &state,
        &thread.thread_id,
        "ws",
        "interactive",
        None,
        "Title",
        "Question",
        Some("user-stable"),
        Some("assistant-stable"),
        Some("turn-stable"),
        Some("turn-stable"),
    )
    .unwrap();
    state
        .chat_store
        .lock()
        .unwrap()
        .set_message_delivery_state(
            &thread.thread_id,
            "assistant-stable",
            local_first_desktop_gateway::MessageDeliveryState::WaitingUser,
        )
        .unwrap();

    super::start_visible_conversation_turn(
        &state,
        &thread.thread_id,
        "ws",
        "interactive",
        None,
        "Title",
        "Answer",
        Some("user-stable"),
        Some("assistant-stable"),
        Some("turn-stable"),
        Some("turn-stable"),
    )
    .unwrap();

    assert_eq!(
        state
            .chat_store
            .lock()
            .unwrap()
            .message(&thread.thread_id, "assistant-stable")
            .unwrap()
            .unwrap()
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Streaming
    );
}

#[test]
fn model_configuration_event_delivers_the_typed_model_wake() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let user = super::gateway_user_id();
    let workspace = super::gateway_workspace_id();
    let task = local_first_task_runtime::TaskRecord::new(
        "turn-model-wake",
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "answer",
        serde_json::json!({"prompt": "answer"}),
    );
    let contract = local_first_execution_protocol::ValidatedExecutionContract::try_from(
        local_first_execution_protocol::ExecutionContract::new(
            task.task_id.as_str(),
            "chat_turn",
            local_first_execution_protocol::ExecutionScope {
                user_id: user.as_str().into(),
                workspace_id: workspace.as_str().into(),
                thread_id: None,
            },
            serde_json::to_value(&task).unwrap(),
        ),
    )
    .unwrap();
    let wake = local_first_execution_protocol::WakeCondition::ModelAvailable {
        role: "primary".into(),
    };
    let outcome = local_first_execution_protocol::ValidatedExecutionOutcome::new(
        local_first_execution_protocol::ExecutionOutcome::Suspended {
            wake,
            checkpoint: local_first_execution_protocol::CheckpointEnvelope::new(
                task.task_id.as_str(),
                1,
                "chat_turn",
                1,
                local_first_execution_protocol::CheckpointDataRef::Public {
                    record_ref: local_first_execution_protocol::DurableDataRef::from_store_id(
                        "fedcba9876543210fedcba9876543210",
                    )
                    .unwrap(),
                },
            ),
        },
        &contract,
    )
    .unwrap();
    {
        let store = state.task_store.lock().unwrap();
        store.insert_task(&task).unwrap();
        store.create_execution(&contract).unwrap();
        store.commit_execution_outcome(&outcome).unwrap();
    }

    assert_eq!(
        super::deliver_model_available_wakes(&state, "primary", "runtime_model_changed").unwrap(),
        1
    );
    assert!(
        state
            .task_store
            .lock()
            .unwrap()
            .execution_revision(task.task_id.as_str(), 2)
            .unwrap()
            .is_some()
    );
}

#[test]
fn actionable_choice_marker_remains_presentation_only() {
    let cards = super::actionable_cards_from_raw_text(concat!(
        "Pick one.\n",
        r#"‹‹CHOICES››{"question":"Which?","options":["A","B"]}‹‹/CHOICES››"#,
    ));
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].kind, "CHOICES");
}

#[test]
fn scheduled_agent_stops_map_to_typed_wakes_not_cards() {
    let contract = local_first_execution_protocol::ValidatedExecutionContract::try_from(
        local_first_execution_protocol::ExecutionContract::new(
            "execution-1",
            "proactive_prompt",
            local_first_execution_protocol::ExecutionScope {
                user_id: "user-1".into(),
                workspace_id: "workspace-1".into(),
                thread_id: Some("thread-1".into()),
            },
            serde_json::json!({}),
        ),
    )
    .unwrap();
    assert!(matches!(
        super::wake_for_agent_stop(
            &contract,
            &local_first_engine::TurnStop::SuspendedUser,
            Some("ignored_marker")
        ),
        Some(local_first_execution_protocol::WakeCondition::User { .. })
    ));
    assert!(matches!(
        super::wake_for_agent_stop(
            &contract,
            &local_first_engine::TurnStop::SuspendedApproval,
            Some("GMAIL_SEND_EMAIL")
        ),
        Some(local_first_execution_protocol::WakeCondition::Approval { approval_ref })
            if approval_ref.ends_with(":GMAIL_SEND_EMAIL")
    ));
    assert!(
        super::wake_for_agent_stop(
            &contract,
            &local_first_engine::TurnStop::Completed,
            Some("CHOICES")
        )
        .is_none()
    );
}

#[test]
fn approval_resume_prompt_anchors_to_source_request_and_approved_args() {
    let args = serde_json::json!({
        "path": "/Users/fabio/Desktop/path-b-telegram-bound.md",
        "content": "telegram-test"
    });
    let prompt = super::approval_resume_prompt(
        "mcp__filesystem__create",
        "{\"ok\":true}",
        Some(&args),
        Some(
            "Usa il tool MCP filesystem per creare /Users/fabio/Desktop/path-b-telegram-bound.md con una riga: telegram-test.",
        ),
    );
    assert!(prompt.contains("ORIGINAL USER REQUEST"));
    assert!(prompt.contains("/Users/fabio/Desktop/path-b-telegram-bound.md"));
    assert!(prompt.contains("telegram-test"));
    assert!(prompt.contains("Do not switch to any other file, path, task, memory, or open loop"));
    assert!(prompt.contains("Do not mention or act on paths that are not in"));
}

#[test]
fn telegram_approval_progress_messages_are_actionable() {
    let reply = super::approval_progress_reply("AB12CD");
    assert!(reply.contains("AB12CD"));
    assert!(reply.contains("Verifico"));
    assert!(reply.contains("avvio"));

    let approval = crate::chat_store::RemoteApprovalRow {
        approval_id: "approval-test".to_string(),
        code: "AB12CD".to_string(),
        tool: "mcp__filesystem__create".to_string(),
        arguments: serde_json::json!({
            "path": "/Users/fabio/Desktop/status.md",
            "content": "x"
        }),
        label: "create".to_string(),
        thread_id: Some("thread-test".to_string()),
        objective_revision: None,
        source_message_id: Some("assistant-test".to_string()),
        requires_source: true,
        status: "executing".to_string(),
        expires_at: 0,
        dispatched_at: Some(1),
    };
    let running = super::remote_approval_thread_status(&approval, "running", None);
    assert!(running.contains("Approvazione Telegram ricevuta"));
    assert!(running.contains("mcp__filesystem__create"));
    assert!(running.contains("/Users/fabio/Desktop/status.md"));
    let executed = super::remote_approval_thread_status(&approval, "executed", Some("ok"));
    assert!(executed.contains("Riprendo il task"));
    assert!(executed.contains("ok"));
    let failed = super::remote_approval_thread_status(
        &approval,
        "delivery_failed",
        Some("sidecar unreachable"),
    );
    assert!(failed.contains("delivery_failed"));
    assert!(failed.contains("sidecar unreachable"));
}

#[test]
fn proactive_parse_declines_cleanly() {
    // Explicit decline → None (the supervisor chose silence over noise).
    let null = serde_json::json!({ "suggestion": null });
    assert!(parse_review_suggestion(&null, "proj").is_none());
    // Missing the wrapper key → None.
    assert!(parse_review_suggestion(&serde_json::json!({}), "proj").is_none());
    // Present but no title/body → not actionable → None.
    let empty = serde_json::json!({ "suggestion": { "kind": "x", "title": "", "body": "" } });
    assert!(parse_review_suggestion(&empty, "proj").is_none());
}

#[test]
fn proactive_parse_builds_card() {
    let value = serde_json::json!({
        "suggestion": {
            "kind": "Progetto fermo",
            "title": "Idra è fermo da un po'",
            "body": "Nessuna attività recente sul progetto Idra.",
            "rationale": "Ultima decisione registrata settimane fa.",
            "dedup_key": "Idra",
            "proposed_action": "Vuoi che controlli lo stato?"
        }
    });
    let card = parse_review_suggestion(&value, "ws-idra").expect("card");
    assert_eq!(card.scope, "ws-idra");
    assert_eq!(card.kind, "Progetto fermo");
    assert_eq!(card.dedup_key, "progetto-fermo:idra");
    assert_eq!(
        card.proposed_action.as_deref(),
        Some("Vuoi che controlli lo stato?")
    );
    // A non-string proposed_action is serialized, not dropped.
    let obj_action = serde_json::json!({
        "suggestion": {
            "title": "X", "body": "Y", "dedup_key": "k",
            "proposed_action": { "tool": "create_automation" }
        }
    });
    let card2 = parse_review_suggestion(&obj_action, "p").expect("card2");
    assert!(card2.proposed_action.unwrap().contains("create_automation"));
    // dedup_key falls back to the title when omitted.
    let no_key = serde_json::json!({ "suggestion": { "title": "Ciao Mondo", "body": "b" } });
    assert_eq!(
        parse_review_suggestion(&no_key, "p").unwrap().dedup_key,
        "suggerimento:ciao-mondo"
    );
}

#[test]
fn proactive_parse_extracts_choices() {
    // A closed question carries quick-reply options → stored as a JSON array string,
    // and round-trips back to a JSON array for the frontend.
    let q = serde_json::json!({
        "suggestion": {
            "kind": "curiosità", "title": "Lavoro o privato?", "body": "Come usi Homun?",
            "dedup_key": "uso", "choices": ["Lavoro", "Privato", "  ", "Entrambi"]
        }
    });
    let card = parse_review_suggestion(&q, "p").expect("card");
    assert_eq!(
        card.choices.as_deref(),
        Some(r#"["Lavoro","Privato","Entrambi"]"#)
    );
    assert_eq!(
        suggestion_choices_json(&card.choices),
        serde_json::json!(["Lavoro", "Privato", "Entrambi"])
    );
    // No choices / empty / non-array → None → null on the wire.
    let plain = serde_json::json!({ "suggestion": { "title": "T", "body": "B" } });
    assert!(
        parse_review_suggestion(&plain, "p")
            .unwrap()
            .choices
            .is_none()
    );
    let empty = serde_json::json!({
        "suggestion": { "title": "T", "body": "B", "choices": ["", "  "] }
    });
    assert!(
        parse_review_suggestion(&empty, "p")
            .unwrap()
            .choices
            .is_none()
    );
    assert_eq!(suggestion_choices_json(&None), serde_json::Value::Null);
}

#[test]
fn proactive_fuzzy_dedup_blocks_paraphrases() {
    // The exact key misses paraphrases; the fuzzy check must catch them while NOT
    // collapsing genuinely distinct cards (even when they share a `kind` prefix).
    let existing = vec![
        (
            "curiosità:tappo-moto".to_string(),
            "Che tappo cerchi per la moto?".to_string(),
        ),
        (
            "scadenza:contratto-acme".to_string(),
            "Contratto Acme in scadenza".to_string(),
        ),
    ];
    // Reworded anchor for the SAME thing → duplicate.
    assert!(is_semantic_duplicate(
        "curiosità:tappo-della-moto",
        "Quale tappo per la moto?",
        &existing
    ));
    // A different curiosità (shares only the kind token) → NOT a duplicate.
    assert!(!is_semantic_duplicate(
        "curiosità:vacanze-estive",
        "Dove vai in vacanza?",
        &existing
    ));
    // Distinct topic entirely → NOT a duplicate.
    assert!(!is_semantic_duplicate(
        "progetto-fermo:idra",
        "Idra è fermo",
        &existing
    ));
    // Empty board → nothing matches.
    assert!(!is_semantic_duplicate("curiosità:tappo-moto", "x", &[]));
}

#[test]
fn suggestion_lookup_preserves_durable_dedup_key() {
    let store = ChatStore::in_memory().unwrap();
    let id = store
        .insert_suggestion(&chat_store::SuggestionInput {
            scope: "project-x".to_string(),
            kind: "follow-up".to_string(),
            title: "Controlla Idra".to_string(),
            body: "Idra sembra fermo.".to_string(),
            rationale: "Nessuna attività recente.".to_string(),
            proposed_action: Some("Controllare lo stato di Idra".to_string()),
            choices: None,
            dedup_key: "follow-up:idra".to_string(),
            source_ref: "supervisor:test".to_string(),
            relevant_until: None,
        })
        .unwrap();

    let row = store.suggestion(id).unwrap().expect("suggestion");
    assert_eq!(row.dedup_key, "follow-up:idra");
    assert_eq!(row.status, "pending");
}

#[test]
fn project_path_jail_blocks_escapes() {
    let root = std::env::temp_dir();
    // Allowed: relative paths inside the project (existing or not yet created).
    assert!(jail_in_root(&root, "src/main.rs").is_ok());
    assert!(jail_in_root(&root, "a/b/c.txt").is_ok());
    // Blocked: parent-dir escapes, absolute paths, empties.
    assert!(jail_in_root(&root, "../secret").is_err());
    assert!(jail_in_root(&root, "/etc/passwd").is_err());
    assert!(jail_in_root(&root, "a/../../b").is_err());
    assert!(jail_in_root(&root, "").is_err());
}

#[test]
fn project_filesystem_mcp_instruction_binds_connected_mcp_to_thread_root() {
    let root = std::path::Path::new("/Users/fabio/Desktop/test-homun");
    let instruction = project_filesystem_mcp_instruction(Some(root), true)
        .expect("a linked project plus Filesystem MCP needs an explicit instruction");

    assert!(instruction.contains("/Users/fabio/Desktop/test-homun"));
    assert!(instruction.contains("mcp__filesystem__create"));
    assert!(instruction.contains("path-b-gate/note.md"));
    assert!(instruction.contains("call the MCP write tool anyway"));
    assert!(project_filesystem_mcp_instruction(None, true).is_none());
    assert!(project_filesystem_mcp_instruction(Some(root), false).is_none());
}

#[test]
fn tool_compatibility_fallback_is_limited_to_a_first_tool_round_bad_request() {
    assert!(should_try_tool_compatibility_fallback(400, true, false));
    assert!(!should_try_tool_compatibility_fallback(400, false, false));
    assert!(!should_try_tool_compatibility_fallback(400, true, true));
    assert!(!should_try_tool_compatibility_fallback(401, true, false));
}

#[test]
fn perimeter_classifies_calendar_and_contacts_connectors() {
    // Calendar connectors (Composio + MCP) are recognized; unrelated tools are not.
    assert!(tool_touches_calendar("GOOGLECALENDAR_EVENTS_LIST"));
    assert!(tool_touches_calendar("OUTLOOK_CALENDAR_GET_EVENT"));
    assert!(tool_touches_calendar("mcp__gcal__calendar_search"));
    assert!(!tool_touches_calendar("GMAIL_FETCH_EMAILS"));
    assert!(!tool_touches_calendar("recall_memory"));

    // Address-book connectors are recognized; calendar/mail are not "contacts".
    assert!(tool_touches_contacts("GOOGLE_CONTACTS_SEARCH_PEOPLE"));
    assert!(tool_touches_contacts("OUTLOOK_GET_CONTACT"));
    assert!(tool_touches_contacts("GOOGLE_PEOPLE_LIST"));
    assert!(!tool_touches_contacts("GOOGLECALENDAR_EVENTS_LIST"));
    assert!(!tool_touches_contacts("GMAIL_FETCH_EMAILS"));
}

#[test]
fn connector_errors_classify_into_actionable_kinds() {
    use ConnectorErrorKind::*;
    // Auth (reconnect): HTTP 401, expired tokens, no connected account.
    assert_eq!(
        classify_connector_error("HTTP 401 Unauthorized"),
        Some(Auth)
    );
    assert_eq!(classify_connector_error("token has expired"), Some(Auth));
    assert_eq!(classify_connector_error("invalid_grant"), Some(Auth));
    assert_eq!(
        classify_connector_error("no connected account for GMAIL"),
        Some(Auth)
    );
    // Rate limit (wait).
    assert_eq!(
        classify_connector_error("429 Too Many Requests"),
        Some(RateLimit)
    );
    // Forbidden (re-grant scopes).
    assert_eq!(
        classify_connector_error("403 Forbidden: missing scope"),
        Some(Forbidden)
    );
    // Unavailable (server/service down).
    assert_eq!(
        classify_connector_error("connection refused"),
        Some(Unavailable)
    );
    assert_eq!(
        classify_connector_error("ECONNREFUSED 127.0.0.1:7000"),
        Some(Unavailable)
    );
    assert_eq!(
        classify_connector_error("mcp server disconnected"),
        Some(Unavailable)
    );
    // Unknown → no hint (model just relays the raw error).
    assert_eq!(
        classify_connector_error("weird domain-specific failure"),
        None
    );

    // Both formatters produce a hint for a classified error and none otherwise,
    // with the connector-appropriate reconnect path.
    assert!(
        connector_error_hint("401")
            .unwrap()
            .contains("COMPOSIO_RECONNECT")
    );
    assert!(mcp_error_hint("401").unwrap().contains("Settings"));
    assert!(connector_error_hint("ok, all good").is_none());
    assert!(mcp_error_hint("ok, all good").is_none());
}

#[test]
fn extract_source_urls_finds_and_trims() {
    let text = "Vedi https://example.com/a, e (https://kayak.it/flights). Fine.";
    let urls = extract_source_urls(text);
    assert!(urls.contains(&"https://example.com/a".to_string()));
    assert!(urls.contains(&"https://kayak.it/flights".to_string()));
}

#[test]
fn low_value_source_urls_are_filtered() {
    // Wikipedia chrome / tracking links must never reach the Sources footer.
    assert!(is_low_value_source_url(
        "https://donate.wikimedia.org/?wmf_source=donate"
    ));
    assert!(is_low_value_source_url(
        "https://en.wikipedia.org/w/index.php?title=2026_FIFA_World_Cup&action=history"
    ));
    assert!(is_low_value_source_url(
        "https://www.fifa.com/data-protection-portal/cookie-policy"
    ));
    // Real content sources are kept.
    assert!(!is_low_value_source_url(
        "https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage"
    ));
    assert!(!is_low_value_source_url(
        "https://www.gazzetta.it/calcio/mondiali/"
    ));
}

#[test]
fn fonti_section_skips_when_already_cited() {
    let sources = vec!["https://example.com".to_string()];
    assert!(fonti_section(&sources, "Answer\n\n**Sources**\n- x").is_none());
    assert!(fonti_section(&[], "Answer").is_none());
    assert!(fonti_section(&sources, "Answer").is_some());
}

#[test]
fn memory_block_is_none_when_empty_or_zero_budget() {
    assert!(format_memory_block(&[], &[], &[], 1500).is_none());
    let some = vec!["Preferisce risposte concise".to_string()];
    assert!(format_memory_block(&[], &some, &[], 0).is_none());
}

// ── Canonical plan (the loop fix) ───────────────────────────────────────
fn sent_step(title: &str, status: &str) -> serde_json::Value {
    serde_json::json!({ "title": title, "status": status })
}

#[test]
fn answer_concludes_plan_only_when_substantial_and_last_step_open() {
    // Substantial answer + at most the last step open → stop nudging (the model finished
    // and forgot to mark done).
    assert!(super::answer_concludes_plan(1, 600));
    assert!(super::answer_concludes_plan(0, 1200));
    // Short answer → keep nudging even with one step open (could be an aside).
    assert!(!super::answer_concludes_plan(1, 599));
    // Several steps still open → it genuinely stopped early, keep nudging.
    assert!(!super::answer_concludes_plan(2, 5000));
}

#[test]
fn hitl_choice_resume_binds_semantic_without_new_objective() {
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("ws_hitl")
        .expect("thread");
    let thread_id = thread.thread_id.clone();
    {
        let store = state.chat_store.lock().unwrap();
        let payload = serde_json::json!({
            "question": "Which?",
            "multi": false,
            "options": ["Alpha", "Beta"]
        });
        let open_work = serde_json::json!({
            "browser_session_live": true,
            "capability_hint": "browse"
        });
        store
            .set_open_hitl_wait(
                "wait_test",
                &thread_id,
                "msg_src",
                "choice",
                &payload.to_string(),
                &open_work.to_string(),
            )
            .expect("persist wait");
    }

    let decision = super::resolve_semantic_decision(&state, Some(&thread_id), "Alpha", None, None);
    assert_eq!(
        decision.decision.steering_disposition,
        super::semantic_decision::SteeringDisposition::ContinueCurrentWork
    );
    assert_eq!(
        decision.decision.relationship_to_active_objective,
        super::semantic_decision::ObjectiveRelationship::SameObjective
    );
    assert_eq!(
        decision.provenance.validator_rejection_code.as_deref(),
        Some(super::hitl_resume::HITL_RESUME_CODE)
    );
    assert!(
        state
            .hitl_resume_by_thread
            .lock()
            .unwrap()
            .contains_key(&thread_id)
    );
    assert!(
        state
            .chat_store
            .lock()
            .unwrap()
            .open_hitl_wait(&thread_id)
            .unwrap()
            .is_some()
    );
}

#[test]
fn taking_hitl_resume_context_marks_wait_resolved() {
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("ws_hitl_take")
        .expect("thread");
    let thread_id = thread.thread_id.clone();
    {
        let store = state.chat_store.lock().unwrap();
        let payload = serde_json::json!({
            "question": "Which?",
            "multi": false,
            "options": ["Alpha", "Beta"]
        });
        store
            .set_open_hitl_wait(
                "wait_take",
                &thread_id,
                "msg_src",
                "choice",
                &payload.to_string(),
                "{}",
            )
            .expect("persist wait");
    }

    let _ = super::resolve_semantic_decision(&state, Some(&thread_id), "Alpha", None, None);
    let context = super::take_hitl_resume_turn_context(&state, Some(&thread_id));

    assert!(context.is_some());
    assert!(
        state
            .chat_store
            .lock()
            .unwrap()
            .open_hitl_wait(&thread_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn turn_outcome_awaiting_user_persists_free_wait_without_marker_parts() {
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("ws_hitl_outcome")
        .expect("thread");
    let thread_id = thread.thread_id.clone();
    let assistant = super::channel_chat_message_with_id("assistant", "", "assistant_hitl_outcome");
    state
        .chat_store
        .lock()
        .unwrap()
        .append_assistant_message(&thread_id, &assistant)
        .expect("assistant message");

    let outcome = local_first_engine::TurnOutcome {
        stop: local_first_engine::TurnStop::SuspendedUser,
        memory_answer: "Pick one.".to_string(),
        awaiting_user: Some(local_first_engine::hitl::HitlEnvelope {
            kind: local_first_engine::hitl::HitlKind::Choice,
            hold_policy: local_first_engine::hitl::HoldPolicy::Free,
            payload: serde_json::json!({
                "question": "Which option?",
                "multi": false,
                "options": ["Alpha", "Beta"]
            }),
            source_marker: "CHOICES".to_string(),
        }),
        ..local_first_engine::TurnOutcome::default()
    };

    super::persist_hitl_wait_from_outcome(&state, &thread_id, &assistant.id, &outcome)
        .expect("persist typed wait");

    let wait = state
        .chat_store
        .lock()
        .unwrap()
        .open_hitl_wait(&thread_id)
        .unwrap()
        .expect("open wait");
    assert_eq!(wait.kind, super::hitl_resume::HitlWaitKind::Choice);
    assert_eq!(wait.source_message_id, assistant.id);
    assert_eq!(wait.payload["options"][0], "Alpha");
}

#[test]
fn typed_hitl_wait_persistence_fails_closed_when_runtime_state_is_unavailable() {
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("ws_hitl_fail_closed")
        .expect("thread");
    let assistant =
        super::channel_chat_message_with_id("assistant", "", "assistant_hitl_fail_closed");
    state
        .chat_store
        .lock()
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .expect("assistant message");
    let outcome = local_first_engine::TurnOutcome {
        stop: local_first_engine::TurnStop::SuspendedUser,
        awaiting_user: Some(local_first_engine::hitl::HitlEnvelope {
            kind: local_first_engine::hitl::HitlKind::Choice,
            hold_policy: local_first_engine::hitl::HoldPolicy::Free,
            payload: serde_json::json!({
                "question": "Which option?",
                "multi": false,
                "options": ["Alpha", "Beta"]
            }),
            source_marker: "CHOICES".to_string(),
        }),
        ..local_first_engine::TurnOutcome::default()
    };
    let task_store = state.task_store.clone();
    std::thread::spawn(move || {
        let _guard = task_store.lock().expect("task store");
        panic!("poison task store for fail-closed test");
    })
    .join()
    .expect_err("poisoning thread must panic");

    let error =
        super::persist_hitl_wait_from_outcome(&state, &thread.thread_id, &assistant.id, &outcome)
            .expect_err("missing runtime state must keep HITL projection pending");

    assert!(error.contains("task store unavailable"));
    assert!(
        state
            .chat_store
            .lock()
            .unwrap()
            .open_hitl_wait(&thread.thread_id)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn channel_projection_replays_completed_receipt_without_sending_again() {
    let state = super::AppState::for_tests();
    let thread = {
        let store = state.chat_store.lock().expect("chat store");
        let thread = store
            .find_or_create_channel_thread("workspace-1", "telegram", "sender-1", "Telegram sender")
            .expect("channel thread");
        store
            .set_channel_thread_recipient(&thread.thread_id, "recipient-1")
            .expect("channel recipient");
        thread
    };
    let mut task = local_first_task_runtime::TaskRecord::new(
        "turn-channel-replay-1",
        local_first_task_runtime::UserId::new("user-1"),
        local_first_task_runtime::WorkspaceId::new("workspace-1"),
        "chat_turn",
        "reply",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "source": "channel",
            "approval": "read_only",
        }),
    );
    task.status = local_first_task_runtime::TaskStatus::Running;
    task.lease_owner = Some("worker-1".to_string());
    let contract: local_first_execution_protocol::ValidatedExecutionContract =
        local_first_execution_protocol::ExecutionContract::new(
            "turn-channel-replay-1",
            "chat_turn",
            local_first_execution_protocol::ExecutionScope {
                user_id: "user-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                thread_id: Some(thread.thread_id.clone()),
            },
            serde_json::to_value(task).expect("task"),
        )
        .try_into()
        .expect("contract");
    state
        .task_store
        .lock()
        .expect("task store")
        .create_execution(&contract)
        .expect("execution");
    let outcome = local_first_execution_protocol::ValidatedExecutionOutcome::new(
        local_first_execution_protocol::ExecutionOutcome::completed(
            serde_json::json!({"answer": "Delivered answer"}),
        ),
        &contract,
    )
    .expect("outcome");
    let projection_claim = {
        let store = state.task_store.lock().expect("task store");
        store
            .commit_execution_outcome(&outcome)
            .expect("commit outcome");
        store
            .claim_projection("chat_lifecycle", "projector", 1, 1)
            .expect("claim projection")
            .expect("pending projection")
    };
    let host = super::effect_host::EffectHost::for_projection(
        state.task_store.as_ref(),
        &contract,
        &projection_claim,
    );
    let super::effect_host::EffectDecision::Execute(lease) = host
        .begin(super::channel_reply_effect_request(
            &contract,
            &thread.thread_id,
            "telegram",
            "recipient-1",
            "Delivered answer",
        ))
        .expect("channel claim")
    else {
        panic!("first channel projection must execute");
    };
    let receipt_ref = lease.receipt_ref().clone();
    host.complete(
        &lease,
        &serde_json::json!({"delivered": true}),
        &serde_json::json!({"channel": "telegram"}),
    )
    .expect("complete");

    let delivery = super::mirror_reply_to_channel_if_any(
        &state,
        &contract,
        Some(&projection_claim),
        &thread.thread_id,
        "Delivered answer",
    )
    .await
    .expect("replay completed delivery");

    let super::ChannelProjectionDelivery::Delivered(delivery) = delivery else {
        panic!("channel delivery must be completed");
    };

    assert_eq!(delivery["status"], "completed");
    assert_eq!(delivery["receipt_ref"], receipt_ref.as_ref());
}

#[test]
fn hitl_clarify_resume_binds_any_non_empty_reply() {
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("ws_hitl_clarify")
        .expect("thread");
    let thread_id = thread.thread_id.clone();
    {
        let store = state.chat_store.lock().unwrap();
        let payload = serde_json::json!({
            "question": "Passenger details?",
            "fields": ["name", "email"]
        });
        let open_work = serde_json::json!({
            "browser_session_live": true,
            "capability_hint": "browse"
        });
        store
            .set_open_hitl_wait(
                "wait_clarify",
                &thread_id,
                "msg_src",
                "clarify",
                &payload.to_string(),
                &open_work.to_string(),
            )
            .expect("persist wait");
    }

    let decision = super::resolve_semantic_decision(
        &state,
        Some(&thread_id),
        "Mario Rossi, mario@example.com",
        None,
        None,
    );
    assert_eq!(
        decision.decision.steering_disposition,
        super::semantic_decision::SteeringDisposition::ContinueCurrentWork
    );
    assert_eq!(
        decision.provenance.validator_rejection_code.as_deref(),
        Some(super::hitl_resume::HITL_RESUME_CODE)
    );
    assert!(
        state
            .hitl_resume_by_thread
            .lock()
            .unwrap()
            .contains_key(&thread_id)
    );
}

#[test]
fn browse_subagent_prompt_prefers_result_card_over_duplicate_cta_labels() {
    let prompt = super::browse_subagent_system_prompt(true);
    assert!(prompt.contains("SELECTING A RESULT"));
    assert!(prompt.contains("unnamed `button [ref=…]`"));
    assert!(prompt.contains("Continua"));
    assert!(prompt.contains("SCELTA VIAGGIO"));
}

#[test]
fn browse_subagent_prompt_exposes_its_terminal_tool() {
    let prompt = super::browse_subagent_system_prompt(false);
    assert!(prompt.contains("ONLY these tools:"));
    assert!(prompt.contains("browser_done"));
    assert!(prompt.contains("calling browser_done"));
}

#[test]
fn browse_subagent_prompt_keeps_direct_url_goals_on_opened_page() {
    let prompt = super::browse_subagent_system_prompt(true);
    assert!(prompt.contains("\"open <url>\""));
    assert!(prompt.contains("\"Apri <url>\""));
    assert!(prompt.contains("Do NOT search"));
    assert!(prompt.contains("use browser_act on the opened page"));
}

#[test]
fn read_only_browse_subagent_does_not_see_rehydrate() {
    let names = super::browse_subagent_tool_schemas(true, None)
        .iter()
        .filter_map(|schema| {
            schema
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    assert!(!names.iter().any(|name| name == "browser_rehydrate"));
    assert!(!super::browse_subagent_system_prompt(false).contains("browser_rehydrate"));

    let writable_names = super::browse_subagent_tool_schemas(false, None)
        .iter()
        .filter_map(|schema| {
            schema
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    assert!(
        writable_names
            .iter()
            .any(|name| name == "browser_rehydrate")
    );
}

// Stand-in for the OS-keychain-held vault wrap key; injected so vault tests
// exercise the syskey crypto without touching the real keychain.
const TEST_VAULT_WRAP_KEY: [u8; 32] = [7u8; 32];

#[test]
fn vault_record_from_proposal_creates_metadata_only_record() {
    let request = super::VaultProposalActionRequest {
        category: "payments".to_string(),
        label: "Carta personale".to_string(),
        redacted_preview: "[VAULT:payments:card:last4=1111]".to_string(),
        secret_value: None,
        pending_id: None,
        pin: None,
        thread_id: Some("thread_1".to_string()),
        message_id: Some("msg_1".to_string()),
        resolution: None,
        record_id: None,
    };
    let record = super::vault_record_from_proposal(&request).expect("record");
    assert_eq!(record.category, local_first_vault::VaultCategory::Payments);
    assert_eq!(record.label, "Carta personale");
    assert_eq!(
        record.metadata["redacted_preview"],
        "[VAULT:payments:card:last4=1111]"
    );
    assert_eq!(record.metadata["source"], "vault_propose");
    assert_eq!(record.metadata["thread_id"], "thread_1");
    assert_eq!(record.metadata["message_id"], "msg_1");
    assert_eq!(record.secret_ref.provider_id(), "vault");
    assert_eq!(record.secret_ref.connection_id(), record.id.as_str());
}

#[test]
fn vault_proposal_accept_encrypts_secret_value_when_pin_is_provided() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let setup = super::VaultPinSetupRequest {
        pin: "123456".to_string(),
        current_pin: None,
    };
    super::apply_vault_pin_setup(&vault, &TEST_VAULT_WRAP_KEY, &setup).expect("setup pin");
    let request = super::VaultProposalActionRequest {
        category: "payments".to_string(),
        label: "Carta personale".to_string(),
        redacted_preview: "[VAULT:payments:card:last4=1111]".to_string(),
        secret_value: Some("4111111111111111".to_string()),
        pending_id: None,
        pin: Some("123456".to_string()),
        thread_id: Some("thread_1".to_string()),
        message_id: Some("msg_1".to_string()),
        resolution: None,
        record_id: None,
    };

    let response =
        super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request).expect("accept");
    let record_id = response.record_id.parse().unwrap();
    let key = vault
        .unlock_local_master_key_system(&TEST_VAULT_WRAP_KEY)
        .expect("master key");
    let secret = vault
        .get_secret_material(&record_id, &key)
        .expect("encrypted secret")
        .expect("saved secret");

    assert_eq!(secret.expose_utf8().unwrap(), "4111111111111111");
    let saved = local_first_vault::VaultStore::get(&vault, &record_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        saved.metadata["redacted_preview"],
        "[VAULT:payments:card:last4=1111]"
    );
    assert!(!saved.metadata.to_string().contains("4111111111111111"));
}

#[test]
fn vault_proposal_accept_migrates_legacy_pin_without_master_key() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let verifier = local_first_vault::LocalPinVerifier::create("123456").unwrap();
    vault.set_local_pin_verifier(verifier).unwrap();
    let request = super::VaultProposalActionRequest {
        category: "identity".to_string(),
        label: "Codice Fiscale".to_string(),
        redacted_preview: "[VAULT:identity:fiscal_code]".to_string(),
        secret_value: Some("CNTFBA76L16F839Y".to_string()),
        pending_id: None,
        pin: Some("123456".to_string()),
        thread_id: None,
        message_id: None,
        resolution: None,
        record_id: None,
    };

    let response =
        super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request).expect("accept");

    let record_id = response.record_id.parse().unwrap();
    let key = vault
        .unlock_local_master_key_system(&TEST_VAULT_WRAP_KEY)
        .expect("master key");
    let secret = vault
        .get_secret_material(&record_id, &key)
        .expect("encrypted secret")
        .expect("saved secret");
    assert_eq!(secret.expose_utf8().unwrap(), "CNTFBA76L16F839Y");
}

#[test]
fn vault_record_summary_lists_redacted_metadata_and_delete_removes_record() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let request = super::VaultProposalActionRequest {
        category: "payments".to_string(),
        label: "Carta personale".to_string(),
        redacted_preview: "[VAULT:payments:card:last4=1111]".to_string(),
        secret_value: None,
        pending_id: None,
        pin: None,
        thread_id: Some("thread_1".to_string()),
        message_id: Some("msg_1".to_string()),
        resolution: None,
        record_id: None,
    };
    let response =
        super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request).expect("accept");
    let summaries = vault
        .list()
        .expect("list")
        .into_iter()
        .map(super::vault_record_summary)
        .collect::<Vec<_>>();

    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].id, response.record_id);
    assert_eq!(summaries[0].category, "payments");
    assert_eq!(summaries[0].label, "Carta personale");
    assert_eq!(
        summaries[0].redacted_preview,
        "[VAULT:payments:card:last4=1111]"
    );
    assert!(
        !serde_json::to_string(&summaries)
            .unwrap()
            .contains("secret_ref")
    );

    let record_id = response.record_id.parse().unwrap();
    vault.delete(&record_id).expect("delete");
    assert!(vault.list().expect("list after delete").is_empty());
}

#[test]
fn vault_metadata_matches_saved_record_without_secret_material() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let request = super::VaultProposalActionRequest {
        category: "identity".to_string(),
        label: "Codice Fiscale".to_string(),
        redacted_preview: "[VAULT:identity:fiscal_code]".to_string(),
        secret_value: Some("CNTFBA76L16F839Y".to_string()),
        pending_id: None,
        pin: Some("123456".to_string()),
        thread_id: None,
        message_id: None,
        resolution: None,
        record_id: None,
    };
    super::apply_vault_pin_setup(
        &vault,
        &TEST_VAULT_WRAP_KEY,
        &super::VaultPinSetupRequest {
            pin: "123456".to_string(),
            current_pin: None,
        },
    )
    .expect("pin");
    super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request).expect("accept");

    let found =
        super::search_vault_records(&vault, "qual è il mio codice fiscale", 5).expect("search");
    let json = serde_json::to_string(&found).unwrap();

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].label, "Codice Fiscale");
    assert_eq!(found[0].category, "identity");
    assert!(json.contains("[VAULT:identity:fiscal_code]"));
    assert!(!json.contains("CNTFBA76L16F839Y"));
}

#[test]
fn recall_memory_falls_back_to_vault_metadata_without_exposing_tool_or_secret() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    super::apply_vault_pin_setup(
        &vault,
        &TEST_VAULT_WRAP_KEY,
        &super::VaultPinSetupRequest {
            pin: "123456".to_string(),
            current_pin: None,
        },
    )
    .expect("pin");
    let request = super::VaultProposalActionRequest {
        category: "identity".to_string(),
        label: "Codice Fiscale".to_string(),
        redacted_preview: "[VAULT:identity:fiscal_code]".to_string(),
        secret_value: Some("CNTFBA76L16F839Y".to_string()),
        pending_id: None,
        pin: Some("123456".to_string()),
        thread_id: None,
        message_id: None,
        resolution: None,
        record_id: None,
    };
    super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request).expect("accept");

    let answer = super::recall_memory_response_with_vault_fallback(
        &vault,
        "qual è il mio codice fiscale",
        Vec::new(),
        false,
        true,
    );

    assert!(answer.contains("No memories relevant"));
    assert!(answer.contains("Vault records matching"));
    assert!(answer.contains(super::VAULT_REVEAL_OPEN));
    assert!(answer.contains("Codice Fiscale"));
    assert!(answer.contains("[VAULT:identity:fiscal_code]"));
    assert!(!answer.contains("CNTFBA76L16F839Y"));
}

#[test]
fn vault_intent_is_required_before_emitting_a_reveal_card() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    super::apply_vault_pin_setup(
        &vault,
        &TEST_VAULT_WRAP_KEY,
        &super::VaultPinSetupRequest {
            pin: "123456".to_string(),
            current_pin: None,
        },
    )
    .expect("pin");
    let request = super::VaultProposalActionRequest {
        category: "identity".to_string(),
        label: "Codice Fiscale".to_string(),
        redacted_preview: "[VAULT:identity:fiscal_code]".to_string(),
        secret_value: Some("CNTFBA76L16F839Y".to_string()),
        pending_id: None,
        pin: Some("123456".to_string()),
        thread_id: None,
        message_id: None,
        resolution: None,
        record_id: None,
    };
    super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request).expect("accept");

    let metadata_only = super::recall_memory_response_with_vault_fallback(
        &vault,
        "qual è il mio codice fiscale",
        Vec::new(),
        false,
        false,
    );
    let reveal = super::recall_memory_response_with_vault_fallback(
        &vault,
        "qual è il mio codice fiscale",
        Vec::new(),
        false,
        true,
    );

    assert!(metadata_only.contains("Codice Fiscale"));
    assert!(!metadata_only.contains(super::VAULT_REVEAL_OPEN));
    assert!(reveal.contains(super::VAULT_REVEAL_OPEN));
    assert!(!reveal.contains("CNTFBA76L16F839Y"));
}

#[test]
fn vault_reveal_marker_is_appended_when_model_omits_it() {
    let marker = "‹‹VAULT_REVEAL››{\"record_id\":\"vault_1\",\"category\":\"identity\",\"label\":\"Codice Fiscale\",\"redacted_preview\":\"[VAULT:identity:fiscal_code]\"}‹‹/VAULT_REVEAL››";

    let added = super::append_vault_reveal_marker_if_missing(
        "Il dato è nel Vault.".to_string(),
        Some(marker),
    );
    assert!(added.contains(marker));

    let unchanged = super::append_vault_reveal_marker_if_missing(added.clone(), Some(marker));
    assert_eq!(unchanged.matches(super::VAULT_REVEAL_OPEN).count(), 1);
    assert_eq!(
        super::extract_vault_reveal_marker(&added).as_deref(),
        Some(marker)
    );
}

#[test]
fn recall_memory_still_offers_vault_reveal_when_memory_mentions_record() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    super::apply_vault_pin_setup(
        &vault,
        &TEST_VAULT_WRAP_KEY,
        &super::VaultPinSetupRequest {
            pin: "123456".to_string(),
            current_pin: None,
        },
    )
    .expect("pin");
    let request = super::VaultProposalActionRequest {
        category: "identity".to_string(),
        label: "Codice Fiscale".to_string(),
        redacted_preview: "[VAULT:identity:fiscal_code]".to_string(),
        secret_value: Some("CNTFBA76L16F839Y".to_string()),
        pending_id: None,
        pin: Some("123456".to_string()),
        thread_id: None,
        message_id: None,
        resolution: None,
        record_id: None,
    };
    super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request).expect("accept");

    let answer = super::recall_memory_response_with_vault_fallback(
        &vault,
        "codice fiscale",
        vec!["- [episode] Il codice fiscale è nel Vault.".to_string()],
        false,
        true,
    );

    assert!(answer.contains("Relevant memories from memory"));
    assert!(answer.contains(super::VAULT_REVEAL_OPEN));
    assert!(!answer.contains("CNTFBA76L16F839Y"));
}

#[test]
fn memory_recall_timing_trace_is_stable_and_redacted() {
    let timing = super::MemoryRecallTiming {
        lock_wait_ms: 3,
        profile_ms: 5,
        open_loops_ms: 7,
        fts_ms: 11,
        query_embedding_ms: Some(13),
        query_embedding_cache_hit: true,
        query_embedding_timed_out: false,
        vector_scan_ms: Some(17),
        graph_context_ms: 19,
        total_ms: 23,
        vector_candidates: 29,
        fts_candidates: 31,
        degraded: true,
    };

    let line = super::memory_recall_timing_trace_line(&timing);

    assert!(line.starts_with("memory recall:"));
    assert!(line.contains("total_ms=23"));
    assert!(line.contains("lock_wait_ms=3"));
    assert!(line.contains("query_embedding_ms=13"));
    assert!(line.contains("query_embedding_cache_hit=true"));
    assert!(line.contains("query_embedding_timed_out=false"));
    assert!(line.contains("vector_candidates=29"));
    assert!(line.contains("fts_candidates=31"));
    assert!(line.contains("degraded=true"));
    assert!(!line.contains("codice"));
    assert!(!line.contains("fiscale"));
}

#[test]
fn vault_record_update_changes_metadata_without_touching_secret_material() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let setup = super::VaultPinSetupRequest {
        pin: "123456".to_string(),
        current_pin: None,
    };
    super::apply_vault_pin_setup(&vault, &TEST_VAULT_WRAP_KEY, &setup).expect("setup pin");
    let request = super::VaultProposalActionRequest {
        category: "payments".to_string(),
        label: "Carta personale".to_string(),
        redacted_preview: "[VAULT:payments:card:last4=1111]".to_string(),
        secret_value: Some("4111111111111111".to_string()),
        pending_id: None,
        pin: Some("123456".to_string()),
        thread_id: Some("thread_1".to_string()),
        message_id: Some("msg_1".to_string()),
        resolution: None,
        record_id: None,
    };
    let response =
        super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request).expect("accept");
    let record_id = response.record_id.parse().unwrap();
    let update = super::VaultRecordUpdateRequest {
        category: "private_notes".to_string(),
        label: "Carta backup".to_string(),
        secret_value: None,
        pin: None,
    };

    let updated = super::update_vault_record(&vault, &TEST_VAULT_WRAP_KEY, &record_id, &update)
        .expect("update metadata");

    assert!(updated.ok);
    assert_eq!(updated.record.id, response.record_id);
    assert_eq!(updated.record.category, "private_notes");
    assert_eq!(updated.record.label, "Carta backup");
    assert_eq!(
        updated.record.redacted_preview,
        "[VAULT:payments:card:last4=1111]"
    );
    let key = vault
        .unlock_local_master_key_system(&TEST_VAULT_WRAP_KEY)
        .expect("master key");
    let secret = vault
        .get_secret_material(&record_id, &key)
        .expect("encrypted secret")
        .expect("saved secret");
    assert_eq!(secret.expose_utf8().unwrap(), "4111111111111111");
    let saved = local_first_vault::VaultStore::get(&vault, &record_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        saved.category,
        local_first_vault::VaultCategory::PrivateNotes
    );
    assert_eq!(saved.label, "Carta backup");
    assert!(!saved.metadata.to_string().contains("4111111111111111"));
}

#[test]
fn vault_record_reveal_and_update_secret_require_pin() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let setup = super::VaultPinSetupRequest {
        pin: "123456".to_string(),
        current_pin: None,
    };
    super::apply_vault_pin_setup(&vault, &TEST_VAULT_WRAP_KEY, &setup).expect("setup pin");
    let request = super::VaultProposalActionRequest {
        category: "identity".to_string(),
        label: "Codice Fiscale".to_string(),
        redacted_preview: "[VAULT:identity:Codice Fiscale]".to_string(),
        secret_value: Some("CNTFBA76L16F839Y".to_string()),
        pending_id: None,
        pin: Some("123456".to_string()),
        thread_id: None,
        message_id: None,
        resolution: None,
        record_id: None,
    };
    let response =
        super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request).expect("accept");
    let record_id = response.record_id.parse().unwrap();

    let revealed = super::reveal_vault_record_secret(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &record_id,
        &super::VaultRecordRevealRequest {
            pin: "123456".to_string(),
        },
    )
    .expect("reveal");

    assert_eq!(revealed.record.label, "Codice Fiscale");
    assert_eq!(revealed.secret_value, "CNTFBA76L16F839Y");
    let wrong_pin = super::reveal_vault_record_secret(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &record_id,
        &super::VaultRecordRevealRequest {
            pin: "000000".to_string(),
        },
    )
    .expect_err("wrong pin rejected");
    assert_eq!(wrong_pin.code, "invalid_vault_pin");
    let update = super::VaultRecordUpdateRequest {
        category: "identity".to_string(),
        label: "Codice Fiscale corretto".to_string(),
        secret_value: Some("CNTFBA76L16F839Z".to_string()),
        pin: Some("123456".to_string()),
    };
    let updated = super::update_vault_record(&vault, &TEST_VAULT_WRAP_KEY, &record_id, &update)
        .expect("update");

    assert_eq!(updated.record.label, "Codice Fiscale corretto");
    let revealed = super::reveal_vault_record_secret(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &record_id,
        &super::VaultRecordRevealRequest {
            pin: "123456".to_string(),
        },
    )
    .expect("reveal updated");
    assert_eq!(revealed.secret_value, "CNTFBA76L16F839Z");
}

#[test]
fn vault_proposal_accept_stores_pending_value_without_pin_and_consumes_it() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    super::apply_vault_pin_setup(
        &vault,
        &TEST_VAULT_WRAP_KEY,
        &super::VaultPinSetupRequest {
            pin: "123456".to_string(),
            current_pin: None,
        },
    )
    .expect("pin");
    let pending = super::privacy_guard::PendingVaultProposalStore::default();
    let pending_id = pending.insert(super::privacy_guard::PendingVaultProposal {
        category: "vehicles".to_string(),
        label: "Targa auto".to_string(),
        redacted_preview: "[VAULT:vehicles:plate]".to_string(),
        secret_value: "FM470BN".to_string(),
    });
    let request = super::VaultProposalActionRequest {
        category: "vehicles".to_string(),
        label: "Targa auto".to_string(),
        redacted_preview: "[VAULT:vehicles:plate]".to_string(),
        secret_value: None,
        pending_id: Some(pending_id.clone()),
        pin: None,
        thread_id: None,
        message_id: None,
        resolution: None,
        record_id: None,
    };

    let response =
        super::accept_vault_proposal(&vault, Some(&pending), &TEST_VAULT_WRAP_KEY, &request)
            .expect("accept");
    assert_eq!(response.status, "created");
    // The value is stored immediately with NO PIN, and the pending is consumed
    // — closing the idempotency gap that let a re-accept create a duplicate.
    assert!(pending.get(&pending_id).is_none());

    let record_id = response.record_id.parse().unwrap();
    let revealed = super::reveal_vault_record_secret(
        &vault,
        Some(&pending),
        &TEST_VAULT_WRAP_KEY,
        &record_id,
        &super::VaultRecordRevealRequest {
            pin: "123456".to_string(),
        },
    )
    .expect("reveal");
    assert_eq!(revealed.secret_value, "FM470BN");
}

#[test]
fn vault_save_is_idempotent_across_preview_drift() {
    // Regression: the dedup identity must NOT depend on `redacted_preview`, a
    // model-generated marker. The same logical secret (same category+label+value)
    // proposed twice with a DRIFTED preview must resolve to Ignore, not a second
    // record and not a spurious conflict.
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let first = super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "identity",
            "Codice Fiscale",
            "[VAULT:identity:fiscal_code]",
            Some("RSSMRA80A01H501U"),
        ),
    )
    .expect("first save");
    assert_eq!(first.status, "created");

    // Same (category, label, value), DIFFERENT model-generated preview/marker.
    let second = super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "identity",
            "Codice Fiscale",
            "[VAULT:identity:cf:tax_id]",
            Some("RSSMRA80A01H501U"),
        ),
    )
    .expect("second save");
    assert_eq!(second.status, "ignored");
    assert_eq!(second.record_id, first.record_id);
    assert_eq!(vault.list().unwrap().len(), 1);
}

#[test]
fn vault_pending_match_tolerates_preview_drift() {
    // A pending proposal whose stored `redacted_preview` differs from the request's
    // (cosmetic, model-generated) must still save — matched on (category, label).
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let pending = super::privacy_guard::PendingVaultProposalStore::default();
    let pending_id = pending.insert(super::privacy_guard::PendingVaultProposal {
        category: "vehicles".to_string(),
        label: "Targa auto".to_string(),
        redacted_preview: "[VAULT:vehicles:plate]".to_string(),
        secret_value: "FM470BN".to_string(),
    });
    let request = super::VaultProposalActionRequest {
        category: "vehicles".to_string(),
        label: "Targa auto".to_string(),
        // Drifted preview vs the pending's stored marker.
        redacted_preview: "[VAULT:vehicles:license_plate]".to_string(),
        secret_value: None,
        pending_id: Some(pending_id.clone()),
        pin: None,
        thread_id: None,
        message_id: None,
        resolution: None,
        record_id: None,
    };

    let response =
        super::accept_vault_proposal(&vault, Some(&pending), &TEST_VAULT_WRAP_KEY, &request)
            .expect("save tolerates preview drift");
    assert_eq!(response.status, "created");
    assert!(pending.get(&pending_id).is_none());
}

// ---- Part C: dedup on save, now that vault values are system-readable ----

/// Minimal accept request builder for the dedup tests (no pending, no PIN).
fn vault_action_request(
    category: &str,
    label: &str,
    redacted_preview: &str,
    secret_value: Option<&str>,
) -> super::VaultProposalActionRequest {
    super::VaultProposalActionRequest {
        category: category.to_string(),
        label: label.to_string(),
        redacted_preview: redacted_preview.to_string(),
        secret_value: secret_value.map(str::to_string),
        pending_id: None,
        pin: None,
        thread_id: None,
        message_id: None,
        resolution: None,
        record_id: None,
    }
}

fn read_secret_no_pin(vault: &local_first_vault::SQLiteVaultStore, record_id_text: &str) -> String {
    let record_id = record_id_text.parse().unwrap();
    let key = vault
        .unlock_local_master_key_system(&TEST_VAULT_WRAP_KEY)
        .expect("no-pin master key");
    vault
        .get_secret_material(&record_id, &key)
        .unwrap()
        .unwrap()
        .expose_utf8()
        .unwrap()
}

#[test]
fn vault_dedup_ignores_identical_key_and_value() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let request = vault_action_request(
        "private_notes",
        "Percorso file",
        "[VAULT:private_notes:local_file_path]",
        Some("/Users/fabio/segreto.txt"),
    );
    let first = super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request)
        .expect("first save");
    assert_eq!(first.status, "created");

    // Same key AND same value → ignored, no duplicate (the proven double-accept bug).
    let second = super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request)
        .expect("second save");
    assert_eq!(second.status, "ignored");
    assert_eq!(second.record_id, first.record_id);
    assert_eq!(vault.list().unwrap().len(), 1);
}

#[test]
fn vault_dedup_reports_key_only_conflict() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "private_notes",
            "Percorso file",
            "[VAULT:private_notes:local_file_path]",
            Some("/old/path"),
        ),
    )
    .expect("first");

    // Same category+field, DIFFERENT value → conflict("key"), nothing created.
    let conflict = super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "private_notes",
            "Percorso file",
            "[VAULT:private_notes:local_file_path]",
            Some("/new/path"),
        ),
    )
    .expect("conflict");
    assert_eq!(conflict.status, "conflict");
    assert_eq!(conflict.match_type.as_deref(), Some("key"));
    assert!(conflict.existing.is_some());
    assert_eq!(vault.list().unwrap().len(), 1);
}

#[test]
fn vault_dedup_reports_value_only_conflict() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "identity",
            "Codice Fiscale",
            "[VAULT:identity:fiscal_code]",
            Some("SHARED-SECRET"),
        ),
    )
    .expect("first");

    // Same value under a DIFFERENT key → conflict("value").
    let conflict = super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "vehicles",
            "Targa",
            "[VAULT:vehicles:plate]",
            Some("SHARED-SECRET"),
        ),
    )
    .expect("conflict");
    assert_eq!(conflict.status, "conflict");
    assert_eq!(conflict.match_type.as_deref(), Some("value"));
    assert_eq!(vault.list().unwrap().len(), 1);
}

#[test]
fn vault_dedup_creates_when_neither_key_nor_value_match() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request("identity", "CF", "[VAULT:identity:fiscal_code]", Some("A")),
    )
    .expect("first");
    let second = super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request("vehicles", "Targa", "[VAULT:vehicles:plate]", Some("B")),
    )
    .expect("second");
    assert_eq!(second.status, "created");
    assert_eq!(vault.list().unwrap().len(), 2);
}

#[test]
fn vault_conflict_resolution_add_creates_a_second_record() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "private_notes",
            "Percorso",
            "[VAULT:private_notes:local_file_path]",
            Some("/a"),
        ),
    )
    .expect("first");
    let mut add = vault_action_request(
        "private_notes",
        "Percorso",
        "[VAULT:private_notes:local_file_path]",
        Some("/b"),
    );
    add.resolution = Some("add".to_string());
    let response =
        super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &add).expect("add");
    assert_eq!(response.status, "created");
    assert_eq!(vault.list().unwrap().len(), 2);
}

#[test]
fn vault_conflict_resolution_update_overwrites_the_targeted_value() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let first = super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "private_notes",
            "Percorso",
            "[VAULT:private_notes:local_file_path]",
            Some("/old"),
        ),
    )
    .expect("first");
    let mut update = vault_action_request(
        "private_notes",
        "Percorso",
        "[VAULT:private_notes:local_file_path]",
        Some("/new"),
    );
    update.resolution = Some("update".to_string());
    update.record_id = Some(first.record_id.clone());
    let response =
        super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &update).expect("update");
    assert_eq!(response.status, "created");
    assert_eq!(vault.list().unwrap().len(), 1);
    assert_eq!(read_secret_no_pin(&vault, &first.record_id), "/new");
}

#[test]
fn vault_conflict_resolution_ignore_keeps_existing_and_creates_nothing() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let first = super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "private_notes",
            "Percorso",
            "[VAULT:private_notes:local_file_path]",
            Some("/keep"),
        ),
    )
    .expect("first");
    let mut ignore = vault_action_request(
        "private_notes",
        "Percorso",
        "[VAULT:private_notes:local_file_path]",
        Some("/discard"),
    );
    ignore.resolution = Some("ignore".to_string());
    ignore.record_id = Some(first.record_id.clone());
    let response =
        super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &ignore).expect("ignore");
    assert_eq!(response.status, "ignored");
    assert_eq!(vault.list().unwrap().len(), 1);
    assert_eq!(read_secret_no_pin(&vault, &first.record_id), "/keep");
}

#[test]
fn vault_use_path_reads_value_with_no_pin_after_syskey_save() {
    // The whole point of the refactor: the system reads a saved value with NO PIN.
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let saved = super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "identity",
            "CF",
            "[VAULT:identity:fiscal_code]",
            Some("VALUE-1"),
        ),
    )
    .expect("save without pin");
    assert_eq!(read_secret_no_pin(&vault, &saved.record_id), "VALUE-1");
}

#[test]
fn vault_legacy_pin_wrapped_blocks_no_pin_save_until_migrated() {
    // A legacy PIN-wrapped vault cannot store a NEW readable value without the
    // PIN (the master key is still PIN-locked). A save carrying the PIN migrates
    // it inline; afterwards the system stores/dedups values with no PIN.
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let verifier = local_first_vault::LocalPinVerifier::create("123456").unwrap();
    vault.set_local_pin_verifier(verifier.clone()).unwrap();
    vault
        .ensure_local_master_key(&verifier, "123456")
        .expect("legacy master key");

    let no_pin = vault_action_request("identity", "CF", "[VAULT:identity:fiscal_code]", Some("X"));
    let err = super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &no_pin)
        .expect_err("blocked before migration");
    assert_eq!(err.code, "invalid_vault_pin");

    let mut with_pin =
        vault_action_request("identity", "CF", "[VAULT:identity:fiscal_code]", Some("X"));
    with_pin.pin = Some("123456".to_string());
    let ok = super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &with_pin)
        .expect("migrated save");
    assert_eq!(ok.status, "created");
    assert_eq!(
        vault.keyring_algorithm().unwrap().as_deref(),
        Some("xchacha20poly1305-syskey-v1")
    );

    // Autonomous (no-PIN) dedup now works against the migrated vault.
    let dup = super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request("identity", "CF", "[VAULT:identity:fiscal_code]", Some("X")),
    )
    .expect("dedup with no pin");
    assert_eq!(dup.status, "ignored");
}

#[tokio::test]
async fn cors_preflight_allows_patch_for_browser_gateway_writes() {
    use axum::{
        Router,
        body::Body,
        http::{
            Request, StatusCode,
            header::{
                ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_REQUEST_HEADERS,
                ACCESS_CONTROL_REQUEST_METHOD, ORIGIN,
            },
        },
        routing::get,
    };
    use tower::ServiceExt;

    async fn ok() -> &'static str {
        "ok"
    }

    let app = Router::new()
        .route("/api/vault/records/record_1", get(ok).patch(ok))
        .layer(super::gateway_cors::cors_layer());
    let response = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/vault/records/record_1")
                .header(ORIGIN, "http://localhost:1420")
                .header(ACCESS_CONTROL_REQUEST_METHOD, "PATCH")
                .header(ACCESS_CONTROL_REQUEST_HEADERS, "authorization,content-type")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let methods = response
        .headers()
        .get(ACCESS_CONTROL_ALLOW_METHODS)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    assert!(
        methods.split(',').any(|method| method.trim() == "PATCH"),
        "allowed methods should include PATCH, got {methods:?}"
    );
}

// Resilience guard (2026-07-09): a stalled model turn once froze EVERY gateway
// endpoint — including the lock-free `/api/health` liveness probe the Electron
// watchdog relies on. `health` must never couple to a store lock: this pins that
// invariant. A background thread parks holding the chat_store lock (mimicking a
// handler/turn that owns a store while blocked); health must still answer within a
// tight deadline. If a future change makes `health` take a store lock, one worker
// blocks on the held mutex and the 2s timeout trips this test instead of shipping a
// watchdog-killing regression.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_stays_live_while_a_store_lock_is_held() {
    use axum::{Router, body::Body, http::Request, http::StatusCode, routing::get};
    use tower::ServiceExt;

    let state = super::AppState::for_tests();
    let chat_store = state.chat_store.clone();
    let (acquired_tx, acquired_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _guard = chat_store.lock().expect("hold chat_store lock");
        acquired_tx.send(()).expect("signal lock acquired");
        std::thread::sleep(std::time::Duration::from_secs(3));
    });
    // Only probe once the lock is genuinely held, so the guard is meaningful.
    acquired_rx
        .recv()
        .expect("background thread acquired the lock");

    let app = Router::new()
        .route(
            "/api/health",
            get(super::gateway_health::health::<super::AppState>),
        )
        .with_state(state);
    // The request MUST run on a separate task: if `health` were to block on the held
    // mutex, it would park a worker — and if the request ran inline on THIS task it
    // would park the very thread driving the timeout (a blocking call defeats an async
    // timeout on its own thread — the same trap as the production bug). Spawning it
    // keeps the timeout on a free worker so a regression trips instead of hanging.
    let request = tokio::spawn(async move {
        app.oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
    });
    let response = tokio::time::timeout(std::time::Duration::from_secs(2), request)
        .await
        .expect("/api/health must answer within 2s even while a store lock is held")
        .expect("health request task panicked")
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    holder.join().ok();
}

#[test]
fn vault_category_from_marker_rejects_unknown_category() {
    let error = super::vault_category_from_marker("banking").expect_err("unknown category");
    assert!(error.contains("unknown vault category"));
}

#[test]
fn vault_pin_setup_rejects_invalid_pin_values() {
    let request = super::VaultPinSetupRequest {
        pin: "12345".to_string(),
        current_pin: None,
    };

    let error = super::local_pin_verifier_from_request(&request).expect_err("short pin");
    assert!(error.contains("PIN"));
}

#[test]
fn vault_pin_verify_requires_configured_matching_pin() {
    let request = super::VaultPinSetupRequest {
        pin: "123456".to_string(),
        current_pin: None,
    };
    let verifier = super::local_pin_verifier_from_request(&request).expect("verifier");

    assert!(super::local_pin_verify_result(Some(&verifier), "123456"));
    assert!(!super::local_pin_verify_result(Some(&verifier), "654321"));
    assert!(!super::local_pin_verify_result(None, "123456"));
}

#[test]
fn vault_pin_change_requires_current_pin_when_already_configured() {
    let existing = local_first_vault::LocalPinVerifier::create("123456").unwrap();
    let replacement_without_current = super::VaultPinSetupRequest {
        pin: "654321".to_string(),
        current_pin: None,
    };
    let error = super::local_pin_setup_verifier(Some(&existing), &replacement_without_current)
        .expect_err("current pin required");
    assert!(error.contains("Current Vault PIN"));

    let replacement_with_wrong_current = super::VaultPinSetupRequest {
        pin: "654321".to_string(),
        current_pin: Some("111111".to_string()),
    };
    let error = super::local_pin_setup_verifier(Some(&existing), &replacement_with_wrong_current)
        .expect_err("current pin must match");
    assert!(error.contains("Invalid current Vault PIN"));

    let replacement_with_current = super::VaultPinSetupRequest {
        pin: "654321".to_string(),
        current_pin: Some("123456".to_string()),
    };
    let updated = super::local_pin_setup_verifier(Some(&existing), &replacement_with_current)
        .expect("valid pin change");
    assert!(updated.verify("654321"));
    assert!(!updated.verify("123456"));
}

#[test]
fn vault_pin_setup_establishes_system_wrapped_master_key_independent_of_pin() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    let first_setup = super::VaultPinSetupRequest {
        pin: "123456".to_string(),
        current_pin: None,
    };

    super::apply_vault_pin_setup(&vault, &TEST_VAULT_WRAP_KEY, &first_setup).expect("first setup");

    // New model: the master key is wrapped by the SYSTEM key, not the PIN.
    assert_eq!(
        vault.keyring_algorithm().unwrap().as_deref(),
        Some("xchacha20poly1305-syskey-v1")
    );
    let master_key = vault
        .unlock_local_master_key_system(&TEST_VAULT_WRAP_KEY)
        .expect("system master key");

    // Changing the PIN neither rotates nor re-wraps the master key: the PIN is
    // a reveal-only gate now, cryptographically independent of the master key.
    let change = super::VaultPinSetupRequest {
        pin: "654321".to_string(),
        current_pin: Some("123456".to_string()),
    };
    super::apply_vault_pin_setup(&vault, &TEST_VAULT_WRAP_KEY, &change).expect("pin change");

    assert_eq!(
        vault
            .unlock_local_master_key_system(&TEST_VAULT_WRAP_KEY)
            .expect("master key unchanged after pin change"),
        master_key
    );
    let new_verifier = vault.local_pin_verifier().unwrap().unwrap();
    assert!(new_verifier.verify("654321"));
    assert!(!new_verifier.verify("123456"));
}

#[test]
fn vault_pin_change_migrates_legacy_pin_wrapped_master_key_to_system() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    // Legacy state: a PIN-wrapped master key already exists.
    let verifier = local_first_vault::LocalPinVerifier::create("123456").unwrap();
    vault.set_local_pin_verifier(verifier.clone()).unwrap();
    let legacy_key = vault
        .ensure_local_master_key(&verifier, "123456")
        .expect("legacy master key");
    assert_eq!(
        vault.keyring_algorithm().unwrap().as_deref(),
        Some("xchacha20poly1305-pin-v1")
    );

    // A PIN change carries the current PIN, which the setup uses to migrate the
    // wrapping (pin -> syskey) exactly once, preserving the master key value.
    let change = super::VaultPinSetupRequest {
        pin: "654321".to_string(),
        current_pin: Some("123456".to_string()),
    };
    super::apply_vault_pin_setup(&vault, &TEST_VAULT_WRAP_KEY, &change).expect("legacy pin change");

    assert_eq!(
        vault.keyring_algorithm().unwrap().as_deref(),
        Some("xchacha20poly1305-syskey-v1")
    );
    assert_eq!(
        vault
            .unlock_local_master_key_system(&TEST_VAULT_WRAP_KEY)
            .expect("migrated master key"),
        legacy_key
    );
}

fn payment_snapshot() -> local_first_vault::PaymentApprovalSnapshot {
    local_first_vault::PaymentApprovalSnapshot {
        approval_id: "pay_test".to_string(),
        merchant: "Trainline".to_string(),
        domain: "www.thetrainline.com".to_string(),
        amount_minor: 5900,
        currency: "EUR".to_string(),
        product_summary: "Napoli -> Roma 2026-07-10 09:50".to_string(),
        payment_method_label: "Visa 1111".to_string(),
        checkout_fingerprint: "checkout_hash_a".to_string(),
    }
}

#[test]
fn payment_approval_marker_wraps_snapshot_payload() {
    let marker = super::payment_approval_marker(&payment_snapshot());

    assert!(marker.starts_with(super::PAYMENT_APPROVAL_OPEN));
    assert!(marker.ends_with(super::PAYMENT_APPROVAL_CLOSE));
    let parsed = super::confirm_marker_value(
        &marker,
        super::PAYMENT_APPROVAL_OPEN,
        super::PAYMENT_APPROVAL_CLOSE,
    )
    .expect("valid payment marker");
    assert_eq!(parsed["snapshot"]["approval_id"], "pay_test");
    assert_eq!(parsed["snapshot"]["amount_minor"], 5900);
    assert_eq!(parsed["snapshot"]["payment_method_label"], "Visa 1111");
}

#[test]
fn payment_approval_grant_requires_pin_and_one_shot_cvv() {
    let verifier = local_first_vault::LocalPinVerifier::create("123456").unwrap();
    let request = super::VaultPaymentApprovalRequest {
        snapshot: payment_snapshot(),
        pin: "123456".to_string(),
        cvv: "123".to_string(),
        thread_id: None,
        message_id: None,
    };

    let grant =
        super::payment_approval_grant_from_request(&request, &verifier).expect("payment grant");
    assert_eq!(grant.snapshot.approval_id, "pay_test");
    assert_eq!(grant.cvv_one_shot.as_deref(), Some("123"));

    let bad_pin = super::VaultPaymentApprovalRequest {
        pin: "654321".to_string(),
        ..request
    };
    assert!(super::payment_approval_grant_from_request(&bad_pin, &verifier).is_err());

    let bad_cvv = super::VaultPaymentApprovalRequest {
        snapshot: payment_snapshot(),
        pin: "123456".to_string(),
        cvv: "12x".to_string(),
        thread_id: None,
        message_id: None,
    };
    assert!(super::payment_approval_grant_from_request(&bad_cvv, &verifier).is_err());
}

#[test]
fn rewrite_payment_approval_removes_card_and_leaves_approved_id() {
    let marker = super::payment_approval_marker(&payment_snapshot());
    let text = format!("Riepilogo checkout.\n\n{marker}\n\nNon procedo senza conferma.");

    let rewritten = super::rewrite_payment_approval_to_done(&text, "pay_test", 300);

    assert!(rewritten.contains("Riepilogo checkout."));
    assert!(rewritten.contains("Pagamento autorizzato localmente"));
    assert!(rewritten.contains("payment_approval_id: pay_test"));
    assert!(!rewritten.contains(super::PAYMENT_APPROVAL_OPEN));
    assert!(!rewritten.contains("123"));
}

#[test]
fn payment_approval_secret_injects_cvv_once() {
    let mut approvals = std::collections::HashMap::from([(
        "pay_test".to_string(),
        super::PaymentApprovalGrant {
            snapshot: payment_snapshot(),
            cvv_one_shot: Some("123".to_string()),
            thread_id: String::new(),
            consumed: false,
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(300),
        },
    )]);
    let mut action = serde_json::json!({
        "kind": "fill",
        "ref": "e12",
        "payment_approval_id": "pay_test",
        "vault_secret": "cvv_one_shot"
    });

    assert!(super::apply_payment_approval_secret_from_map(&mut approvals, &mut action).unwrap());
    assert_eq!(action["text"], "123");
    assert!(action.get("vault_secret").is_none());

    let mut second = serde_json::json!({
        "kind": "fill",
        "ref": "e12",
        "payment_approval_id": "pay_test",
        "vault_secret": "cvv_one_shot"
    });
    assert!(super::apply_payment_approval_secret_from_map(&mut approvals, &mut second).is_err());

    let mut click = serde_json::json!({
        "kind": "click",
        "ref": "e20",
        "payment_approval_id": "pay_test",
        "vault_secret": "cvv_one_shot"
    });
    assert!(super::apply_payment_approval_secret_from_map(&mut approvals, &mut click).is_err());
}

#[test]
fn controlled_checkout_approval_flow_rewrites_transcript_and_consumes_cvv() {
    let chat = ChatStore::in_memory().expect("chat store");
    let thread = chat.create_thread("default").expect("thread");
    let snapshot = payment_snapshot();
    let marker = super::payment_approval_marker(&snapshot);
    let assistant = super::channel_chat_message_with_id(
        "assistant",
        &format!("Riepilogo checkout.\n\n{marker}\n\nAttendo approvazione."),
        "assistant_checkout",
    );
    chat.append_assistant_message(&thread.thread_id, &assistant)
        .expect("assistant message");

    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().expect("vault");
    vault
        .set_local_pin_verifier(local_first_vault::LocalPinVerifier::create("123456").unwrap())
        .expect("pin verifier");
    let mut approvals = std::collections::HashMap::new();
    let request = super::VaultPaymentApprovalRequest {
        snapshot,
        pin: "123456".to_string(),
        cvv: "123".to_string(),
        thread_id: Some(thread.thread_id.clone()),
        message_id: Some("assistant_checkout".to_string()),
    };

    let response = super::approve_payment_checkout_request(&vault, &chat, &mut approvals, request)
        .expect("approval response");

    assert_eq!(response.payment_approval_id, "pay_test");
    assert_eq!(
        response.expires_in_seconds,
        super::PAYMENT_APPROVAL_TTL_SECONDS
    );
    let rewritten = chat
        .message(&thread.thread_id, "assistant_checkout")
        .expect("message query")
        .expect("message")
        .text;
    assert!(rewritten.contains("payment_approval_id: pay_test"));
    assert!(!rewritten.contains(super::PAYMENT_APPROVAL_OPEN));
    assert!(!rewritten.contains("123456"));
    assert!(!rewritten.contains("CVV: 123"));

    // Machine floor marks e20 as the payment control — never a label match.
    let payment_floor: std::collections::HashSet<String> =
        std::collections::HashSet::from(["e20".to_string()]);
    let blocked_click =
        serde_json::json!({"kind":"click","ref":"e20","action_class":"payment_commit"});
    assert!(
        browser_safety::evaluate_browser_action(&blocked_click, &payment_floor, false, None)
            .is_some()
    );
    let approved_click = serde_json::json!({
        "kind":"click","ref":"e20","action_class":"payment_commit","payment_approval_id":"pay_test"
    });
    assert!(
        browser_safety::evaluate_browser_action(
            &approved_click,
            &payment_floor,
            false,
            Some("pay_test")
        )
        .is_none()
    );

    let mut fill_cvv = serde_json::json!({
        "kind": "fill",
        "ref": "e12",
        "payment_approval_id": "pay_test",
        "vault_secret": "cvv_one_shot"
    });
    assert!(super::apply_payment_approval_secret_from_map(&mut approvals, &mut fill_cvv).unwrap());
    assert_eq!(fill_cvv["text"], "123");
    assert!(fill_cvv.get("vault_secret").is_none());

    let mut second_fill = serde_json::json!({
        "kind": "fill",
        "ref": "e12",
        "payment_approval_id": "pay_test",
        "vault_secret": "cvv_one_shot"
    });
    assert!(
        super::apply_payment_approval_secret_from_map(&mut approvals, &mut second_fill).is_err()
    );
}

#[test]
fn payment_grant_is_thread_scoped_and_final_click_is_one_shot() {
    let mut approvals = std::collections::HashMap::from([(
        "pay_test".to_string(),
        super::PaymentApprovalGrant {
            snapshot: payment_snapshot(),
            cvv_one_shot: Some("123".to_string()),
            thread_id: "thread_1".to_string(),
            consumed: false,
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(300),
        },
    )]);
    let action = serde_json::json!({
        "kind": "click",
        "ref": "e20",
        "action_class": "payment_commit",
        "payment_approval_id": "pay_test"
    });
    let payment_floor: std::collections::HashSet<String> = std::collections::HashSet::new();

    assert!(
        super::claim_payment_approval_from_map(
            &mut approvals,
            &action,
            &payment_floor,
            false,
            Some("thread_2")
        )
        .is_err()
    );
    assert_eq!(
        super::claim_payment_approval_from_map(
            &mut approvals,
            &action,
            &payment_floor,
            false,
            Some("thread_1")
        )
        .unwrap(),
        "pay_test"
    );
    assert!(
        super::claim_payment_approval_from_map(
            &mut approvals,
            &action,
            &payment_floor,
            false,
            Some("thread_1")
        )
        .is_err()
    );
}

#[test]
fn payment_grant_survives_a_class_error_and_the_redeclared_retry_succeeds_once() {
    // Regression for the A2/A3 review finding: a committing action that
    // carries a valid, unconsumed payment_approval_id but omits (or
    // conflicts on) action_class must NOT burn the one-shot grant. Only
    // the enforcement site's CLAIM decision differs from the gate's
    // REJECT decision: the gate still fail-closed rejects a class error;
    // claiming must require a genuinely resolved PaymentCommit.
    let mut approvals = std::collections::HashMap::from([(
        "pay_test".to_string(),
        super::PaymentApprovalGrant {
            snapshot: payment_snapshot(),
            cvv_one_shot: Some("123".to_string()),
            thread_id: "thread_1".to_string(),
            consumed: false,
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(300),
        },
    )]);
    let payment_floor: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Under-declared action: a valid payment_approval_id but no
    // action_class at all (model typo / omission on a committing click).
    let missing_class_action = serde_json::json!({
        "kind": "click",
        "ref": "e20",
        "payment_approval_id": "pay_test"
    });
    assert!(
        browser_safety::effective_action_class(&missing_class_action, &payment_floor, false)
            .is_err(),
        "discriminator the fix relies on: an under-declared committing action is a class error"
    );

    // Filling the CVV field must NOT consume the one-shot grant: that fill is not the act of
    // paying, and burning the grant there made the subsequent real payment click fail with
    // "payment approval was already used" — the documented checkout flow could never complete.
    let cvv_fill = serde_json::json!({
        "kind": "fill",
        "ref": "e20",
        "vault_secret": "cvv_one_shot",
        "payment_approval_id": "pay_test",
        "action_class": "payment_commit"
    });
    assert!(
        !super::should_claim_payment_approval(&cvv_fill, &payment_floor, true),
        "a vault-secret field fill must not consume the one-shot payment grant"
    );
    // The action that actually commits the money still claims it.
    let pay_click = serde_json::json!({
        "kind": "click",
        "ref": "e20",
        "payment_approval_id": "pay_test",
        "action_class": "payment_commit"
    });
    assert!(
        super::should_claim_payment_approval(&pay_click, &payment_floor, true),
        "the committing payment action must still consume the grant (one-shot, fail-closed)"
    );

    // Enforcement-site decision: must NOT claim on a class error.
    let should_claim =
        super::should_claim_payment_approval(&missing_class_action, &payment_floor, false);
    assert!(
        !should_claim,
        "a class error must never trigger consuming the one-shot grant"
    );
    if should_claim {
        // Only reachable if the enforcement gate regresses to the old
        // `action_is_payment_commit`-based decision (which also treats a
        // class error as "payment"); mirrors the real call site so this
        // branch, if ever taken, burns the grant just like the bug did.
        let _ = super::claim_payment_approval_from_map(
            &mut approvals,
            &missing_class_action,
            &payment_floor,
            false,
            Some("thread_1"),
        );
    }

    // The gate still fail-closed rejects the action on the class error —
    // no approved id was ever produced, so nothing unauthorized executes.
    let blocked =
        browser_safety::evaluate_browser_action(&missing_class_action, &payment_floor, false, None);
    assert!(
        blocked
            .as_deref()
            .is_some_and(|reason| reason.contains("BROWSER_ACTION_CLASS_MISSING")),
        "expected a BROWSER_ACTION_CLASS_MISSING rejection, got {blocked:?}"
    );

    // The grant must still be unconsumed: the corrected retry can reuse it.
    assert!(
        !approvals.get("pay_test").unwrap().consumed,
        "grant must not be burned by a class-error action"
    );

    // A correctly re-declared retry with the SAME approval id resolves to
    // a genuine PaymentCommit and succeeds exactly once.
    let declared_payment_action = serde_json::json!({
        "kind": "click",
        "ref": "e20",
        "action_class": "payment_commit",
        "payment_approval_id": "pay_test"
    });
    assert_eq!(
        browser_safety::effective_action_class(&declared_payment_action, &payment_floor, false),
        Ok(browser_safety::ActionClass::PaymentCommit)
    );
    assert!(super::should_claim_payment_approval(
        &declared_payment_action,
        &payment_floor,
        false
    ));
    let claimed = super::claim_payment_approval_from_map(
        &mut approvals,
        &declared_payment_action,
        &payment_floor,
        false,
        Some("thread_1"),
    )
    .expect("retry should successfully claim the still-unconsumed grant");
    assert_eq!(claimed, "pay_test");
    assert!(
        browser_safety::evaluate_browser_action(
            &declared_payment_action,
            &payment_floor,
            false,
            Some(&claimed)
        )
        .is_none(),
        "declared payment_commit with matching approval id must be allowed"
    );

    // One-shot: the grant is now burned, a second attempt fails.
    assert!(
        super::claim_payment_approval_from_map(
            &mut approvals,
            &declared_payment_action,
            &payment_floor,
            false,
            Some("thread_1")
        )
        .is_err()
    );
}

#[test]
fn clickcoords_with_payment_class_is_rejected_before_the_claim_and_leaves_the_grant_unconsumed() {
    // Regression for the Important review finding on Task 1 (commit
    // eb9d877d): the single-action `browser_act` enforcement branch in
    // `execute_browser_tool` used to compute `approved_payment_id` — via
    // `should_claim_payment_approval` → `claim_payment_approval_for_action`
    // → `claim_payment_approval_from_map`, which sets `grant.consumed =
    // true` — BEFORE checking whether the action is `clickCoords`.
    // Because `effective_action_class` resolves purely from the
    // model-DECLARED `action_class` field (`kind` never enters that
    // decision), a clickCoords action carrying `action_class:
    // "payment_commit"` and a valid, unconsumed `payment_approval_id`
    // resolves to a genuine `Ok(PaymentCommit)`, so
    // `should_claim_payment_approval` said "claim it" and the grant was
    // burned — even though the action is then unconditionally rejected
    // as BROWSER_UNSUPPORTED_COMMITTING_ACTION. The coordinate click
    // never executed (good), but the Payment Approval Card was burned
    // for nothing, forcing an unnecessary re-approval.
    //
    // LIMITATION: `execute_browser_tool` is a private `async fn` that
    // needs a live `AppState`, a tokio runtime and a real/mock browser
    // session, so it cannot be driven directly by a plain `#[test]`.
    // This test instead exercises
    // `single_action_rejects_unsupported_execution_before_payment_claim` — the
    // exact function the fixed single-action branch now calls FIRST,
    // gating both `apply_payment_approval_secret_for_action` and
    // `should_claim_payment_approval`/`claim_payment_approval_for_action`
    // behind it — together with the same map-based claim helper
    // (`claim_payment_approval_from_map`) the sibling tests above use,
    // to pin the ordering invariant the fix establishes: reject BEFORE
    // claim, so the grant survives for a legitimate follow-up action.
    let mut approvals = std::collections::HashMap::from([(
        "pay_test".to_string(),
        super::PaymentApprovalGrant {
            snapshot: payment_snapshot(),
            cvv_one_shot: Some("123".to_string()),
            thread_id: "thread_1".to_string(),
            consumed: false,
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(300),
        },
    )]);
    let payment_floor: std::collections::HashSet<String> = std::collections::HashSet::new();

    // The trap: a hallucinated clickCoords action declaring
    // action_class:"payment_commit" plus a valid payment_approval_id.
    let click_coords_action = serde_json::json!({
        "kind": "clickCoords",
        "x": 120,
        "y": 240,
        "action_class": "payment_commit",
        "payment_approval_id": "pay_test"
    });

    // Discriminator the bug relied on: `kind` is irrelevant to
    // `effective_action_class`, so this payload resolves as a
    // GENUINELY claimable PaymentCommit — proving the claim call, if it
    // ran first, would succeed and burn the grant.
    assert!(
        super::should_claim_payment_approval(&click_coords_action, &payment_floor, false),
        "a clickCoords action declaring action_class:payment_commit must resolve as a \
             genuine PaymentCommit — this is exactly why the clickCoords reject must run \
             BEFORE should_claim_payment_approval/claim_payment_approval_for_action, never after"
    );
    // Confirms the claim really would burn it, on a disposable clone —
    // isolated so it never touches the `approvals` map the assertions
    // below check.
    let mut would_be_burned = approvals.clone();
    assert!(
        super::claim_payment_approval_from_map(
            &mut would_be_burned,
            &click_coords_action,
            &payment_floor,
            false,
            Some("thread_1"),
        )
        .is_ok(),
        "sanity: the trap payload is a well-formed, claimable grant"
    );
    assert!(
        would_be_burned.get("pay_test").unwrap().consumed,
        "sanity: claiming this exact payload does consume the grant when reached"
    );

    // (a) The fix: the single-action branch now checks this FIRST and
    // rejects with the typed BROWSER_UNSUPPORTED_COMMITTING_ACTION error.
    let blocked_before_claim =
        super::single_action_rejects_unsupported_execution_before_payment_claim(
            &click_coords_action,
        );
    assert_eq!(
        blocked_before_claim,
        Some(super::BROWSER_UNSUPPORTED_COMMITTING_ACTION_ERROR),
        "expected the typed BROWSER_UNSUPPORTED_COMMITTING_ACTION rejection"
    );

    // (b) Mirror the real call site's actual gate on the ORIGINAL
    // `approvals` map: `execute_browser_tool`'s single-action branch
    // only reaches should_claim_payment_approval/claim_payment_approval_for_action
    // when `blocked_before_claim.is_none()`. Threading that exact
    // condition here (rather than asserting on an untouched map) means
    // this test genuinely fails if the reorder ever regresses: dropping
    // the `blocked_before_claim.is_none()` guard — i.e. reverting to the
    // pre-fix ordering — would make this branch run the claim and burn
    // the grant, flipping the assertion below to RED.
    if blocked_before_claim.is_none()
        && super::should_claim_payment_approval(&click_coords_action, &payment_floor, false)
    {
        let _ = super::claim_payment_approval_from_map(
            &mut approvals,
            &click_coords_action,
            &payment_floor,
            false,
            Some("thread_1"),
        );
    }
    assert!(
        !approvals.get("pay_test").unwrap().consumed,
        "clickCoords must be rejected before any payment-approval claim runs; the grant \
             must survive UNCONSUMED for a subsequent legitimate action to use"
    );
}

// --- 1.3: generalized reject (non-schema kind / selector field) ---

#[test]
fn schema_legal_kinds_are_all_accepted_and_a_hallucinated_kind_is_not() {
    for kind in super::BROWSER_ACT_SCHEMA_KINDS {
        let action = serde_json::json!({"kind": kind, "ref": "e1"});
        assert!(
            super::browser_action_execution_fields_are_schema_legal(&action),
            "schema kind {kind:?} must be accepted"
        );
    }
    for bad_kind in ["clickCoords", "batch", "evaluate", "wat"] {
        let action = serde_json::json!({"kind": bad_kind, "ref": "e1"});
        assert!(
            !super::browser_action_execution_fields_are_schema_legal(&action),
            "non-schema kind {bad_kind:?} must be rejected"
        );
    }
}

#[test]
fn selector_field_is_rejected_even_on_an_otherwise_legal_kind() {
    // `selector` bypasses the ref-based floor entirely (a floored ref never has
    // to appear in the request at all), so it must be rejected regardless of an
    // otherwise-legal `kind`.
    let action = serde_json::json!({"kind": "click", "selector": "#pay-now"});
    assert!(!super::browser_action_execution_fields_are_schema_legal(
        &action
    ));
}

#[test]
fn single_action_reject_catches_non_schema_kind_and_selector_before_any_claim() {
    let hallucinated_kind =
        serde_json::json!({"kind": "wat", "ref": "e1", "action_class": "payment_commit"});
    assert_eq!(
        super::single_action_rejects_unsupported_execution_before_payment_claim(&hallucinated_kind),
        Some(super::BROWSER_UNSUPPORTED_COMMITTING_ACTION_ERROR)
    );

    let selector_action = serde_json::json!({
        "kind": "click", "selector": "#pay-now", "action_class": "payment_commit"
    });
    assert_eq!(
        super::single_action_rejects_unsupported_execution_before_payment_claim(&selector_action),
        Some(super::BROWSER_UNSUPPORTED_COMMITTING_ACTION_ERROR)
    );

    // A legitimate schema-legal single action is never rejected here.
    let legal = serde_json::json!({"kind": "click", "ref": "e1", "action_class": "ordinary"});
    assert_eq!(
        super::single_action_rejects_unsupported_execution_before_payment_claim(&legal),
        None
    );
}

#[test]
fn single_action_reject_does_not_re_reject_a_normalized_bundle() {
    // Once `normalize_browser_action_bundle` validates every item and rewrites
    // the wrapper's `kind` to its own internal "batch" marker, the single-action
    // reject-check must treat that wrapper as legitimate (it is not itself a
    // schema kind, but it is not a hallucinated one either) — distinguished by
    // the presence of the `actions` array, not by `kind`.
    let normalized_bundle = serde_json::json!({
        "kind": "batch",
        "chatBundle": true,
        "actions": [{"kind": "click", "ref": "e1", "action_class": "ordinary"}]
    });
    assert_eq!(
        super::single_action_rejects_unsupported_execution_before_payment_claim(&normalized_bundle),
        None
    );
}

#[test]
fn bundle_item_missing_action_class_reports_the_class_error_not_a_payment_error() {
    // Regression: `action_is_payment_commit` counts a class ERROR as payment (fail-closed for
    // the single-action gate), so running it before `evaluate_browser_action` masked every
    // ordinary mistake as a payment problem — a bundle item that merely forgot `action_class`
    // was told to "Ask for the Payment Approval Card", which for a search button is nonsense the
    // model cannot act on, and which the bundle log then recorded as the wrong cause.
    let payment_floor: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut bundle = serde_json::json!({
        "actions": [{"kind": "click", "ref": "e42"}]
    });
    let rejected =
        super::normalize_browser_action_bundle(&mut bundle, "chat_0", &payment_floor, false);
    let reason = rejected.expect("a committing item without action_class must be rejected");
    assert!(
        reason.contains("BROWSER_ACTION_CLASS_MISSING"),
        "the model must be told the ACTUAL problem (missing action_class), got: {reason}"
    );
    assert!(
        !reason.contains("Payment Approval Card"),
        "a missing class must not be reported as a payment error: {reason}"
    );

    // A genuine, well-formed payment_commit item still gets the payment message.
    let mut payment_bundle = serde_json::json!({
        "actions": [{"kind": "click", "ref": "e9", "action_class": "payment_commit"}]
    });
    let rejected = super::normalize_browser_action_bundle(
        &mut payment_bundle,
        "chat_0",
        &payment_floor,
        false,
    );
    assert!(
        rejected.is_some_and(|reason| reason.contains("Payment Approval Card")),
        "a real payment_commit item must still be refused inside a bundle"
    );
}

#[test]
fn bundle_item_with_selector_or_non_schema_kind_is_rejected_before_the_gate() {
    let payment_floor: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut selector_bundle = serde_json::json!({
        "actions": [{"kind": "click", "selector": "#pay-now", "action_class": "ordinary"}]
    });
    let rejected = super::normalize_browser_action_bundle(
        &mut selector_bundle,
        "chat_0",
        &payment_floor,
        false,
    );
    assert!(
        rejected.is_some_and(|reason| reason.contains("BROWSER_UNSUPPORTED_COMMITTING_ACTION"))
    );

    let mut bad_kind_bundle = serde_json::json!({
        "actions": [{"kind": "clickCoords", "x": 1, "y": 2, "action_class": "ordinary"}]
    });
    let rejected = super::normalize_browser_action_bundle(
        &mut bad_kind_bundle,
        "chat_0",
        &payment_floor,
        false,
    );
    assert!(
        rejected.is_some_and(|reason| reason.contains("BROWSER_UNSUPPORTED_COMMITTING_ACTION"))
    );

    // A schema-legal bundle is normalized (not rejected) and gets tagged "batch".
    let mut legal_bundle = serde_json::json!({
        "actions": [{"kind": "click", "ref": "e1", "action_class": "ordinary"}]
    });
    assert!(
        super::normalize_browser_action_bundle(&mut legal_bundle, "chat_0", &payment_floor, false,)
            .is_none()
    );
    assert_eq!(legal_bundle["kind"], "batch");
}

// --- 1.4: ref ∈ payment floor gates ANY kind (defense-in-depth) ---

#[test]
fn act_gate_blocks_scroll_on_a_floored_ref_regardless_of_kind() {
    // `scroll` is not in the committing set at all, but a ref the machine
    // analysis already floored must still force a declared class — defense
    // against a FUTURE (or hallucinated) kind acting on a floored control.
    let floor: std::collections::HashSet<String> =
        std::collections::HashSet::from(["e9".to_string()]);
    let action = serde_json::json!({ "kind": "scroll", "ref": "e9", "target_id": "chat_0" });
    assert!(browser_safety::evaluate_browser_action(&action, &floor, false, None).is_some());
}

// --- 1.2: per-target payment context (focus flag + robust last-acted-floored) ---

#[test]
fn per_target_context_defaults_to_false_for_an_unobserved_target() {
    let map: std::collections::HashMap<String, super::BrowserPaymentContext> =
        std::collections::HashMap::new();
    assert!(!super::browser_payment_context_for(&map, "chat_0"));
}

#[test]
fn last_acted_floored_raises_the_combined_context_for_its_target_only() {
    let mut map: std::collections::HashMap<String, super::BrowserPaymentContext> =
        std::collections::HashMap::new();
    // Acting on a floored ref on chat_0 sets ITS flag...
    super::browser_mark_target_acted_floored(&mut map, "chat_0");
    assert!(super::browser_payment_context_for(&map, "chat_0"));
    // ...and must NOT bleed into a different tab (fixes IMPORTANT D).
    assert!(!super::browser_payment_context_for(&map, "chat_1"));
}

#[test]
fn explicit_snapshot_on_one_target_does_not_clear_a_different_targets_floor() {
    // Regression for IMPORTANT D: acting on tab B's floored ref, then an
    // explicit re-observation (snapshot/navigate) of tab A, then a ref-less
    // Enter on tab B must still be floored — tab A's clear must not bleed into
    // tab B's entry.
    let mut map: std::collections::HashMap<String, super::BrowserPaymentContext> =
        std::collections::HashMap::new();
    super::browser_mark_target_acted_floored(&mut map, "chat_1"); // tab B acted on a floored ref
    super::browser_clear_target_acted_floored(&mut map, "chat_0"); // tab A re-observed
    assert!(
        super::browser_payment_context_for(&map, "chat_1"),
        "tab B's last-acted-floored flag must survive a DIFFERENT tab's re-observation"
    );
    // Clearing the SAME target does take effect.
    super::browser_clear_target_acted_floored(&mut map, "chat_1");
    assert!(!super::browser_payment_context_for(&map, "chat_1"));
}

#[test]
fn refless_enter_is_floored_by_last_acted_floored_with_no_focus_signal() {
    // "act on a floored ref, then a ref-less Enter (no focus context) → floored."
    let mut map: std::collections::HashMap<String, super::BrowserPaymentContext> =
        std::collections::HashMap::new();
    let payment_floor: std::collections::HashSet<String> =
        std::collections::HashSet::from(["e12".to_string()]);
    // The prior act targeted e12 (a floored ref) — mirrors what the enforcement
    // site does via `browser_action_targeted_a_floored_ref`.
    let cvv_fill = serde_json::json!({"kind": "fill", "ref": "e12", "text": "123"});
    assert!(super::browser_action_targeted_a_floored_ref(
        &cvv_fill,
        &payment_floor
    ));
    super::browser_mark_target_acted_floored(&mut map, "chat_0");

    let combined = super::browser_payment_context_for(&map, "chat_0");
    assert!(
        combined,
        "last_acted_floored alone must floor, with NO focus signal"
    );

    let enter = serde_json::json!({"kind": "press", "key": "Enter", "action_class": "ordinary"});
    let reason =
        browser_safety::evaluate_browser_action(&enter, &payment_floor, combined, None).unwrap();
    assert!(reason.contains("BROWSER_ACTION_CLASS_CONFLICT"));
}

#[test]
fn action_targeted_a_floored_ref_covers_single_and_bundle_actions() {
    let payment_floor: std::collections::HashSet<String> =
        std::collections::HashSet::from(["e12".to_string()]);
    assert!(super::browser_action_targeted_a_floored_ref(
        &serde_json::json!({"kind": "fill", "ref": "e12"}),
        &payment_floor
    ));
    assert!(!super::browser_action_targeted_a_floored_ref(
        &serde_json::json!({"kind": "fill", "ref": "e1"}),
        &payment_floor
    ));
    // A bundle: any item's ref matching the floor set counts.
    let bundle = serde_json::json!({
        "actions": [
            {"kind": "click", "ref": "e1"},
            {"kind": "fill", "ref": "e12"}
        ]
    });
    assert!(super::browser_action_targeted_a_floored_ref(
        &bundle,
        &payment_floor
    ));
    let bundle_no_hit = serde_json::json!({
        "actions": [{"kind": "click", "ref": "e1"}]
    });
    assert!(!super::browser_action_targeted_a_floored_ref(
        &bundle_no_hit,
        &payment_floor
    ));
}

// --- Build1 fill-fields fail-open: `fields[].ref` must floor too ---

#[test]
fn fill_fields_array_targeting_floored_ref_sets_last_acted_floored_for_a_following_refless_enter() {
    // {kind:"fill", fields:[{ref:<floored>, value:"x"}]} carries no top-level
    // `ref` — the sidecar's canonical multi-field contract puts the ref inside
    // `fields[]` (see `resolveFillFields` in
    // `runtimes/browser-automation/src/browser/actions.ts`). Before the fix,
    // `browser_action_targeted_a_floored_ref` only read `action.get("ref")` and
    // missed it entirely, so `last_acted_floored` never got set — leaving a
    // FOLLOWING ref-less Enter (no focus signal, e.g. a cross-origin PSP OOPIF
    // that fails `focusPaymentContext` open) completely ungated.
    let payment_floor: std::collections::HashSet<String> =
        std::collections::HashSet::from(["e12".to_string()]);
    let cc_fields_fill = serde_json::json!({
        "kind": "fill",
        "fields": [{"ref": "e12", "type": "text", "value": "4242 4242 4242 4242"}]
    });
    assert!(super::browser_action_targeted_a_floored_ref(
        &cc_fields_fill,
        &payment_floor
    ));

    let mut ctx_by_target: std::collections::HashMap<String, super::BrowserPaymentContext> =
        std::collections::HashMap::new();
    super::browser_mark_target_acted_floored(&mut ctx_by_target, "chat_0");
    let combined = super::browser_payment_context_for(&ctx_by_target, "chat_0");
    assert!(
        combined,
        "last_acted_floored alone must floor, with NO focus signal"
    );

    let enter = serde_json::json!({"kind": "press", "key": "Enter", "action_class": "ordinary"});
    let reason = browser_safety::evaluate_browser_action(&enter, &payment_floor, combined, None)
            .expect("a ref-less Enter following a floored fields[] fill must be rejected as under-declared payment_commit");
    assert!(reason.contains("BROWSER_ACTION_CLASS_CONFLICT"));

    // A fields[] fill hitting ONLY a non-floored ref must NOT set the flag.
    let ordinary_fields_fill = serde_json::json!({
        "kind": "fill",
        "fields": [{"ref": "e1", "value": "Napoli"}, {"ref": "e2", "value": "Milano"}]
    });
    assert!(!super::browser_action_targeted_a_floored_ref(
        &ordinary_fields_fill,
        &payment_floor
    ));

    // A bundle whose item uses fields[] to hit a floored ref counts too.
    let bundle = serde_json::json!({
        "actions": [
            {"kind": "click", "ref": "e1"},
            {"kind": "fill", "fields": [{"ref": "e12", "value": "4242"}]}
        ]
    });
    assert!(super::browser_action_targeted_a_floored_ref(
        &bundle,
        &payment_floor
    ));
}

// --- Build1 Fix 3: per-target floor set (cross-tab fail-open) ---

#[test]
fn browser_floor_for_target_defaults_to_empty_for_an_unobserved_target() {
    let map: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    assert!(super::browser_floor_refs_for_target(&map, "chat_0").is_empty());
}

#[test]
fn browser_set_target_floor_only_touches_its_own_target() {
    let mut map: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    super::browser_set_target_floor(
        &mut map,
        "chat_1",
        std::collections::HashSet::from(["e5".to_string()]),
    );
    super::browser_set_target_floor(&mut map, "chat_0", std::collections::HashSet::new());
    assert!(super::browser_floor_refs_for_target(&map, "chat_1").contains("e5"));
    assert!(super::browser_floor_refs_for_target(&map, "chat_0").is_empty());
}

#[test]
fn browser_per_target_floor_set_survives_a_different_targets_observation_cross_tab_regression() {
    // Build1 Fix 3 regression: a single global floor set let observing tab A
    // clobber tab B's floor out from under it. Scenario from the review:
    // observe tab B (floors e5), observe tab A (empties A only), act on tab
    // B's e5 → last_acted_floored[B] set → a ref-less Enter on tab B floors.
    let mut floor_by_target: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    super::browser_set_target_floor(
        &mut floor_by_target,
        "chat_1", // tab B
        std::collections::HashSet::from(["e5".to_string()]),
    );
    super::browser_set_target_floor(
        &mut floor_by_target,
        "chat_0", // tab A — its own (empty) floor must not bleed into chat_1
        std::collections::HashSet::new(),
    );
    let b_floor = super::browser_floor_refs_for_target(&floor_by_target, "chat_1");
    assert!(
        b_floor.contains("e5"),
        "tab B's floor must survive tab A's unrelated observation"
    );

    // Act: type into tab B's e5 (a floored ref) — mirrors the enforcement
    // site's PRE-act `browser_action_targeted_a_floored_ref` check, now read
    // from chat_1's OWN entry rather than a single shared set.
    let cvv_fill =
        serde_json::json!({"kind": "type", "ref": "e5", "text": "123", "target_id": "chat_1"});
    assert!(super::browser_action_targeted_a_floored_ref(
        &cvv_fill, &b_floor
    ));

    let mut ctx_by_target: std::collections::HashMap<String, super::BrowserPaymentContext> =
        std::collections::HashMap::new();
    super::browser_mark_target_acted_floored(&mut ctx_by_target, "chat_1");
    assert!(super::browser_payment_context_for(&ctx_by_target, "chat_1"));
    assert!(!super::browser_payment_context_for(
        &ctx_by_target,
        "chat_0"
    ));

    // A ref-less Enter on tab B must floor via last_acted_floored, using
    // chat_1's own (still-intact) floor set.
    let enter = serde_json::json!({"kind": "press", "key": "Enter", "action_class": "ordinary"});
    let combined = super::browser_payment_context_for(&ctx_by_target, "chat_1");
    let reason = browser_safety::evaluate_browser_action(&enter, &b_floor, combined, None)
        .expect("ref-less Enter on tab B must be rejected as under-declared payment_commit");
    assert!(reason.contains("BROWSER_ACTION_CLASS_CONFLICT"));
}

#[test]
fn stale_ref_recovery_message_forbids_reusing_the_old_ref() {
    let msg = super::stale_ref_recovery_message(Some("e145"), "[ref=e200] Article");
    assert!(msg.contains("Do NOT retry e145"));
    assert!(msg.contains("NEW [ref=...]"));
    assert!(msg.contains("[ref=e200] Article"));
    // The message is built off the shared engine marker so
    // `local_first_engine::browser::is_stale_ref_recovery_result` recognizes it (MINOR 8).
    assert!(local_first_engine::browser::is_stale_ref_recovery_result(
        &msg
    ));
}

#[test]
fn stale_ref_error_detection_covers_common_playwright_phrasings() {
    // MINOR 8: broadened beyond the original stale/detached pair to the phrasings Playwright
    // actually throws, case-insensitively.
    assert!(super::is_stale_ref_error("Error: stale element reference"));
    assert!(super::is_stale_ref_error(
        "element is DETACHED from document"
    ));
    assert!(super::is_stale_ref_error(
        "Error: element is not attached to the DOM"
    ));
    assert!(super::is_stale_ref_error(
        "Error: no node found for selector [ref=e12]"
    ));
    assert!(super::is_stale_ref_error("NO NODE FOUND for selector"));
    assert!(!super::is_stale_ref_error(
        "Error: timeout waiting for selector"
    ));
}

#[test]
fn replace_latest_plan_marker_updates_delivered_plan_status() {
    let steps = vec![
        serde_json::json!({"id":"s1","title":"Open page","status":"done","detail":"ok"}),
        serde_json::json!({"id":"s2","title":"Deliver answer","status":"done","detail":"sent"}),
    ];
    let answer = "‹‹PLAN››- [x] **Open page** (`s1`): ok\n\
- [ ] **Deliver answer** (`s2`): pending‹‹/PLAN››\nDone.";
    let updated = super::replace_latest_plan_marker(answer, None, &steps);
    assert!(updated.contains("- [x] **Deliver answer** (`s2`): sent"));
    assert!(!updated.contains("- [ ] **Deliver answer**"));
    assert!(updated.ends_with("\nDone."));
}

#[test]
fn reconcile_final_plan_marker_does_not_close_open_step_from_answer_length() {
    let plan = super::runtime_execution_plan(&[
        serde_json::json!({"id":"s1","title":"Emit card","status":"done","detail":"ok"}),
        serde_json::json!({"id":"s2","title":"Deliver result","status":"doing","detail":"pending"}),
    ]);
    let answer = format!(
        "‹‹PLAN››{}‹‹/PLAN››\n{}",
        super::build_plan_markdown(None, &super::execution_plan_steps(&plan)),
        "Risultato finale: completato. ".repeat(40)
    );

    let updated = super::reconcile_final_plan_marker_on_delivery(&plan, &answer);

    assert!(updated.contains("- [-] **Deliver result** (`s2`)"));
    assert!(!updated.contains("- [x] **Deliver result**"));
}

#[test]
fn reconcile_final_plan_marker_closes_last_reporting_step_with_delivered_evidence() {
    let plan = super::runtime_execution_plan(&[
        serde_json::json!({"id":"s1","title":"Preparare la ricerca","status":"done","detail":"ok"}),
        serde_json::json!({"id":"s2","title":"Cercare treni Milano Roma","status":"done","detail":"risultati letti"}),
        serde_json::json!({"id":"s3","title":"Estrarre e riportare 3-5 opzioni con fonte","status":"doing","detail":"in corso"}),
    ]);
    let answer_body = format!(
        "| Ora | Treno | Fonte |\n\
| --- | --- | --- |\n\
| 08:00 | Frecciarossa 9503 | https://www.trenitalia.com |\n\
| 08:10 | Italo 9951 | https://www.italotreno.it |\n\n\
Fonti: https://www.trenitalia.com e https://www.italotreno.it\n\n{}",
        "Ho letto i risultati e riporto opzioni utilizzabili con fonte. ".repeat(12)
    );
    let answer = format!(
        "‹‹PLAN››{}‹‹/PLAN››\n{}",
        super::build_plan_markdown(None, &super::execution_plan_steps(&plan)),
        answer_body
    );

    let updated = super::reconcile_final_plan_marker_on_delivery(&plan, &answer);

    assert!(updated.contains("- [x] **Estrarre e riportare 3-5 opzioni con fonte** (`s3`)"));
    assert!(!updated.contains("- [-] **Estrarre e riportare 3-5 opzioni con fonte**"));
}

#[test]
fn reconcile_final_plan_marker_does_not_launder_blocked_steps() {
    let plan = super::runtime_execution_plan(&[
        serde_json::json!({"id":"s1","title":"Preparare la ricerca","status":"done","detail":"ok"}),
        serde_json::json!({"id":"s2","title":"Cercare treni Milano Roma","status":"blocked","detail":"paused by the harness: no progress"}),
        serde_json::json!({"id":"s3","title":"Estrarre e riportare 3-5 opzioni con fonte","status":"doing","detail":"in corso"}),
    ]);
    let answer = format!(
        "‹‹PLAN››{}‹‹/PLAN››\n| Ora | Fonte |\n| --- | --- |\n| 08:00 | https://www.trenitalia.com |\n\n{}",
        super::build_plan_markdown(None, &super::execution_plan_steps(&plan)),
        "Risposta sostanziale con tabella e fonti. ".repeat(20)
    );

    let updated = super::reconcile_final_plan_marker_on_delivery(&plan, &answer);

    assert!(updated.contains("- [!] **Cercare treni Milano Roma** (`s2`)"));
    assert!(updated.contains("- [-] **Estrarre e riportare 3-5 opzioni con fonte** (`s3`)"));
    assert!(!updated.contains("- [x] **Cercare treni Milano Roma**"));
    assert!(!updated.contains("- [x] **Estrarre e riportare 3-5 opzioni con fonte**"));
}

#[test]
fn reconcile_final_plan_preserves_all_evidence_free_open_steps() {
    let plan = super::runtime_execution_plan(&[
        serde_json::json!({"id":"s1","title":"Vincitrice","status":"done","detail":"ok"}),
        serde_json::json!({"id":"s2","title":"Girone","status":"doing","detail":"wip"}),
        serde_json::json!({"id":"s3","title":"Finale","status":"todo","detail":""}),
        serde_json::json!({"id":"s4","title":"Haaland","status":"blocked","detail":"n/a"}),
    ]);
    let answer = format!(
        "‹‹PLAN››{}‹‹/PLAN››\n{}",
        super::build_plan_markdown(None, &super::execution_plan_steps(&plan)),
        "Risposta completa con tutti i mercati coperti. ".repeat(30)
    );

    let updated = super::reconcile_final_plan_marker_on_delivery(&plan, &answer);

    assert!(updated.contains("- [-] **Girone** (`s2`)"));
    assert!(updated.contains("- [ ] **Finale** (`s3`)"));
    assert!(updated.contains("- [!] **Haaland** (`s4`)"));
    assert!(!updated.contains("- [x] **Girone**"));
    assert!(!updated.contains("- [x] **Finale**"));
}

#[test]
fn reconcile_final_plan_noop_on_short_answer() {
    // Char floor: a truncated / empty delivery (budget burned) means the work isn't really
    // done — do NOT auto-close the plan, or we'd fake completion on a genuine stop.
    let plan = super::runtime_execution_plan(&[
        serde_json::json!({"id":"s1","title":"Emit card","status":"done","detail":"ok"}),
        serde_json::json!({"id":"s2","title":"Deliver","status":"doing","detail":"wip"}),
    ]);
    let answer = format!(
        "‹‹PLAN››{}‹‹/PLAN››\nDone.",
        super::build_plan_markdown(None, &super::execution_plan_steps(&plan)),
    );

    let updated = super::reconcile_final_plan_marker_on_delivery(&plan, &answer);

    // Unchanged: the still-open step stays open (doing marker `[-]`).
    assert!(updated.contains("- [-] **Deliver** (`s2`)"));
    assert!(!updated.contains("- [x] **Deliver**"));
}

#[test]
fn read_only_objective_blocks_mutating_tools_but_keeps_analysis_tools() {
    use crate::semantic_decision::{EffectClass, ObjectiveEffectPolicy};
    let read_only = ObjectiveEffectPolicy::from_allowed_effects([
        EffectClass::Read,
        EffectClass::RequestAuthorization,
    ]);
    let mutation = ObjectiveEffectPolicy::from_allowed_effects([
        EffectClass::Read,
        EffectClass::FilesystemWrite,
    ]);

    assert!(super::objective_blocks_tool(
        &read_only,
        "create_artifact",
        &Default::default(),
    ));
    assert!(super::objective_blocks_tool(
        &read_only,
        "apply_patch",
        &Default::default(),
    ));
    assert!(!super::objective_blocks_tool(
        &read_only,
        "read_file",
        &Default::default(),
    ));
    assert!(!super::objective_blocks_tool(
        &read_only,
        "update_plan",
        &Default::default(),
    ));
    assert!(!super::objective_blocks_tool(
        &mutation,
        "apply_patch",
        &Default::default(),
    ));
}

#[test]
fn read_only_objective_prunes_writes_but_keeps_directory_analysis() {
    let mut tools = vec![
        super::list_directory_tool_schema(),
        super::read_text_file_tool_schema(),
        super::make_document_tool_schema(),
        super::write_file_tool_schema(),
    ];
    let policy = crate::semantic_decision::ObjectiveEffectPolicy::from_allowed_effects([
        crate::semantic_decision::EffectClass::Read,
        crate::semantic_decision::EffectClass::RequestAuthorization,
    ]);
    super::prune_tools_for_objective_policy(&mut tools, &policy, &Default::default());
    let names = tools
        .iter()
        .filter_map(|schema| {
            schema
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str)
        })
        .collect::<Vec<_>>();

    assert_eq!(names, vec!["list_directory", "read_text_file"]);
}

#[test]
fn tool_effect_classification_distinguishes_mutation_boundaries() {
    use crate::semantic_decision::EffectClass;

    assert_eq!(
        super::tool_effect_class("write_file", &Default::default()),
        EffectClass::FilesystemWrite
    );
    assert_eq!(
        super::tool_effect_class("make_document", &Default::default()),
        EffectClass::ArtifactCreation
    );
    assert_eq!(
        super::tool_effect_class("send_message", &Default::default()),
        EffectClass::ExternalWrite
    );
    assert_eq!(
        super::tool_effect_class("read_file", &Default::default()),
        EffectClass::Read
    );
    assert_eq!(
        super::tool_effect_class("browse", &Default::default()),
        EffectClass::Read,
        "browser mutations remain governed by the browser action lattice"
    );
}

#[test]
fn typed_effect_policy_controls_pruning_independently_of_mode() {
    use crate::semantic_decision::{EffectClass, ObjectiveEffectPolicy};

    let policy = ObjectiveEffectPolicy::from_allowed_effects([
        EffectClass::Read,
        EffectClass::RequestAuthorization,
        EffectClass::ArtifactCreation,
    ]);
    let mut tools = vec![
        super::read_file_tool_schema(),
        super::make_document_tool_schema(),
        super::write_file_tool_schema(),
        super::send_message_tool_schema(),
    ];

    super::prune_tools_for_objective_policy(&mut tools, &policy, &Default::default());
    let names = tools
        .iter()
        .filter_map(|schema| {
            schema
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str)
        })
        .collect::<Vec<_>>();

    assert_eq!(names, vec!["read_file", "make_document"]);
    assert!(super::objective_blocks_tool(
        &policy,
        "write_file",
        &Default::default(),
    ));
    assert!(!super::objective_blocks_tool(
        &policy,
        "make_document",
        &Default::default(),
    ));
}

#[test]
fn model_round_consumes_durable_steering_exactly_once() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let thread = state
        .chat_store
        .lock()
        .unwrap()
        .create_thread("workspace-a")
        .unwrap();
    let user_id = super::gateway_user_id();
    {
        let store = state.task_store.lock().unwrap();
        let objective = store
            .upsert_objective_contract(
                user_id.as_str(),
                "workspace-a",
                &thread.thread_id,
                "message-1",
                "Analyze only",
                local_first_task_runtime::ObjectiveMode::ReadOnlyAnalysis,
                &serde_json::json!({}),
                &serde_json::json!(["read"]),
                &serde_json::json!({"deliverable": "report"}),
                "active",
            )
            .unwrap();
        store
            .append_turn_steering(
                user_id.as_str(),
                "workspace-a",
                &thread.thread_id,
                "turn-1",
                &local_first_task_runtime::NewTurnSteering {
                    source_message_id: "message-2".into(),
                    prompt: "Controlla anche la memoria".into(),
                    visible_prompt: "Controlla anche la memoria".into(),
                    images: vec![],
                    attachments: serde_json::json!([]),
                    mode: None,
                    model: None,
                },
                objective.revision,
            )
            .unwrap();
    }
    let context = crate::model_client::GatewaySteeringContext {
        state: &state,
        user_id: user_id.as_str(),
        workspace_id: "workspace-a",
        thread_id: &thread.thread_id,
        turn_id: "turn-1",
        run_id: "run-1",
    };

    let fixture = |_: &str, _: Option<&local_first_task_runtime::ObjectiveContractRecord>| {
        let mut decision = super::semantic_decision::safe_fallback(None, "test_fixture");
        decision.decision.relationship_to_active_objective =
            super::semantic_decision::ObjectiveRelationship::CompatibleExtension;
        decision.provenance.fallback_reason = None;
        decision
    };
    let first = crate::model_client::steering_messages_for_round_with(context, fixture);
    let second = crate::model_client::steering_messages_for_round_with(context, fixture);

    assert_eq!(first.len(), 1);
    assert!(
        first[0]["content"]
            .as_str()
            .unwrap()
            .contains("APPLY TO THE CURRENT RUN")
    );
    assert!(second.is_empty());
}

#[test]
fn gateway_projects_and_acknowledges_structured_turn_control() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let user_id = super::gateway_user_id();
    let objective = state
        .task_store
        .lock()
        .unwrap()
        .upsert_objective_contract(
            user_id.as_str(),
            "workspace-a",
            "thread-1",
            "message-objective",
            "Find train results",
            local_first_task_runtime::ObjectiveMode::ReadOnlyAnalysis,
            &serde_json::json!({}),
            &serde_json::json!(["read"]),
            &serde_json::json!({"deliverable": "results"}),
            "active",
        )
        .unwrap();
    let pending = state
        .task_store
        .lock()
        .unwrap()
        .append_turn_steering(
            user_id.as_str(),
            "workspace-a",
            "thread-1",
            "turn-1",
            &local_first_task_runtime::NewTurnSteering {
                source_message_id: "message-control".into(),
                prompt: "answer with current evidence".into(),
                visible_prompt: "answer with current evidence".into(),
                images: Vec::new(),
                attachments: serde_json::json!([]),
                mode: None,
                model: None,
            },
            objective.revision,
        )
        .unwrap();
    let claimed = state
        .task_store
        .lock()
        .unwrap()
        .claim_pending_turn_steering(
            user_id.as_str(),
            "workspace-a",
            "thread-1",
            "turn-1",
            "run-1",
            1,
        )
        .unwrap()
        .remove(0);
    let mut decision = super::semantic_decision::safe_fallback(None, "fixture");
    decision.provenance.fallback_reason = None;
    decision.decision.relationship_to_active_objective =
        super::semantic_decision::ObjectiveRelationship::CompatibleExtension;
    decision.decision.steering_disposition =
        super::semantic_decision::SteeringDisposition::FinalizeWithCurrentEvidence;
    let interpreted = state
        .task_store
        .lock()
        .unwrap()
        .mark_turn_steering_interpreted(
            claimed.steering_id,
            claimed.revision,
            &serde_json::to_value(decision).unwrap(),
            "run-1",
        )
        .unwrap();
    let context = crate::model_client::GatewaySteeringContext {
        state: &state,
        user_id: user_id.as_str(),
        workspace_id: "workspace-a",
        thread_id: "thread-1",
        turn_id: "turn-1",
        run_id: "run-1",
    };

    let control = crate::model_client::current_turn_control(context).unwrap();
    assert_eq!(control.steering_id, pending.steering_id);
    assert_eq!(
        control.disposition,
        local_first_engine::TurnControlDisposition::FinalizeWithCurrentEvidence
    );
    crate::model_client::acknowledge_turn_control_applied(context, control.steering_id);
    assert_eq!(
        state
            .task_store
            .lock()
            .unwrap()
            .load_turn_steering(control.steering_id, user_id.as_str(), "workspace-a",)
            .unwrap()
            .unwrap()
            .status,
        local_first_task_runtime::TurnSteeringStatus::Applied
    );
    crate::model_client::acknowledge_turn_control_completed(context, control.steering_id);
    let completed = state
        .task_store
        .lock()
        .unwrap()
        .load_turn_steering(control.steering_id, user_id.as_str(), "workspace-a")
        .unwrap()
        .unwrap();
    assert_eq!(
        completed.status,
        local_first_task_runtime::TurnSteeringStatus::Completed
    );
    assert!(completed.revision > interpreted.revision);
}

#[test]
fn gateway_confirmation_requirement_overrides_the_requested_disposition() {
    let _env = TestEnv::acquire();
    let state = super::AppState::for_tests();
    let user_id = super::gateway_user_id();
    let objective = state
        .task_store
        .lock()
        .unwrap()
        .upsert_objective_contract(
            user_id.as_str(),
            "workspace-a",
            "thread-1",
            "message-objective",
            "Find train results",
            local_first_task_runtime::ObjectiveMode::ReadOnlyAnalysis,
            &serde_json::json!({}),
            &serde_json::json!(["read"]),
            &serde_json::json!({"deliverable": "results"}),
            "active",
        )
        .unwrap();
    state
        .task_store
        .lock()
        .unwrap()
        .append_turn_steering(
            user_id.as_str(),
            "workspace-a",
            "thread-1",
            "turn-1",
            &local_first_task_runtime::NewTurnSteering {
                source_message_id: "message-confirm".into(),
                prompt: "change the active objective".into(),
                visible_prompt: "change the active objective".into(),
                images: Vec::new(),
                attachments: serde_json::json!([]),
                mode: None,
                model: None,
            },
            objective.revision,
        )
        .unwrap();
    let claimed = state
        .task_store
        .lock()
        .unwrap()
        .claim_pending_turn_steering(
            user_id.as_str(),
            "workspace-a",
            "thread-1",
            "turn-1",
            "run-1",
            1,
        )
        .unwrap()
        .remove(0);
    let mut decision = super::semantic_decision::safe_fallback(None, "fixture");
    decision.provenance.fallback_reason = None;
    decision.decision.relationship_to_active_objective =
        super::semantic_decision::ObjectiveRelationship::CompatibleExtension;
    decision.decision.steering_disposition =
        super::semantic_decision::SteeringDisposition::ReplanCurrentWork;
    decision.decision.requires_user_confirmation = true;
    state
        .task_store
        .lock()
        .unwrap()
        .mark_turn_steering_interpreted(
            claimed.steering_id,
            claimed.revision,
            &serde_json::to_value(decision).unwrap(),
            "run-1",
        )
        .unwrap();
    let context = crate::model_client::GatewaySteeringContext {
        state: &state,
        user_id: user_id.as_str(),
        workspace_id: "workspace-a",
        thread_id: "thread-1",
        turn_id: "turn-1",
        run_id: "run-1",
    };

    let control = crate::model_client::current_turn_control(context).unwrap();

    assert_eq!(
        control.disposition,
        local_first_engine::TurnControlDisposition::NeedsClarification
    );
}

#[test]
fn merge_plan_creates_then_keeps_stable_ids() {
    let mut plan = Vec::new();
    let claims = merge_plan(
        &mut plan,
        &[
            sent_step("Generate images", "doing"),
            sent_step("Write deck.json", "todo"),
        ],
    );
    assert!(claims.is_empty());
    assert_eq!(plan.len(), 2);
    assert_eq!(plan[0]["id"], "s1");
    assert_eq!(plan[1]["id"], "s2");
    assert_eq!(plan_next_open(&plan).as_deref(), Some("Generate images"));
}

#[test]
fn merge_plan_matches_by_id_despite_rephrased_title() {
    // Step exists with id s1; the model re-sends it with a PARAPHRASED title but
    // echoes the id → UPDATE in place (no balloon), not a duplicate. (WS1-F2.)
    let mut plan = vec![serde_json::json!({
        "id": "s1", "title": "Generate images", "status": "doing", "detail": ""
    })];
    let claims = merge_plan(
        &mut plan,
        &[serde_json::json!({ "id": "s1", "title": "Render the images", "status": "done" })],
    );
    assert_eq!(plan.len(), 1, "id match must not create a duplicate");
    assert_eq!(plan[0]["id"], "s1");
    assert_eq!(claims, vec![0]);
    assert_eq!(plan_step_status(&plan[0]), "doing");
}

#[test]
fn merge_plan_id_only_advance_no_title() {
    // step_advance sends {id, status} WITHOUT a title → update the matching step in
    // place (not skip, not create a titleless step). (WS1-F2 slice 2.)
    let mut plan = vec![serde_json::json!({
        "id": "s1", "title": "Render deck", "status": "doing", "detail": ""
    })];
    let claims = merge_plan(
        &mut plan,
        &[serde_json::json!({ "id": "s1", "status": "done" })],
    );
    assert_eq!(plan.len(), 1, "id-only update must not create a step");
    assert_eq!(plan[0]["title"], "Render deck", "title preserved");
    assert_eq!(claims, vec![0]);
    assert_eq!(plan_step_status(&plan[0]), "doing");
}

#[test]
fn monotonic_progress_completes_steps_before_the_frontier() {
    // The model advanced `doing` to step 3 but left the earlier steps `todo` (never
    // marked them done). Monotonic progress closes them so "Progress" reflects reality.
    let mut steps = vec![
        serde_json::json!({ "id": "s1", "title": "A", "status": "todo", "detail": "" }),
        serde_json::json!({ "id": "s2", "title": "B", "status": "todo", "detail": "" }),
        serde_json::json!({ "id": "s3", "title": "C", "status": "doing", "detail": "" }),
        serde_json::json!({ "id": "s4", "title": "D", "status": "todo", "detail": "" }),
    ];
    enforce_monotonic_plan_progress(&mut steps);
    assert_eq!(
        plan_step_status(&steps[0]),
        "done",
        "before frontier → done"
    );
    assert_eq!(
        plan_step_status(&steps[1]),
        "done",
        "before frontier → done"
    );
    assert_eq!(plan_step_status(&steps[2]), "doing", "frontier stays doing");
    assert_eq!(
        plan_step_status(&steps[3]),
        "todo",
        "after frontier stays todo"
    );
}

/// The plan the ENGINE reads (`LoopState::plan`) must expose the SAME canonical step shape
/// the gateway merges and verifies. `effects.plan` serializes the typed `ExecutionPlan`, whose
/// `PlanStep` keeps title/status inside `arguments` — so a raw serialization makes every
/// engine-side reader (`plan_step_status`/`plan_step_title`, hence the autoadvance frontier and
/// the "keep going" nudge) see an untitled `todo`, whatever the real state is. That silently
/// disables every plan-driven control in the loop, leaving the wall clock as the only limit.
#[test]
fn the_plan_value_handed_to_the_engine_preserves_status_and_title() {
    let canonical = vec![
        serde_json::json!({ "id": "s1", "title": "Cerca il treno", "status": "done", "detail": "" }),
        serde_json::json!({ "id": "s2", "title": "Apri la prenotazione", "status": "doing", "detail": "" }),
    ];
    use local_first_engine::plan::{
        plan_step_status, plan_step_title, plan_value_goal, plan_value_steps,
    };
    // Exactly what the update_plan arm / the resume / the frontier advance assign to `ls.plan`.
    let as_engine_sees_it = super::canonical_plan_value(None, &canonical);
    let steps = plan_value_steps(&as_engine_sees_it);
    assert_eq!(steps.len(), 2, "the engine sees both steps");
    assert_eq!(plan_step_title(&steps[0]), "Cerca il treno");
    assert_eq!(plan_step_status(&steps[0]), "done");
    assert_eq!(
        plan_value_goal(&as_engine_sees_it),
        None,
        "no goal in → no goal out"
    );
    let with_goal = super::canonical_plan_value(Some("Prenotare il treno"), &canonical);
    assert_eq!(
        plan_value_goal(&with_goal),
        Some("Prenotare il treno".to_string()),
        "the goal rides the canonical plan Value, steps untouched"
    );
    assert_eq!(plan_value_steps(&with_goal).len(), 2);
    assert_eq!(
        plan_step_status(&steps[1]),
        "doing",
        "the frontier must be visible to the loop"
    );
    // And the merge path reads the SAME state back out of it (no status lost round-tripping
    // through the typed `ExecutionPlan` that `update_plan` still merges on).
    let round_tripped = super::execution_plan_steps(&super::plan_value_from(&as_engine_sees_it));
    assert_eq!(plan_step_status(&round_tripped[0]), "done");
    assert_eq!(plan_step_status(&round_tripped[1]), "doing");
    assert_eq!(plan_step_title(&round_tripped[1]), "Apri la prenotazione");
}

/// The raw `ExecutionPlan` serialization is what the engine used to receive, and it is exactly
/// what must never be handed to it again: `plan_step_status` defaults a missing field to
/// `"todo"`, so the loop saw an untitled `todo` for every step and every plan-driven control
/// went quiet. Pins the difference between the two shapes so a future refactor can't silently
/// swap them back.
#[test]
fn the_raw_execution_plan_serialization_hides_status_from_the_engine() {
    use local_first_engine::plan::{plan_step_status, plan_value_steps};
    let canonical =
        vec![serde_json::json!({ "id": "s1", "title": "Fatto", "status": "done", "detail": "" })];
    let raw = serde_json::to_value(super::runtime_execution_plan(&canonical)).unwrap();
    let steps = plan_value_steps(&raw);
    assert_eq!(
        plan_step_status(&steps[0]),
        "todo",
        "the raw shape buries status in `arguments` — this is the trap, keep it documented"
    );
    assert_eq!(
        plan_step_status(&plan_value_steps(&super::canonical_plan_value(None, &canonical))[0]),
        "done"
    );
}

#[test]
fn advance_plan_frontier_moves_the_doing_pointer() {
    let mut steps = vec![
        serde_json::json!({ "id": "s1", "title": "A", "status": "done", "detail": "" }),
        serde_json::json!({ "id": "s2", "title": "B", "status": "doing", "detail": "" }),
        serde_json::json!({ "id": "s3", "title": "C", "status": "todo", "detail": "" }),
    ];
    assert_eq!(advance_plan_frontier(&mut steps), Some(1));
    assert_eq!(plan_step_status(&steps[1]), "done", "frontier closed");
    assert_eq!(plan_step_status(&steps[2]), "doing", "next todo promoted");
    // Last step doing, no todo after → closes it, no new doing, plan complete.
    assert_eq!(advance_plan_frontier(&mut steps), Some(2));
    assert_eq!(plan_done_count(&steps), 3);
    // Nothing in progress → None.
    assert_eq!(advance_plan_frontier(&mut steps), None);
}

#[test]
fn monotonic_progress_closes_stale_doing_before_frontier() {
    // Regression (deepseek trace): the model set s1 `doing`, read its result, then set s2
    // `doing` WITHOUT ever marking s1 done. s1 must close so `plan_next_open` returns s2
    // (not s1) and the nudge stops sending the model back to step 1.
    let mut steps = vec![
        serde_json::json!({ "id": "s1", "title": "Vincitrice", "status": "doing", "detail": "read" }),
        serde_json::json!({ "id": "s2", "title": "Girone", "status": "doing", "detail": "" }),
        serde_json::json!({ "id": "s3", "title": "Finale", "status": "todo", "detail": "" }),
    ];
    enforce_monotonic_plan_progress(&mut steps);
    assert_eq!(
        plan_step_status(&steps[0]),
        "done",
        "stale earlier doing → done"
    );
    assert_eq!(
        plan_step_status(&steps[1]),
        "doing",
        "frontier (last doing) stays doing"
    );
    assert_eq!(
        plan_step_status(&steps[2]),
        "todo",
        "after frontier stays todo"
    );
    assert_eq!(
        plan_next_open(&steps).as_deref(),
        Some("Girone"),
        "next open is the frontier, not step 1"
    );
    assert_eq!(
        plan_done_count(&steps),
        1,
        "progress reflects the closed step"
    );
}

#[test]
fn monotonic_progress_preserves_blocked_and_no_frontier() {
    // A blocked step before the frontier stays blocked (not silently completed).
    let mut steps = vec![
        serde_json::json!({ "id": "s1", "title": "A", "status": "blocked", "detail": "" }),
        serde_json::json!({ "id": "s2", "title": "B", "status": "doing", "detail": "" }),
    ];
    enforce_monotonic_plan_progress(&mut steps);
    assert_eq!(
        plan_step_status(&steps[0]),
        "blocked",
        "blocked stays blocked"
    );
    // No doing/done anywhere → nothing to derive → unchanged.
    let mut all_todo = vec![
        serde_json::json!({ "id": "s1", "title": "A", "status": "todo", "detail": "" }),
        serde_json::json!({ "id": "s2", "title": "B", "status": "todo", "detail": "" }),
    ];
    enforce_monotonic_plan_progress(&mut all_todo);
    assert_eq!(
        plan_step_status(&all_todo[0]),
        "todo",
        "no frontier → unchanged"
    );
}

#[test]
fn merge_plan_id_only_for_missing_step_is_ignored() {
    let mut plan: Vec<serde_json::Value> = Vec::new();
    let claims = merge_plan(
        &mut plan,
        &[serde_json::json!({ "id": "s9", "status": "done" })],
    );
    assert!(
        plan.is_empty(),
        "id-only for a non-existent step → no titleless step created"
    );
    assert!(claims.is_empty());
}

#[test]
fn merge_plan_done_is_sticky_no_reset_loop() {
    // Step 1 reaches done…
    let mut plan = vec![serde_json::json!({
        "id": "s1", "title": "Generate images", "status": "done", "detail": ""
    })];
    // …then the model re-runs the skill and re-sends the WHOLE plan as todo.
    let claims = merge_plan(
        &mut plan,
        &[
            sent_step("Generate images", "todo"),
            sent_step("Write deck.json", "todo"),
        ],
    );
    // The done step is NOT reopened (no regenerate loop); the new step is appended.
    assert_eq!(plan_step_status(&plan[0]), "done");
    assert!(claims.is_empty());
    assert_eq!(plan.len(), 2);
    // Next action is the genuinely-open step, not the finished one.
    assert_eq!(plan_next_open(&plan).as_deref(), Some("Write deck.json"));
    assert_eq!(plan_done_count(&plan), 1);
}

#[test]
fn merge_plan_new_done_claim_is_held_doing_for_verification() {
    let mut plan = vec![serde_json::json!({
        "id": "s1", "title": "Write deck.json", "status": "doing", "detail": ""
    })];
    let claims = merge_plan(&mut plan, &[sent_step("Write deck.json", "done")]);
    // Claimed done → held `doing` (pending F2), and reported as a claim.
    assert_eq!(claims, vec![0]);
    assert_eq!(plan_step_status(&plan[0]), "doing");
    assert_eq!(plan_done_count(&plan), 0);
}

#[test]
fn merge_plan_preserves_explicit_dependencies() {
    let mut plan = vec![serde_json::json!({
        "id": "s1", "title": "Read docs", "status": "done", "detail": ""
    })];
    let claims = merge_plan(
        &mut plan,
        &[serde_json::json!({
            "title": "Implement slice",
            "status": "doing",
            "depends_on": ["s1"]
        })],
    );

    assert!(claims.is_empty());
    assert_eq!(plan.len(), 2);
    assert_eq!(plan[1]["depends_on"], serde_json::json!(["s1"]));
}

#[test]
fn merge_execution_plan_is_runtime_canonical_state() {
    let seed = vec![serde_json::json!({
        "id": "s1", "title": "Read docs", "status": "done", "detail": ""
    })];
    let mut plan = super::runtime_execution_plan(&seed);

    let claims = super::merge_execution_plan(
        &mut plan,
        &[serde_json::json!({
            "title": "Implement slice",
            "status": "doing",
            "depends_on": ["s1"]
        })],
    );
    let steps = super::execution_plan_steps(&plan);

    assert!(claims.is_empty());
    assert_eq!(plan.steps.len(), 2);
    assert_eq!(plan.steps[1].step_id, "s2");
    assert_eq!(plan.steps[1].depends_on, vec!["s1".to_string()]);
    assert_eq!(steps[1]["title"], "Implement slice");
    assert_eq!(steps[1]["status"], "doing");
}

#[test]
fn merge_execution_plan_preserves_plan_and_step_contract_metadata() {
    let mut plan = local_first_orchestrator::ExecutionPlan {
        route: local_first_orchestrator::OrchestratorRoute::CapabilityCall,
        direct_answer: None,
        plan_propose: Some(local_first_orchestrator::PlanProposal {
            summary: "Approve the workflow".to_string(),
            steps: vec!["Render deck".to_string()],
        }),
        steps: vec![local_first_orchestrator::PlanStep {
            step_id: "render".to_string(),
            kind: local_first_orchestrator::PlanStepKind::CapabilityCall,
            depends_on: vec!["brand".to_string()],
            provider_id: Some("native".to_string()),
            tool_name: Some("make_deck".to_string()),
            arguments: serde_json::json!({
                "title": "Render deck",
                "status": "doing",
                "detail": "Rendering",
                "done_criterion": "deck.pptx exists"
            }),
            execution_policy: local_first_orchestrator::StepExecutionPolicy::DurableTask,
            risk_level: "medium".to_string(),
            expected_duration_seconds: 30,
            agent_id: None,
            goal: Some("Render deck".to_string()),
            contract: Some("DeckWorkflow".to_string()),
            allowed_actions: vec![],
            requires_user_approval: Some(false),
            timeout_seconds: Some(120),
            max_tokens: Some(2048),
        }],
        needs_more_tools: None,
    };

    let claims = super::merge_execution_plan(
        &mut plan,
        &[serde_json::json!({
            "id": "render",
            "status": "blocked",
            "detail": "Provider unavailable"
        })],
    );

    assert!(claims.is_empty());
    assert_eq!(
        plan.route,
        local_first_orchestrator::OrchestratorRoute::CapabilityCall
    );
    assert!(plan.plan_propose.is_some());
    assert_eq!(plan.steps.len(), 1);
    let step = &plan.steps[0];
    assert_eq!(
        step.kind,
        local_first_orchestrator::PlanStepKind::CapabilityCall
    );
    assert_eq!(step.provider_id.as_deref(), Some("native"));
    assert_eq!(step.tool_name.as_deref(), Some("make_deck"));
    assert_eq!(
        step.execution_policy,
        local_first_orchestrator::StepExecutionPolicy::DurableTask
    );
    assert_eq!(step.contract.as_deref(), Some("DeckWorkflow"));
    assert_eq!(step.timeout_seconds, Some(120));
    assert_eq!(
        step.arguments
            .get("status")
            .and_then(|value| value.as_str()),
        Some("blocked")
    );
    assert_eq!(
        step.arguments
            .get("detail")
            .and_then(|value| value.as_str()),
        Some("Provider unavailable")
    );
}

#[test]
fn chat_payload_max_tokens_override_skips_forced_synthesis() {
    assert_eq!(
        super::chat_payload_max_tokens(false, Some("24")),
        24,
        "debug cutoff should apply to the main loop"
    );
    assert_eq!(
        super::chat_payload_max_tokens(true, Some("24")),
        6000,
        "forced synthesis must keep the normal fresh budget"
    );
    assert_eq!(super::chat_payload_max_tokens(false, Some("0")), 6000);
    assert_eq!(super::chat_payload_max_tokens(false, Some("nope")), 6000);
}

#[test]
fn orchestration_plan_tools_expose_strict_schemas() {
    let update_plan = super::update_plan_tool_schema();
    assert_eq!(
        update_plan.pointer("/function/strict"),
        Some(&serde_json::Value::Bool(true))
    );
    assert_eq!(
        update_plan.pointer("/function/parameters/additionalProperties"),
        Some(&serde_json::Value::Bool(false))
    );
    assert_eq!(
        update_plan.pointer("/function/parameters/properties/steps/items/additionalProperties"),
        Some(&serde_json::Value::Bool(false))
    );
    assert_eq!(
        update_plan.pointer("/function/parameters/properties/steps/items/required"),
        Some(&serde_json::json!([
            "id",
            "title",
            "status",
            "detail",
            "depends_on",
            "done_criterion"
        ]))
    );
    assert_eq!(
        update_plan.pointer("/function/parameters/properties/steps/items/properties/id/type"),
        Some(&serde_json::json!(["string", "null"]))
    );
    // The plan's `goal` is OPTIONAL at the schema level (required stays `["steps"]`)
    // but admitted as a top-level property alongside the strict no-extra-fields rule.
    assert_eq!(
        update_plan.pointer("/function/parameters/properties/goal/type"),
        Some(&serde_json::json!(["string", "null"]))
    );
    assert_eq!(
        update_plan.pointer("/function/parameters/required"),
        Some(&serde_json::json!(["steps"]))
    );

    let step_advance = super::step_advance_tool_schema();
    assert_eq!(
        step_advance.pointer("/function/strict"),
        Some(&serde_json::Value::Bool(true))
    );
    assert_eq!(
        step_advance.pointer("/function/parameters/additionalProperties"),
        Some(&serde_json::Value::Bool(false))
    );
    assert_eq!(
        step_advance.pointer("/function/parameters/required"),
        Some(&serde_json::json!(["id", "status", "detail"]))
    );
}

#[test]
fn orchestration_completion_judge_uses_strict_schema() {
    let schema = super::orchestration_completion_judge_schema();
    assert_eq!(
        schema.pointer("/additionalProperties"),
        Some(&serde_json::Value::Bool(false))
    );
    assert_eq!(
        schema.pointer("/required"),
        Some(&serde_json::json!(["complete", "reason"]))
    );

    let response_format = super::orchestration_judge_response_format("step_completion");
    assert_eq!(
        response_format.pointer("/json_schema/strict"),
        Some(&serde_json::Value::Bool(true))
    );
    assert_eq!(
        response_format.pointer("/json_schema/schema/additionalProperties"),
        Some(&serde_json::Value::Bool(false))
    );
}

#[test]
fn completion_judge_parser_accepts_strict_object_and_complete_fragment_only() {
    let object = super::parse_completion_judge_verdict(
        "```json\n{\"complete\":true,\"reason\":\"evidence matched\"}\n```",
    )
    .expect("object verdict");
    assert_eq!(object["complete"], true);
    assert_eq!(object["reason"], "evidence matched");

    let fragment = super::parse_completion_judge_verdict(
        "\"complete\": false, \"reason\": \"missing external result\"",
    )
    .expect("fragment verdict");
    assert_eq!(fragment["complete"], false);
    assert_eq!(fragment["reason"], "missing external result");

    let truncated_fragment =
        super::parse_completion_judge_verdict("\": true, \"reason\": \"external result observed\"")
            .expect("truncated completion-key verdict");
    assert_eq!(truncated_fragment["complete"], true);
    assert_eq!(truncated_fragment["reason"], "external result observed");

    assert!(
        super::parse_completion_judge_verdict("\": true, \"comment\": \"missing reason\"")
            .is_none()
    );
    assert!(super::parse_completion_judge_verdict("complete: true").is_none());
    assert!(super::parse_completion_judge_verdict("The step looks complete.").is_none());
}

#[test]
fn external_failure_backstop_rejects_failed_external_actions_on_action_criteria() {
    // The live anomaly: 9+ failed browse attempts, no train result, and the model
    // claimed done with an analytical summary. Action criterion + only failed
    // external markers → deterministic rejection (judge not even consulted).
    let evidence = [
        "browse(treni Roma Milano) → found: false",
        "[external_action_failed] operation=browse",
        "browser_act → Action failed: element not found",
        "[external_action_failed] operation=browser_act",
        "assistant_candidate → 9+ browse attempts failed, no train result obtained",
    ]
    .join("\n");
    let reason =
        super::external_failure_backstop("ottenere i treni Roma-Milano di domani", &evidence)
            .expect("action criterion with only failed external actions must be rejected");
    assert!(reason.contains("deterministic backstop"));
    assert!(reason.to_lowercase().contains("repl"));

    // A single failure marker is enough to trip the backstop.
    let evidence = "[external_action_failed] operation=send_message";
    assert!(super::external_failure_backstop("inviare il messaggio al canale", evidence).is_some());
}

#[test]
fn external_failure_backstop_defers_analytical_criteria_to_the_judge() {
    let evidence = [
        "browse(orari) → found: false",
        "[external_action_failed] operation=browse",
    ]
    .join("\n");
    // Analytical criteria (case-insensitive keywords): describing the failures IS
    // the deliverable, so the deterministic backstop must stand down and let the
    // LLM judge decide.
    for criterion in [
        "Riepiloga cosa è successo",
        "summarize the failed attempts",
        "analizza i motivi dello stallo",
        "produce a short report of the attempts",
        "spiega perché la ricerca non funziona",
        "explain what blocked the search",
        "indagare il motivo del blocco",
        "capire why la pagina non carica",
    ] {
        assert!(
            super::external_failure_backstop(criterion, &evidence).is_none(),
            "analytical criterion «{criterion}» must reach the judge"
        );
        assert!(
            super::criterion_is_analytical(criterion),
            "«{criterion}» must classify as analytical"
        );
    }
}

#[test]
fn external_failure_backstop_stands_down_after_a_successful_external_action() {
    // Failed attempts followed by a SUCCESSFUL external result: the judge decides
    // (the success may or may not match the criterion/target — not a hard reject).
    let evidence = [
        "[external_action_failed] operation=browse",
        "[external_action_failed] operation=browser_act",
        "browser_act → Action performed.",
        "[external_action_ok] operation=browser_act",
    ]
    .join("\n");
    assert!(super::external_failure_backstop("ottenere i treni Roma-Milano", &evidence).is_none());
}

#[test]
fn external_failure_backstop_is_a_noop_without_failure_markers() {
    // No external failures → behavior unchanged for every criterion shape.
    let evidence = "browser_navigate → Page opened. Snapshot: …\n[external_action_ok] operation=browser_navigate";
    assert!(super::external_failure_backstop("aprire la pagina degli orari", evidence).is_none());
    assert!(super::external_failure_backstop("aprire la pagina degli orari", "").is_none());
    assert!(super::external_failure_backstop("", "plain prose evidence").is_none());
}

#[test]
fn action_words_do_not_classify_as_analytical_criteria() {
    // "elenca"/"risultati"/"tabella"/"treni" are ACTION criteria: they require an
    // external result to exist, so they must NOT disarm the backstop.
    for criterion in [
        "elenca le opzioni di viaggio",
        "mostra i risultati della ricerca",
        "tabella dei treni disponibili",
        "trovare i treni per domani",
    ] {
        assert!(
            !super::criterion_is_analytical(criterion),
            "«{criterion}» is an action criterion, not analytical"
        );
        let evidence = "[external_action_failed] operation=browse";
        assert!(
            super::external_failure_backstop(criterion, evidence).is_some(),
            "«{criterion}» must trip the backstop on failed-only evidence"
        );
    }
}

#[test]
fn step_completion_judge_prompt_pins_the_failed_external_action_rule() {
    let prompt = super::step_completion_judge_system_prompt();
    assert!(prompt.contains("failed external actions (browser/channel)"));
    assert!(prompt.contains("a textual summary describing failures is not evidence of completion"));
}

#[test]
fn managed_tool_authorization_is_fail_closed_and_policy_gated() {
    // F1.c: the deny-by-default gate that the retired facade path enforced must survive
    // the move to the v3 execution path. This is the security-relevant seam.
    use local_first_capabilities::{
        ActionClass, McpToolPolicy, PolicyContext, UserId, WorkspaceId,
    };
    let provider_id = CapProviderId::new("composio");
    let policies = vec![McpToolPolicy {
        tool_name: "GMAIL_FETCH_EMAILS".to_string(),
        action: ActionClass::Read,
        privacy_domains: vec!["managed-cloud".to_string()],
        sensitivity: "private".to_string(),
    }];
    let ctx = |allow_cloud: bool| PolicyContext {
        user_id: UserId::new("u"),
        workspace_id: WorkspaceId::new("w"),
        enabled_providers: vec![provider_id.clone()],
        privacy_domains: vec!["managed-cloud".to_string()],
        allowed_actions: vec![ActionClass::Read],
        max_autonomy_level: 4,
        allow_managed_cloud: allow_cloud,
    };
    // Authorized: cached tool, Managed allowed, domain + action granted.
    assert!(
        authorize_managed_capability_tool(
            &policies,
            &ctx(true),
            &provider_id,
            "GMAIL_FETCH_EMAILS"
        )
        .is_ok()
    );
    // Fail-closed: a tool absent from the v3 catalog cache cannot be authorized.
    assert!(
        authorize_managed_capability_tool(&policies, &ctx(true), &provider_id, "GMAIL_SEND_EMAIL")
            .is_err()
    );
    // Policy-gated: revoke managed-cloud → denied even for a cached tool.
    assert!(
        authorize_managed_capability_tool(
            &policies,
            &ctx(false),
            &provider_id,
            "GMAIL_FETCH_EMAILS"
        )
        .is_err()
    );
}

#[test]
fn context_budget_follows_real_window_with_env_override() {
    use super::resolve_context_budget_chars;
    // The model's REAL catalog window drives the budget (×3 chars/token) when no override.
    assert_eq!(resolve_context_budget_chars(None, Some(8_192)), 8_192 * 3);
    // A 128k model keeps a far larger budget than a small one — the whole point of F0.7.
    assert!(
        resolve_context_budget_chars(None, Some(131_072))
            > resolve_context_budget_chars(None, Some(8_192))
    );
    // No catalog window (uncatalogued endpoint) → safe 32k default.
    assert_eq!(resolve_context_budget_chars(None, None), 32_768 * 3);
    // Explicit env override wins over the model window (debugging / capping a liar).
    assert_eq!(
        resolve_context_budget_chars(Some(4_096), Some(131_072)),
        4_096 * 3
    );
    // A zero/garbage override or window is ignored, not treated as a real size.
    assert_eq!(
        resolve_context_budget_chars(Some(0), Some(8_192)),
        8_192 * 3
    );
    assert_eq!(resolve_context_budget_chars(None, Some(0)), 32_768 * 3);
}

#[test]
fn make_deck_workflow_definition_projects_execution_plan() {
    let definition = super::make_deck_workflow_definition();
    let plan = super::workflow_execution_plan(
        &definition,
        serde_json::json!({
            "brief": "Quarterly results",
            "language": "en",
            "slides": 6,
            "template_ref": "homun/executive-update-board-01",
            "design_template": "executive_update",
            "design_theme": "high_contrast",
            "design_profile": "executive",
            "design_components": ["kpi_grid", "timeline"],
        }),
    );

    assert_eq!(definition.id, "make_deck");
    assert_eq!(
        plan.route,
        local_first_orchestrator::OrchestratorRoute::MixedWorkflow
    );
    assert_eq!(plan.steps.len(), 6);
    assert_eq!(plan.steps[0].step_id, "brand");
    assert_eq!(plan.steps[0].contract.as_deref(), Some("DeckWorkflow"));
    assert_eq!(plan.steps[4].step_id, "render");
    assert_eq!(
        plan.steps[4].depends_on,
        vec!["deck_json".to_string(), "images".to_string()],
    );
    assert_eq!(
        plan.steps[5]
            .arguments
            .get("workflow_id")
            .and_then(|value| value.as_str()),
        Some("make_deck"),
    );
    assert_eq!(
        plan.steps[0]
            .arguments
            .pointer("/input/template_ref")
            .and_then(|value| value.as_str()),
        Some("homun/executive-update-board-01"),
    );
    assert_eq!(
        plan.steps[0]
            .arguments
            .pointer("/input/design_template")
            .and_then(|value| value.as_str()),
        Some("executive_update"),
    );
    assert_eq!(
        plan.steps[0]
            .arguments
            .pointer("/input/design_theme")
            .and_then(|value| value.as_str()),
        Some("high_contrast"),
    );
    assert_eq!(
        plan.steps[0]
            .arguments
            .pointer("/input/design_profile")
            .and_then(|value| value.as_str()),
        Some("executive"),
    );
    assert_eq!(
        plan.steps[0]
            .arguments
            .pointer("/input/design_components")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str())
                    .collect::<Vec<_>>()
            }),
        Some(vec!["kpi_grid", "timeline"]),
    );
}

#[test]
fn make_deck_workflow_plan_runs_through_brain_without_planner() {
    let definition = super::make_deck_workflow_definition();
    let plan = super::workflow_execution_plan(
        &definition,
        serde_json::json!({
            "brief": "Quarterly results",
            "language": "en",
            "slides": 6,
        }),
    );

    let validated =
        super::run_static_workflow_plan_through_brain("Quarterly results", plan).unwrap();

    assert_eq!(
        validated.route,
        local_first_orchestrator::OrchestratorRoute::MixedWorkflow
    );
    assert_eq!(validated.steps.len(), 6);
    assert_eq!(validated.steps[0].step_id, "brand");
    assert_eq!(validated.steps[5].step_id, "register_artifacts");
    assert_eq!(validated.steps[5].contract.as_deref(), Some("DeckWorkflow"));
}

#[test]
fn make_document_workflow_definition_projects_execution_plan() {
    let definition = super::make_document_workflow_definition();
    let plan = super::workflow_execution_plan(
        &definition,
        serde_json::json!({
            "brief": "Write a customer onboarding memo",
            "language": "en",
            "name": "onboarding.md",
        }),
    );

    assert_eq!(definition.id, "make_document");
    assert_eq!(definition.tool_name, "make_document");
    assert_eq!(
        plan.route,
        local_first_orchestrator::OrchestratorRoute::MixedWorkflow
    );
    assert_eq!(plan.steps.len(), 4);
    assert_eq!(plan.steps[0].step_id, "brief");
    assert_eq!(plan.steps[0].contract.as_deref(), Some("DocumentWorkflow"));
    assert_eq!(plan.steps[2].step_id, "write_artifact");
    assert_eq!(plan.steps[2].depends_on, vec!["draft_markdown".to_string()]);
    assert_eq!(
        plan.steps[3]
            .arguments
            .get("workflow_id")
            .and_then(|value| value.as_str()),
        Some("make_document"),
    );
}

#[test]
fn make_document_workflow_plan_runs_through_brain_without_planner() {
    let definition = super::make_document_workflow_definition();
    let plan = super::workflow_execution_plan(
        &definition,
        serde_json::json!({
            "brief": "Write a customer onboarding memo",
            "language": "en",
            "name": "onboarding.md",
        }),
    );

    let validated =
        super::run_static_workflow_plan_through_brain("Write onboarding memo", plan).unwrap();

    assert_eq!(
        validated.route,
        local_first_orchestrator::OrchestratorRoute::MixedWorkflow
    );
    assert_eq!(validated.steps.len(), 4);
    assert_eq!(validated.steps[0].step_id, "brief");
    assert_eq!(validated.steps[3].step_id, "register_artifact");
    assert_eq!(
        validated.steps[3].contract.as_deref(),
        Some("DocumentWorkflow")
    );
}

#[tokio::test]
async fn static_workflow_plan_validation_is_async_runtime_safe() {
    let definition = super::make_document_workflow_definition();
    let plan = super::workflow_execution_plan(
        &definition,
        serde_json::json!({
            "brief": "Write a customer onboarding memo",
            "language": "en",
            "name": "onboarding.md",
        }),
    );

    let validated = super::run_static_workflow_plan_through_brain_async(
        "Write onboarding memo".to_string(),
        plan,
    )
    .await
    .unwrap();

    assert_eq!(
        validated.route,
        local_first_orchestrator::OrchestratorRoute::MixedWorkflow
    );
    assert_eq!(validated.steps[3].step_id, "register_artifact");
}

fn semantic_route_fixture(
    shape: super::semantic_decision::ExecutionShape,
    capability: Option<&str>,
) -> super::semantic_decision::ValidatedSemanticDecision {
    let mut decision = super::semantic_decision::safe_fallback(None, "test_fixture");
    decision.decision.execution_shape = shape;
    decision.decision.selected_capability = capability.map(str::to_string);
    decision.decision.rationale = "selected by the model fixture".to_string();
    decision.provenance.fallback_reason = None;
    decision
}

#[test]
fn semantic_decision_routes_to_the_selected_workflow() {
    let semantic = semantic_route_fixture(
        super::semantic_decision::ExecutionShape::Workflow,
        Some("make_deck"),
    );
    let decision = super::route_capability_from_semantic(Some(&semantic));

    assert!(matches!(
        decision,
        super::CapabilityRouteDecision::Workflow {
            workflow_id: "make_deck",
            tool_name: "make_deck",
            ..
        }
    ));
}

#[test]
fn agent_loop_route_does_not_depend_on_prompt_retrieval_rank() {
    let semantic =
        semantic_route_fixture(super::semantic_decision::ExecutionShape::AgentLoop, None);
    let decision = super::route_capability_from_semantic(Some(&semantic));

    assert!(matches!(
        decision,
        super::CapabilityRouteDecision::AgentLoop { .. }
    ));
}

#[test]
fn native_atomic_registry_maps_pdf_atomic_to_real_tool_schema() {
    let corpus = super::native_atomic_capability_entries();
    let ranked = super::bm25_rank(&corpus, "unisci questi PDF", 1);
    let entry = ranked.first().expect("pdf atomic entry");
    let tool_name = entry
        .schema
        .as_ref()
        .and_then(|schema| schema.pointer("/function/name"))
        .and_then(|value| value.as_str());

    assert_eq!(entry.key, "pdf_atomic");
    assert_eq!(tool_name, Some("run_in_sandbox"));
    assert!(entry.text.contains("merge"));
    assert!(entry.text.contains("converti"));
}

#[test]
fn semantic_registry_exposes_native_atomic_capabilities_with_their_effects() {
    let registry = super::semantic_capability_registry();
    let sandbox = registry
        .iter()
        .find(|entry| entry.key == "run_in_sandbox")
        .expect("sandbox atomic capability");

    assert!(sandbox.enabled);
    assert!(
        sandbox
            .effects
            .contains(&super::semantic_decision::EffectClass::FilesystemWrite)
    );
    assert!(registry.iter().any(|entry| entry.key == "pdf_atomic"));
}

#[test]
fn semantic_atomic_sandbox_route_loads_the_registered_tool() {
    let semantic = semantic_route_fixture(
        super::semantic_decision::ExecutionShape::AtomicCapability,
        Some("run_in_sandbox"),
    );
    let decision = super::route_capability_from_semantic(Some(&semantic));

    assert!(matches!(
        decision,
        super::CapabilityRouteDecision::AtomicTool {
            capability_key: "run_in_sandbox",
            ..
        }
    ));
    assert_eq!(
        super::native_atomic_by_key("run_in_sandbox").map(|entry| entry.tool_name),
        Some("run_in_sandbox")
    );
}

#[test]
fn template_catalog_entries_are_searchable_but_not_callable() {
    let corpus = super::template_catalog_capability_entries();
    let ranked = super::bm25_rank(&corpus, "startup pitch investor", 3);
    let entry = ranked.first().expect("template catalog entry");

    assert_eq!(entry.key, "homun/startup-pitch-clean-01");
    assert_eq!(entry.source, super::CapabilitySource::TemplateCatalog);
    assert!(entry.schema.is_none());
    assert!(!entry.is_skill);
    assert!(entry.text.contains("template catalog"));
}

/// (F1.d) The browser tools seeded into the registry must BE the chat tools — same
/// names, same real schemas — not the old dot-named placeholders. Otherwise the planner
/// plans a `browser.navigate` step the chat loop can't run.
#[test]
fn browser_registry_tools_mirror_the_chat_tools_with_real_schemas() {
    let tools = super::browser_registry_cached_tools();
    let names: Vec<&str> = tools.iter().map(|tool| tool.tool.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "browser_navigate",
            "browser_snapshot",
            "browser_rehydrate",
            "browser_act",
            "browser_tabs",
            "browser_screenshot",
            "browser_dialog",
        ]
    );

    let navigate = tools
        .iter()
        .find(|tool| tool.tool.name == "browser_navigate")
        .expect("browser_navigate seeded");
    // The real schema, not the `{"type":"object"}` placeholder the seed used to carry.
    assert!(
        navigate
            .tool
            .input_schema
            .pointer("/properties/url")
            .is_some(),
        "browser_navigate must carry its real `url` parameter schema"
    );
    assert_ne!(
        navigate.tool.input_schema,
        serde_json::json!({"type": "object"})
    );

    // Read vs WriteWithConfirmation mirrors the chat safety posture.
    let snapshot = tools
        .iter()
        .find(|tool| tool.tool.name == "browser_snapshot")
        .expect("browser_snapshot seeded");
    assert_eq!(snapshot.tool.action, super::ActionClass::Read);
    assert_eq!(
        navigate.tool.action,
        super::ActionClass::WriteWithConfirmation
    );
}

/// (F1.a + F1.d) The end-to-end point of this convergence: feed the SEEDED browser tools
/// into the SAME ranker the orchestrator planner uses (`ToolCorpus`, now backed by the
/// shared BM25) and confirm a plain browse intent surfaces `browser_navigate`. Before the
/// fix the planner indexed dot-named placeholders and saw a shadow set → 0 browse steps.
#[test]
fn seeded_browser_tools_are_retrievable_by_the_planner_ranker() {
    use local_first_orchestrator::ToolCorpus;
    let tools: Vec<_> = super::browser_registry_cached_tools()
        .into_iter()
        .map(|cached| cached.tool)
        .collect();
    let mut corpus = ToolCorpus::default();
    corpus.rebuild_from_tools(&tools);
    let cards = corpus.search("open and read a web page in the browser", 3);
    assert!(
        cards
            .iter()
            .any(|card| card.tool_name == "browser_navigate"),
        "planner ranker must surface browser_navigate, got {:?}",
        cards.iter().map(|card| &card.tool_name).collect::<Vec<_>>()
    );
}

/// (F1.d migration) The seed must be idempotent AND shed the old dot-named placeholders:
/// `upsert_cached_tool` keys on `(provider, name)`, so without `clear_cached_tools` a
/// renamed tool set would leave `browser.navigate` rows shadowing the planner forever.
#[test]
fn seed_browser_provider_is_idempotent_and_drops_stale_dot_named_tools() {
    let registry = super::CapabilityRegistryStore::open_in_memory().unwrap();
    let browser = super::CapabilityProviderId::new("browser");

    // First seed creates the provider + the seven real tools.
    super::seed_default_capabilities(&registry).unwrap();
    // Simulate an older build's stale dot-named row left in the cache.
    registry
        .upsert_cached_tool(&super::CachedCapabilityTool::new(
            browser.clone(),
            "browser.navigate",
            super::CapabilityProviderKind::Browser,
            super::ActionClass::WriteWithConfirmation,
            "old placeholder",
            vec!["browser".to_string()],
            "private",
            serde_json::json!({"type": "object"}),
        ))
        .unwrap();
    // Re-seed: clear_cached_tools must drop the stale row, and re-seeding must not dup.
    super::seed_default_capabilities(&registry).unwrap();

    let names: Vec<String> = registry
        .cached_tools(&browser)
        .unwrap()
        .into_iter()
        .map(|cached| cached.tool.name)
        .collect();
    assert_eq!(
        names.len(),
        7,
        "exactly the seven chat browser tools, no dup, no stale: {names:?}"
    );
    assert!(
        names.iter().all(|name| name.starts_with("browser_")),
        "no dot-named shadow survives re-seed: {names:?}"
    );
    assert!(names.iter().any(|name| name == "browser_navigate"));
    assert!(!names.iter().any(|name| name == "browser.navigate"));
}

/// (F1.d contract) The seeded browser tools must be real, typed contracts when driven
/// through the actual `CapabilityFacade` — the same path the orchestrator uses: policy
/// gates visibility/executability, and `validate_arguments` rejects bad args with a
/// TYPED error BEFORE any execution. Proves the schemas aren't placeholders.
#[test]
fn seeded_browser_tools_enforce_their_arg_contracts_through_the_facade() {
    let registry = super::CapabilityRegistryStore::open_in_memory().unwrap();
    super::seed_default_capabilities(&registry).unwrap();
    let user = super::gateway_capability_user_id();
    let workspace = super::gateway_capability_workspace_id();
    let policy = registry.policy_context(&user, &workspace).unwrap();
    let browser = super::CapabilityProviderId::new("browser");
    let tools: Vec<_> = registry
        .cached_tools(&browser)
        .unwrap()
        .into_iter()
        .map(|cached| cached.tool)
        .collect();

    let mut facade = super::CapabilityFacade::new(
        super::CapabilityPolicy,
        super::InMemoryCapabilityAudit::default(),
    );
    facade.register_provider(super::CachedToolProvider::new(
        browser.clone(),
        super::CapabilityProviderKind::Browser,
        tools,
    ));

    // The browser grant (Read + WriteWithConfirmation, autonomy 3) makes all seven visible
    // and executable, so calls reach argument validation.
    let plan = facade.list_tools(&policy).unwrap();
    assert_eq!(
        plan.visible_tools.len(),
        7,
        "all seven browser tools visible"
    );
    assert_eq!(
        plan.executable_tools.len(),
        7,
        "and executable under the grant"
    );

    let call = |tool: &str, args: serde_json::Value| super::CapabilityCall {
        provider_id: browser.clone(),
        tool_name: tool.to_string(),
        arguments: args,
    };

    // Missing required arg → typed SchemaValidationFailed (navigate needs `url`).
    let missing_url = facade
        .call_tool(&policy, call("browser_navigate", serde_json::json!({})))
        .unwrap_err();
    assert!(
        matches!(
            missing_url,
            super::CapabilityError::SchemaValidationFailed(_)
        ),
        "navigate without url must be a typed validation error, got {missing_url:?}"
    );
    // browser_act needs `kind`.
    let missing_kind = facade
        .call_tool(&policy, call("browser_act", serde_json::json!({})))
        .unwrap_err();
    assert!(
        matches!(
            missing_kind,
            super::CapabilityError::SchemaValidationFailed(_)
        ),
        "act without kind/actions must be a typed validation error, got {missing_kind:?}"
    );
    let valid_bundle = facade
        .call_tool(
            &policy,
            call(
                "browser_act",
                serde_json::json!({
                    "actions": [
                        {"kind": "type", "ref": "e1", "text": "Napoli"},
                        {"kind": "click", "ref": "e2"}
                    ]
                }),
            ),
        )
        .unwrap_err();
    assert!(
        matches!(valid_bundle, super::CapabilityError::ProviderUnavailable(_)),
        "a well-formed action bundle must clear validation and reach the executor, got {valid_bundle:?}"
    );

    // Valid args PASS validation — proven because execution is reached and the
    // planning-only cached provider refuses with ProviderUnavailable (not a validation
    // error). I.e. the schema accepted the good call.
    let valid = facade
        .call_tool(
            &policy,
            call(
                "browser_navigate",
                serde_json::json!({"url": "https://example.com"}),
            ),
        )
        .unwrap_err();
    assert!(
        matches!(valid, super::CapabilityError::ProviderUnavailable(_)),
        "a well-formed navigate must clear validation and reach the executor, got {valid:?}"
    );
}

/// F3 on-ramp validation (ADR 0020): the orchestrator planner used to return 0 steps for a
/// browse task because it indexed the registry's dot-named placeholder browser tools — a
/// shadow set. F1.d seeded the REAL chat browser tools into the registry, so the planner
/// should now SEE the browser and be able to plan with it. This drives the SAME brain
/// construction the OrchestratorBrain planner uses, but over an in-memory seeded registry and
/// against the local gemma4 (the weak tier — caposaldo #2). Ignored by default: it hits the
/// live Ollama endpoint. Run with:
///   cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway \
///     orchestrated_planner_sees_browser -- --ignored --nocapture
#[test]
#[ignore = "hits the live Ollama gemma4 endpoint; run manually"]
fn orchestrated_planner_sees_browser_on_gemma4() {
    use local_first_capabilities::PolicyContext;

    // 1. Seed an in-memory registry exactly as the gateway does (real browser tools, F1.d).
    let registry = super::CapabilityRegistryStore::open_in_memory().unwrap();
    super::seed_default_capabilities(&registry).unwrap();
    let user = super::gateway_capability_user_id();
    let workspace = super::gateway_capability_workspace_id();
    let mut policy: PolicyContext = registry.policy_context(&user, &workspace).unwrap();

    // 2. Build the facade the brain plans over (planning is Read/Draft only).
    let mut provider_tools = Vec::new();
    for provider in &policy.enabled_providers {
        let tools: Vec<_> = registry
            .cached_tools(provider)
            .unwrap()
            .into_iter()
            .map(|cached| cached.tool)
            .collect();
        provider_tools.push((provider.clone(), tools));
    }
    policy.allowed_actions = vec![super::ActionClass::Read, super::ActionClass::Draft];
    let mut facade = super::CapabilityFacade::new(
        super::CapabilityPolicy,
        super::InMemoryCapabilityAudit::default(),
    );
    for (provider_id, tools) in provider_tools {
        let kind = tools
            .first()
            .map(|tool| tool.provider_kind)
            .unwrap_or(super::CapabilityProviderKind::Native);
        facade.register_provider(super::CachedToolProvider::new(provider_id, kind, tools));
    }

    // Deterministic half: the planner's tool view now CONTAINS the real browser tool.
    let visible = facade.list_tools(&policy).unwrap();
    assert!(
        visible
            .visible_tools
            .iter()
            .any(|tool| tool.name == "browser_navigate"),
        "F1.d regressed: the planner can't see browser_navigate; visible = {:?}",
        visible.visible_tool_names()
    );

    // 3. Live half: run the planner on gemma4 for a browse task and print the plan.
    let router = super::build_router_from(
        super::ProviderKind::OpenaiCompat,
        "http://127.0.0.1:11434/v1",
        "gemma4:latest",
        None,
        32_768,
    );
    let mut brain = super::OrchestratorBrain::new(
        router,
        super::GatewayBrainMemory(None),
        facade,
        local_first_task_runtime::TaskStore::open_in_memory().unwrap(),
    );
    let request = super::OrchestratorRequest {
        request_id: "f3_onramp_validation".to_string(),
        policy_context: policy,
        user_message: "Cerca sul web i treni da Milano a Roma per domani mattina e \
                           riportami orari e prezzi."
            .to_string(),
        conversation_summary: None,
        attachments: Vec::new(),
        budgets: super::brain_budgets_for_context_window(Some(32_768)),
        language: "it".to_string(),
    };
    let plan = brain
        .plan_only(&request)
        .expect("plan_only must succeed end-to-end on gemma4 (the on-ramp mechanism)");

    eprintln!("\n=== F3 on-ramp: gemma4 plan ===");
    eprintln!("route: {:?}", plan.route);
    for (i, step) in plan.steps.iter().enumerate() {
        eprintln!(
            "  step {i}: kind={:?} tool={:?} args={} goal={:?}",
            step.kind, step.tool_name, step.arguments, step.goal
        );
    }
    let mentions_browser = plan.steps.iter().any(|step| {
        step.tool_name
            .as_deref()
            .is_some_and(|t| t.contains("browser"))
    });
    eprintln!(
        "steps={} mentions_browser={mentions_browser}",
        plan.steps.len()
    );
    eprintln!("=== end plan ===\n");
}

/// F3 engine-#2 VERTICAL on the weak tier (ADR 0020 Fase 1 b+d): gemma4 plans, then the
/// in-turn `drive` executes that REAL plan to `done` through the canonical CapabilityFacade.
/// The browser provider here is an EXECUTABLE fake seeded with the real browser tool schemas
/// (visible to the planner AND runnable by the driver) — no live sidecar needed.
///
/// Validates the full chain on the weak tier: planner (gemma4) → driver → per-step
/// argument-fill (gemma4 again, CONSTRAINED to the tool schema — the planner leaves args empty
/// by design, ADR 0020 P1) → execute via the facade → runtime marks `done` only after verify.
/// The three invariants hold: boundedness (one result per step), monotonicity (a Done never
/// reopens), identity = step_id. Ignored: hits the live Ollama endpoint. Run with:
///   cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway \
///     orchestrated_brain_drives_plan_on_gemma4 -- --ignored --nocapture
#[test]
#[ignore = "hits the live Ollama gemma4 endpoint; run manually"]
fn orchestrated_brain_drives_plan_on_gemma4() {
    use local_first_capabilities::{FakeCapabilityProvider, PolicyContext, ProviderId};

    // 1. Seed the registry exactly as the gateway does (real browser tools, F1.d).
    let registry = super::CapabilityRegistryStore::open_in_memory().unwrap();
    super::seed_default_capabilities(&registry).unwrap();
    let user = super::gateway_capability_user_id();
    let workspace = super::gateway_capability_workspace_id();
    let mut policy: PolicyContext = registry.policy_context(&user, &workspace).unwrap();
    // Allow confirmation-gated writes so browser_act can execute through the fake provider.
    policy.allowed_actions = vec![
        super::ActionClass::Read,
        super::ActionClass::Draft,
        super::ActionClass::WriteWithConfirmation,
    ];

    // 2. Build the facade: the browser provider is an EXECUTABLE fake carrying the real
    //    browser tool schemas (visible to the planner AND runnable by the driver); every
    //    other seeded provider stays planning-only (CachedToolProvider).
    let mut facade = super::CapabilityFacade::new(
        super::CapabilityPolicy,
        super::InMemoryCapabilityAudit::default(),
    );
    let browser_provider_id = ProviderId::new("browser");
    for provider in &policy.enabled_providers {
        let tools: Vec<_> = registry
            .cached_tools(provider)
            .unwrap()
            .into_iter()
            .map(|cached| cached.tool)
            .collect();
        if *provider == browser_provider_id {
            let mut fake = FakeCapabilityProvider::new(
                provider.clone(),
                super::CapabilityProviderKind::Browser,
                true,
                None,
                tools.clone(),
            );
            // Canned per-tool responses so each browser step succeeds deterministically.
            for tool in &tools {
                fake.set_tool_response(
                    &tool.name,
                    serde_json::json!({"ok": true, "tool": tool.name}),
                );
            }
            facade.register_provider(fake);
        } else {
            let kind = tools
                .first()
                .map(|tool| tool.provider_kind)
                .unwrap_or(super::CapabilityProviderKind::Native);
            facade.register_provider(super::CachedToolProvider::new(
                provider.clone(),
                kind,
                tools,
            ));
        }
    }

    // 3. Plan on gemma4, then DRIVE the plan to completion.
    let router = super::build_router_from(
        super::ProviderKind::OpenaiCompat,
        "http://127.0.0.1:11434/v1",
        "gemma4:latest",
        None,
        32_768,
    );
    let mut brain = super::OrchestratorBrain::new(
        router,
        super::GatewayBrainMemory(None),
        facade,
        local_first_task_runtime::TaskStore::open_in_memory().unwrap(),
    );
    let request = super::OrchestratorRequest {
        request_id: "f3_drive_validation".to_string(),
        policy_context: policy,
        user_message: "Cerca sul web i treni da Milano a Roma per domani mattina e \
                           riportami orari e prezzi."
            .to_string(),
        conversation_summary: None,
        attachments: Vec::new(),
        budgets: super::brain_budgets_for_context_window(Some(32_768)),
        language: "it".to_string(),
    };
    let plan = brain
        .plan_only(&request)
        .expect("plan_only must succeed on gemma4");
    let outcome = brain
        .drive(&request, &plan)
        .expect("drive must execute the gemma4 plan end-to-end");

    eprintln!("\n=== F3 drive: gemma4 plan executed ===");
    for result in &outcome.results {
        eprintln!(
            "  {} -> {:?} {:?}",
            result.step_id, result.status, result.error
        );
    }
    let done = outcome
        .results
        .iter()
        .filter(|r| r.status == local_first_orchestrator::DriveStepStatus::Done)
        .count();
    eprintln!("done {}/{} steps", done, outcome.results.len());
    eprintln!("=== end drive ===\n");

    // Boundedness: exactly one result per planned step — driving never grows the plan.
    assert_eq!(
        outcome.results.len(),
        plan.steps.len(),
        "driver must return one result per step (boundedness invariant)"
    );
    // At least one step reached Done: gemma4 planned, gemma4 filled the args constrained to
    // the tool schema, the facade executed, and the runtime verified — the engine-#2 vertical
    // works end-to-end on the weak tier (caposaldo #2).
    assert!(
        done >= 1,
        "no step reached Done; the gemma4 plan did not drive to completion through the facade"
    );
}

/// F3.2c agentic-mode validation on the weak tier (ADR 0016 Pilastro 2 / ADR 0020 Fase 2):
/// a `SubagentTask` step is driven by the bounded inner loop where gemma4 STEERS — it chooses
/// a read/gather tool from the constrained enum, runs it through the facade, and finishes with
/// a summary, all under the harness's round budget. A hand-built single-subagent plan + an
/// executable fake `web_search` (Read) tool. Proves a weak model can drive the agentic loop.
/// Ignored: hits the live Ollama endpoint. Run with:
///   cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway \
///     orchestrated_subagent_gathers_on_gemma4 -- --ignored --nocapture
#[test]
#[ignore = "hits the live Ollama gemma4 endpoint; run manually"]
fn orchestrated_subagent_gathers_on_gemma4() {
    use local_first_capabilities::{
        FakeCapabilityProvider, PolicyContext, ProviderId, UserId, WorkspaceId,
    };
    use local_first_orchestrator::{ExecutionPlan, OrchestratorRoute, PlanStep, PlanStepKind};
    use local_first_subagents::{AgentId, AllowedAction};

    // Executable fake gather provider: one Read tool the sub-agent may use.
    let search_tool = super::CapabilityTool {
        name: "web_search".to_string(),
        provider_id: ProviderId::new("research"),
        provider_kind: super::CapabilityProviderKind::Native,
        action: super::ActionClass::Read,
        description: "Search the web for a query and return result snippets".to_string(),
        privacy_domains: vec!["web".to_string()],
        sensitivity: "public".to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
            "additionalProperties": false
        }),
    };
    let mut provider = FakeCapabilityProvider::new(
        ProviderId::new("research"),
        super::CapabilityProviderKind::Native,
        true,
        None,
        vec![search_tool],
    );
    provider.set_tool_response(
        "web_search",
        serde_json::json!({"results": ["Frecciarossa 08:00 €29", "Italo 09:10 €25"]}),
    );
    let mut facade = super::CapabilityFacade::new(
        super::CapabilityPolicy,
        super::InMemoryCapabilityAudit::default(),
    );
    facade.register_provider(provider);

    let policy = PolicyContext {
        user_id: UserId::new("u"),
        workspace_id: WorkspaceId::new("w"),
        enabled_providers: vec![ProviderId::new("research")],
        privacy_domains: vec!["web".to_string()],
        allowed_actions: vec![super::ActionClass::Read, super::ActionClass::Draft],
        max_autonomy_level: 2,
        allow_managed_cloud: false,
    };

    let router = super::build_router_from(
        super::ProviderKind::OpenaiCompat,
        "http://127.0.0.1:11434/v1",
        "gemma4:latest",
        None,
        32_768,
    );
    let mut brain = super::OrchestratorBrain::new(
        router,
        super::GatewayBrainMemory(None),
        facade,
        local_first_task_runtime::TaskStore::open_in_memory().unwrap(),
    );

    // Hand-built plan: one read/gather sub-agent (no planner roundtrip needed).
    let plan = ExecutionPlan {
        route: OrchestratorRoute::SubagentWorkflow,
        direct_answer: None,
        plan_propose: None,
        steps: vec![PlanStep {
            step_id: "gather_trains".to_string(),
            kind: PlanStepKind::SubagentTask,
            depends_on: vec![],
            provider_id: None,
            tool_name: None,
            arguments: serde_json::Value::Null,
            execution_policy: super::StepExecutionPolicy::DurableTask,
            risk_level: "low".to_string(),
            expected_duration_seconds: 30,
            agent_id: Some(AgentId::Tool),
            goal: Some("Find morning train times from Milan to Rome".to_string()),
            contract: Some("A short summary listing the train times".to_string()),
            allowed_actions: vec![AllowedAction::Read],
            requires_user_approval: None,
            timeout_seconds: None,
            max_tokens: None,
        }],
        needs_more_tools: None,
    };
    let request = super::OrchestratorRequest {
        request_id: "f3_2c_validation".to_string(),
        policy_context: policy,
        user_message: "treni del mattino Milano-Roma".to_string(),
        conversation_summary: None,
        attachments: Vec::new(),
        budgets: super::brain_budgets_for_context_window(Some(32_768)),
        language: "it".to_string(),
    };

    let outcome = brain
        .drive(&request, &plan)
        .expect("agentic subagent step must drive on gemma4");

    let step = &outcome.results[0];
    eprintln!("\n=== F3.2c agentic: gemma4 sub-agent ===");
    eprintln!("status: {:?}", step.status);
    eprintln!("evidence: {:?}", step.outcome.as_ref().map(|o| &o.evidence));
    eprintln!("output: {:?}", step.outcome.as_ref().map(|o| &o.output));
    eprintln!("=== end ===\n");

    // The sub-agent finished within budget → Done with a summary.
    assert_eq!(
        step.status,
        local_first_orchestrator::DriveStepStatus::Done,
        "gemma4 sub-agent did not reach Done"
    );
    assert!(
        step.outcome
            .as_ref()
            .unwrap()
            .output
            .get("summary")
            .is_some(),
        "agentic step must return a summary"
    );
}

#[test]
fn imported_template_pack_manifest_loads_real_pptx_metadata() {
    let root = std::env::temp_dir().join(format!(
        "homun-imported-template-pack-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let pack = root.join("slidescarnival_pitch");
    std::fs::create_dir_all(pack.join("thumbnails")).expect("pack dirs");
    std::fs::write(pack.join("source.pptx"), b"pptx bytes").expect("source pptx");
    std::fs::write(pack.join("thumbnails/slide-001.png"), b"png").expect("thumb");
    std::fs::write(
        pack.join("manifest.json"),
        serde_json::json!({
            "id": "slidescarnival/pitch-clean",
            "name": "Pitch Clean",
            "kind": "presentation",
            "description": "Imported SlidesCarnival pitch template.",
            "source_provider": "slidescarnival",
            "source_url": "https://www.slidescarnival.com/template/example/123",
            "license": "Creative Commons Attribution 4.0",
            "attribution_required": true,
            "attribution_text": "Template by SlidesCarnival",
            "redistribution_policy": "generated_decks_only",
            "design_template": "startup_pitch",
            "design_theme": "clean_corporate",
            "design_profile": "sales_pitch",
            "design_components": ["kpi_grid", "timeline"],
            "layout_archetypes": ["cover", "problem", "solution", "ask"],
            "tags": ["slidescarnival", "pitch"],
            "route_text": "slidescarnival pitch investor startup"
        })
        .to_string(),
    )
    .expect("manifest");

    let provider = super::ImportedTemplatePackProvider::from_root(&root).expect("provider");
    let entries = super::TemplateCatalogProvider::entries(&provider);
    let entry = entries
        .iter()
        .find(|entry| entry.id == "slidescarnival/pitch-clean")
        .expect("imported entry");

    assert_eq!(entry.provider, "local_template_pack");
    assert_eq!(entry.source_provider.as_deref(), Some("slidescarnival"));
    assert_eq!(
        entry.source_ref.as_deref(),
        Some("https://www.slidescarnival.com/template/example/123")
    );
    assert_eq!(
        entry.license.as_deref(),
        Some("Creative Commons Attribution 4.0")
    );
    assert_eq!(
        entry.attribution_text.as_deref(),
        Some("Template by SlidesCarnival")
    );
    assert_eq!(
        entry.redistribution_policy.as_deref(),
        Some("generated_decks_only")
    );
    assert!(entry.attribution_required);
    assert!(
        entry
            .preview_ref
            .as_deref()
            .is_some_and(|value| value.starts_with("template-pack://slidescarnival/pitch-clean/"))
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn imported_template_pack_rejects_missing_source_pptx() {
    let root = std::env::temp_dir().join(format!(
        "homun-imported-template-pack-missing-{}",
        std::process::id()
    ));
    let pack = root.join("bad_pack");
    std::fs::create_dir_all(&pack).expect("pack dir");
    std::fs::write(
        pack.join("manifest.json"),
        serde_json::json!({
            "id": "slidescarnival/missing-source",
            "name": "Missing Source",
            "kind": "presentation",
            "description": "Invalid imported pack.",
            "source_provider": "slidescarnival",
            "license": "Creative Commons Attribution 4.0",
            "attribution_required": true,
            "attribution_text": "Template by SlidesCarnival",
            "redistribution_policy": "generated_decks_only",
            "design_template": "startup_pitch",
            "route_text": "invalid"
        })
        .to_string(),
    )
    .expect("manifest");

    let provider = super::ImportedTemplatePackProvider::from_root(&root).expect("provider");
    assert!(super::TemplateCatalogProvider::entries(&provider).is_empty());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn template_catalog_entries_include_imported_template_packs_after_bundled_templates() {
    let root = std::env::temp_dir().join(format!(
        "homun-template-pack-aggregate-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let pack = root.join("imported_pitch");
    std::fs::create_dir_all(pack.join("thumbnails")).expect("pack dirs");
    std::fs::write(pack.join("source.pptx"), b"pptx").expect("source");
    std::fs::write(pack.join("thumbnails/slide-001.png"), b"png").expect("thumb");
    std::fs::write(
        pack.join("manifest.json"),
        serde_json::json!({
            "id": "slidescarnival/imported-pitch",
            "name": "Imported Pitch",
            "kind": "presentation",
            "description": "Imported real PPTX template.",
            "source_provider": "slidescarnival",
            "source_url": "https://www.slidescarnival.com/template/imported/123",
            "license": "Creative Commons Attribution 4.0",
            "attribution_required": true,
            "attribution_text": "Template by SlidesCarnival",
            "redistribution_policy": "generated_decks_only",
            "design_template": "startup_pitch",
            "route_text": "imported pitch"
        })
        .to_string(),
    )
    .expect("manifest");

    let imported = super::ImportedTemplatePackProvider::from_root(&root).expect("provider");
    let bundled_root =
        super::template_packs::bundled_template_pack_root().expect("repo templates dir");
    let bundled = super::template_packs::BundledTemplatePackProvider::from_root(&bundled_root)
        .expect("bundled provider");
    let catalog = super::collect_template_catalog_entries(&[&bundled, &imported]);
    let bundled_position = catalog
        .iter()
        .position(|entry| entry.id == "homun/startup-pitch-clean-01")
        .expect("bundled template");
    let imported_position = catalog
        .iter()
        .position(|entry| entry.id == "slidescarnival/imported-pitch")
        .expect("imported template");

    assert!(bundled_position < imported_position);
    assert_eq!(
        catalog[imported_position].source_provider.as_deref(),
        Some("slidescarnival")
    );
    assert!(catalog[imported_position].template_pack_root.is_some());

    let response = super::template_catalog_response_from_entries(catalog);
    let value = serde_json::to_value(&response).expect("json");
    let imported_json = value["templates"]
        .as_array()
        .expect("templates")
        .iter()
        .find(|entry| entry["id"] == "slidescarnival/imported-pitch")
        .expect("imported response");

    assert_eq!(imported_json["provider"], "local_template_pack");
    assert_eq!(imported_json["source_provider"], "slidescarnival");
    assert_eq!(imported_json["attribution_required"], true);
    assert_eq!(
        imported_json["attribution_text"],
        "Template by SlidesCarnival"
    );
    assert_eq!(
        imported_json["redistribution_policy"],
        "generated_decks_only"
    );
    assert_eq!(imported_json["is_imported"], true);
    assert!(imported_json.get("source_path").is_none());
    assert!(imported_json.get("template_pack_root").is_none());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn import_pptx_template_pack_copies_source_and_writes_manifest() {
    let root = std::env::temp_dir().join(format!(
        "homun-import-root-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let source = root.join("source-files/template.pptx");
    std::fs::create_dir_all(source.parent().unwrap()).expect("source dir");
    if !write_test_pptx(&source, "Customer Pitch") {
        return;
    }
    let target_root = root.join("packs");

    let imported = super::import_pptx_template_pack(
        &target_root,
        super::ImportPptxTemplateRequest {
            source_path: source.to_string_lossy().to_string(),
            name: "Customer Pitch".to_string(),
            source_provider: Some("slidescarnival".to_string()),
            source_url: Some(
                "https://www.slidescarnival.com/template/customer-pitch/123".to_string(),
            ),
            license: Some("Creative Commons Attribution 4.0".to_string()),
            attribution_required: Some(true),
            attribution_text: Some("Template by SlidesCarnival".to_string()),
            redistribution_policy: Some("generated_decks_only".to_string()),
            tags: Some(vec!["pitch".to_string(), "slidescarnival".to_string()]),
        },
    )
    .expect("imported");

    assert!(imported.source_path.as_ref().is_some_and(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "source.pptx")
    }));
    assert!(target_root.join("customer-pitch/source.pptx").exists());
    assert!(target_root.join("customer-pitch/manifest.json").exists());
    assert_eq!(imported.id, "local/customer-pitch");
    assert_eq!(imported.source_provider.as_deref(), Some("slidescarnival"));
    assert_eq!(
        imported.source_ref.as_deref(),
        Some("https://www.slidescarnival.com/template/customer-pitch/123")
    );
    assert!(imported.attribution_required);

    let response = super::template_catalog_response_from_entries(vec![imported]);
    let value = serde_json::to_value(&response).expect("json");
    let first = &value["templates"][0];
    assert_eq!(first["is_imported"], true);
    assert!(first.get("source_path").is_none());
    assert!(first.get("template_pack_root").is_none());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn import_pptx_template_pack_generates_slide_preview_thumbnail() {
    let root = std::env::temp_dir().join(format!(
        "homun-import-thumbnail-root-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let source = root.join("source-files/template.pptx");
    std::fs::create_dir_all(source.parent().unwrap()).expect("source dir");
    if !write_test_pptx(&source, "Sales Kickoff") {
        return;
    }
    let target_root = root.join("packs");

    let imported = super::import_pptx_template_pack(
        &target_root,
        super::ImportPptxTemplateRequest {
            source_path: source.to_string_lossy().to_string(),
            name: "Sales Kickoff".to_string(),
            source_provider: Some("slidescarnival".to_string()),
            source_url: None,
            license: None,
            attribution_required: Some(false),
            attribution_text: None,
            redistribution_policy: None,
            tags: Some(vec!["sales".to_string()]),
        },
    )
    .expect("imported");

    let thumb = target_root
        .join("sales-kickoff")
        .join("thumbnails")
        .join("slide-001.png");
    assert!(thumb.is_file(), "expected thumbnail at {}", thumb.display());
    assert!(
        std::fs::metadata(&thumb)
            .map(|metadata| metadata.len() > 1024)
            .unwrap_or(false),
        "thumbnail should contain rendered PNG data"
    );
    assert_eq!(
        imported.preview_ref.as_deref(),
        Some("template-pack://local/sales-kickoff/thumbnails/slide-001.png")
    );

    let response = super::template_catalog_response_from_entries(vec![imported]);
    let value = serde_json::to_value(&response).expect("json");
    assert!(
        value["templates"][0]["preview_ref"]
            .as_str()
            .is_some_and(|preview| preview.starts_with("/api/templates/preview?ref=")),
        "{}",
        value["templates"][0]
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn delete_imported_template_pack_removes_local_pack_only() {
    let root = std::env::temp_dir().join(format!(
        "homun-import-delete-root-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let pack = root.join("sales-kickoff");
    std::fs::create_dir_all(pack.join("thumbnails")).expect("pack dirs");
    std::fs::write(pack.join("source.pptx"), b"pptx").expect("source");
    std::fs::write(pack.join("thumbnails/slide-001.png"), b"png").expect("thumb");
    std::fs::write(
        pack.join("manifest.json"),
        serde_json::json!({
            "id": "local/sales-kickoff",
            "name": "Sales Kickoff",
            "kind": "presentation",
            "description": "Imported real PPTX template.",
            "source_provider": "user_upload",
            "license": "User upload",
            "attribution_required": false,
            "redistribution_policy": "owned_by_user",
            "design_template": "startup_pitch",
            "route_text": "sales kickoff"
        })
        .to_string(),
    )
    .expect("manifest");

    super::delete_imported_template_pack(&root, "local/sales-kickoff")
        .expect("delete imported pack");

    assert!(!pack.exists(), "pack directory should be removed");
    assert!(super::delete_imported_template_pack(&root, "homun/startup-pitch-clean-01").is_err());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn materialize_deck_template_source_copies_imported_pptx_for_renderer() {
    let root = std::env::temp_dir().join(format!(
        "homun-template-render-source-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let source = root.join("source.pptx");
    std::fs::create_dir_all(&root).expect("root");
    std::fs::write(&source, b"real pptx bytes").expect("source");
    let thread_slug = format!("template-render-source-{}", std::process::id());
    let _ = std::fs::remove_dir_all(super::sandbox::artifacts_dir().join(&thread_slug));

    let template = super::TemplateCatalogEntry {
        provider: "local_template_pack".to_string(),
        id: "local/sales-kickoff".to_string(),
        name: "Sales Kickoff".to_string(),
        kind: "presentation".to_string(),
        category: "other".to_string(),
        description: "Imported template".to_string(),
        name_it: None,
        description_it: None,
        use_cases: Vec::new(),
        audience: Vec::new(),
        design_template: "startup_pitch".to_string(),
        design_theme: None,
        design_profile: None,
        design_components: Vec::new(),
        layout_archetypes: Vec::new(),
        tags: Vec::new(),
        intake_questions: Vec::new(),
        preview_ref: None,
        preview_html_ref: None,
        source_ref: None,
        license: None,
        source_provider: Some("user_upload".to_string()),
        source_path: Some(source.clone()),
        template_pack_root: Some(root.clone()),
        bundled: false,
        attribution_required: false,
        attribution_text: None,
        redistribution_policy: None,
        route_text: "sales kickoff".to_string(),
    };

    let filename = super::materialize_deck_template_source(&thread_slug, Some(&template))
        .expect("materialized")
        .expect("filename");

    assert_eq!(filename, ".internal/template-source.pptx");
    assert_eq!(
        std::fs::read(
            super::sandbox::artifacts_dir()
                .join(&thread_slug)
                .join(&filename)
        )
        .expect("copied"),
        b"real pptx bytes"
    );

    let _ = std::fs::remove_dir_all(super::sandbox::artifacts_dir().join(&thread_slug));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn expanded_template_catalog_routes_common_pmi_deliverables() {
    let corpus = super::template_catalog_capability_entries();

    // Bundled-only catalog (Task 7): route against the two real shipped packs
    // instead of the retired seed's meeting-minutes/case-study entries.
    let executive_update = super::bm25_rank(&corpus, "board update rischi decisioni next steps", 1)
        .into_iter()
        .next()
        .expect("executive update template");
    assert_eq!(executive_update.key, "homun/executive-update-board-01");

    let startup_pitch = super::bm25_rank(&corpus, "startup pitch fundraising investor", 1)
        .into_iter()
        .next()
        .expect("startup pitch template");
    assert_eq!(startup_pitch.key, "homun/startup-pitch-clean-01");
}

#[test]
fn template_catalog_collects_multiple_providers_without_duplicate_ids() {
    struct ExtraProvider;
    impl super::TemplateCatalogProvider for ExtraProvider {
        fn provider_id(&self) -> &'static str {
            "extra"
        }

        fn entries(&self) -> Vec<super::TemplateCatalogEntry> {
            vec![
                super::template_catalog_entry(
                    "extra",
                    "external/customer-case-study-01",
                    "Customer Case Study",
                    "document",
                    "Case study template for customer proof and outcomes.",
                    &["case study"],
                    &["customers"],
                    "sales_proposal",
                    Some("clean_corporate"),
                    Some("sales_pitch"),
                    &["quote_callout", "kpi_grid"],
                    &["summary", "proof", "outcomes"],
                    "case study customer proof outcomes",
                ),
                super::template_catalog_entry(
                    "extra",
                    "homun/startup-pitch-clean-01",
                    "Duplicate Startup Pitch",
                    "presentation",
                    "Duplicate should not override first provider.",
                    &["duplicate"],
                    &["test"],
                    "project_plan",
                    None,
                    None,
                    &[],
                    &[],
                    "duplicate",
                ),
            ]
        }
    }

    let bundled_root =
        super::template_packs::bundled_template_pack_root().expect("repo templates dir");
    let bundled = super::template_packs::BundledTemplatePackProvider::from_root(&bundled_root)
        .expect("bundled provider");
    let catalog = super::collect_template_catalog_entries(&[&bundled, &ExtraProvider]);

    assert_eq!(
        catalog
            .iter()
            .filter(|entry| entry.id == "homun/startup-pitch-clean-01")
            .count(),
        1,
    );
    assert_eq!(
        catalog
            .iter()
            .find(|entry| entry.id == "external/customer-case-study-01")
            .map(|entry| entry.provider.as_str()),
        Some("extra"),
    );
    assert_eq!(
        super::template_catalog_by_id_from_entries(
            &catalog,
            Some("external/customer-case-study-01")
        )
        .map(|entry| entry.design_template),
        Some("sales_proposal".to_string()),
    );
}

#[test]
fn file_template_catalog_provider_loads_valid_manifest() {
    let manifest = serde_json::json!({
        "provider_id": "acme_file",
        "templates": [
            {
                "id": "acme_file/investor-pitch-01",
                "name": "Investor Pitch",
                "kind": "presentation",
                "description": "Investor pitch template from a local catalog file.",
                "use_cases": ["fundraising", "pitch"],
                "audience": ["investors"],
                "design_template": "startup_pitch",
                "design_theme": "clean_corporate",
                "design_profile": "sales_pitch",
                "design_components": ["kpi_grid", "timeline", "unknown_component"],
                "layout_archetypes": ["cover", "traction", "ask"],
                "tags": ["premium", "investor", "premium"],
                "preview_ref": "assets/investor-pitch.png",
                "source_ref": "https://example.com/templates/investor-pitch",
                "license": "commercial",
                "route_text": "investor pitch fundraising"
            }
        ]
    });
    let provider = super::FileTemplateCatalogProvider::from_json_str(manifest.to_string().as_str())
        .expect("file provider");
    let entries = super::TemplateCatalogProvider::entries(&provider);

    assert_eq!(
        super::TemplateCatalogProvider::provider_id(&provider),
        "acme_file"
    );
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].id, "acme_file/investor-pitch-01");
    assert_eq!(entries[0].provider, "acme_file");
    assert_eq!(entries[0].design_template, "startup_pitch");
    assert_eq!(entries[0].design_theme.as_deref(), Some("clean_corporate"));
    assert_eq!(
        entries[0].design_components,
        vec!["kpi_grid".to_string(), "timeline".to_string()],
    );
    assert_eq!(
        entries[0].tags,
        vec!["premium".to_string(), "investor".to_string()],
    );
    assert_eq!(
        entries[0].preview_ref.as_deref(),
        Some("assets/investor-pitch.png")
    );
    assert_eq!(
        entries[0].source_ref.as_deref(),
        Some("https://example.com/templates/investor-pitch"),
    );
    assert_eq!(entries[0].license.as_deref(), Some("commercial"));
}

#[test]
fn file_template_catalog_entry_parses_localized_names() {
    let manifest = serde_json::json!({
        "provider_id": "acme",
        "templates": [{
            "id": "acme/localized-01",
            "kind": "presentation",
            "name": "Localized Pitch",
            "name_it": "Pitch localizzato",
            "description": "A pitch template.",
            "description_it": "Un template per pitch.",
            "design_template": "startup_pitch",
            "route_text": "pitch localized"
        }]
    });
    let provider = super::FileTemplateCatalogProvider::from_json_str(manifest.to_string().as_str())
        .expect("provider");
    let entry = &provider.entries[0];
    assert_eq!(entry.name_it.as_deref(), Some("Pitch localizzato"));
    assert_eq!(
        entry.description_it.as_deref(),
        Some("Un template per pitch.")
    );
    assert!(!entry.bundled);
    assert!(entry.preview_html_ref.is_none());
}

#[test]
fn file_template_catalog_entry_parses_intake_questions() {
    let manifest = serde_json::json!({
        "provider_id": "acme",
        "templates": [{
            "id": "acme/q-01", "kind": "document", "name": "Q",
            "description": "Doc with questions.", "design_template": "sales_proposal",
            "route_text": "q",
            "intake_questions": ["Who is it for?", "Which numbers matter?"]
        }]
    });
    let provider = super::FileTemplateCatalogProvider::from_json_str(manifest.to_string().as_str())
        .expect("provider");
    assert_eq!(
        provider.entries[0].intake_questions,
        vec!["Who is it for?", "Which numbers matter?"]
    );
}

#[test]
fn file_template_catalog_entry_parses_category_with_fallback() {
    let manifest = serde_json::json!({"provider_id": "acme", "templates": [
            {"id": "acme/a", "kind": "document", "name": "A", "description": "d",
             "design_template": "sales_proposal", "route_text": "r", "category": "cv_career"},
            {"id": "acme/b", "kind": "document", "name": "B", "description": "d",
             "design_template": "sales_proposal", "route_text": "r", "category": "bogus"},
            {"id": "acme/c", "kind": "document", "name": "C", "description": "d",
             "design_template": "sales_proposal", "route_text": "r"}]});
    let p =
        super::FileTemplateCatalogProvider::from_json_str(manifest.to_string().as_str()).unwrap();
    assert_eq!(p.entries[0].category, "cv_career");
    assert_eq!(p.entries[1].category, "other"); // bogus → fallback
    assert_eq!(p.entries[2].category, "other"); // absent → fallback
}

#[test]
fn bundled_entries_do_not_report_as_imported() {
    let manifest = serde_json::json!({
        "provider_id": "acme",
        "templates": [{
            "id": "acme/bundled-01",
            "kind": "presentation",
            "name": "Bundled Pack",
            "description": "A bundled template pack.",
            "design_template": "startup_pitch",
            "route_text": "bundled pack"
        }]
    });
    let provider = super::FileTemplateCatalogProvider::from_json_str(manifest.to_string().as_str())
        .expect("provider");
    let mut entry = provider.entries[0].clone();
    entry.template_pack_root = Some(std::path::PathBuf::from("/tmp/pack"));
    entry.bundled = true;
    let response = super::template_catalog_response_from_entries(vec![entry.clone()]);
    assert!(!response.templates[0].is_imported);
    entry.bundled = false;
    let response = super::template_catalog_response_from_entries(vec![entry]);
    assert!(response.templates[0].is_imported);
}

#[test]
fn file_template_catalog_provider_ignores_unsafe_preview_refs() {
    let manifest = serde_json::json!({
        "provider_id": "acme_file",
        "templates": [
            {
                "id": "acme_file/unsafe-preview-01",
                "name": "Unsafe Preview",
                "kind": "document",
                "description": "Template with unsafe preview metadata.",
                "design_template": "technical_brief",
                "preview_ref": "../secret.png",
                "source_ref": "file:///Users/fabio/secrets/template.json",
                "route_text": "unsafe preview"
            }
        ]
    });
    let provider = super::FileTemplateCatalogProvider::from_json_str(manifest.to_string().as_str())
        .expect("file provider");
    let entry = super::TemplateCatalogProvider::get(&provider, "acme_file/unsafe-preview-01")
        .expect("entry");

    assert_eq!(entry.preview_ref, None);
    assert_eq!(entry.source_ref, None);
}

#[test]
fn template_catalog_response_exposes_read_only_gallery_metadata() {
    let response =
        super::template_catalog_response_from_entries(vec![super::TemplateCatalogEntry {
            provider: "external".to_string(),
            id: "external/gallery-template-01".to_string(),
            name: "Gallery Template".to_string(),
            kind: "presentation".to_string(),
            category: "other".to_string(),
            description: "Template prepared for gallery preview.".to_string(),
            name_it: None,
            description_it: None,
            use_cases: vec!["pitch".to_string()],
            audience: vec!["clients".to_string()],
            design_template: "startup_pitch".to_string(),
            design_theme: Some("clean_corporate".to_string()),
            design_profile: Some("sales_pitch".to_string()),
            design_components: vec!["kpi_grid".to_string()],
            layout_archetypes: vec!["cover".to_string()],
            tags: vec!["premium".to_string()],
            intake_questions: Vec::new(),
            preview_ref: Some("assets/gallery-template.png".to_string()),
            preview_html_ref: None,
            source_ref: Some("https://example.com/gallery-template".to_string()),
            license: Some("commercial".to_string()),
            source_provider: None,
            source_path: None,
            template_pack_root: None,
            bundled: false,
            attribution_required: false,
            attribution_text: None,
            redistribution_policy: None,
            route_text: "gallery template".to_string(),
        }]);
    let value = serde_json::to_value(&response).expect("json");
    let first = &value["templates"][0];

    assert_eq!(first["id"], "external/gallery-template-01");
    assert_eq!(first["preview_ref"], "assets/gallery-template.png");
    assert_eq!(first["tags"][0], "premium");
    assert!(first.get("schema").is_none());
    assert!(first.get("callable").is_none());
}

#[test]
fn template_preview_relative_paths_are_jailed_to_known_assets() {
    assert_eq!(
        super::template_preview_content_type("thumbnails/slide-001.png"),
        Some("image/png")
    );
    assert_eq!(
        super::template_preview_content_type("preview.html"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        super::template_preview_content_type("thumbnails/evil.svg"),
        None
    );
    assert_eq!(super::template_preview_content_type("source.pptx"), None);
    assert_eq!(
        super::template_preview_content_type("nested/preview.html"),
        None
    );
}

#[test]
fn template_catalog_response_exposes_selection_notes_for_gallery() {
    let bundled_root =
        super::template_packs::bundled_template_pack_root().expect("repo templates dir");
    let bundled = super::template_packs::BundledTemplatePackProvider::from_root(&bundled_root)
        .expect("bundled provider");
    let response = super::template_catalog_response_from_entries(
        super::TemplateCatalogProvider::entries(&bundled),
    );
    let value = serde_json::to_value(&response).expect("json");
    let startup = value["templates"]
        .as_array()
        .expect("templates")
        .iter()
        .find(|entry| entry["id"] == "homun/startup-pitch-clean-01")
        .expect("startup pitch");
    let notes = startup["selection_notes"]
        .as_array()
        .expect("selection notes");

    assert!(
        notes
            .iter()
            .any(|note| note.as_str().is_some_and(|text| text.contains("pitch"))),
        "selection notes should explain why this template fits a request"
    );
    assert!(
        notes
            .iter()
            .any(|note| note.as_str().is_some_and(|text| text.contains("investors"))),
        "selection notes should expose audience fit"
    );
}

#[test]
fn template_catalog_capability_text_includes_selection_notes() {
    let corpus = super::template_catalog_capability_entries();
    let startup = corpus
        .iter()
        .find(|entry| entry.key == "homun/startup-pitch-clean-01")
        .expect("startup pitch");

    assert!(
        startup.text.contains("Selection notes"),
        "capability search should see template selection rationale"
    );
    assert!(startup.text.contains("investors"));
}

#[test]
fn file_template_catalog_provider_rejects_invalid_manifest_identity() {
    let invalid = serde_json::json!({
        "provider_id": "../bad provider",
        "templates": [
            {
                "id": "bad id",
                "name": "Bad",
                "kind": "presentation",
                "description": "Bad template.",
                "design_template": "unknown",
                "route_text": "bad"
            }
        ]
    });

    assert!(
        super::FileTemplateCatalogProvider::from_json_str(invalid.to_string().as_str()).is_err()
    );
}

#[test]
fn file_template_catalog_provider_loads_manifest_from_path() {
    let path = std::env::temp_dir().join(format!(
        "homun-template-catalog-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let manifest = serde_json::json!({
        "provider_id": "file_path_catalog",
        "templates": [
            {
                "id": "file_path_catalog/project-plan-01",
                "name": "Project Plan",
                "kind": "presentation",
                "description": "Project plan from disk.",
                "design_template": "project_plan",
                "design_theme": "minimal_mono",
                "design_profile": "technical",
                "design_components": ["process_steps", "timeline"],
                "route_text": "project plan disk"
            }
        ]
    });
    std::fs::write(&path, manifest.to_string()).expect("write manifest");

    let provider = super::FileTemplateCatalogProvider::from_path(&path).expect("provider");
    let _ = std::fs::remove_file(&path);

    assert_eq!(
        super::TemplateCatalogProvider::provider_id(&provider),
        "file_path_catalog"
    );
    assert_eq!(
        super::TemplateCatalogProvider::get(&provider, "file_path_catalog/project-plan-01")
            .map(|entry| entry.design_template),
        Some("project_plan".to_string()),
    );
}

#[test]
fn semantic_document_decision_produces_document_workflow_trace() {
    let semantic = semantic_route_fixture(
        super::semantic_decision::ExecutionShape::Workflow,
        Some("make_document"),
    );
    let decision = super::route_capability_from_semantic(Some(&semantic));

    assert!(matches!(
        decision,
        super::CapabilityRouteDecision::Workflow {
            workflow_id: "make_document",
            tool_name: "make_document",
            ..
        }
    ));
    let trace = super::capability_route_trace_line(&decision).expect("trace line");
    assert!(
        trace.contains("workflow make_document/make_document"),
        "{trace}"
    );
}

#[test]
fn workflow_registry_contributes_native_workflows_to_capability_corpus() {
    let corpus = super::native_workflow_capability_entries();
    let corpus_keys: Vec<&str> = corpus.iter().map(|entry| entry.key.as_str()).collect();
    let ranked = super::bm25_rank(&corpus, "creare un pitch per Homun", 2);
    let keys: Vec<&str> = ranked.iter().map(|entry| entry.key.as_str()).collect();

    assert!(corpus_keys.contains(&"make_deck"));
    assert!(corpus_keys.contains(&"make_document"));
    assert_eq!(keys.first().copied(), Some("make_deck"));
}

#[test]
fn mcp_tools_contribute_typed_entries_to_capability_corpus() {
    let schemas = vec![
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "mcp__filesystem__read_file",
                "description": "Read a file from the connected filesystem MCP server.",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "mcp__calendar__list_events",
                "description": "List calendar events from the connected calendar MCP server.",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
    ];
    let corpus = super::mcp_capability_entries(&schemas);
    let ranked = super::bm25_rank(&corpus, "read a file from filesystem", 1);
    let entry = ranked.first().expect("mcp entry");

    assert_eq!(entry.key, "mcp__filesystem__read_file");
    assert_eq!(entry.source, super::CapabilitySource::McpTool);
    assert!(!entry.is_skill);
    assert!(entry.text.contains("mcp connected tool"), "{}", entry.text);
    assert_eq!(
        entry
            .schema
            .as_ref()
            .and_then(|schema| schema.pointer("/function/name"))
            .and_then(|value| value.as_str()),
        Some("mcp__filesystem__read_file"),
    );
}

#[test]
fn connector_hits_are_typed_capability_entries() {
    let schema = serde_json::json!({
        "type": "function",
        "function": {
            "name": "GMAIL_SEND_EMAIL",
            "description": "Send an email message via Gmail.",
            "parameters": { "type": "object", "properties": {} }
        }
    });
    let entry = super::connector_capability_entry("GMAIL_SEND_EMAIL".to_string(), schema)
        .expect("connector capability entry");

    assert_eq!(entry.key, "GMAIL_SEND_EMAIL");
    assert_eq!(entry.source, super::CapabilitySource::ConnectorTool);
    assert!(!entry.is_skill);
    assert!(entry.text.contains("connector tool"), "{}", entry.text);
    assert_eq!(
        entry
            .schema
            .as_ref()
            .and_then(|schema| schema.pointer("/function/name"))
            .and_then(|value| value.as_str()),
        Some("GMAIL_SEND_EMAIL"),
    );
}

#[test]
fn connector_search_returns_typed_toolkit_entries() {
    let index = vec![
        catalog_entry(
            "GMAIL_FETCH_EMAILS",
            "Fetch a list of email messages from Gmail",
        ),
        catalog_entry("GMAIL_SEND_EMAIL", "Send an email message via Gmail"),
        catalog_entry(
            "GOOGLECALENDAR_EVENTS_LIST",
            "List calendar events in a time range",
        ),
    ];

    let hits = super::search_connector_capability_entries(&index, "send gmail email", 8);
    let keys: Vec<&str> = hits.iter().map(|entry| entry.key.as_str()).collect();

    assert!(keys.contains(&"GMAIL_FETCH_EMAILS"));
    assert!(keys.contains(&"GMAIL_SEND_EMAIL"));
    assert!(!keys.contains(&"GOOGLECALENDAR_EVENTS_LIST"));
    assert!(
        hits.iter()
            .all(|entry| entry.source == super::CapabilitySource::ConnectorTool)
    );
    assert!(hits.iter().all(|entry| entry.schema.is_some()));
}

#[test]
fn capability_discovery_trace_records_typed_sources() {
    let index = vec![
        catalog_entry(
            "GMAIL_FETCH_EMAILS",
            "Fetch a list of email messages from Gmail",
        ),
        catalog_entry("GMAIL_SEND_EMAIL", "Send an email message via Gmail"),
    ];
    let hits = super::search_connector_capability_entries(&index, "read unread gmail", 8);
    let trace =
        super::capability_discovery_trace_line("read unread gmail", &hits).expect("trace line");

    assert!(
        trace.contains("capability discovery `read unread gmail`"),
        "{trace}"
    );
    assert!(trace.contains("connector:GMAIL_FETCH_EMAILS"), "{trace}");
    assert!(trace.contains("connector:GMAIL_SEND_EMAIL"), "{trace}");
}

#[test]
fn connected_capability_execution_trace_records_source() {
    let index = vec![catalog_entry(
        "GMAIL_FETCH_EMAILS",
        "Fetch a list of email messages from Gmail",
    )];

    assert_eq!(
        super::connected_capability_execution_trace_line("GMAIL_FETCH_EMAILS", &index).as_deref(),
        Some("capability execution connector:GMAIL_FETCH_EMAILS"),
    );
    assert_eq!(
        super::connected_capability_execution_trace_line("mcp__filesystem__read_file", &index,)
            .as_deref(),
        Some("capability execution mcp:mcp__filesystem__read_file"),
    );
    assert!(super::connected_capability_execution_trace_line("run_in_sandbox", &index).is_none());
}

#[test]
fn semantic_document_route_prunes_to_document_workflow() {
    let semantic = semantic_route_fixture(
        super::semantic_decision::ExecutionShape::Workflow,
        Some("make_document"),
    );
    let capability_route = super::route_capability_from_semantic(Some(&semantic));
    let decision = super::workflow_route_from_capability(&capability_route);

    assert_eq!(
        decision,
        super::WorkflowRouteDecision::Workflow {
            workflow_id: "make_document",
            tool_name: "make_document",
            scaffolding_tier: "document",
        },
    );
    assert_eq!(
        super::document_artifact_name(Some("../Customer Brief 2026")),
        "Customer-Brief-2026.md",
    );
    assert_eq!(
            super::document_artifact_name_from_brief(
                "Scrivi un documento markdown breve chiamato homun-smoke-document.md: una nota operativa",
            )
            .as_deref(),
            Some("homun-smoke-document.md"),
        );
    assert_eq!(
        super::document_artifact_name_from_brief(
            "Crea un documento PDF chiamato homun-document-pdf-smoke.pdf: una nota operativa",
        )
        .as_deref(),
        Some("homun-document-pdf-smoke.pdf"),
    );
}

#[test]
fn make_document_tool_requires_artifact_name() {
    let schema = super::make_document_tool_schema();
    let required = schema
        .pointer("/function/parameters/required")
        .and_then(|value| value.as_array())
        .expect("required array");

    assert!(required.iter().any(|value| value.as_str() == Some("brief")));
    assert!(required.iter().any(|value| value.as_str() == Some("name")));
    assert_eq!(
        schema
            .pointer("/function/parameters/properties/formats/items/enum")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str())
                    .collect::<Vec<_>>()
            }),
        Some(vec!["md", "pdf", "docx"]),
    );
    assert_eq!(
        schema
            .pointer("/function/parameters/properties/document_type/enum")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str())
                    .collect::<Vec<_>>()
            }),
        Some(vec![
            "generic",
            "report",
            "memo",
            "brief",
            "proposal",
            "meeting_minutes",
        ]),
    );
    assert_eq!(
        schema
            .pointer("/function/parameters/properties/layout_profile/enum")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str())
                    .collect::<Vec<_>>()
            }),
        Some(vec![
            "standard",
            "one_page",
            "executive_brief",
            "detailed_report",
            "proposal",
        ]),
    );
    assert!(
        schema
            .pointer("/function/parameters/properties/sections/items/type")
            .and_then(|value| value.as_str())
            == Some("string")
    );
}

#[test]
fn make_deck_and_document_accept_template_ref() {
    let deck_schema = super::make_deck_tool_schema();
    let document_schema = super::make_document_tool_schema();

    assert_eq!(
        deck_schema
            .pointer("/function/parameters/properties/template_ref/type")
            .and_then(|value| value.as_str()),
        Some("string"),
    );
    assert_eq!(
        document_schema
            .pointer("/function/parameters/properties/template_ref/type")
            .and_then(|value| value.as_str()),
        Some("string"),
    );
}

#[test]
fn deliverable_design_profile_schema_is_shared_by_deck_and_document() {
    let deck_schema = super::make_deck_tool_schema();
    let document_schema = super::make_document_tool_schema();
    let expected = Some(vec![
        "executive",
        "sales_pitch",
        "technical",
        "editorial",
        "minimal",
    ]);
    let deck_profiles = deck_schema
        .pointer("/function/parameters/properties/design_profile/enum")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
        });
    let document_profiles = document_schema
        .pointer("/function/parameters/properties/design_profile/enum")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
        });

    assert_eq!(deck_profiles, expected);
    assert_eq!(document_profiles, expected);
}

#[test]
fn deliverable_design_template_schema_is_shared_by_deck_and_document() {
    let deck_schema = super::make_deck_tool_schema();
    let document_schema = super::make_document_tool_schema();
    let expected = Some(vec![
        "startup_pitch",
        "executive_update",
        "project_plan",
        "technical_brief",
        "sales_proposal",
        "cv",
        "cover_letter",
        "product_catalog",
    ]);
    let deck_templates = deck_schema
        .pointer("/function/parameters/properties/design_template/enum")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
        });
    let document_templates = document_schema
        .pointer("/function/parameters/properties/design_template/enum")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
        });

    assert_eq!(deck_templates, expected);
    assert_eq!(document_templates, expected);
}

#[test]
fn default_brand_kit_is_not_materialized() {
    // S1a final-review fix: the UNCONFIGURED default kit must never be
    // materialized to brand.json — deck_render/doc_render's `{**brand,
    // **theme}` merge treats every present field as a truthy override, so
    // even default-blue/orange/Inter clobbers a pack's curated editorial
    // theme (e.g. editorial_ivory's green/Source Serif 4) at real generation
    // time, though the committed preview (no brand.json in that loop)
    // shows the correct curated look. Mirrors the UI's own guard
    // (BrandKitPanel.tsx's brandPreviewOverride returns null for the
    // default kit).
    assert!(!super::should_materialize_brand_kit(
        &super::BrandKit::default()
    ));
}

#[test]
fn customized_brand_kit_is_materialized() {
    // Any single field diverging from the default must still flip the
    // decision to "materialize" — this is the surgical counterpart to
    // the test above, guarding against an over-broad "always skip".
    let kit = super::BrandKit {
        primary_color: "#ff0000".to_string(),
        ..Default::default()
    };
    assert!(super::should_materialize_brand_kit(&kit));

    let only_org = super::BrandKit {
        organization: "Acme".to_string(),
        ..Default::default()
    };
    assert!(super::should_materialize_brand_kit(&only_org));
}

#[test]
fn deliverable_design_theme_schema_is_medium_aware() {
    // S1a final-review fix: decks and documents share ONE theme name list,
    // but documents must exclude the 2 dark-surface editorial themes
    // (editorial_noir/editorial_bold) — doc_render's body text/tables
    // still assume a light surface, so a dark theme there is unreadable,
    // even though it reads as dramatic on a fixed-canvas deck slide.
    let deck_schema = super::make_deck_tool_schema();
    let document_schema = super::make_document_tool_schema();
    let deck_expected = Some(vec![
        "clean_corporate",
        "high_contrast",
        "warm_editorial",
        "minimal_mono",
        "soft_gradient",
        // S1a: editorial themes (bundled packs' new defaults) must be
        // pickable by the model too, not just resolved from a template.
        "editorial_noir",
        "editorial_warm",
        "editorial_bold",
        "editorial_ivory",
        "editorial_slate",
    ]);
    let document_expected = Some(vec![
        "clean_corporate",
        "high_contrast",
        "warm_editorial",
        "minimal_mono",
        "soft_gradient",
        // NOT editorial_noir/editorial_bold — dark-surface, deck-only.
        "editorial_warm",
        "editorial_ivory",
        "editorial_slate",
    ]);
    let deck_themes = deck_schema
        .pointer("/function/parameters/properties/design_theme/enum")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
        });
    let document_themes = document_schema
        .pointer("/function/parameters/properties/design_theme/enum")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
        });

    assert_eq!(deck_themes, deck_expected);
    assert_eq!(document_themes, document_expected);
    assert!(!document_themes.unwrap().contains(&"editorial_noir"));
}

#[test]
fn document_generation_options_drops_dark_editorial_theme() {
    // Belt-and-suspenders enforcement at resolution time (not just the
    // schema enum): a dark editorial theme reaching document generation
    // by any other path (template_ref, older client) must be dropped
    // rather than rendered unreadable.
    let parsed = serde_json::json!({ "design_theme": "editorial_noir" });
    let options = super::document_generation_options(&parsed);
    assert_eq!(options.design_theme, None);

    let parsed_light = serde_json::json!({ "design_theme": "editorial_ivory" });
    let options_light = super::document_generation_options(&parsed_light);
    assert_eq!(
        options_light.design_theme.as_deref(),
        Some("editorial_ivory")
    );
}

#[test]
fn deliverable_design_theme_directive_covers_all_editorial_themes() {
    // Final-review fix: these 5 arms did not exist at all, so shipped
    // editorial packs generated with no theme prose directive.
    for name in [
        "editorial_noir",
        "editorial_warm",
        "editorial_bold",
        "editorial_ivory",
        "editorial_slate",
    ] {
        assert!(
            super::deliverable_design_theme_directive(Some(name), "deck").is_some(),
            "missing deck directive for {name}"
        );
        assert!(
            super::deliverable_design_theme_directive(Some(name), "document").is_some(),
            "missing document directive for {name}"
        );
    }
}

#[test]
fn deliverable_design_template_expands_to_defaults_without_overriding_explicit_args() {
    let parsed = serde_json::json!({ "design_template": "startup_pitch" });

    assert_eq!(
        super::resolved_deliverable_design_profile(
            &parsed,
            super::deliverable_design_template(&parsed).as_deref(),
        )
        .as_deref(),
        Some("sales_pitch"),
    );
    assert_eq!(
        super::resolved_deliverable_design_components(
            &parsed,
            super::deliverable_design_template(&parsed).as_deref(),
        ),
        vec![
            "kpi_grid".to_string(),
            "timeline".to_string(),
            "quote_callout".to_string(),
        ],
    );

    let explicit = serde_json::json!({
        "design_template": "startup_pitch",
        "design_profile": "technical",
        "design_components": ["risks_table", "kpi_grid"]
    });
    assert_eq!(
        super::resolved_deliverable_design_profile(
            &explicit,
            super::deliverable_design_template(&explicit).as_deref(),
        )
        .as_deref(),
        Some("technical"),
    );
    assert_eq!(
        super::resolved_deliverable_design_components(
            &explicit,
            super::deliverable_design_template(&explicit).as_deref(),
        ),
        vec![
            "kpi_grid".to_string(),
            "timeline".to_string(),
            "quote_callout".to_string(),
            "risks_table".to_string(),
        ],
    );
}

#[test]
fn document_template_families_are_whitelisted_with_defaults() {
    for template in ["cv", "cover_letter", "product_catalog"] {
        assert!(super::DELIVERABLE_DESIGN_TEMPLATES.contains(&template));
        let (profile, _components) = super::deliverable_template_defaults(Some(template));
        assert!(profile.is_some(), "{template} must have a default profile");
    }
}

#[test]
fn template_catalog_ref_resolves_deck_design_defaults() {
    let parsed = serde_json::json!({
        "template_ref": "homun/startup-pitch-clean-01",
    });
    let template_ref = super::deliverable_template_ref(&parsed);
    let catalog_template = super::template_catalog_by_id(template_ref.as_deref());
    let design_template = super::deliverable_design_template(&parsed).or_else(|| {
        catalog_template
            .as_ref()
            .map(|entry| entry.design_template.clone())
    });
    let design_theme = super::deliverable_design_theme(&parsed).or_else(|| {
        catalog_template
            .as_ref()
            .and_then(|entry| entry.design_theme.clone())
    });
    let design_profile = super::deliverable_design_profile(&parsed)
        .or_else(|| {
            catalog_template
                .as_ref()
                .and_then(|entry| entry.design_profile.clone())
        })
        .or_else(|| {
            let (profile, _) = super::deliverable_template_defaults(design_template.as_deref());
            profile.map(String::from)
        });
    let design_components = super::resolved_deliverable_design_components_with_catalog(
        &parsed,
        design_template.as_deref(),
        catalog_template
            .as_ref()
            .map(|entry| entry.design_components.as_slice())
            .unwrap_or(&[]),
    );

    assert_eq!(
        template_ref.as_deref(),
        Some("homun/startup-pitch-clean-01")
    );
    assert_eq!(design_template.as_deref(), Some("startup_pitch"));
    // S1a-T5: startup-pitch-clean-01's editorial default is editorial_bold
    // (dark teal deck), not the old clean_corporate.
    assert_eq!(design_theme.as_deref(), Some("editorial_bold"));
    assert_eq!(design_profile.as_deref(), Some("sales_pitch"));
    // Defaults for startup_pitch (kpi_grid/timeline/quote_callout) plus the real
    // bundled manifest's own design_components (kpi_grid/timeline/comparison_table)
    // merged+deduped — comparison_table is the only net-new entry.
    assert_eq!(
        design_components,
        vec![
            "kpi_grid".to_string(),
            "timeline".to_string(),
            "quote_callout".to_string(),
            "comparison_table".to_string(),
        ],
    );
}

#[test]
fn make_deck_content_failure_distinguishes_template_from_provider() {
    let message = super::make_deck_content_failure_message(
        "connection refused",
        Some("homun/startup-pitch-clean-01"),
        Some("homun/startup-pitch-clean-01"),
        "http://127.0.0.1:11434/v1",
        "kimi-k2.6:cloud",
    );

    assert!(
        message.contains("MAKE_DECK_CONTENT_PROVIDER_UNAVAILABLE"),
        "{message}"
    );
    assert!(message.contains("resolved locally"), "{message}");
    assert!(
        message.contains("does NOT require a Monet MCP connection"),
        "{message}"
    );
    assert!(
        message.contains("Provider endpoint: `http://127.0.0.1:11434/v1`"),
        "{message}"
    );
    assert!(
        message.contains("Do not create files manually"),
        "{message}"
    );
}

#[test]
fn deck_artifact_metadata_includes_imported_template_attribution() {
    let template = super::TemplateCatalogEntry {
        provider: "local_template_pack".to_string(),
        id: "slidescarnival/pitch-clean".to_string(),
        name: "Pitch Clean".to_string(),
        kind: "presentation".to_string(),
        category: "other".to_string(),
        description: "Imported template.".to_string(),
        name_it: None,
        description_it: None,
        use_cases: vec!["pitch".to_string()],
        audience: vec!["clients".to_string()],
        design_template: "startup_pitch".to_string(),
        design_theme: Some("clean_corporate".to_string()),
        design_profile: Some("sales_pitch".to_string()),
        design_components: vec!["kpi_grid".to_string()],
        layout_archetypes: vec!["cover".to_string()],
        tags: vec!["slidescarnival".to_string()],
        intake_questions: Vec::new(),
        preview_ref: Some(
            "template-pack://slidescarnival/pitch-clean/thumbnails/slide-001.png".to_string(),
        ),
        preview_html_ref: None,
        source_ref: Some("https://www.slidescarnival.com/template/example/123".to_string()),
        license: Some("Creative Commons Attribution 4.0".to_string()),
        source_provider: Some("slidescarnival".to_string()),
        source_path: None,
        template_pack_root: None,
        bundled: false,
        attribution_required: true,
        attribution_text: Some("Template by SlidesCarnival".to_string()),
        redistribution_policy: Some("generated_decks_only".to_string()),
        route_text: "pitch".to_string(),
    };

    let metadata = super::deck_template_metadata(Some(&template));

    assert_eq!(metadata["template_ref"], "slidescarnival/pitch-clean");
    assert_eq!(metadata["template_provider"], "local_template_pack");
    assert_eq!(metadata["template_source_provider"], "slidescarnival");
    assert_eq!(
        metadata["template_source_ref"],
        "https://www.slidescarnival.com/template/example/123"
    );
    assert_eq!(
        metadata["template_license"],
        "Creative Commons Attribution 4.0"
    );
    assert_eq!(metadata["template_attribution_required"], true);
    assert_eq!(
        metadata["template_attribution_text"],
        "Template by SlidesCarnival"
    );
    assert_eq!(
        metadata["template_redistribution_policy"],
        "generated_decks_only"
    );
}

#[test]
fn deliverable_design_components_schema_is_shared_by_deck_and_document() {
    let deck_schema = super::make_deck_tool_schema();
    let document_schema = super::make_document_tool_schema();
    let expected = Some(vec![
        "kpi_grid",
        "timeline",
        "comparison_table",
        "quote_callout",
        "process_steps",
        "risks_table",
    ]);
    let deck_components = deck_schema
        .pointer("/function/parameters/properties/design_components/items/enum")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
        });
    let document_components = document_schema
        .pointer("/function/parameters/properties/design_components/items/enum")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
        });

    assert_eq!(deck_components, expected);
    assert_eq!(document_components, expected);
}

#[test]
fn deck_slide_count_must_match_the_request_exactly() {
    let mut deck = serde_json::json!({
        "slides": [
            { "id": "cover" },
            { "id": "one" },
            { "id": "two" },
            { "id": "three" },
            { "id": "closing" }
        ]
    });

    assert!(super::enforce_deck_slide_count(&mut deck, 3).is_err());

    let mut too_short = serde_json::json!({ "slides": [{}, {}] });
    assert!(super::enforce_deck_slide_count(&mut too_short, 3).is_err());

    let mut exact = serde_json::json!({ "slides": [{}, {}, {}] });
    super::enforce_deck_slide_count(&mut exact, 3).unwrap();
}

#[test]
fn deck_grounding_contract_detects_closed_world_briefs() {
    let strict = super::deck_grounding_directive(
        "Usa solo questi dati, nessun web o connettore, non inventare nulla.",
    );
    let ordinary = super::deck_grounding_directive("Create a product overview deck.");

    assert!(strict.contains("STRICT CLOSED-WORLD BRIEF"), "{strict}");
    assert!(strict.contains("topic label is not proof"), "{strict}");
    assert!(!ordinary.contains("STRICT CLOSED-WORLD BRIEF"));
    assert!(ordinary.contains("do not invent factual results"));
}

#[test]
fn deck_closed_world_contract_removes_unsourced_speaker_notes() {
    let mut deck = serde_json::json!({
        "slides": [
            { "layout": "cover", "title": "Homun", "notes": "" },
            {
                "layout": "bullets",
                "title": "Tre componenti",
                "bullets": ["Agent loop", "Sandbox", "Vault"],
                "notes": "I tre componenti fondamentali da verificare."
            }
        ]
    });

    super::apply_deck_grounding_contract(
        &mut deck,
        "Usa solo questi dati e non inventare altri contenuti.",
    );

    assert_eq!(deck["slides"][1]["notes"], "");
    assert_eq!(deck["slides"][1]["bullets"][0], "Agent loop");
}

#[test]
fn artifact_catalog_is_thread_scoped_and_uses_an_existing_fallback_path() {
    let metadata = serde_json::json!({
        "thread_id": "thread-current",
        "thread_slug": "managed-current"
    });
    assert!(super::artifact_memory_matches_thread(
        &metadata,
        Some("thread-current")
    ));
    assert!(!super::artifact_memory_matches_thread(
        &metadata,
        Some("thread-other")
    ));
    assert!(super::artifact_memory_matches_thread(&metadata, None));

    let executable = std::env::current_exe().unwrap();
    let executable = executable.to_str().unwrap();
    assert_eq!(
        super::existing_artifact_storage(Some(executable), Some(executable)),
        Some((executable, "managed"))
    );
    assert_eq!(
        super::existing_artifact_storage(Some(executable), Some("/path/that/does/not/exist")),
        Some((executable, "project"))
    );
}

#[test]
fn deck_design_components_materialize_renderer_supported_layouts() {
    let mut deck = serde_json::json!({
        "title": "Homun",
        "subtitle": "",
        "slides": [
            { "layout": "cover", "title": "Homun", "bullets": [], "notes": "", "want_image": true },
            { "layout": "bullets", "title": "Traction", "bullets": ["ARR +42%", "NPS 61"], "notes": "", "want_image": true },
            { "layout": "bullets", "title": "Principle", "bullets": ["Local-first is the product"], "notes": "", "want_image": true },
            { "layout": "bullets", "title": "Roadmap", "bullets": ["Now: documents", "Next: decks"], "notes": "", "want_image": true },
            { "layout": "closing", "title": "Next", "bullets": ["Approve"], "notes": "", "want_image": false }
        ]
    });
    let components = vec![
        "kpi_grid".to_string(),
        "quote_callout".to_string(),
        "timeline".to_string(),
    ];

    super::apply_deck_design_components(&mut deck, &components);
    let slides = deck
        .get("slides")
        .and_then(|value| value.as_array())
        .expect("slides");

    assert_eq!(slides[0]["layout"], "cover");
    assert_eq!(slides[1]["layout"], "kpi");
    assert_eq!(slides[1]["kpi"], "ARR +42%");
    assert_eq!(slides[1]["want_image"], false);
    assert_eq!(slides[2]["layout"], "quote");
    assert_eq!(slides[2]["quote"], "Local-first is the product");
    assert_eq!(slides[3]["layout"], "two_column");
    assert_eq!(slides[3]["columns"][0]["title"], "Now");
    assert_eq!(slides[3]["columns"][1]["title"], "Next");
    assert_eq!(slides[4]["layout"], "closing");
}

#[test]
fn deck_design_components_never_invent_placeholder_content() {
    let mut deck = serde_json::json!({
        "slides": [
            { "layout": "cover", "title": "QA" },
            { "layout": "bullets", "title": "No evidence", "bullets": [] },
            { "layout": "closing", "title": "Next", "bullets": ["Run gates"] }
        ]
    });

    super::apply_deck_design_components(&mut deck, &["comparison_table".to_string()]);

    assert_eq!(deck["slides"][1]["layout"], "bullets");
    assert!(deck["slides"][1].get("columns").is_none());
}

#[test]
fn deck_semantic_gate_rejects_placeholders_and_empty_slides() {
    let deck = serde_json::json!({
        "slides": [
            { "layout": "cover", "title": "QA" },
            {
                "layout": "two_column",
                "title": "Metrics",
                "columns": [
                    { "title": "Option A", "bullets": ["Option A"] },
                    { "title": "Option B", "bullets": ["Option B"] }
                ]
            },
            { "layout": "bullets", "title": "Empty", "bullets": [] },
            { "layout": "closing", "title": "Next", "bullets": [] }
        ]
    });

    let errors = super::deck_semantic_quality_errors(&deck);

    assert!(errors.iter().any(|error| error.contains("placeholder")));
    assert!(
        errors
            .iter()
            .any(|error| error.contains("no substantive content"))
    );
    assert!(!errors.iter().any(|error| error.starts_with("slide 4 ")));
}

#[test]
fn deck_model_normalization_promotes_notes_without_filling_empty_slides() {
    let mut deck = serde_json::json!({
        "title": "Homun Release QA 2",
        "subtitle": "Collaudo del percorso di release",
        "slides": [
            { "layout": "cover", "title": "Objective", "notes": "" },
            {
                "layout": "bullets",
                "title": "Contracts",
                "notes": "Agent loop verified. Sandbox isolated. Vault remains closed."
            },
            { "layout": "bullets", "title": "No evidence", "notes": "" },
            { "layout": "closing", "title": "Next gate", "notes": "Do not promote me" }
        ]
    });

    super::normalize_deck_model_content(&mut deck);

    assert_eq!(deck["slides"][0]["title"], "Homun Release QA 2");
    assert_eq!(
        deck["slides"][0]["subtitle"],
        "Collaudo del percorso di release"
    );
    assert_eq!(
        deck["slides"][1]["bullets"],
        serde_json::json!([
            "Agent loop verified",
            "Sandbox isolated",
            "Vault remains closed"
        ])
    );
    assert!(deck["slides"][2].get("bullets").is_none());
    assert!(deck["slides"][3].get("bullets").is_none());
}

#[test]
fn deck_design_theme_materializes_renderer_theme_tokens() {
    let mut deck = serde_json::json!({
        "title": "Homun",
        "subtitle": "",
        "slides": [
            { "layout": "cover", "title": "Homun", "bullets": [], "notes": "", "want_image": true }
        ]
    });
    let brand = super::BrandKit {
        organization: "Homun".to_string(),
        primary_color: "#123456".to_string(),
        secondary_color: "#234567".to_string(),
        accent_color: "#345678".to_string(),
        heading_font: "Inter".to_string(),
        body_font: "Inter".to_string(),
        logo_data_url: String::new(),
    };

    super::apply_deck_design_theme(&mut deck, Some("warm_editorial"), &brand);

    assert_eq!(
        deck.pointer("/theme/organization").and_then(|v| v.as_str()),
        Some("Homun")
    );
    assert_eq!(
        deck.pointer("/theme/primary").and_then(|v| v.as_str()),
        Some("#7c2d12")
    );
    assert_eq!(
        deck.pointer("/theme/secondary").and_then(|v| v.as_str()),
        Some("#431407")
    );
    assert_eq!(
        deck.pointer("/theme/accent").and_then(|v| v.as_str()),
        Some("#f97316")
    );
    assert_eq!(
        deck.pointer("/theme/heading_font").and_then(|v| v.as_str()),
        Some("Source Serif 4")
    );
}

#[test]
fn editorial_themes_use_bundled_serif_not_georgia() {
    // Task 1's curated font set is bundled (OFL, shipped in fonts_embed); the prior
    // non-OFL, non-bundled default only survived via the container's font-fallback,
    // which silently swapped the intended editorial look. Pin every editorial theme to
    // a bundled serif so the declared token and the rendered output actually match.
    let brand = super::BrandKit::default();
    for theme in [
        "editorial_noir",
        "editorial_bold",
        "editorial_warm",
        "editorial_ivory",
        "editorial_slate",
    ] {
        let tokens = super::design_theme_tokens(Some(theme), &brand);
        let head = tokens["heading_font"].as_str().unwrap_or("");
        assert_ne!(head, "Georgia", "{theme} still uses non-bundled Georgia");
        assert!(
            head == "Playfair Display" || head == "Source Serif 4",
            "{theme} heading_font `{head}` is not a bundled serif"
        );
    }
}

#[test]
fn deck_design_theme_passes_editorial_name_through_for_surface_ink_resolution() {
    // Regression (found wiring S1a-T5): design_theme_tokens used to return
    // ONLY flat primary/secondary/accent fields, no "name" — so an editorial
    // theme's surface/ink/muted/hairline/on_brand (design_tokens.py THEMES)
    // never reached deck_render.py at REAL generation time; a deck made
    // from the startup-pitch-clean-01 template silently rendered on a
    // plain white surface instead of the dramatic dark teal the committed
    // preview shows. `name` must reach the theme object so
    // deck_render.py's theme_values(name, overrides) resolves the rest.
    let mut deck = serde_json::json!({
        "title": "Homun",
        "subtitle": "",
        "slides": [
            { "layout": "cover", "title": "Homun", "bullets": [], "notes": "", "want_image": true }
        ]
    });
    let brand = super::BrandKit {
        organization: "Homun".to_string(),
        primary_color: "#123456".to_string(),
        secondary_color: "#234567".to_string(),
        accent_color: "#345678".to_string(),
        heading_font: "Inter".to_string(),
        body_font: "Inter".to_string(),
        logo_data_url: String::new(),
    };

    super::apply_deck_design_theme(&mut deck, Some("editorial_bold"), &brand);

    assert_eq!(
        deck.pointer("/theme/name").and_then(|v| v.as_str()),
        Some("editorial_bold")
    );
}

#[test]
fn deck_quality_guardrails_bound_text_before_render() {
    let long_title = "A".repeat(90);
    let long_bullet = "B".repeat(180);
    let mut deck = serde_json::json!({
        "title": "Homun",
        "subtitle": "",
        "slides": [
            {
                "layout": "bullets",
                "title": long_title,
                "bullets": [
                    long_bullet,
                    "two",
                    "three",
                    "four",
                    "five"
                ],
                "notes": "",
                "want_image": false
            }
        ]
    });

    let issues = super::apply_deck_quality_guardrails(&mut deck);
    let slide = deck.pointer("/slides/0").expect("slide");

    assert_eq!(issues.len(), 3, "{issues:?}");
    assert!(
        slide["title"].as_str().unwrap().chars().count() <= 72,
        "{slide}"
    );
    assert_eq!(slide["bullets"].as_array().unwrap().len(), 4);
    assert!(
        slide["bullets"][0].as_str().unwrap().chars().count() <= 150,
        "{slide}"
    );
}

#[test]
fn deck_quality_guardrails_remove_duplicate_and_title_repeated_bullets() {
    let mut deck = serde_json::json!({
        "title": "Homun",
        "subtitle": "",
        "slides": [
            {
                "layout": "bullets",
                "title": "Zero dati fuori dal dispositivo",
                "bullets": [
                    "Zero dati fuori dal dispositivo",
                    "Automazioni ricorrenti locali",
                    "Automazioni ricorrenti locali",
                    "Artifact editabili con provenienza"
                ],
                "notes": "",
                "want_image": false
            }
        ]
    });

    let issues = super::apply_deck_quality_guardrails(&mut deck);
    let bullets = deck
        .pointer("/slides/0/bullets")
        .and_then(|value| value.as_array())
        .expect("bullets");

    assert!(
        issues
            .iter()
            .any(|issue| issue.contains("duplicate/redundant bullet")),
        "{issues:?}"
    );
    assert_eq!(bullets.len(), 2, "{bullets:?}");
    assert_eq!(bullets[0].as_str(), Some("Automazioni ricorrenti locali"));
    assert_eq!(
        bullets[1].as_str(),
        Some("Artifact editabili con provenienza")
    );
}

#[test]
fn rendered_deck_qa_failure_is_extracted_from_renderer_output() {
    let output = r#"wrote deck.html
DECK_QA_JSON:{"ok":false,"slide_count":1,"issues":[{"severity":"error","code":"slide_overflow","message":"slide 1 overflows"},{"severity":"error","code":"image_not_loaded","message":"slide 1: image failed to load"},{"severity":"error","code":"low_contrast","message":"slide 1: p contrast ratio 2.1 is below 4.5"},{"severity":"error","code":"text_too_small","message":"slide 1: p font-size 9px is below 12px"}]}
"#;

    let failure = super::rendered_deck_qa_failure(output).expect("qa failure");

    assert!(
        failure.contains("slide_overflow: slide 1 overflows"),
        "{failure}"
    );
    assert!(
        failure.contains("image_not_loaded: slide 1: image failed to load"),
        "{failure}"
    );
    assert!(failure.contains("low_contrast:"), "{failure}");
    assert!(failure.contains("text_too_small:"), "{failure}");
    assert!(
        super::rendered_deck_qa_failure(r#"DECK_QA_JSON:{"ok":true,"slide_count":1,"issues":[]}"#)
            .is_none()
    );
}

#[test]
fn document_render_command_is_container_relative_and_qa_gated() {
    let cmd = super::build_document_render_command("/home/agent/output/t1", "cv-elena");
    assert!(cmd.starts_with("cd '/home/agent/output/t1' && doc-render cv-elena.json"));
    assert!(cmd.contains("--prefix cv-elena"));
    assert!(cmd.contains("--print-to-pdf=cv-elena.pdf"));
    assert!(cmd.contains("deck-qa cv-elena.html --json --mode document"));
    assert!(cmd.contains("DECK_QA_JSON:"));
}

#[test]
fn templated_document_outcome_degrades_when_render_produced_docx_only() {
    // The container was reachable (Ok branch) but only the host-written
    // DOCX exists on disk — html/pdf never landed. Before the fix this
    // read as full success because the docx check alone can't tell a
    // real render apart from a render that silently failed.
    let produced = vec!["cv-elena.docx".to_string()];
    let message = super::templated_document_outcome(
        &produced,
        "cv-elena",
        "wf_1",
        None,
        "renderer crashed: some diagnostic tail",
    );
    assert!(
        message.contains("Designed HTML/PDF need the local computer"),
        "{message}"
    );
    assert!(!message.contains("The document is DONE"), "{message}");
    assert!(
        message.contains("renderer crashed: some diagnostic tail"),
        "{message}"
    );
}

#[test]
fn templated_document_outcome_succeeds_when_all_three_files_land() {
    let produced = vec![
        "cv-elena.html".to_string(),
        "cv-elena.pdf".to_string(),
        "cv-elena.docx".to_string(),
    ];
    let message =
        super::templated_document_outcome(&produced, "cv-elena", "wf_1", None, "ok output");
    assert!(message.contains("The document is DONE"), "{message}");
    assert!(
        message.contains("cv-elena.html, cv-elena.pdf, cv-elena.docx"),
        "{message}"
    );
}

#[test]
fn templated_document_outcome_reports_qa_failure_even_with_full_render() {
    let produced = vec![
        "cv-elena.html".to_string(),
        "cv-elena.pdf".to_string(),
        "cv-elena.docx".to_string(),
    ];
    let message = super::templated_document_outcome(
        &produced,
        "cv-elena",
        "wf_1",
        Some("low_contrast: p contrast ratio 2.1 is below 4.5"),
        "ok output",
    );
    assert!(message.contains("with visual QA issues"), "{message}");
    assert!(message.contains("low_contrast:"), "{message}");
}

#[test]
fn templated_document_outcome_truncates_diagnostic_tail_to_last_300_chars() {
    let long_output = "x".repeat(1000) + "END_MARKER";
    let produced: Vec<String> = vec![];
    let message =
        super::templated_document_outcome(&produced, "cv-elena", "wf_1", None, &long_output);
    assert!(message.contains("END_MARKER"), "{message}");
    assert!(message.len() < long_output.len(), "{message}");
}

#[test]
fn templated_document_delivered_is_false_on_qa_failure() {
    // A full render (html+pdf+docx all landed) that FAILED QA is NOT a delivery — the
    // outcome tells the user to fix and retry, so the routing binding must survive (no
    // clear_routing_binding). Reuses the fixture shape from
    // `templated_document_outcome_reports_qa_failure_even_with_full_render`.
    let produced = vec![
        "cv-elena.html".to_string(),
        "cv-elena.pdf".to_string(),
        "cv-elena.docx".to_string(),
    ];
    assert!(
        !super::templated_document_delivered(
            &produced,
            "cv-elena",
            Some("low_contrast: p contrast ratio 2.1 is below 4.5"),
        ),
        "a QA-failed render must not count as delivered (binding must survive for retry)"
    );
}

#[test]
fn templated_document_delivered_is_false_when_html_or_pdf_missing() {
    // Container-side render dropped html/pdf (only the host-written DOCX exists) — degraded,
    // retry-safe → not delivered.
    let produced = vec!["cv-elena.docx".to_string()];
    assert!(
        !super::templated_document_delivered(&produced, "cv-elena", None),
        "a DOCX-only render must not count as delivered"
    );
}

#[test]
fn templated_document_delivered_true_only_on_full_success() {
    let produced = vec![
        "cv-elena.html".to_string(),
        "cv-elena.pdf".to_string(),
        "cv-elena.docx".to_string(),
    ];
    assert!(super::templated_document_delivered(
        &produced, "cv-elena", None
    ));
}

#[test]
fn templated_document_delivered_agrees_with_outcome_success() {
    // Pins the pure delivered-seam to `templated_document_outcome`'s success definition so
    // the two can never drift: delivered == true IFF the outcome is the "DONE" message.
    let full = vec![
        "cv-elena.html".to_string(),
        "cv-elena.pdf".to_string(),
        "cv-elena.docx".to_string(),
    ];
    let docx_only = vec!["cv-elena.docx".to_string()];
    let cases: &[(&[String], Option<&str>)] = &[
        (&full, None),                            // full success
        (&full, Some("low_contrast: 2.1 < 4.5")), // QA failure
        (&docx_only, None),                       // html/pdf missing
        (&[], None),                              // nothing produced
    ];
    for (produced, qa) in cases {
        let delivered = super::templated_document_delivered(produced, "cv-elena", *qa);
        let outcome =
            super::templated_document_outcome(produced, "cv-elena", "wf_1", *qa, "output");
        let outcome_is_success = outcome.contains("The document is DONE");
        assert_eq!(
            delivered, outcome_is_success,
            "delivered ({delivered}) must match outcome success ({outcome_is_success}) for {produced:?} qa={qa:?}"
        );
    }
}

#[test]
fn document_template_pack_requires_document_kind_bundled_and_pack_root() {
    // Base fixture: a document-kind entry but NOT yet bundled/pack-rooted
    // (the fixture helper's defaults) — the discriminator must say No,
    // never guess from a partial match.
    let mut entry = super::template_catalog_entry(
        "homun",
        "homun/cv-professional-01",
        "CV Professional",
        "document",
        "A professional CV template.",
        &["cv", "resume"],
        &["job_seeker"],
        "cv",
        Some("clean_corporate"),
        None,
        &[],
        &[],
        "cv resume professional",
    );
    assert!(super::document_template_pack(Some(&entry)).is_none());

    // Bundled + a pack root on disk: now it qualifies.
    entry.bundled = true;
    entry.template_pack_root = Some(std::path::PathBuf::from("/tmp/does-not-need-to-exist"));
    assert!(super::document_template_pack(Some(&entry)).is_some());

    // A presentation pack (same bundled+root shape) must NOT qualify.
    let mut presentation = entry.clone();
    presentation.kind = "presentation".to_string();
    assert!(super::document_template_pack(Some(&presentation)).is_none());

    // Not bundled (e.g. a user-imported document pack) must NOT qualify.
    let mut imported = entry.clone();
    imported.bundled = false;
    assert!(super::document_template_pack(Some(&imported)).is_none());

    // Bundled flag without a pack root (shouldn't happen, but never guess)
    // must NOT qualify either.
    let mut no_root = entry.clone();
    no_root.template_pack_root = None;
    assert!(super::document_template_pack(Some(&no_root)).is_none());

    assert!(super::document_template_pack(None).is_none());
}

#[test]
fn deck_template_chrome_overlays_cover_and_section() {
    // Pack example: cover has eyebrow+hero_art, section has hero_art.
    let example = serde_json::json!({"slides": [
        {"layout": "cover", "title": "Kite", "eyebrow": "SEED ROUND", "hero_art": "rings"},
        {"layout": "section", "title": "Market", "hero_art": "grid"}
    ]});
    // Generated deck: model gave a cover (no chrome) + a refined eyebrow on cover,
    // a section (no chrome), and a bullets slide.
    let mut deck = serde_json::json!({"slides": [
        {"layout": "cover", "title": "Real Co", "eyebrow": "SERIES A · 2026"},
        {"layout": "section", "title": "Traction"},
        {"layout": "bullets", "title": "Ask", "bullets": ["x"]}
    ]});
    super::apply_deck_template_chrome(&mut deck, &example);
    let s = deck["slides"].as_array().unwrap();
    // cover: model eyebrow kept (refinement), hero_art carried deterministically
    assert_eq!(s[0]["eyebrow"], "SERIES A · 2026");
    assert_eq!(s[0]["hero_art"], "rings");
    // section: hero_art carried from the pack's section
    assert_eq!(s[1]["hero_art"], "grid");
    // bullets slide untouched
    assert!(s[2].get("hero_art").is_none());
}

#[test]
fn deck_template_chrome_never_inherits_visible_pack_text_and_is_failopen() {
    let example = serde_json::json!({"slides": [
            {"layout": "cover", "title": "Kite", "eyebrow": "PITCH", "hero_art": "rings"}]});
    let mut deck = serde_json::json!({"slides": [{"layout": "cover", "title": "Real"}]});
    super::apply_deck_template_chrome(&mut deck, &example);
    assert!(deck["slides"][0].get("eyebrow").is_none());
    assert_eq!(deck["slides"][0]["hero_art"], "rings");
    // fail-open: example with no slides / no cover chrome does nothing, no panic
    let mut deck2 = serde_json::json!({"slides": [{"layout": "cover", "title": "R"}]});
    super::apply_deck_template_chrome(&mut deck2, &serde_json::json!({}));
    assert!(deck2["slides"][0].get("hero_art").is_none());
}

#[test]
fn deck_artifact_contract_includes_editable_previews_and_source() {
    assert_eq!(
        super::DECK_ARTIFACT_NAMES,
        &["deck.pptx", "deck.html", "deck.pdf", "deck.json"]
    );
}

#[test]
fn deck_content_schema_exposes_refinable_eyebrow() {
    let schema = super::deck_content_schema();
    let item = &schema["properties"]["slides"]["items"]["properties"];
    assert!(item.get("eyebrow").is_some());
    // eyebrow IS required (OpenAI strict structured-outputs demands every
    // property be listed in `required`); refinable/blankable is expressed
    // by the model emitting "" on non-cover slides, not by omission.
    let req = schema["properties"]["slides"]["items"]["required"]
        .as_array()
        .unwrap();
    assert!(req.iter().any(|v| v == "eyebrow"));
}

#[test]
fn rendered_deck_qa_metadata_is_structured_for_artifacts() {
    let qa = serde_json::json!({
        "ok": false,
        "slide_count": 1,
        "issues": [
            {
                "severity": "error",
                "code": "low_contrast",
                "message": "slide 1: p contrast ratio 2.1 is below 4.5",
                "raw": {"ignored": true}
            }
        ]
    });

    let metadata = super::deck_quality_metadata_from_qa_result(Some(&qa)).expect("metadata");

    assert_eq!(metadata["quality_status"], serde_json::json!("warning"));
    assert_eq!(metadata["quality_slide_count"], serde_json::json!(1));
    assert_eq!(
        metadata["quality_issues"][0]["code"],
        serde_json::json!("low_contrast")
    );
    assert_eq!(
        metadata["quality_issues"][0]["severity"],
        serde_json::json!("error")
    );
    assert_eq!(
        metadata["quality_issues"][0]["message"],
        serde_json::json!("slide 1: p contrast ratio 2.1 is below 4.5")
    );
    assert!(metadata["quality_issues"][0].get("raw").is_none());
}

#[test]
fn document_design_components_append_renderable_markdown_blocks() {
    let markdown = "# Homun brief\n\nARR +42% from retained teams.\n\n- Ship document workflow\n- Improve deck quality\n- Reduce risk";
    let components = vec![
        "kpi_grid".to_string(),
        "timeline".to_string(),
        "quote_callout".to_string(),
    ];

    let augmented = super::apply_document_design_components(markdown, &components);

    assert!(augmented.contains("## Key metrics"), "{augmented}");
    assert!(
        augmented.contains("| Metric | Value | Implication |"),
        "{augmented}"
    );
    assert!(
        augmented.contains("ARR +42% from retained teams."),
        "{augmented}"
    );
    assert!(augmented.contains("## Timeline"), "{augmented}");
    assert!(
        augmented.contains("| Phase | Detail | Outcome |"),
        "{augmented}"
    );
    assert!(augmented.contains("## Key principle"), "{augmented}");
    assert!(
        augmented.contains("> ARR +42% from retained teams."),
        "{augmented}"
    );
}

#[test]
fn document_design_components_render_as_docx_tables() {
    let markdown = "# Homun brief\n\nARR +42% from retained teams.\n\n- Ship document workflow\n- Improve deck quality";
    let augmented = super::apply_document_design_components(
        markdown,
        &["kpi_grid".to_string(), "risks_table".to_string()],
    );
    let bytes = super::markdown_to_docx("brief", &augmented).unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut document = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("word/document.xml").unwrap(),
        &mut document,
    )
    .unwrap();

    assert!(document.contains("Key metrics"), "{document}");
    assert!(document.contains("Risks and mitigations"), "{document}");
    assert!(document.matches("<w:tbl>").count() >= 2, "{document}");
}

#[test]
fn document_quality_guardrail_accepts_structured_markdown() {
    let markdown =
        "# Brief\n\nExecutive summary.\n\n| Metric | Value |\n| --- | --- |\n| ARR | +42% |\n";

    assert!(super::document_quality_issues(markdown).is_empty());
}

#[test]
fn document_quality_guardrail_flags_unrenderable_markdown() {
    let long_word = "A".repeat(180);
    let markdown = format!(
        "# Brief\n\n{long_word}\n\n| Metric | Value |\n| --- | --- |\n| ARR | +42% | extra |\n"
    );
    let issues = super::document_quality_issues(&markdown);

    assert!(
        issues
            .iter()
            .any(|issue| issue.contains("long unbroken text")),
        "{issues:?}"
    );
    assert!(
        issues
            .iter()
            .any(|issue| issue.contains("table row has 3 cells but expected 2")),
        "{issues:?}"
    );
}

#[test]
fn document_quality_guardrails_normalize_table_cells_before_render() {
    let markdown = "\
# Brief

| Phase | Owner |
| --- | --- |
| Discovery | Product | extra context |
| Build |
";

    let (normalized, issues) = super::apply_document_quality_guardrails(markdown);

    assert!(
        issues
            .iter()
            .any(|issue| issue.contains("table row has 3 cells but expected 2")),
        "{issues:?}"
    );
    assert!(
        issues
            .iter()
            .any(|issue| issue.contains("table row has 1 cells but expected 2")),
        "{issues:?}"
    );
    assert!(
        super::document_quality_issues(&normalized).is_empty(),
        "{normalized}"
    );
    assert!(
        normalized.contains("| Discovery | Product / extra context |"),
        "{normalized}"
    );
    assert!(normalized.contains("| Build | - |"), "{normalized}");
}

#[test]
fn make_document_generation_options_are_explicit_and_bounded() {
    let options = super::document_generation_options(&serde_json::json!({
        "template_ref": "homun/executive-update-board-01",
        "document_type": "report",
        "audience": " PMI italiana ",
        "tone": "executive",
        "layout_profile": "executive_brief",
        "design_template": "executive_update",
        "design_theme": "minimal_mono",
        "design_profile": "technical",
        "design_components": [
            "kpi_grid",
            "timeline",
            "kpi_grid",
            "unknown_component"
        ],
        "sections": [
            "Problema",
            "Soluzione",
            "",
            "Roadmap"
        ],
    }));

    assert_eq!(
        options.template_ref.as_deref(),
        Some("homun/executive-update-board-01"),
    );
    assert_eq!(options.document_type.as_deref(), Some("report"));
    assert_eq!(options.audience.as_deref(), Some("PMI italiana"));
    assert_eq!(options.tone.as_deref(), Some("executive"));
    assert_eq!(options.layout_profile.as_deref(), Some("executive_brief"));
    assert_eq!(options.design_template.as_deref(), Some("executive_update"));
    assert_eq!(options.design_theme.as_deref(), Some("minimal_mono"));
    assert_eq!(options.design_profile.as_deref(), Some("technical"));
    // Defaults for executive_update (kpi_grid/risks_table/timeline) already cover
    // the real bundled manifest's own design_components (kpi_grid/risks_table),
    // so nothing net-new is merged in here (contrast the make_deck test above,
    // where startup_pitch's manifest DOES add comparison_table).
    assert_eq!(
        options.design_components,
        vec![
            "kpi_grid".to_string(),
            "risks_table".to_string(),
            "timeline".to_string(),
        ],
    );
    assert_eq!(
        options.sections,
        vec![
            "Problema".to_string(),
            "Soluzione".to_string(),
            "Roadmap".to_string()
        ],
    );

    let directives = super::document_generation_directives(&options);
    assert!(
        directives.contains("Template reference: homun/executive-update-board-01."),
        "{directives}"
    );
    assert!(
        directives.contains("Document type: report."),
        "{directives}"
    );
    assert!(
        directives.contains("Audience: PMI italiana."),
        "{directives}"
    );
    assert!(directives.contains("Tone: executive."), "{directives}");
    assert!(
        directives.contains("Layout profile: executive_brief."),
        "{directives}"
    );
    assert!(
        directives.contains("decision-ready headings"),
        "{directives}"
    );
    assert!(
        directives.contains("Design template: executive_update."),
        "{directives}"
    );
    assert!(
        directives.contains("Design theme: minimal_mono."),
        "{directives}"
    );
    assert!(
        directives.contains("Design profile: technical."),
        "{directives}"
    );
    assert!(
        directives.contains("implementation details"),
        "{directives}"
    );
    assert!(directives.contains("Component: kpi_grid."), "{directives}");
    assert!(directives.contains("Component: timeline."), "{directives}");
    assert!(
        directives.contains("Component: risks_table."),
        "{directives}"
    );
    assert!(
        directives.contains("Required section order: Problema -> Soluzione -> Roadmap."),
        "{directives}"
    );

    let ignored = super::document_generation_options(&serde_json::json!({
        "template_ref": "homun/unknown",
        "document_type": "pitch",
        "tone": "friendly",
        "layout_profile": "marketing_site",
        "design_template": "cinematic",
        "design_theme": "neon",
        "design_profile": "cinematic",
        "design_components": ["hero", "kpi_grid"],
        "sections": ["Valida"]
    }));
    assert_eq!(ignored.document_type, None);
    assert_eq!(ignored.tone, None);
    assert_eq!(ignored.layout_profile, None);
    assert_eq!(ignored.template_ref, None);
    assert_eq!(ignored.design_template, None);
    assert_eq!(ignored.design_theme, None);
    assert_eq!(ignored.design_profile, None);
    assert_eq!(ignored.design_components, vec!["kpi_grid".to_string()]);
    assert_eq!(ignored.sections, vec!["Valida".to_string()]);

    // The pair the templated render's theme merge (F2-T8) relies on: the
    // explicit design_theme above WINS over the pack's catalog theme, and
    // with NO explicit theme the catalog entry's own theme degrades in —
    // so doc.json's `theme.name` always matches what the content
    // directives told the model.
    //
    // S1a final-review Fix 3: `executive-update-board-01` is a DECK pack
    // (kind=presentation) whose editorial default is the DARK
    // editorial_noir — using it here (a document-generation test) now
    // doubles as the catalog-degrade-in path for the dark-theme guard:
    // even reached via a mismatched template_ref's catalog default, a
    // dark editorial theme must still be dropped for a document (never
    // just relies on the schema enum, which a template_ref bypasses).
    let fallback = super::document_generation_options(&serde_json::json!({
        "template_ref": "homun/executive-update-board-01",
    }));
    assert_eq!(fallback.design_theme, None);

    // The still-valid form of the same "catalog theme degrades in"
    // mechanic: a DOCUMENT pack's own (light) editorial theme must still
    // flow through untouched.
    let doc_fallback = super::document_generation_options(&serde_json::json!({
        "template_ref": "homun/cv-professional-01",
    }));
    assert_eq!(
        doc_fallback.design_theme.as_deref(),
        Some("editorial_ivory")
    );
}

#[test]
fn make_document_formats_preserve_explicit_pdf_outputs() {
    let parsed = serde_json::json!({
        "formats": ["md", "pdf", "pdf", "txt"],
    });

    assert_eq!(
        super::document_artifact_name_with_extension(Some("brief finale.pdf"), "md"),
        "brief-finale.md",
    );
    assert_eq!(
        super::document_artifact_name_with_extension(Some("brief finale.md"), "pdf"),
        "brief-finale.pdf",
    );
    assert_eq!(
        super::document_output_formats(&parsed, "brief-finale.md", "Scrivi un documento"),
        vec!["md".to_string(), "pdf".to_string()],
    );
    assert_eq!(
        super::document_output_formats(
            &serde_json::json!({}),
            "brief-finale.pdf",
            "Scrivi un documento"
        ),
        vec!["pdf".to_string()],
    );
    assert_eq!(
        super::document_output_formats(
            &serde_json::json!({}),
            "brief-finale.md",
            "Genera anche un PDF"
        ),
        vec!["pdf".to_string()],
    );
}

#[test]
fn make_document_formats_support_editable_docx_outputs() {
    assert_eq!(
        super::document_artifact_name_with_extension(Some("brief finale.docx"), "md"),
        "brief-finale.md",
    );
    assert_eq!(
        super::document_artifact_name_with_extension(Some("brief finale.md"), "docx"),
        "brief-finale.docx",
    );
    assert_eq!(
        super::document_artifact_name_from_brief(
            "Scrivi un documento Word chiamato homun-brief.docx",
        )
        .as_deref(),
        Some("homun-brief.docx"),
    );
    assert_eq!(
        super::document_output_formats(
            &serde_json::json!({"formats": ["md", "docx", "pdf"]}),
            "brief-finale.md",
            "Scrivi un documento",
        ),
        vec!["md".to_string(), "docx".to_string(), "pdf".to_string()],
    );
    assert_eq!(
        super::document_output_formats(
            &serde_json::json!({}),
            "brief-finale.md",
            "Genera un documento editabile Word",
        ),
        vec!["docx".to_string()],
    );
}

#[test]
fn markdown_to_docx_writes_valid_word_package() {
    let bytes = super::markdown_to_docx("brief", "# Titolo\n\n- **Punto** & *valore*").unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut document = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("word/document.xml").unwrap(),
        &mut document,
    )
    .unwrap();

    assert!(document.contains("Titolo"), "{document}");
    assert!(document.contains("<w:b/>"), "{document}");
    assert!(document.contains("<w:i/>"), "{document}");
    assert!(document.contains("Punto"), "{document}");
    assert!(document.contains("&amp;"), "{document}");
    assert!(!document.contains("**"), "{document}");
    assert!(!document.contains("*valore*"), "{document}");
    assert!(archive.by_name("[Content_Types].xml").is_ok());
    assert!(archive.by_name("word/styles.xml").is_ok());
    assert!(archive.by_name("word/_rels/document.xml.rels").is_ok());
}

#[test]
fn markdown_to_docx_renders_pipe_tables() {
    let markdown = "\
# Report

| Metrica | Valore |
| --- | ---: |
| ARR | 120 < 150 |
| Margine | 42% |
";
    let bytes = super::markdown_to_docx("report", markdown).unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut document = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("word/document.xml").unwrap(),
        &mut document,
    )
    .unwrap();

    assert!(document.contains("<w:tbl>"), "{document}");
    assert!(
        document.contains(r#"<w:tblW w:w="5000" w:type="pct"/>"#),
        "{document}"
    );
    assert!(document.contains("<w:tblGrid>"), "{document}");
    assert!(
        document.contains(r#"<w:tcW w:w="1750" w:type="pct"/>"#),
        "{document}"
    );
    assert!(
        document.contains(r#"<w:tcW w:w="3250" w:type="pct"/>"#),
        "{document}"
    );
    assert!(
        document.contains(r#"<w:shd w:fill="F2F2F2"/>"#),
        "{document}"
    );
    assert!(document.contains("<w:tr>"), "{document}");
    assert!(document.contains("Metrica"), "{document}");
    assert!(document.contains("120 &lt; 150"), "{document}");
    assert!(
        !document.contains(r#"<w:tcW w:w="0" w:type="auto"/>"#),
        "{document}"
    );
    assert!(!document.contains("---:"), "{document}");
}

#[test]
fn markdown_to_docx_promotes_plain_first_line_to_title() {
    let bytes = super::markdown_to_docx("brief", "Titolo documento\n\n1. Primo passo").unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut document = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("word/document.xml").unwrap(),
        &mut document,
    )
    .unwrap();

    assert!(
        document.contains(r#"<w:pStyle w:val="Heading1"/>"#),
        "{document}"
    );
    assert!(
        document.contains(r#"<w:pStyle w:val="ListParagraph"/>"#),
        "{document}"
    );
    assert!(document.contains("1. Primo passo"), "{document}");
}

#[test]
fn doc_json_to_docx_renders_blocks_structurally() {
    // Same probing technique as the markdown_to_docx tests above: the zip
    // uses Deflated compression for word/document.xml, so we must unzip
    // (a raw-bytes substring probe on the archive would NOT find plain text).
    let doc = serde_json::json!({"title": "CV Elena", "blocks": [
        {"type": "contact_header", "name": "Elena Ricci", "headline": "Ops Director",
         "contact_items": ["elena@example.com"]},
        {"type": "timeline", "title": "Experience", "entries": [
            {"label": "2022", "heading": "Director", "subheading": "Aurora",
             "points": ["TimelinePointProbe"]}]},
        {"type": "pricing_table", "title": "Pricing", "headers": ["Plan", "Price"],
         "rows": [["Base", "PriceCellProbe"]], "note": ""}
    ]});
    let bytes = super::doc_json_to_docx(&doc).expect("docx");
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut document = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("word/document.xml").unwrap(),
        &mut document,
    )
    .unwrap();
    for probe in ["Elena Ricci", "TimelinePointProbe", "PriceCellProbe"] {
        assert!(document.contains(probe), "missing {probe}: {document}");
    }
    // Structural checks: contact name is Heading1, timeline point is a
    // ListParagraph bullet, pricing renders as a real table (not prose).
    assert!(
        document.contains(r#"<w:pStyle w:val="Heading1"/>"#),
        "{document}"
    );
    assert!(
        document.contains(r#"<w:pStyle w:val="ListParagraph"/>"#),
        "{document}"
    );
    assert!(document.contains("<w:tbl>"), "{document}");
    assert!(archive.by_name("[Content_Types].xml").is_ok());
    assert!(archive.by_name("word/styles.xml").is_ok());
}

#[test]
fn docx_cover_blocks_render_eyebrow_before_title() {
    let sc = serde_json::json!({"type": "section_cover", "title": "Acme", "subtitle": "s",
            "eyebrow": "CASE STUDY"});
    let xml = super::doc_block_to_docx_xml(&sc);
    assert!(xml.contains("CASE STUDY"));
    // eyebrow appears BEFORE the title text in the XML stream
    assert!(xml.find("CASE STUDY").unwrap() < xml.find("Acme").unwrap());
    // a cover block WITHOUT eyebrow renders no eyebrow paragraph (fail-open)
    let sc2 = serde_json::json!({"type": "section_cover", "title": "Acme", "subtitle": "s"});
    let xml2 = super::doc_block_to_docx_xml(&sc2);
    assert!(!xml2.contains("CASE STUDY"));
}

#[test]
fn doc_table_rows_clamp_to_header_width() {
    // Defense-in-depth mirror of doc_render.py: a hand-authored row wider
    // than the header set must be clamped, or markdown_table_to_docx
    // (col_count = longest row) renders a blank shaded header cell over
    // real data. Also: an empty section_cover title must not leave a
    // stray empty Heading1 paragraph (empty-means-absent convention).
    let doc = serde_json::json!({"title": "Specs", "blocks": [
        {"type": "section_cover", "title": "", "subtitle": ""},
        {"type": "spec_table", "title": "Specs", "headers": ["Key", "Value"],
         "rows": [["Weight", "2kg", "OverflowCellProbe"]]}
    ]});
    let bytes = super::doc_json_to_docx(&doc).expect("docx");
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut document = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("word/document.xml").unwrap(),
        &mut document,
    )
    .unwrap();
    assert!(document.contains("Weight"), "{document}");
    assert!(document.contains("2kg"), "{document}");
    assert!(!document.contains("OverflowCellProbe"), "{document}");
    assert!(
        !document.contains(r#"<w:pStyle w:val="Heading1"/>"#),
        "{document}"
    );
}

#[test]
fn docx_artifacts_register_as_documents() {
    assert_eq!(super::artifact_memory_kind("cv.docx"), "document");
    assert_eq!(super::artifact_memory_kind("deck.pptx"), "presentation");
}

#[test]
fn artifact_memories_do_not_participate_in_semantic_dedup() {
    assert!(!local_first_memory::memory_type_participates_in_semantic_dedup("artifact"));
    assert!(local_first_memory::memory_type_participates_in_semantic_dedup("decision"));
    assert!(local_first_memory::memory_type_participates_in_semantic_dedup("open_loop"));
}

#[test]
fn workflow_router_prunes_alternative_tools_for_document_workflow() {
    let semantic = semantic_route_fixture(
        super::semantic_decision::ExecutionShape::Workflow,
        Some("make_document"),
    );
    let capability_route = super::route_capability_from_semantic(Some(&semantic));
    let decision = super::workflow_route_from_capability(&capability_route);
    let mut tools = vec![
        super::make_document_tool_schema(),
        super::run_in_sandbox_tool_schema(),
        super::create_artifact_tool_schema(),
    ];

    super::prune_tools_for_workflow_route(&mut tools, &decision);

    let names: Vec<&str> = tools
        .iter()
        .filter_map(|schema| {
            schema
                .pointer("/function/name")
                .and_then(|value| value.as_str())
        })
        .collect();
    assert_eq!(names, vec!["make_document"]);
}

#[test]
fn bound_template_ref_is_injected_when_model_omits_it() {
    let mut args = serde_json::json!({"brief":"x"});
    super::merge_bound_template_ref(&mut args, "homun/cv-professional-01");
    assert_eq!(args["template_ref"], "homun/cv-professional-01");
}

#[test]
fn bound_template_ref_wins_over_a_different_model_supplied_ref() {
    // Deterministic: the SELECTED template is authoritative even if a weak/drifting
    // model put a different (or stale) template_ref of its own into the args.
    let mut args = serde_json::json!({"brief":"x", "template_ref":"homun/other-pack-02"});
    super::merge_bound_template_ref(&mut args, "homun/cv-professional-01");
    assert_eq!(args["template_ref"], "homun/cv-professional-01");
}

#[test]
fn prune_removes_denied_tools_not_just_retains_route_tool() {
    let mut tools = vec![
        serde_json::json!({"function":{"name":"make_document"}}),
        serde_json::json!({"function":{"name":"skill:create_documents"}}),
        serde_json::json!({"function":{"name":"run_command"}}),
    ];
    super::prune_tools_for_route_and_deny(
        &mut tools,
        "make_document",
        &["skill:*".into(), "run_command".into()],
    );
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t.pointer("/function/name").and_then(|v| v.as_str()))
        .collect();
    assert_eq!(names, vec!["make_document"]);
}

#[test]
fn active_binding_forces_workflow_route_over_semantic_default() {
    let binding = super::RoutingBinding {
        plugin_id: "presentations".into(),
        route_id: "presentations.template_document".into(),
        args: serde_json::json!({"template_ref":"homun/cv-professional-01"}),
    };
    let semantic =
        semantic_route_fixture(super::semantic_decision::ExecutionShape::AgentLoop, None);
    let routed = super::route_capability_with_binding(Some(&semantic), Some(&binding));
    match routed {
        super::CapabilityRouteDecision::Workflow { tool_name, .. } => {
            assert_eq!(tool_name, "make_document")
        }
        other => panic!("expected forced Workflow route, got {other:?}"),
    }
    // Without the explicit structured binding, the model-owned decision remains authoritative.
    assert!(!matches!(
        super::route_capability_with_binding(Some(&semantic), None),
        super::CapabilityRouteDecision::Workflow { .. }
    ));
}

#[test]
fn workflow_route_blocks_manual_tool_fallbacks() {
    let workflow_semantic = semantic_route_fixture(
        super::semantic_decision::ExecutionShape::Workflow,
        Some("make_deck"),
    );
    let route = super::route_capability_from_semantic(Some(&workflow_semantic));

    assert!(
        super::workflow_route_blocked_tool_message(&route, "make_deck").is_none(),
        "workflow tool must remain allowed"
    );
    let blocked = super::workflow_route_blocked_tool_message(&route, "mcp__filesystem__create")
        .expect("filesystem fallback must be blocked");
    assert!(blocked.contains("WORKFLOW_ROUTE_BLOCKED_TOOL"), "{blocked}");
    assert!(blocked.contains("make_deck"), "{blocked}");

    let agent_semantic =
        semantic_route_fixture(super::semantic_decision::ExecutionShape::AgentLoop, None);
    let generic = super::route_capability_from_semantic(Some(&agent_semantic));
    assert!(
        super::workflow_route_blocked_tool_message(&generic, "mcp__filesystem__create").is_none(),
        "generic agent-loop turns keep normal tools"
    );
}

#[test]
fn workflow_route_allows_exactly_one_matching_tool_call_per_turn() {
    let workflow_semantic = semantic_route_fixture(
        super::semantic_decision::ExecutionShape::Workflow,
        Some("make_deck"),
    );
    let policy = super::gateway_turn_policy(super::route_capability_from_semantic(Some(
        &workflow_semantic,
    )));

    assert!(local_first_engine::TurnPolicy::route_blocked(&policy, "make_deck").is_none());
    let blocked = local_first_engine::TurnPolicy::route_blocked(&policy, "make_deck")
        .expect("the second workflow call must be blocked");

    assert!(
        blocked.contains("WORKFLOW_ROUTE_ALREADY_CALLED"),
        "{blocked}"
    );
}

#[test]
fn build_chat_payload_forces_tool_choice_when_requested() {
    let tools = vec![serde_json::json!({"function":{"name":"make_document"}})];
    let messages = vec![serde_json::json!({"role":"user","content":"hi"})];
    let forced = super::build_chat_payload(
        "gpt-test",
        "https://api.example.com",
        &messages,
        &tools,
        0.4,
        false,
        Some("make_document"),
    );
    assert_eq!(forced["tool_choice"]["type"], "function");
    assert_eq!(forced["tool_choice"]["function"]["name"], "make_document");

    // Behavior-preserving: `None` (every call site except the loop's main round call, S2 T5)
    // keeps today's plain "auto".
    let auto = super::build_chat_payload(
        "gpt-test",
        "https://api.example.com",
        &messages,
        &tools,
        0.4,
        false,
        None,
    );
    assert_eq!(auto["tool_choice"], "auto");
}

#[test]
fn build_chat_payload_forced_tool_has_no_effect_without_an_offered_toolset() {
    // No tools offered at all → no `tools`/`tool_choice` field, forced or not.
    let no_tools = super::build_chat_payload(
        "gpt-test",
        "https://api.example.com",
        &[],
        &[],
        0.4,
        false,
        Some("make_document"),
    );
    assert!(no_tools.get("tool_choice").is_none());

    // Final round omits tools entirely (the model must synthesize text) — forcing must not
    // resurrect a tool_choice field here either.
    let tools = vec![serde_json::json!({"function":{"name":"make_document"}})];
    let final_round = super::build_chat_payload(
        "gpt-test",
        "https://api.example.com",
        &[],
        &tools,
        0.4,
        true,
        Some("make_document"),
    );
    assert!(final_round.get("tool_choice").is_none());
}

#[test]
fn forced_tool_for_turn_requires_specific_forcing_and_turn_index_two() {
    let routing = local_first_capabilities::WorkflowRouting {
        route_id: "presentations.template_document".into(),
        plugin_id: "presentations".into(),
        tool_name: "make_document".into(),
        route_text: String::new(),
        priority: 100,
        deterministic: true,
        deny_tools: vec![],
        forcing: local_first_capabilities::Forcing::Specific,
    };
    // Turn 1 (just the "Use template" pick, 0 or 1 user messages so far) — stay "auto" so
    // the model can ask intake questions instead of firing the tool on a guessed brief.
    assert_eq!(super::forced_tool_for_turn(Some(&routing), 0), None);
    assert_eq!(super::forced_tool_for_turn(Some(&routing), 1), None);
    // Post-intake (>=2 user messages: seed prompt + at least one reply) — force it.
    assert_eq!(
        super::forced_tool_for_turn(Some(&routing), 2).as_deref(),
        Some("make_document")
    );
    assert_eq!(
        super::forced_tool_for_turn(Some(&routing), 5).as_deref(),
        Some("make_document")
    );
    // No active binding → never forced, regardless of turn index.
    assert_eq!(super::forced_tool_for_turn(None, 5), None);
    // Non-`Specific` forcing (e.g. `Required`) never forces `tool_choice`, even post-intake —
    // this belt-and-suspenders is scoped to the routes that opted into hard pinning.
    let mut required = routing.clone();
    required.forcing = local_first_capabilities::Forcing::Required;
    assert_eq!(super::forced_tool_for_turn(Some(&required), 5), None);
}

#[test]
fn thread_user_message_count_counts_only_user_role() {
    let snapshot = super::ChatMessagesSnapshot {
        thread_id: "t1".into(),
        messages: vec![
            super::channel_chat_message("user", "Use template: CV professional"),
            super::channel_chat_message("assistant", "Which fields should the CV cover?"),
            super::channel_chat_message("user", "Mario Rossi, Senior Developer, 8 anni…"),
        ],
    };
    assert_eq!(super::thread_user_message_count(&snapshot), 2);
}

#[test]
fn thread_user_message_count_fail_open_counts_committed_user_turns() {
    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let state = test_app_state_for_brief(facade);
    let thread = super::lock_store(&state)
        .unwrap()
        .create_thread("ws")
        .unwrap();

    // No thread_id at all → fail open to 0 (treated as "still turn 1").
    assert_eq!(super::thread_user_message_count_fail_open(&state, None), 0);
    // A fresh thread with no messages yet → 0.
    assert_eq!(
        super::thread_user_message_count_fail_open(&state, Some(&thread.thread_id)),
        0
    );

    super::lock_store(&state)
        .unwrap()
        .commit_prompt_result(
            &thread.thread_id,
            &super::channel_chat_message("user", "Use template: CV professional"),
            &super::channel_chat_message("assistant", "Which fields should the CV cover?"),
            None,
        )
        .unwrap();
    assert_eq!(
        super::thread_user_message_count_fail_open(&state, Some(&thread.thread_id)),
        1,
        "the seed 'Use template' turn is turn 1 — forced_tool_for_turn must stay auto here"
    );

    super::lock_store(&state)
        .unwrap()
        .commit_prompt_result(
            &thread.thread_id,
            &super::channel_chat_message("user", "Mario Rossi, Senior Developer, 8 anni…"),
            &super::channel_chat_message("assistant", "Here is your CV…"),
            None,
        )
        .unwrap();
    assert_eq!(
        super::thread_user_message_count_fail_open(&state, Some(&thread.thread_id)),
        2,
        "the first intake reply crosses the >=2 threshold that forces tool_choice"
    );
}

#[test]
fn stream_entry_terminal_event_counts_as_finished_for_activity() {
    let (tx, _) = tokio::sync::broadcast::channel::<String>(4);
    let entry = super::StreamEntry {
        lines: std::sync::Mutex::new(vec![
            r#"{"type":"delta","text":"ok"}"#.to_string(),
            r#"{"type":"done","text":"ok","metrics":{}}"#.to_string(),
        ]),
        tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(super::now_epoch_secs()),
        thread_id: Some("thread-a".to_string()),
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    };

    assert!(super::stream_entry_has_terminal_event(&entry));
}

#[test]
fn legacy_marker_deltas_expand_to_structured_stream_events() {
    let activity =
        super::expand_legacy_delta_to_chat_events_with_mode("‹‹ACT››🧭 Planning‹‹/ACT››", false);
    assert_eq!(
        activity,
        vec![super::GenerateStreamEvent::Activity {
            text: "🧭 Planning".to_string()
        }]
    );

    let plan =
        super::expand_legacy_delta_to_chat_events_with_mode("‹‹PLAN››- [x] Done‹‹/PLAN››", false);
    assert_eq!(
        plan,
        vec![super::GenerateStreamEvent::PlanUpdate {
            markdown: "- [x] Done".to_string()
        }]
    );

    let plain = super::expand_legacy_delta_to_chat_events_with_mode("hello", false);
    assert_eq!(
        plain,
        vec![super::GenerateStreamEvent::Delta {
            text: "hello".to_string()
        }]
    );
}

#[test]
fn legacy_card_marker_deltas_expand_to_structured_stream_events() {
    let choices = super::expand_legacy_delta_to_chat_events_with_mode(
        "‹‹CHOICES››{\"question\":\"Confermi?\",\"options\":[\"Si\",\"No\"]}‹‹/CHOICES››",
        false,
    );
    assert!(matches!(
        &choices[0],
        super::GenerateStreamEvent::ChoicePrompt { payload }
            if payload["question"] == "Confermi?"
    ));

    let vault = super::expand_legacy_delta_to_chat_events_with_mode(
        "‹‹VAULT_REVEAL››{\"record_id\":\"vault_1\",\"label\":\"Codice Fiscale\"}‹‹/VAULT_REVEAL››",
        false,
    );
    assert!(matches!(
        &vault[0],
        super::GenerateStreamEvent::VaultReveal { payload }
            if payload["record_id"] == "vault_1"
    ));

    let payment = super::expand_legacy_delta_to_chat_events_with_mode(
        "‹‹PAYMENT_APPROVAL››{\"snapshot\":{\"approval_id\":\"pay_1\"}}‹‹/PAYMENT_APPROVAL››",
        false,
    );
    assert!(matches!(
        &payment[0],
        super::GenerateStreamEvent::PaymentApproval { payload }
            if payload["snapshot"]["approval_id"] == "pay_1"
    ));
    assert!(matches!(
        payment.as_slice(),
        [super::GenerateStreamEvent::PaymentApproval { .. }]
    ));
}

#[test]
fn legacy_marker_delta_expansion_can_keep_delta_for_compat_clients() {
    let activity =
        super::expand_legacy_delta_to_chat_events_with_mode("‹‹ACT››🧭 Planning‹‹/ACT››", true);
    assert_eq!(activity.len(), 2);
    assert!(matches!(
        activity[0],
        super::GenerateStreamEvent::Activity { .. }
    ));
    assert!(matches!(
        activity[1],
        super::GenerateStreamEvent::Delta { .. }
    ));
}

#[test]
fn idle_stream_entry_counts_as_stale_for_activity() {
    let (tx, _) = tokio::sync::broadcast::channel::<String>(4);
    let now = super::now_epoch_secs();
    let entry = super::StreamEntry {
        lines: std::sync::Mutex::new(vec![r#"{"type":"delta","text":"still"}"#.to_string()]),
        tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(
            now.saturating_sub(super::STREAM_ACTIVITY_IDLE_STALE_SECS + 1),
        ),
        thread_id: Some("thread-a".to_string()),
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    };

    assert!(super::stream_entry_is_activity_stale(&entry, now));
}

#[test]
fn silent_stream_entry_counts_as_stale_for_activity() {
    let (tx, _) = tokio::sync::broadcast::channel::<String>(4);
    let now = super::now_epoch_secs();
    let entry = super::StreamEntry {
        lines: std::sync::Mutex::new(Vec::new()),
        tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(
            now.saturating_sub(super::STREAM_SILENT_IDLE_STALE_SECS + 1),
        ),
        thread_id: Some("thread-a".to_string()),
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    };

    assert!(super::stream_entry_is_activity_stale(&entry, now));
}

#[tokio::test]
async fn terminal_emit_marks_stream_entry_finished() {
    let (mpsc, mut rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(4);
    let (tx, _) = tokio::sync::broadcast::channel::<String>(4);
    let entry = std::sync::Arc::new(super::StreamEntry {
        lines: std::sync::Mutex::new(Vec::new()),
        tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(super::now_epoch_secs()),
        thread_id: Some("thread-a".to_string()),
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    });
    let sink = super::StreamSink {
        mpsc,
        entry: entry.clone(),
    };

    super::emit_stream_event(
        &sink,
        super::GenerateStreamEvent::Done {
            text: "ok".to_string(),
            metrics: super::TokenMetrics::zero(),
            redacted_user_text: None,
        },
    )
    .await
    .expect("done event emits");
    let _ = rx.recv().await;

    assert!(entry.finished.load(std::sync::atomic::Ordering::Relaxed));
}

#[tokio::test]
async fn typed_engine_stop_unblocks_broker_transport_without_a_done_event() {
    let (tx, _) = tokio::sync::broadcast::channel::<String>(4);
    let entry = std::sync::Arc::new(super::StreamEntry {
        lines: std::sync::Mutex::new(Vec::new()),
        tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(super::now_epoch_secs()),
        thread_id: Some("thread-a".to_string()),
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    });
    let waiter = tokio::spawn(super::wait_for_stream_outcome(entry.clone()));

    super::publish_stream_outcome(
        &entry,
        local_first_engine::TurnOutcome {
            stop: local_first_engine::TurnStop::SuspendedModel {
                role: "primary".to_string(),
            },
            ..Default::default()
        },
    );

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
        .await
        .expect("typed outcome wakes the transport")
        .expect("waiter joins");
    assert!(matches!(
        outcome.stop,
        local_first_engine::TurnStop::SuspendedModel { .. }
    ));
    assert!(entry.lines.lock().expect("stream lines").is_empty());
}

#[test]
fn broker_stream_extracts_redacted_user_text_from_terminal_event() {
    let line = serde_json::json!({
        "type": "done",
        "text": "vault proposal",
        "redacted_user_text": "Il codice è [VAULT:credentials:password]"
    })
    .to_string();

    assert_eq!(
        super::redacted_user_text_from_stream_line(&line).as_deref(),
        Some("Il codice è [VAULT:credentials:password]")
    );
    assert!(
        super::redacted_user_text_from_stream_line(r#"{"type":"delta","text":"hello"}"#).is_none()
    );
}

#[tokio::test]
async fn privacy_preflight_early_response_publishes_typed_outcome() {
    let root = isolated_gateway_test_dir("privacy-preflight-typed-outcome");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let workspace_id = super::gateway_workspace_id();
    let thread = chat.create_thread(workspace_id.as_str()).unwrap();
    let mut state = AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let request_id = "privacy-early-outcome";

    let response = super::stream_chat_via_openai(
        &state,
        local_first_desktop_gateway::ChatGenerateStreamRequest {
            request_id: request_id.to_string(),
            agent_run_id: None,
            agent_checkpoint: None,
            checkpoint_input: None,
            prompt: "Fabio Cantone CNTFBA76L16F839Y".to_string(),
            thread_id: Some(thread.thread_id.clone()),
            context: Vec::new(),
            max_context_chars: None,
            model: None,
            images: Vec::new(),
            attachments: Vec::new(),
            max_tokens: 2000,
            temperature: 0.3,
            wait_if_busy: true,
            request_timeout_seconds: None,
            tool_policy: Some("full".to_string()),
            mode: None,
        },
        "http://127.0.0.1:9/v1".to_string(),
        "llama3.2".to_string(),
        None,
    )
    .await
    .expect("privacy preflight returns a stream response");
    let entry = super::stream_registry()
        .lock()
        .unwrap()
        .get(request_id)
        .cloned()
        .expect("registered stream entry");
    let _ = axum::body::to_bytes(response.into_body(), usize::MAX).await;

    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        super::wait_for_stream_outcome(entry),
    )
    .await
    .expect("privacy early response must wake typed outcome waiters");
    assert!(matches!(
        outcome.stop,
        local_first_engine::TurnStop::Completed
    ));
    assert!(outcome.memory_answer.contains("VAULT_PROPOSE"));
}

#[tokio::test]
async fn privacy_preflight_broker_drain_persists_vault_proposal_event() {
    let root = isolated_gateway_test_dir("privacy-preflight-broker-fanout");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let workspace_id = super::gateway_workspace_id();
    let thread = chat.create_thread(workspace_id.as_str()).unwrap();
    let user = super::channel_chat_message_with_id(
        "user",
        "Fabio Cantone CNTFBA76L16F839Y",
        "privacy_broker_user",
    );
    let assistant = local_first_desktop_gateway::seeded_ready_message(
        &thread.thread_id,
        "unix:1001.000000000".to_string(),
    );
    chat.commit_prompt_result(&thread.thread_id, &user, &assistant, None)
        .unwrap();
    let mut state = AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let request_id = "broker-turn_privacy_broker_fanout";

    let response = super::stream_chat_via_openai(
        &state,
        local_first_desktop_gateway::ChatGenerateStreamRequest {
            request_id: request_id.to_string(),
            agent_run_id: None,
            agent_checkpoint: None,
            checkpoint_input: None,
            prompt: "Fabio Cantone CNTFBA76L16F839Y".to_string(),
            thread_id: Some(thread.thread_id.clone()),
            context: Vec::new(),
            max_context_chars: None,
            model: None,
            images: Vec::new(),
            attachments: Vec::new(),
            max_tokens: 2000,
            temperature: 0.3,
            wait_if_busy: true,
            request_timeout_seconds: None,
            tool_policy: Some("full".to_string()),
            mode: None,
        },
        "http://127.0.0.1:9/v1".to_string(),
        "llama3.2".to_string(),
        None,
    )
    .await
    .expect("privacy preflight returns a stream response");
    let entry = super::stream_registry()
        .lock()
        .unwrap()
        .get(request_id)
        .cloned()
        .expect("registered stream entry");
    let buffered = entry.lines.lock().unwrap().join("\n");
    assert!(
        buffered.contains("VAULT_PROPOSE"),
        "privacy early response must buffer the vault proposal stream line"
    );
    let immediate_events = state
        .task_store
        .lock()
        .unwrap()
        .read_turn_events("turn_privacy_broker_fanout", 0)
        .unwrap();
    assert!(
        immediate_events
            .iter()
            .any(|event| event.kind == local_first_task_runtime::TurnEventKind::VaultPropose),
        "broker privacy preflight must fan out card markers before executor finalization"
    );
    assert!(
        immediate_events
            .iter()
            .all(|event| !local_first_task_runtime::turn_event_kind_is_terminal(event.kind)),
        "stream fanout must leave terminal events to canonical projection"
    );
    let body_task = tokio::spawn(async move {
        let _ = axum::body::to_bytes(response.into_body(), usize::MAX).await;
    });

    super::drain_agent_stream_into_message_with_fanout(
        &state,
        &thread.thread_id,
        &user.id,
        &assistant.id,
        entry,
        "turn_privacy_broker_fanout",
        local_first_desktop_gateway::MessageDeliveryState::Delivered,
    )
    .await
    .expect("drain succeeds");
    let _ = body_task.await;

    let events = state
        .task_store
        .lock()
        .unwrap()
        .read_turn_events("turn_privacy_broker_fanout", 0)
        .unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.kind == local_first_task_runtime::TurnEventKind::VaultPropose),
        "events did not include vault marker: {events:?}"
    );
    assert!(
        events
            .iter()
            .all(|event| !local_first_task_runtime::turn_event_kind_is_terminal(event.kind)),
        "stream fanout must leave terminal events to canonical projection: {events:?}"
    );
}

#[tokio::test]
async fn emit_stream_event_publishes_structured_event_without_legacy_marker_delta_by_default() {
    let (mpsc, mut rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(4);
    let (tx, _) = tokio::sync::broadcast::channel::<String>(4);
    let entry = std::sync::Arc::new(super::StreamEntry {
        lines: std::sync::Mutex::new(Vec::new()),
        tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(super::now_epoch_secs()),
        thread_id: Some("thread-a".to_string()),
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    });
    let sink = super::StreamSink {
        mpsc,
        entry: entry.clone(),
    };

    super::emit_stream_event(
        &sink,
        super::GenerateStreamEvent::Delta {
            text: "‹‹ACT››🧭 Planning‹‹/ACT››".to_string(),
        },
    )
    .await
    .expect("event emits");

    let first = rx.recv().await.expect("first event").expect("bytes");
    assert!(String::from_utf8_lossy(&first).contains(r#""type":"activity""#));
    assert!(rx.try_recv().is_err());
    let lines = entry.lines.lock().expect("stream lines");
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains(r#""type":"activity""#));
}

#[test]
fn channel_agent_stream_lines_accumulate_delta_and_done_text() {
    let mut streamed = String::new();
    let mut final_text = None;

    assert!(!super::apply_agent_stream_line(
        r#"{"type":"delta","text":"hello "}"#,
        &mut streamed,
        &mut final_text,
    ));
    assert!(!super::apply_agent_stream_line(
        r#"{"type":"delta","text":"world"}"#,
        &mut streamed,
        &mut final_text,
    ));
    assert_eq!(streamed, "hello world");
    assert!(final_text.is_none());

    assert!(super::apply_agent_stream_line(
        r#"{"type":"done","text":"final answer","metrics":{}}"#,
        &mut streamed,
        &mut final_text,
    ));
    assert_eq!(final_text.as_deref(), Some("final answer"));
}

#[test]
fn fanout_recall_preserves_the_payload_and_uses_recall_kind() {
    let raw = serde_json::json!({
        "type": "recall",
        "payload": {
            "query": "launch",
            "hits": [{
                "ref": "memory:owner:project-a:1",
                "source_workspace_id": "project-a",
                "source_label": "Homun roadmap",
                "collection": "decisions",
                "grant_id": null,
                "conflict": false
            }],
            "scope": "project"
        }
    });
    let (kind, payload) = super::turn_event_from_stream_value(&raw).expect("recall maps");
    assert_eq!(kind, local_first_task_runtime::TurnEventKind::Recall);
    assert_eq!(payload, raw["payload"]);
}

#[test]
fn fanout_vault_propose_preserves_card_payload() {
    let raw = serde_json::json!({
        "type": "vault_propose",
        "payload": {
            "category": "vehicles",
            "label": "Targa auto",
            "redacted_preview": "[VAULT:vehicles:plate]",
            "pending_id": "pending_1"
        }
    });

    let (kind, payload) = super::turn_event_from_stream_value(&raw).expect("vault card maps");

    assert_eq!(kind.as_str(), "vault_propose");
    assert_eq!(payload, raw["payload"]);
}

#[test]
fn fanout_done_with_legacy_vault_marker_is_durable() {
    let state = super::AppState::for_tests();
    let line = serde_json::json!({
        "type": "done",
        "text": "‹‹VAULT_PROPOSE››{\"pending_id\":\"pending_1\"}‹‹/VAULT_PROPOSE››",
        "metrics": {}
    })
    .to_string();

    super::fanout_turn_event(&state, "turn_done_vault_marker", &line);

    let events = state
        .task_store
        .lock()
        .unwrap()
        .read_turn_events("turn_done_vault_marker", 0)
        .unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.kind == local_first_task_runtime::TurnEventKind::VaultPropose),
        "done fanout events did not include marker: {events:?}"
    );
    assert!(
        events
            .iter()
            .all(|event| !local_first_task_runtime::turn_event_kind_is_terminal(event.kind)),
        "done fanout must not persist a terminal event before canonical projection: {events:?}"
    );
}

#[test]
fn fanout_legacy_card_markers_handles_multiple_vault_markers() {
    let state = super::AppState::for_tests();
    let text = "‹‹VAULT_PROPOSE››{\"pending_id\":\"pending_1\"}‹‹/VAULT_PROPOSE››\n\
        ‹‹VAULT_PROPOSE››{\"pending_id\":\"pending_2\"}‹‹/VAULT_PROPOSE››";

    super::fanout_legacy_card_markers_from_text(&state, "turn_multiple_vault_markers", text);

    let events = state
        .task_store
        .lock()
        .unwrap()
        .read_turn_events("turn_multiple_vault_markers", 0)
        .unwrap();
    let flattened = serde_json::to_string(&events).unwrap();
    assert!(flattened.contains("VAULT_PROPOSE") || flattened.contains("vault_propose"));
}

#[tokio::test]
async fn broker_fanout_waits_for_terminal_line_after_typed_outcome() {
    let state = super::AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .create_thread("workspace-broker-fanout")
        .unwrap();
    let assistant = local_first_desktop_gateway::seeded_ready_message(
        &thread.thread_id,
        "unix:1000.000000000".to_string(),
    );
    super::lock_store(&state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();

    let (mpsc, _rx) = tokio::sync::mpsc::channel(4);
    let (tx, _btx) = tokio::sync::broadcast::channel(4);
    let entry = std::sync::Arc::new(super::StreamEntry {
        lines: std::sync::Mutex::new(Vec::new()),
        tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(super::now_epoch_secs()),
        thread_id: Some(thread.thread_id.clone()),
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    });
    let sink = super::StreamSink {
        mpsc,
        entry: entry.clone(),
    };
    super::publish_stream_outcome(
        &entry,
        local_first_engine::TurnOutcome {
            stop: local_first_engine::TurnStop::Completed,
            memory_answer: "‹‹VAULT_PROPOSE››{\"pending_id\":\"pending_1\"}‹‹/VAULT_PROPOSE››"
                .to_string(),
            ..Default::default()
        },
    );

    let state_for_drain = state.clone();
    let thread_id = thread.thread_id.clone();
    let assistant_id = assistant.id.clone();
    let drain = tokio::spawn(async move {
        super::drain_agent_stream_into_message_with_fanout(
            &state_for_drain,
            &thread_id,
            "user_broker_race",
            &assistant_id,
            entry,
            "turn_broker_race",
            local_first_desktop_gateway::MessageDeliveryState::Delivered,
        )
        .await
    });

    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    super::emit_stream_event(
        &sink,
        super::GenerateStreamEvent::VaultPropose {
            payload: serde_json::json!({
                "category": "vehicles",
                "label": "Targa auto",
                "redacted_preview": "[VAULT:vehicles:plate]",
                "pending_id": "pending_1"
            }),
        },
    )
    .await
    .expect("vault card line emits");

    tokio::time::timeout(std::time::Duration::from_secs(1), drain)
        .await
        .expect("drain completes")
        .expect("drain joins")
        .expect("drain succeeds");

    let events = state
        .task_store
        .lock()
        .unwrap()
        .read_turn_events("turn_broker_race", 0)
        .unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.kind.as_str() == "vault_propose"
                && event.payload["pending_id"] == "pending_1"),
        "vault card must be durable on the broker turn events endpoint"
    );
}

#[test]
fn capability_runtime_projection_turn_event_preserves_metadata() {
    let raw = serde_json::json!({
        "type": "tool_result",
        "payload": {
            "name": "find_capability",
            "capability_runtime": {
                "loaded_tools": ["mcp__github__list_issues"],
                "blocked_capabilities": [
                    {"key": "mcp__github__create_issue", "reason": "approval_required"}
                ]
            }
        }
    });

    let (kind, payload) = super::turn_event_from_stream_value(&raw).expect("tool result maps");

    assert_eq!(kind, local_first_task_runtime::TurnEventKind::Tool);
    assert_eq!(
        payload["payload"]["capability_runtime"]["loaded_tools"],
        serde_json::json!(["mcp__github__list_issues"])
    );
    assert_eq!(
        payload["payload"]["capability_runtime"]["blocked_capabilities"][0],
        serde_json::json!({"key": "mcp__github__create_issue", "reason": "approval_required"})
    );
}

#[test]
fn fanout_stream_error_maps_to_turn_event_error() {
    let raw = serde_json::json!({
        "type": "error",
        "code": "model_timeout",
        "message": "The model took too long to respond. Please try again.",
        "retryable": false
    });

    let (kind, payload) = super::turn_event_from_stream_value(&raw).expect("stream error maps");

    assert_eq!(kind, local_first_task_runtime::TurnEventKind::Error);
    assert_eq!(payload["code"], "model_timeout");
    assert_eq!(
        payload["message"],
        "The model took too long to respond. Please try again."
    );
    assert_eq!(payload["retryable"], false);
}

#[test]
fn automatic_recall_payload_keeps_an_empty_recall_visible_to_the_stream() {
    let pack = local_first_memory::RecallPack::from_block(
        "launch",
        local_first_memory::MemoryScope::Personal,
        None,
    );

    let payload = super::recall_stream_payload_from_pack(&pack);
    assert_eq!(payload.query, "launch");
    assert!(payload.hits.is_empty());
    assert_eq!(payload.scope, "personal");
    assert_eq!(payload.status, "empty");
}

#[test]
fn memory_status_distinguishes_empty_from_unavailable() {
    assert!(
        super::memory_access_status_instruction(local_first_memory::MemoryAccessStatus::Empty)
            .contains("connected")
    );
    assert!(
        super::memory_access_status_instruction(
            local_first_memory::MemoryAccessStatus::Unavailable
        )
        .contains("could not be queried")
    );
}

#[test]
fn thread_episode_scope_requires_exact_thread_and_workspace() {
    let metadata = serde_json::json!({
        "thread_id": "thread-a",
        "workspace": "project-a"
    });
    assert!(super::episode_metadata_matches_scope(
        &metadata,
        "thread-a",
        "project-a"
    ));
    assert!(!super::episode_metadata_matches_scope(
        &metadata,
        "thread-b",
        "project-a"
    ));
    assert!(!super::episode_metadata_matches_scope(
        &metadata,
        "thread-a",
        "project-b"
    ));
}

#[test]
fn automatic_recall_payload_preserves_graph_path() {
    let pack = local_first_memory::RecallPack::from_hits(
        "atlas".to_string(),
        local_first_memory::MemoryScope::Project(MemoryWorkspaceId::new("project-a")),
        vec![local_first_memory::RecallHit {
            memory_ref: "memory:owner:project-a:related".to_string(),
            text: "Related memory".to_string(),
            score: 0.5,
            kind: "fact".to_string(),
            source_user_id: local_first_memory::UserId::new("owner"),
            source_workspace_id: MemoryWorkspaceId::new("project-a"),
            source_label: "Project A".to_string(),
            collection: local_first_memory::MemoryCollectionKey::Knowledge,
            grant_id: None,
            policy_version: None,
            source_revision: "sha256:test-revision".to_string(),
            sensitivity: MemoryDataSensitivity::Internal,
            status: local_first_memory::MemoryStatus::Confirmed,
            updated_at: "unix:1800000000".to_string(),
            subject_key: None,
            conflict: false,
            publication_link: None,
            graph_path: vec!["mentions".to_string(), "mentions".to_string()],
        }],
    );

    let payload = super::recall_stream_payload_from_pack(&pack);
    let value = serde_json::to_value(payload).expect("serialize recall payload");
    assert_eq!(
        value["hits"][0]["graph_path"],
        serde_json::json!(["mentions", "mentions"])
    );
}

fn linked_recall_payload_for_turn() -> local_first_subagents::RecallStreamPayload {
    local_first_subagents::RecallStreamPayload {
        query: "linked fact".to_string(),
        hits: vec![local_first_subagents::RecallStreamHit {
            r#ref: "memory:owner:source-a:fact-a".to_string(),
            text: "Linked fact".to_string(),
            score: 0.9,
            kind: "fact".to_string(),
            source_workspace_id: "source-a".to_string(),
            source_label: "Source A".to_string(),
            collection: "knowledge".to_string(),
            grant_id: Some("grant-a".to_string()),
            policy_version: Some(3),
            source_revision: Some("sha256:rev-a".to_string()),
            conflict: false,
            graph_path: Vec::new(),
        }],
        scope: "project".to_string(),
        status: "ready".to_string(),
    }
}

#[test]
fn automatic_recall_seeds_the_loop_read_set() {
    let mut state = local_first_engine::LoopState::new();
    let payload = linked_recall_payload_for_turn();

    super::seed_loop_memory_reads(&mut state, Some(&payload));

    assert_eq!(state.memory_reads.linked.len(), 1);
    assert_eq!(state.memory_reads.linked[0].grant_id, "grant-a");
}

#[test]
fn briefing_and_recall_hits_share_one_deduplicated_turn_attestation() {
    let briefing_hit = test_linked_briefing_hit("briefing", "Linked preference");
    let scope =
        local_first_memory::MemoryScope::Project(local_first_memory::WorkspaceId::new("project-a"));
    let mut payload = None;

    super::merge_automatic_recall_payload(
        &mut payload,
        super::recall_stream_payload_from_hits(
            "current prompt",
            &scope,
            std::slice::from_ref(&briefing_hit),
        ),
    );
    super::merge_automatic_recall_payload(
        &mut payload,
        super::recall_stream_payload_from_hits(
            "current prompt",
            &scope,
            std::slice::from_ref(&briefing_hit),
        ),
    );
    super::merge_automatic_recall_payload(&mut payload, linked_recall_payload_for_turn());

    let payload = payload.expect("merged payload");
    assert_eq!(payload.hits.len(), 2, "duplicate briefing hit is removed");

    let mut loop_state = local_first_engine::LoopState::new();
    super::seed_loop_memory_reads(&mut loop_state, Some(&payload));
    assert_eq!(loop_state.memory_reads.linked.len(), 2);

    let line = serde_json::json!({ "type": "recall", "payload": payload }).to_string();
    let mut collector = super::StreamMemoryReuseCollector::default();
    collector.observe_line(&line);
    assert_eq!(collector.envelope().linked_reads.len(), 2);
    assert_eq!(
        collector.envelope().write_policy,
        local_first_memory::MemoryWritePolicy::UserInputOnly
    );
}

#[test]
fn explicit_recall_payload_becomes_tool_memory_read_effects() {
    let payload = linked_recall_payload_for_turn();

    let effects = super::memory_read_effects_from_recall_payload(&payload);

    assert_eq!(effects.memory_reads.linked.len(), 1);
    assert_eq!(effects.memory_reads.linked[0].grant_id, "grant-a");
}

#[test]
fn stream_memory_reuse_collector_attests_linked_reads() {
    let payload = linked_recall_payload_for_turn();
    let line = serde_json::json!({ "type": "recall", "payload": payload }).to_string();
    let mut collector = super::StreamMemoryReuseCollector::default();

    collector.observe_line(&line);

    assert_eq!(collector.event_parts().len(), 1);
    let envelope = collector.envelope();
    assert_eq!(
        envelope.write_policy,
        local_first_memory::MemoryWritePolicy::UserInputOnly
    );
    assert_eq!(envelope.linked_reads.len(), 1);
    assert_eq!(envelope.linked_reads[0].grant_id, "grant-a");
}

#[test]
fn briefing_attestation_survives_atomic_assistant_finalization() {
    let payload = linked_recall_payload_for_turn();
    let line = serde_json::json!({ "type": "recall", "payload": payload }).to_string();
    let mut collector = super::StreamMemoryReuseCollector::default();
    collector.observe_line(&line);

    let store = super::ChatStore::in_memory().unwrap();
    let thread = store.create_thread("project-a").unwrap();
    let assistant = local_first_desktop_gateway::seeded_ready_message(
        &thread.thread_id,
        format!("unix:{}.000000000", super::now_epoch_secs()),
    );
    store
        .append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();

    let saved = store
        .finalize_assistant_message(
            &thread.thread_id,
            &assistant.id,
            "Answer informed by linked briefing",
            collector.event_parts(),
            &collector.envelope(),
        )
        .unwrap();

    let envelope = saved.memory_reuse.expect("reuse envelope");
    assert_eq!(
        envelope.write_policy,
        local_first_memory::MemoryWritePolicy::UserInputOnly
    );
    assert_eq!(envelope.linked_reads.len(), 1);
}

#[test]
fn stream_memory_reuse_collector_fails_closed_on_corrupt_recall() {
    let line = serde_json::json!({
        "type": "recall",
        "payload": { "hits": [{ "grant_id": "grant-a" }] }
    })
    .to_string();
    let mut collector = super::StreamMemoryReuseCollector::default();

    collector.observe_line(&line);

    assert_eq!(
        collector.envelope().write_policy,
        local_first_memory::MemoryWritePolicy::BlockedUnknown
    );
}

#[test]
fn revoked_linked_answer_stays_available_in_its_existing_thread_context() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let mut message = super::channel_chat_message("assistant", "NEBULA-7429");
    message.memory_reuse = Some(local_first_memory::MemoryReuseEnvelope::user_input_only(
        vec![local_first_memory::LinkedMemoryReadRef {
            source_workspace_id: "source-a".to_string(),
            grant_id: "revoked-grant".to_string(),
            policy_version: 2,
            memory_ref: "memory:owner:source-a:fact-a".to_string(),
            source_revision: "sha256:rev-a".to_string(),
        }],
    ));

    assert!(message.text.contains("NEBULA-7429"));
    let context = super::context_message_for_model(
        &facade,
        (
            &local_first_memory::UserId::new("owner"),
            &local_first_memory::WorkspaceId::new("project-a"),
        ),
        &message,
        1_800_000_000,
    )
    .unwrap();

    assert!(context.text.contains("NEBULA-7429"));
}

#[test]
fn multiple_attested_linked_reads_remain_available_as_one_historical_message() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let mut message = super::channel_chat_message("assistant", "MULTI-GRANT-SENTINEL");
    message.memory_reuse = Some(local_first_memory::MemoryReuseEnvelope::user_input_only(
        vec![
            local_first_memory::LinkedMemoryReadRef {
                source_workspace_id: "source-a".to_string(),
                grant_id: "grant-a".to_string(),
                policy_version: 1,
                memory_ref: "memory:owner:source-a:fact-a".to_string(),
                source_revision: "sha256:rev-a".to_string(),
            },
            local_first_memory::LinkedMemoryReadRef {
                source_workspace_id: "source-b".to_string(),
                grant_id: "grant-b".to_string(),
                policy_version: 1,
                memory_ref: "memory:owner:source-b:fact-b".to_string(),
                source_revision: "sha256:rev-b".to_string(),
            },
        ],
    ));

    let context = super::context_message_for_model(
        &facade,
        (
            &local_first_memory::UserId::new("owner"),
            &local_first_memory::WorkspaceId::new("project-a"),
        ),
        &message,
        1_800_000_000,
    )
    .unwrap();
    assert!(context.text.contains("MULTI-GRANT-SENTINEL"));
}

#[test]
fn malformed_linked_attestation_is_omitted_from_model_context() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let mut message = super::channel_chat_message("assistant", "MALFORMED-SENTINEL");
    message.memory_reuse = Some(local_first_memory::MemoryReuseEnvelope::user_input_only(
        Vec::new(),
    ));

    let context = super::context_message_for_model(
        &facade,
        (
            &local_first_memory::UserId::new("owner"),
            &local_first_memory::WorkspaceId::new("project-a"),
        ),
        &message,
        1_800_000_000,
    )
    .unwrap();

    assert!(!context.text.contains("MALFORMED-SENTINEL"));
}

#[test]
fn persisted_thread_context_is_filtered_server_side() {
    let state = super::AppState::for_tests();
    let (thread_id, blocked_id) = {
        let store = state.chat_store.lock().unwrap();
        let thread = store.create_thread("project-a").unwrap();
        let mut blocked = super::channel_chat_message("assistant", "SERVER-ONLY-SENTINEL");
        blocked.memory_reuse = Some(local_first_memory::MemoryReuseEnvelope::blocked_unknown());
        let blocked_id = blocked.id.clone();
        store
            .append_assistant_message(&thread.thread_id, &blocked)
            .unwrap();
        (thread.thread_id, blocked_id)
    };

    let context = super::thread_context_for_model(&state, &thread_id, &[], None).unwrap();

    assert!(
        state
            .chat_store
            .lock()
            .unwrap()
            .message(&thread_id, &blocked_id)
            .unwrap()
            .unwrap()
            .text
            .contains("SERVER-ONLY-SENTINEL")
    );
    assert!(
        !context
            .iter()
            .any(|message| message.text.contains("SERVER-ONLY-SENTINEL"))
    );
    assert!(context.iter().any(|message| {
        message.text == local_first_desktop_gateway::LINKED_MEMORY_CONTEXT_OMITTED
    }));
}

#[test]
fn sandbox_terminal_owner_is_only_live_while_command_runs() {
    super::sandbox_clear(Some("thread-live-owner".to_string()));
    super::sandbox_begin(
        "echo live".to_string(),
        Some("thread-live-owner".to_string()),
    );

    let running = super::current_sandbox_activity();
    assert!(running.iter().any(|entry| entry.running));
    assert_eq!(
        super::current_sandbox_owner().as_deref(),
        Some("thread-live-owner")
    );

    super::sandbox_end("done".to_string());
    let finished = super::current_sandbox_activity();
    assert!(!finished.iter().any(|entry| entry.running));
    let terminal_active = finished.iter().any(|entry| entry.running);
    let live_owner = if terminal_active {
        super::current_sandbox_owner().or_else(|| {
            finished
                .iter()
                .rev()
                .find_map(|entry| entry.thread_id.clone())
        })
    } else {
        None
    };
    assert_eq!(live_owner, None);

    super::sandbox_clear(None);
}

#[test]
fn collapse_plan_markers_keeps_only_latest() {
    // Reproduces the real Mondiali churn: the harness stacked several full ‹‹PLAN››
    // blocks (one per update_plan/step_advance call) ahead of the prose.
    let churn = "‹‹PLAN››- [-] **A** (`s1`): —‹‹/PLAN››\
            ‹‹PLAN››- [x] **A** (`s1`): done‹‹/PLAN››\
            ‹‹PLAN››- [x] **A** (`s1`): done\n- [-] **B** (`s2`): —‹‹/PLAN››\
            Briefing finale qui.";
    let out = collapse_plan_markers(churn);
    // Exactly one plan block survives, and it's the LAST (freshest) one.
    assert_eq!(out.matches("‹‹PLAN››").count(), 1);
    assert!(
        out.contains("**B** (`s2`)"),
        "kept the latest canonical plan"
    );
    assert!(out.ends_with("Briefing finale qui."), "prose preserved");
    // Resume still parses the surviving block.
    assert_eq!(parse_plan_marker(&out).len(), 2);
}

#[test]
fn collapse_plan_markers_noop_for_single_or_none() {
    let one = "‹‹PLAN››- [ ] **A** (`s1`): —‹‹/PLAN›› done";
    assert_eq!(collapse_plan_markers(one), one);
    let none = "just prose, no plan";
    assert_eq!(collapse_plan_markers(none), none);
}

#[test]
fn collapse_plan_markers_keeps_first_position() {
    // Plan blocks interleaved with prose: the surviving (latest-content) block stays
    // where the FIRST one was, so the card never jumps below the answer.
    let text = "intro ‹‹PLAN››- [ ] **A** (`s1`): —‹‹/PLAN›› middle \
            ‹‹PLAN››- [x] **A** (`s1`): done‹‹/PLAN›› end";
    let out = collapse_plan_markers(text);
    assert_eq!(out.matches("‹‹PLAN››").count(), 1);
    let plan_at = out.find("‹‹PLAN››").unwrap();
    let middle_at = out.find("middle").unwrap();
    assert!(plan_at < middle_at, "plan stays before the middle prose");
    assert!(out.contains("[x] **A**"), "but carries the latest content");
    assert!(out.contains("end"));
}

// Phase 2 (per-project extra writable folders): the exec fence must honor MULTIPLE
// writable roots — a per-project EXTRA folder outside the project root is writable, while
// a folder in NEITHER root stays denied. Mirrors `seatbelt_fence_...` (macOS-only Seatbelt,
// deterministic) but proves the multi-root case that `resolved_writable_roots` produces
// (project + extra). Does NOT touch the guardrail test. The Linux multi-root case is
// covered by `tests/linux_sandbox.rs` (which already passes multiple --allow-write).
#[cfg(target_os = "macos")]
#[test]
fn seatbelt_fence_allows_per_project_extra_writable_folder() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let pid = std::process::id();
        let project = std::env::temp_dir().join(format!("homun_extra_project_{pid}"));
        let extra = std::env::temp_dir().join(format!("homun_extra_folder_{pid}"));
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&extra).unwrap();
        let in_project = project.join("p.txt");
        let in_extra = extra.join("e.txt");
        let _ = std::fs::remove_file(&in_project);
        let _ = std::fs::remove_file(&in_extra);
        // A dir in NEITHER writable root → must stay denied.
        let outside = std::path::PathBuf::from(std::env::var("HOME").unwrap())
            .join(format!("homun_extra_probe_{pid}.txt"));
        let _ = std::fs::remove_file(&outside);

        // Both roots (project + the per-project extra folder) are passed to the fence,
        // exactly as `resolved_writable_roots` would yield them.
        let roots = vec![project.clone(), extra.clone()];

        let mut c = crate::gateway_project_files::build_sandbox_command(
            &roots,
            &format!("echo ok > '{}'", in_project.display()),
        )
        .expect("build_sandbox_command (project root)");
        let project_ok = c.status().await.expect("run (project)").success() && in_project.exists();

        let mut c2 = crate::gateway_project_files::build_sandbox_command(
            &roots,
            &format!("echo ok > '{}'", in_extra.display()),
        )
        .expect("build_sandbox_command (extra root)");
        let extra_ok = c2.status().await.expect("run (extra)").success() && in_extra.exists();

        let mut c3 = crate::gateway_project_files::build_sandbox_command(
            &roots,
            &format!("echo bad > '{}'", outside.display()),
        )
        .expect("build_sandbox_command (outside)");
        let _ = c3.status().await;
        let leaked = outside.exists();

        let _ = std::fs::remove_file(&in_project);
        let _ = std::fs::remove_file(&in_extra);
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&project);
        let _ = std::fs::remove_dir_all(&extra);

        assert!(project_ok, "write under the project root should be ALLOWED");
        assert!(
            extra_ok,
            "write under the per-project EXTRA root should be ALLOWED"
        );
        assert!(
            !leaked,
            "write outside BOTH roots LEAKED — the fence is not confining"
        );
    });
}

// ADR 0023 (C1) live fence check: with the sandbox ON (now the default), the real
// build_sandbox_command → sandbox-exec path must ALLOW writes under a writable root
// and DENY writes elsewhere ($HOME root). macOS-only (Seatbelt); the Linux fence has
// its own integration test (tests/linux_sandbox.rs). Deterministic — no model.
#[cfg(target_os = "macos")]
#[test]
fn seatbelt_fence_allows_in_root_denies_out_of_root() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let pid = std::process::id();
        let root = std::env::temp_dir().join(format!("homun_fence_root_{pid}"));
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("inside.txt");
        let _ = std::fs::remove_file(&inside);
        // $HOME root is NOT a writable root and NOT the temp dir → must be denied.
        let outside = std::path::PathBuf::from(std::env::var("HOME").unwrap())
            .join(format!("homun_fence_probe_{pid}.txt"));
        let _ = std::fs::remove_file(&outside);

        // in-root write → ALLOWED by the workspace-write fence
        let mut c = crate::gateway_project_files::build_sandbox_command(
            std::slice::from_ref(&root),
            &format!("echo ok > '{}'", inside.display()),
        )
        .expect("build_sandbox_command (in-root)");
        let st = c.status().await.expect("run sandbox-exec (in-root)");
        let in_ok = st.success() && inside.exists();

        // out-of-root write ($HOME) → DENIED by (deny default); the file must NOT appear
        let mut c2 = crate::gateway_project_files::build_sandbox_command(
            std::slice::from_ref(&root),
            &format!("echo bad > '{}'", outside.display()),
        )
        .expect("build_sandbox_command (out-of-root)");
        let _ = c2.status().await; // exit code irrelevant; what matters is the file is absent
        let leaked = outside.exists();

        let _ = std::fs::remove_file(&inside);
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            in_ok,
            "in-root write should be ALLOWED under the workspace-write fence"
        );
        assert!(
            !leaked,
            "out-of-root write to $HOME LEAKED — the sandbox fence is NOT active"
        );
    });
}

#[test]
fn ollama_capabilities_parsed_from_show_body() {
    // Shape per Ollama /api/show: capabilities array + model_info["<arch>.context_length"].
    let body = serde_json::json!({
        "capabilities": ["completion", "tools", "vision", "thinking"],
        "model_info": { "general.architecture": "qwen3", "qwen3.context_length": 40960 }
    });
    let caps = super::parse_ollama_capabilities(&body);
    assert!(caps.thinking && caps.tools && caps.vision);
    assert_eq!(caps.context_length, Some(40960));

    // A plain model: no extras, context from its arch key.
    let plain = serde_json::json!({
        "capabilities": ["completion"],
        "model_info": { "general.architecture": "llama", "llama.context_length": 8192 }
    });
    let caps = super::parse_ollama_capabilities(&plain);
    assert!(!caps.thinking && !caps.tools && !caps.vision);
    assert_eq!(caps.context_length, Some(8192));

    // Missing everything → all false / None, never panics.
    let empty = super::parse_ollama_capabilities(&serde_json::json!({}));
    assert_eq!(empty, super::OllamaCapabilities::default());
}

#[test]
fn a_silent_provider_and_a_retired_model_are_not_the_same_thing() {
    use super::ModelReport;
    // The real shape of a retirement, verbatim from Ollama: 410 + "was retired at".
    assert_eq!(
        super::classify_model_report(
            410,
            &serde_json::json!({ "error": "qwen3-vl:235b was retired at 2026-06-16 00:00:00" })
        ),
        ModelReport::Retired
    );
    // An outage or an older Ollama teaches us NOTHING — we must not downgrade a model on our own
    // silence, which would quietly delete a working capability.
    assert_eq!(
        super::classify_model_report(500, &serde_json::json!({ "error": "internal" })),
        ModelReport::Unknown
    );
    assert_eq!(
        super::classify_model_report(200, &serde_json::json!({ "model_info": {} })),
        ModelReport::Unknown
    );
    // A live model speaks.
    assert_eq!(
        super::classify_model_report(
            200,
            &serde_json::json!({ "capabilities": ["completion", "vision", "tools"] })
        ),
        ModelReport::Capabilities(
            vec!["completion".into(), "vision".into(), "tools".into()],
            None
        )
    );
}

#[test]
fn the_provider_report_overrides_the_name_heuristic_both_ways() {
    // `gemma4` has none of the magic substrings, yet Ollama reports vision — the name heuristic
    // called it blind and hid it from the vision role. The report must win.
    let mut seeing = super::model_registry::ModelEntry::inferred("gemma4:12b");
    assert!(
        !seeing.vision,
        "the heuristic guesses wrong here — that's the point"
    );
    super::apply_reported_capabilities(
        &mut seeing,
        &["completion".into(), "vision".into(), "tools".into()],
        Some(128_000),
    );
    assert!(seeing.vision && seeing.tools);
    assert_eq!(seeing.modality, "text");
    assert_eq!(seeing.context_window, Some(128_000));

    // And the other way: `-vl` in the name made a RETIRED model look like the app's only eye.
    // An empty report strips it of every capability, so no role can auto-match it.
    let mut retired = super::model_registry::ModelEntry::inferred("qwen3-vl:235b-cloud");
    assert!(retired.vision, "the heuristic trusted the name");
    super::apply_reported_capabilities(&mut retired, &[], None);
    assert!(!retired.vision && !retired.tools && !retired.reasoning);
}

#[test]
fn retired_models_are_removed_from_the_refreshed_catalog() {
    use super::ModelReport;
    let ids = vec![
        "deepseek-v4-pro:cloud".to_string(),
        "ministral-3:14b-cloud".to_string(),
    ];
    let catalog = ids
        .iter()
        .map(|id| (id.clone(), super::model_registry::ModelEntry::inferred(id)))
        .collect::<std::collections::HashMap<_, _>>();
    let reported = std::collections::HashMap::from([
        (
            "deepseek-v4-pro:cloud".to_string(),
            ModelReport::Capabilities(vec!["completion".into(), "thinking".into()], None),
        ),
        ("ministral-3:14b-cloud".to_string(), ModelReport::Retired),
    ]);

    let refreshed = super::refreshed_catalog_models(
        &ids,
        &catalog,
        &reported,
        &std::collections::HashMap::new(),
        &std::collections::HashMap::new(),
    );

    assert_eq!(refreshed.len(), 1);
    assert_eq!(refreshed[0].id, "deepseek-v4-pro:cloud");
    assert!(refreshed[0].reasoning);
}

#[test]
fn composite_chat_model_override_resolves_only_an_enabled_catalog_entry() {
    let mut registry = super::model_registry::ProviderRegistry::default();
    let mut provider = super::model_registry::ProviderEntry::new(
        "cloud".into(),
        "Cloud".into(),
        super::model_registry::ProviderKind::OpenaiCompat,
        "https://api.example.test/v1".into(),
    );
    provider.models = vec![super::model_registry::ModelEntry::inferred(
        "deepseek-v4-flash",
    )];
    registry.upsert(provider);

    let resolved =
        super::resolve_composite_chat_model_override(&registry, "cloud::deepseek-v4-flash")
            .unwrap()
            .unwrap();
    assert_eq!(resolved.0, "cloud");
    assert_eq!(resolved.1, "https://api.example.test/v1");
    assert_eq!(resolved.2, "deepseek-v4-flash");

    assert!(
        super::resolve_composite_chat_model_override(&registry, "cloud::missing")
            .unwrap_err()
            .contains("model is unavailable")
    );
    registry.get_mut("cloud").unwrap().enabled = false;
    assert!(
        super::resolve_composite_chat_model_override(&registry, "cloud::deepseek-v4-flash")
            .unwrap_err()
            .contains("provider is unavailable")
    );
}

#[test]
fn privacy_guard_auto_resolution_uses_the_smallest_qualified_local_model() {
    let mut registry = super::model_registry::ProviderRegistry::default();
    let mut ollama = super::model_registry::ProviderEntry::new(
        "ollama".into(),
        "Ollama".into(),
        super::model_registry::ProviderKind::Ollama,
        "http://127.0.0.1:11434/v1".into(),
    );
    ollama.models = vec![
        super::model_registry::ModelEntry::inferred("minimax-m3:cloud"),
        super::model_registry::ModelEntry::inferred("gemma4:12b"),
        super::model_registry::ModelEntry::inferred("qwen3.5:2b"),
        super::model_registry::ModelEntry::inferred("qwen3.5:4b"),
    ];
    registry.upsert(ollama);

    let resolved = super::resolve_privacy_guard_role(&registry).unwrap();

    assert_eq!(resolved.provider_id, "ollama");
    assert_eq!(resolved.model, "qwen3.5:4b");
    assert!(resolved.auto);
}

#[test]
fn privacy_guard_does_not_resolve_an_unqualified_local_model() {
    let mut registry = super::model_registry::ProviderRegistry::default();
    let mut ollama = super::model_registry::ProviderEntry::new(
        "ollama".into(),
        "Ollama".into(),
        super::model_registry::ProviderKind::Ollama,
        "http://127.0.0.1:11434/v1".into(),
    );
    ollama.models = vec![super::model_registry::ModelEntry::inferred("qwen3.5:2b")];
    registry.upsert(ollama);

    assert!(super::resolve_privacy_guard_role(&registry).is_none());
}

#[test]
fn privacy_guard_default_config_does_not_depend_on_a_fresh_provider_catalog() {
    let (base_url, model, api_key) = super::qualified_privacy_guard_default_config();

    assert_eq!(base_url, "http://127.0.0.1:11434/v1");
    assert_eq!(model, "qwen3.5:4b");
    assert!(api_key.is_none());
}

#[test]
fn semantic_auth_fallback_prefers_a_usable_different_provider() {
    let mut registry = super::model_registry::ProviderRegistry::default();
    let mut cloud = super::model_registry::ProviderEntry::new(
        "cloud".into(),
        "Cloud".into(),
        super::model_registry::ProviderKind::OpenaiCompat,
        "https://api.example.test/v1".into(),
    );
    cloud.active_model = Some("deepseek-v4-pro".into());
    cloud.models = vec![super::model_registry::ModelEntry::inferred(
        "deepseek-v4-pro",
    )];
    registry.upsert(cloud);

    let mut local = super::model_registry::ProviderEntry::new(
        "ollama".into(),
        "Ollama".into(),
        super::model_registry::ProviderKind::Ollama,
        "http://127.0.0.1:11434/v1".into(),
    );
    local.models = vec![
        super::model_registry::ModelEntry::inferred("deepseek-v4-pro:cloud"),
        super::model_registry::ModelEntry::inferred("gemma4:12b"),
    ];
    registry.upsert(local);

    let fallback =
        super::auth_fallback_resolved_role_from_registry(&registry, "deepseek-v4-pro", |_| false)
            .unwrap();

    assert_eq!(fallback.provider_id, "ollama");
    assert_eq!(fallback.model, "gemma4:12b");
    assert_eq!(fallback.kind, super::model_registry::ProviderKind::Ollama);
}

#[test]
fn semantic_decision_auth_fallback_prefers_qualified_local_json_model() {
    let mut registry = super::model_registry::ProviderRegistry::default();
    let mut cloud = super::model_registry::ProviderEntry::new(
        "cloud".into(),
        "Cloud".into(),
        super::model_registry::ProviderKind::OpenaiCompat,
        "https://api.example.test/v1".into(),
    );
    cloud.active_model = Some("deepseek-v4-pro".into());
    cloud.models = vec![super::model_registry::ModelEntry::inferred(
        "deepseek-v4-pro",
    )];
    registry.upsert(cloud);

    let mut local = super::model_registry::ProviderEntry::new(
        "ollama".into(),
        "Ollama".into(),
        super::model_registry::ProviderKind::Ollama,
        "http://127.0.0.1:11434/v1".into(),
    );
    local.models = vec![
        super::model_registry::ModelEntry::inferred("gemma4:12b"),
        super::model_registry::ModelEntry::inferred("qwen3.5:2b"),
        super::model_registry::ModelEntry::inferred("qwen3.5:4b"),
    ];
    registry.upsert(local);

    let fallback = super::semantic_decision_auth_fallback_resolved_role_from_registry(
        &registry,
        "deepseek-v4-pro",
        |_| false,
    )
    .unwrap();

    assert_eq!(fallback.provider_id, "ollama");
    assert_eq!(fallback.model, "qwen3.5:4b");
    assert_eq!(fallback.kind, super::model_registry::ProviderKind::Ollama);
}

// Malformed URL: RequestBuilder::build() surfaces the stored parse error
// synchronously without performing any network I/O or needing an async runtime.
fn sample_reqwest_request_error() -> reqwest::Error {
    reqwest::blocking::Client::new()
        .get("not a valid url")
        .build()
        .expect_err("malformed URL should fail to build a request")
}

fn semantic_decision_auth_fallback_test_resolved(
    model: &str,
) -> super::model_registry::ResolvedRole {
    super::model_registry::ResolvedRole {
        role: "orchestrator".to_string(),
        provider_id: "cloud".to_string(),
        model: model.to_string(),
        kind: super::model_registry::ProviderKind::OpenaiCompat,
        base_url: "https://api.example.test/v1".to_string(),
        auto: false,
        tier: super::model_registry::ModelTier::Balanced,
    }
}

// Registry with a distinct, usable local fallback model (mirrors the fixture in
// `semantic_decision_auth_fallback_prefers_qualified_local_json_model`).
fn semantic_decision_auth_fallback_registry_with_fallback()
-> super::model_registry::ProviderRegistry {
    let mut registry = super::model_registry::ProviderRegistry::default();
    let mut cloud = super::model_registry::ProviderEntry::new(
        "cloud".into(),
        "Cloud".into(),
        super::model_registry::ProviderKind::OpenaiCompat,
        "https://api.example.test/v1".into(),
    );
    cloud.active_model = Some("deepseek-v4-pro".into());
    cloud.models = vec![super::model_registry::ModelEntry::inferred(
        "deepseek-v4-pro",
    )];
    registry.upsert(cloud);

    let mut local = super::model_registry::ProviderEntry::new(
        "ollama".into(),
        "Ollama".into(),
        super::model_registry::ProviderKind::Ollama,
        "http://127.0.0.1:11434/v1".into(),
    );
    local.models = vec![super::model_registry::ModelEntry::inferred("qwen3.5:4b")];
    registry.upsert(local);
    registry
}

// Registry with no other provider and no local model at all: there is nothing
// distinct to fall back to.
fn semantic_decision_auth_fallback_registry_without_fallback()
-> super::model_registry::ProviderRegistry {
    let mut registry = super::model_registry::ProviderRegistry::default();
    let mut cloud = super::model_registry::ProviderEntry::new(
        "cloud".into(),
        "Cloud".into(),
        super::model_registry::ProviderKind::OpenaiCompat,
        "https://api.example.test/v1".into(),
    );
    cloud.active_model = Some("deepseek-v4-pro".into());
    cloud.models = vec![super::model_registry::ModelEntry::inferred(
        "deepseek-v4-pro",
    )];
    registry.upsert(cloud);
    registry
}

#[test]
fn semantic_decision_auth_fallback_applies_beyond_401() {
    use local_first_subagents::RuntimeClientError;

    assert!(super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::Status(401)
    ));
    assert!(super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::Status(403)
    ));
    assert!(super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::Status(429)
    ));
    assert!(super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::Status(500)
    ));
    assert!(super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::Status(599)
    ));
    assert!(super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::StreamEndedWithoutDone
    ));
    assert!(super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, "timeout"))
    ));
    assert!(super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::Request(sample_reqwest_request_error())
    ));

    // Not a genuine availability signal: leave these ungated (unchanged behavior).
    assert!(!super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::Status(400)
    ));
    assert!(!super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::Status(404)
    ));
    assert!(!super::semantic_decision_auth_fallback_applies(
        &RuntimeClientError::Runtime {
            code: "context_length_exceeded".to_string(),
            message: "too long".to_string(),
        }
    ));
}

#[test]
fn semantic_decision_retries_one_invalid_json_response() {
    use local_first_subagents::{GenerateJsonResponse, TokenMetrics};

    let metrics = || TokenMetrics {
        prompt_tokens: 0,
        generation_tokens: 0,
        prompt_tps: 0.0,
        generation_tps: 0.0,
        peak_memory_gb: 0.0,
        elapsed_seconds: 0.0,
    };
    let mut calls = 0;
    let value = super::generate_semantic_json_with_invalid_retry(|| {
        calls += 1;
        Ok::<_, &'static str>(if calls == 1 {
            GenerateJsonResponse {
                valid: false,
                errors: vec!["EOF while parsing JSON".to_string()],
                json: serde_json::Value::Null,
                raw_output: String::new(),
                repaired: false,
                metrics: metrics(),
            }
        } else {
            GenerateJsonResponse {
                valid: true,
                errors: Vec::new(),
                json: serde_json::json!({"objective": "ok"}),
                raw_output: "{\"objective\":\"ok\"}".to_string(),
                repaired: false,
                metrics: metrics(),
            }
        })
    })
    .unwrap();

    assert_eq!(calls, 2);
    assert_eq!(value["objective"], "ok");
}

#[test]
fn semantic_decision_auth_fallback_attempts_configured_fallback_beyond_401() {
    use local_first_subagents::RuntimeClientError;

    let registry = semantic_decision_auth_fallback_registry_with_fallback();
    let resolved = semantic_decision_auth_fallback_test_resolved("deepseek-v4-pro");

    for error in [
        RuntimeClientError::Status(403),
        RuntimeClientError::Status(429),
        RuntimeClientError::Status(500),
        RuntimeClientError::StreamEndedWithoutDone,
    ] {
        let fallback = super::semantic_decision_auth_fallback_from_registry(
            &error,
            Some(&resolved),
            &registry,
            |_| false,
        );
        assert_eq!(
            fallback.map(|role| role.model),
            Some("qwen3.5:4b".to_string()),
            "expected a fallback for {error:?}"
        );
    }
}

#[test]
fn semantic_decision_auth_fallback_stays_pending_without_configured_fallback() {
    use local_first_subagents::RuntimeClientError;

    let registry = semantic_decision_auth_fallback_registry_without_fallback();
    let resolved = semantic_decision_auth_fallback_test_resolved("deepseek-v4-pro");

    let fallback = super::semantic_decision_auth_fallback_from_registry(
        &RuntimeClientError::Status(500),
        Some(&resolved),
        &registry,
        |_| false,
    );
    assert!(fallback.is_none());
}

#[test]
fn privacy_guard_payload_disables_reasoning_and_requires_json_content() {
    let payload = super::privacy_guard_payload("qwen3.5:0.8b", "nessun segreto");

    assert_eq!(payload["reasoning_effort"], "none");
    assert_eq!(payload["response_format"]["type"], "json_object");
    assert_eq!(payload["messages"][1]["content"], "nessun segreto");
}

#[test]
fn privacy_guard_prompt_defines_contextual_credentials_without_keywords() {
    let payload = super::privacy_guard_payload("qwen3.5:4b", "testo");
    let system = payload["messages"][0]["content"].as_str().unwrap();

    assert!(system.contains("even when the word password is absent"));
    assert!(system.contains("La parola che uso per entrare"));
    assert!(system.contains("\"kind\":\"account_password\""));
}

#[test]
fn ollama_native_root_strips_v1() {
    assert_eq!(
        super::ollama_native_root("http://127.0.0.1:11434/v1"),
        "http://127.0.0.1:11434"
    );
    assert_eq!(
        super::ollama_native_root("http://127.0.0.1:11434/"),
        "http://127.0.0.1:11434"
    );
}

#[test]
fn plan_marker_round_trips() {
    let plan = vec![
        serde_json::json!({"id":"s1","title":"Alpha","status":"done","detail":"d1"}),
        serde_json::json!({"id":"s2","title":"Beta","status":"doing","detail":""}),
    ];
    let marker = format!("‹‹PLAN››{}‹‹/PLAN››", build_plan_markdown(None, &plan));
    let parsed = parse_plan_marker(&format!("prose {marker} more"));
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0]["id"], "s1");
    assert_eq!(plan_step_status(&parsed[0]), "done");
    assert_eq!(parsed[1]["title"], "Beta");
    assert_eq!(plan_step_status(&parsed[1]), "doing");
    assert_eq!(plan_done_count(&parsed), 1);
}

#[test]
fn plan_completion_requires_every_step_done() {
    let blocked = vec![
        serde_json::json!({"id":"s1","title":"Alpha","status":"done","detail":""}),
        serde_json::json!({"id":"s2","title":"Beta","status":"blocked","detail":"waiting"}),
    ];
    assert!(!plan_is_complete(&blocked));
    let reason = plan_incomplete_reason(&blocked).expect("blocked plan is incomplete");
    assert!(reason.contains("1/2"), "{reason}");
    assert!(reason.contains("blocked or unfinished step"), "{reason}");

    let complete = vec![
        serde_json::json!({"id":"s1","title":"Alpha","status":"done","detail":""}),
        serde_json::json!({"id":"s2","title":"Beta","status":"done","detail":""}),
    ];
    assert!(plan_is_complete(&complete));
    assert!(plan_incomplete_reason(&complete).is_none());
}

#[test]
fn step_advance_requires_a_target_and_normalizes_common_adapter_aliases() {
    assert!(super::plan_tool_sent("step_advance", "{}").is_err());
    let (goal, sent) = super::plan_tool_sent(
        "step_advance",
        r#"{"step_id":"s2","status":"completed","detail":"tests pass"}"#,
    )
    .unwrap();
    assert_eq!(goal, None, "step_advance never carries a goal");
    assert_eq!(sent[0]["id"], "s2");
    assert_eq!(sent[0]["status"], "done");
    assert_eq!(sent[0]["detail"], "tests pass");
    // update_plan accepts the optional goal alongside the steps.
    let (goal, sent) = super::plan_tool_sent(
        "update_plan",
        r#"{"goal":"Prenotare il treno","steps":[{"id":"s1","title":"Cerca","status":"doing","detail":""}]}"#,
    )
    .unwrap();
    assert_eq!(goal.as_deref(), Some("Prenotare il treno"));
    assert_eq!(sent.len(), 1);

    let (goal, sent) = super::plan_tool_sent(
        "update_plan",
        r#"{"goal":"null","steps":[{"id":"s1","title":"Cerca","status":"doing","detail":""}]}"#,
    )
    .unwrap();
    assert_eq!(
        goal, None,
        "string 'null' is a weak-model placeholder, not a replacement goal"
    );
    assert_eq!(sent.len(), 1);
}

#[test]
fn contextual_plan_goal_uses_the_canonical_objective() {
    let resolved = super::resolve_plan_goal_for_turn(
        Some("prova per il 30 stessa ora".to_string()),
        None,
        Some("Cerca opzioni di treno Milano-Roma per il 30 agosto 2026 verso le 8:00, leggi i risultati e riporta 3-5 opzioni utili con fonti, senza prenotare o comprare nulla.".to_string()),
    );

    assert_eq!(
        resolved.as_deref(),
        Some(
            "Cerca opzioni di treno Milano-Roma per il 30 agosto 2026 verso le 8:00, leggi i risultati e riporta 3-5 opzioni utili con fonti, senza prenotare o comprare nulla."
        )
    );

    let complete_user_goal = super::resolve_plan_goal_for_turn(
        Some("Analizza il refactor gateway e proponi i prossimi test".to_string()),
        None,
        Some("Router summary".to_string()),
    );
    assert_eq!(
        complete_user_goal.as_deref(),
        Some("Analizza il refactor gateway e proponi i prossimi test")
    );
}

#[test]
fn plan_stall_counts_no_progress_resumes_and_resets_on_progress() {
    // No progress (done-count unchanged across resumes) accumulates; the cap trips.
    let mut stall = 0;
    for _ in 0..MAX_PLAN_STALL_RESUMES {
        assert!(!plan_stall_exhausted(stall));
        stall = next_plan_stall(stall, 1, 1); // last_resume_done == current_done → no progress
    }
    assert!(plan_stall_exhausted(stall), "stall should trip at the cap");
    // Any progress (current_done > last_resume_done) resets the counter to 0.
    let reset = next_plan_stall(stall, 1, 2);
    assert_eq!(reset, 0);
    assert!(!plan_stall_exhausted(reset));
}

#[test]
fn plan_is_settled_when_every_step_done_or_blocked() {
    let running = vec![
        serde_json::json!({"id":"s1","title":"A","status":"done"}),
        serde_json::json!({"id":"s2","title":"B","status":"doing"}),
    ];
    assert!(
        !plan_is_settled(&running),
        "a runnable step keeps the plan unsettled"
    );

    let settled = vec![
        serde_json::json!({"id":"s1","title":"A","status":"done"}),
        serde_json::json!({"id":"s2","title":"B","status":"blocked"}),
    ];
    assert!(
        plan_is_settled(&settled),
        "done+blocked is terminal → settled"
    );
    // Distinct from complete: a settled-with-blocked plan is NOT complete.
    assert!(!plan_is_complete(&settled));

    assert!(!plan_is_settled(&[]), "an empty plan is not settled");
}

#[test]
fn block_stalled_step_blocks_the_first_runnable_and_records_why() {
    let mut plan = vec![
        serde_json::json!({"id":"s1","title":"Done","status":"done"}),
        serde_json::json!({"id":"s2","title":"Stuck","status":"doing"}),
        serde_json::json!({"id":"s3","title":"Later","status":"todo"}),
    ];
    let title = block_stalled_step(&mut plan).expect("a runnable step exists");
    assert_eq!(title, "Stuck");
    assert_eq!(plan_step_status(&plan[1]), "blocked");
    assert!(
        plan[1]["detail"]
            .as_str()
            .unwrap_or("")
            .contains("no progress")
    );
    // The done step and the later todo step are untouched (only the FIRST runnable blocks).
    assert_eq!(plan_step_status(&plan[0]), "done");
    assert_eq!(plan_step_status(&plan[2]), "todo");

    // Nothing runnable → None (already settled, nothing to block).
    let mut settled = vec![serde_json::json!({"id":"s1","title":"A","status":"done"})];
    assert!(block_stalled_step(&mut settled).is_none());
}

#[test]
fn answer_body_is_empty_detects_reasoning_only_completions() {
    // The "non produce la risposta" failure: a reasoning model spends its whole token
    // budget thinking, leaving only a ‹‹REASONING›› trace and no prose. The empty-answer
    // check now lives in `local_first_engine::markers` (5.D1c); exercise it through the
    // loop's entry point `should_force_synthesis_for_empty_visible_answer(accumulated, content)`
    // (with an empty accumulator == the old `answer_body_is_empty(content)`).
    let empty = |content: &str| super::should_force_synthesis_for_empty_visible_answer("", content);
    assert!(empty(""));
    assert!(empty("   \n  "));
    assert!(empty("‹‹REASONING››long chain of thought‹‹/REASONING››"));
    assert!(empty("‹‹PLAN››- [x] step‹‹/PLAN››"));
    assert!(super::should_force_synthesis_for_empty_visible_answer(
        "‹‹PLAN››- [x] **Step** (`s1`): done‹‹/PLAN››‹‹ARTIFACT››{\"name\":\"x.md\",\"size\":1,\"thread\":\"t\"}‹‹/ARTIFACT››",
        "‹‹REASONING››The final answer is hidden in reasoning.‹‹/REASONING››"
    ));
    // A real answer — with or without a reasoning trace above it — is NOT empty.
    assert!(!empty("Here is the answer."));
    assert!(!empty(
        "‹‹REASONING››thought‹‹/REASONING››\nHere is the answer."
    ));
    assert!(!super::should_force_synthesis_for_empty_visible_answer(
        "‹‹PLAN››- [x] **Step** (`s1`): done‹‹/PLAN››",
        "\nHere is the answer."
    ));
}

#[test]
fn merge_plan_keeps_blocked_steps_sticky() {
    // The harness blocked a stalled step (F4); the model must not re-open it by re-sending
    // it as todo/doing — that would re-arm the cross-turn loop.
    let mut plan =
        vec![serde_json::json!({"id":"s1","title":"Stuck","status":"blocked","detail":"paused"})];
    let claims = merge_plan(
        &mut plan,
        &[serde_json::json!({"id":"s1","title":"Stuck","status":"doing"})],
    );
    assert!(claims.is_empty());
    assert_eq!(
        plan_step_status(&plan[0]),
        "blocked",
        "blocked stays blocked"
    );
}

#[test]
fn merge_plan_allows_model_blocked_step_to_be_claimed_done_after_new_evidence() {
    let mut plan = vec![serde_json::json!({
        "id":"s1",
        "title":"Search source",
        "status":"blocked",
        "detail":"Site did not return results yet"
    })];
    let claims = merge_plan(
        &mut plan,
        &[serde_json::json!({
            "id":"s1",
            "title":"Search source",
            "status":"done",
            "detail":"Results read from the source"
        })],
    );
    assert_eq!(
        claims,
        vec![0],
        "done claim must go through F2 verification"
    );
    assert_eq!(plan_step_status(&plan[0]), "doing");
    assert_eq!(plan[0]["detail"], "Results read from the source");
}

#[test]
fn runtime_plan_memory_upserts_single_open_loop() {
    let _env = TestEnv::acquire();
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = super::gateway_memory_user_id();
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let plan = vec![
        serde_json::json!({"id":"s1","title":"Read docs","status":"done","detail":""}),
        serde_json::json!({"id":"s2","title":"Implement slice","status":"doing","detail":""}),
    ];

    let first = super::upsert_runtime_plan_memory(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        Some("thread-1"),
        &plan,
    )
    .unwrap()
    .expect("created");
    let updated_plan = vec![
        serde_json::json!({"id":"s1","title":"Read docs","status":"done","detail":""}),
        serde_json::json!({"id":"s2","title":"Implement slice","status":"done","detail":""}),
        serde_json::json!({"id":"s3","title":"Run tests","status":"doing","detail":""}),
    ];
    let second = super::upsert_runtime_plan_memory(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        Some("thread-1"),
        &updated_plan,
    )
    .unwrap()
    .expect("updated");

    assert_eq!(first, second, "runtime plan memory must update in place");
    let memories = facade.list_memories_for_ui(&user, &workspace).unwrap();
    let plan_memories: Vec<_> = memories
        .iter()
        .filter(|memory| {
            memory.metadata.get("source").and_then(|v| v.as_str()) == Some("runtime_plan")
        })
        .collect();
    assert_eq!(plan_memories.len(), 1);
    let memory = plan_memories[0];
    assert_eq!(memory.memory_type, "open_loop");
    assert_eq!(memory.status, local_first_memory::MemoryStatus::Confirmed);
    assert!(
        !super::active_open_loop_record(memory),
        "runtime plans must not leak through the generic open-loop briefing"
    );
    assert!(
        super::runtime_plan_memory_matches(memory, "thread-1"),
        "thread-scoped runtime-plan loader must still see the plan"
    );
    assert!(!super::runtime_plan_memory_matches(memory, "thread-2"));
    assert!(memory.text.contains("2/3 steps done"), "{}", memory.text);
    assert!(
        memory.text.contains("Next step: Run tests"),
        "{}",
        memory.text
    );
    assert_eq!(
        memory.metadata.get("thread_id").and_then(|v| v.as_str()),
        Some("thread-1")
    );
    assert_eq!(
        memory.metadata.get("next_step").and_then(|v| v.as_str()),
        Some("Run tests")
    );
}

#[test]
fn runtime_plan_memory_is_staled_when_complete() {
    let _env = TestEnv::acquire();
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = super::gateway_memory_user_id();
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let open = vec![
        serde_json::json!({"id":"s1","title":"Read docs","status":"done","detail":""}),
        serde_json::json!({"id":"s2","title":"Run tests","status":"doing","detail":""}),
    ];
    let complete = vec![
        serde_json::json!({"id":"s1","title":"Read docs","status":"done","detail":""}),
        serde_json::json!({"id":"s2","title":"Run tests","status":"done","detail":""}),
    ];

    let reference = super::upsert_runtime_plan_memory(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        Some("thread-2"),
        &open,
    )
    .unwrap()
    .expect("created");
    let completed = super::upsert_runtime_plan_memory(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        Some("thread-2"),
        &complete,
    )
    .unwrap()
    .expect("updated");

    assert_eq!(reference, completed);
    let memory = facade
        .list_memories_for_ui(&user, &workspace)
        .unwrap()
        .into_iter()
        .find(|memory| memory.reference == reference)
        .expect("plan memory");
    assert_eq!(memory.status, local_first_memory::MemoryStatus::Stale);
    assert_eq!(
        memory.metadata.get("status").and_then(|v| v.as_str()),
        Some("complete")
    );
    assert!(!super::active_open_loop_record(&memory));
}

#[test]
fn runtime_plan_memory_materializes_plan_step_graph() {
    let _env = TestEnv::acquire();
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = super::gateway_memory_user_id();
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let plan = vec![
        serde_json::json!({
            "id":"s1",
            "title":"Read docs",
            "status":"done",
            "detail":"",
            "done_criterion":"docs read"
        }),
        serde_json::json!({
            "id":"s2",
            "title":"Implement slice",
            "status":"doing",
            "detail":"",
            "depends_on":["s1"]
        }),
    ];

    let memory_ref = super::upsert_runtime_plan_memory(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        Some("thread-graph"),
        &plan,
    )
    .unwrap()
    .expect("created");

    let entities = facade.list_entities_for_ui(&user, &workspace).unwrap();
    let plan_entity = entities
        .iter()
        .find(|entity| entity.canonical_key == "runtime_plan:thread-graph")
        .expect("plan entity");
    assert_eq!(plan_entity.entity_type, "document");
    assert_eq!(
        plan_entity
            .metadata
            .get("kind")
            .and_then(|value| value.as_str()),
        Some("runtime_plan")
    );
    assert_eq!(
        plan_entity
            .metadata
            .get("done_count")
            .and_then(|value| value.as_u64()),
        Some(1)
    );

    let step_one = entities
        .iter()
        .find(|entity| entity.canonical_key == "runtime_plan:thread-graph:step:s1")
        .expect("step s1");
    let step_two = entities
        .iter()
        .find(|entity| entity.canonical_key == "runtime_plan:thread-graph:step:s2")
        .expect("step s2");
    assert_eq!(step_two.entity_type, "asset");
    assert_eq!(
        step_two
            .metadata
            .get("kind")
            .and_then(|value| value.as_str()),
        Some("runtime_plan_step"),
    );

    let relations = facade.list_relations_for_ui(&user, &workspace).unwrap();
    assert!(relations.iter().any(|relation| {
        relation.source_ref == memory_ref
            && relation.target_ref == plan_entity.reference
            && relation.relation_type == "describes"
    }));
    assert!(relations.iter().any(|relation| {
        relation.source_ref == plan_entity.reference
            && relation.target_ref == step_two.reference
            && relation.relation_type == "relates_to"
            && relation
                .metadata
                .get("kind")
                .and_then(|value| value.as_str())
                == Some("has_step")
    }));
    assert!(relations.iter().any(|relation| {
        relation.source_ref == step_two.reference
            && relation.target_ref == step_one.reference
            && relation.relation_type == "depends_on"
    }));
}

#[test]
fn runtime_plan_memory_projects_execution_plan_contract() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let plan = vec![
        serde_json::json!({
            "id":"s1",
            "title":"Read docs",
            "status":"done",
            "detail":"source docs",
            "done_criterion":"docs read"
        }),
        serde_json::json!({
            "id":"s2",
            "title":"Implement slice",
            "status":"doing",
            "detail":"code path",
            "depends_on":["s1"]
        }),
    ];

    let memory_ref = super::upsert_runtime_plan_memory(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        Some("thread-contract"),
        &plan,
    )
    .unwrap()
    .expect("created");

    let memory = facade
        .list_memories_for_ui(&user, &workspace)
        .unwrap()
        .into_iter()
        .find(|memory| memory.reference == memory_ref)
        .expect("plan memory");
    let execution_plan = memory
        .metadata
        .get("execution_plan")
        .expect("execution plan metadata");
    assert_eq!(
        execution_plan.get("route").and_then(|value| value.as_str()),
        Some("mixed_workflow"),
    );
    let steps = execution_plan
        .get("steps")
        .and_then(|value| value.as_array())
        .expect("execution plan steps");
    assert_eq!(steps.len(), 2);
    assert_eq!(
        steps[0].get("step_id").and_then(|value| value.as_str()),
        Some("s1"),
    );
    assert_eq!(
        steps[0].get("goal").and_then(|value| value.as_str()),
        Some("Read docs"),
    );
    assert_eq!(
        steps[1]
            .get("depends_on")
            .and_then(|value| value.as_array())
            .map(|items| items.len()),
        Some(1),
    );
}

#[test]
fn runtime_plan_step_outcome_writes_confirmed_fact_memory() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let step = serde_json::json!({
        "id": "s2",
        "title": "Run focused tests",
        "status": "done",
        "detail": "cargo test -p local-first-desktop-gateway runtime_plan_step_outcome",
        "done_criterion": "test passes",
    });
    let evidence = vec!["cargo test passed".to_string()];

    let first = super::record_runtime_plan_step_outcome(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        Some("thread-step"),
        &step,
        &evidence,
    )
    .unwrap();
    let second = super::record_runtime_plan_step_outcome(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        Some("thread-step"),
        &step,
        &["cargo test passed again".to_string()],
    )
    .unwrap();

    assert_eq!(
        first, second,
        "same runtime step outcome should update in place"
    );
    let memories = facade.list_memories_for_ui(&user, &workspace).unwrap();
    let outcomes: Vec<_> = memories
        .iter()
        .filter(|memory| {
            memory
                .metadata
                .get("source")
                .and_then(|value| value.as_str())
                == Some("runtime_plan_step")
        })
        .collect();
    assert_eq!(outcomes.len(), 1);
    let memory = outcomes[0];
    assert_eq!(memory.memory_type, "fact");
    assert_eq!(memory.status, local_first_memory::MemoryStatus::Confirmed);
    assert!(memory.text.contains("Run focused tests"), "{}", memory.text);
    assert_eq!(
        memory
            .metadata
            .get("thread_id")
            .and_then(|value| value.as_str()),
        Some("thread-step"),
    );
    assert_eq!(
        memory
            .metadata
            .get("step_id")
            .and_then(|value| value.as_str()),
        Some("s2"),
    );
    assert_eq!(
        memory
            .metadata
            .get("execution_plan_ref")
            .and_then(|value| value.as_str()),
        Some("runtime_plan:thread-step"),
    );
    assert_eq!(
        memory
            .metadata
            .get("evidence")
            .and_then(|value| value.as_array())
            .and_then(|items| items.first())
            .and_then(|value| value.as_str()),
        Some("cargo test passed again"),
    );
}

#[test]
fn subagent_task_outcome_writes_runtime_plan_step_fact() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let task = local_first_task_runtime::TaskRecord::new(
        "subtask-1",
        local_first_task_runtime::UserId::new("local-user"),
        local_first_task_runtime::WorkspaceId::new("local-workspace"),
        "subagent.ReviewAgent",
        "Review the draft",
        serde_json::json!({
            "goal": "Review the draft",
            "contract": "SubagentReview",
        }),
    );
    let outcome = super::TaskExecutionPresentation {
        pending_approval: None,
        summary: "Review complete".to_string(),
        checkpoint_payload: serde_json::json!({"raw": "hidden"}),
        checkpoint_redacted: serde_json::json!({
            "kind": "executor_completed",
            "tool": "subagent",
        }),
        chat_message: "Task completed.".to_string(),
        result_surfacing: super::TaskResultSurfacing::AppendToChat,
        surface: super::SurfaceKind::Logs,
        event_kind: "computer_executor_completed".to_string(),
        event_title: "Executor completed".to_string(),
        event_subtitle: "subagent produced structured output.".to_string(),
        event_payload: serde_json::json!({}),
        artifacts: vec![],
    };

    let reference = super::record_subagent_task_step_outcome_memory(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        Some("thread-subagent"),
        &task,
        &outcome,
    )
    .unwrap()
    .expect("subagent outcome fact");

    let memory = facade
        .list_memories_for_ui(&user, &workspace)
        .unwrap()
        .into_iter()
        .find(|memory| memory.reference == reference)
        .expect("outcome memory");
    assert_eq!(memory.memory_type, "fact");
    assert_eq!(memory.status, local_first_memory::MemoryStatus::Confirmed);
    assert_eq!(
        memory
            .metadata
            .get("source")
            .and_then(|value| value.as_str()),
        Some("runtime_plan_step"),
    );
    assert_eq!(
        memory
            .metadata
            .get("thread_id")
            .and_then(|value| value.as_str()),
        Some("thread-subagent"),
    );
    assert_eq!(
        memory
            .metadata
            .get("step_id")
            .and_then(|value| value.as_str()),
        Some("subtask-1"),
    );
    assert!(
        memory
            .metadata
            .get("evidence")
            .and_then(|value| value.as_array())
            .and_then(|items| items.first())
            .and_then(|value| value.as_str())
            .is_some_and(|value| value.contains("subagent_task")),
    );
}

#[test]
fn memory_block_labels_sections_and_includes_text() {
    let personal = vec!["Preferisce risposte concise in italiano".to_string()];
    let project = vec!["Repo principale: /Clients/Acme/app".to_string()];
    let block = format_memory_block(&[], &personal, &project, 1500).expect("block");
    assert!(block.contains("Personal:"));
    assert!(block.contains("risposte concise"));
    assert!(block.contains("Project:"));
    assert!(block.contains("/Clients/Acme/app"));
}

#[test]
fn memory_block_puts_open_loops_first() {
    let ol = vec!["Preventivo Rossi incompleto: manca assistenza".to_string()];
    let personal = vec!["Preferisce risposte in italiano".to_string()];
    let block = format_memory_block(&ol, &personal, &[], 1500).expect("block");
    assert!(block.contains("OPEN LOOPS"));
    assert!(block.contains("Preventivo Rossi"));
    assert!(
        block.find("OPEN LOOPS").unwrap() < block.find("Personal:").unwrap(),
        "open loops must come before personal"
    );
}

fn test_linked_briefing_hit(key: &str, text: &str) -> local_first_memory::RecallHit {
    local_first_memory::RecallHit {
        memory_ref: format!("memory:owner:personal:{key}"),
        text: text.to_string(),
        score: 1.0,
        kind: "preference".to_string(),
        source_user_id: local_first_memory::UserId::new("owner"),
        source_workspace_id: local_first_memory::WorkspaceId::new("personal"),
        source_label: "Personal".to_string(),
        collection: local_first_memory::MemoryCollectionKey::Preferences,
        grant_id: Some("grant-a".to_string()),
        policy_version: Some(3),
        source_revision: format!("sha256:{key}"),
        sensitivity: local_first_memory::DataSensitivity::Private,
        status: local_first_memory::MemoryStatus::Confirmed,
        updated_at: "unix:1.000000000".to_string(),
        subject_key: None,
        conflict: false,
        publication_link: None,
        graph_path: Vec::new(),
    }
}

#[test]
fn budgeted_briefing_attests_only_linked_items_that_enter_the_prompt() {
    let first_text = "First linked preference";
    let second_text = "Second linked preference that must not fit";
    let personal = vec![
        super::BriefingMemoryItem {
            text: first_text.to_string(),
            linked_hit: Some(test_linked_briefing_hit("first", first_text)),
        },
        super::BriefingMemoryItem {
            text: second_text.to_string(),
            linked_hit: Some(test_linked_briefing_hit("second", second_text)),
        },
    ];
    let budget = format!("- {first_text}\n").len();

    let formatted = super::format_memory_block_with_provenance(&[], &personal, &[], budget);

    assert!(
        formatted
            .block
            .as_deref()
            .is_some_and(|block| block.contains(first_text))
    );
    assert!(
        formatted
            .block
            .as_deref()
            .is_some_and(|block| !block.contains(second_text))
    );
    assert_eq!(formatted.linked_hits.len(), 1);
    assert!(formatted.linked_hits[0].memory_ref.ends_with(":first"));
}

/// ADR 0022 — Tappa 1: parità strutturale del briefing.
///
/// Verifica il wiring dell'invariant P1 (cross-chat = solo progetti):
/// `scope_from_active_workspace()` deve proiettare il workspace personale in
/// `MemoryScope::Personal`, e un workspace nominato in `Project(_)`. È il
/// punto in cui il gating del gateway (env/active workspace) incontra il
/// contratto del crate memoria. L'invariant che i blocchi `project_*` siano
/// `None` per Personal è codificato nei loro guard `PERSONAL_WORKSPACE`
/// (`main.rs:4755/4791/4817`) e validato dal test del crate memoria
/// `briefing_pack_personal_shape_is_well_formed_with_profile_only`.
#[test]
fn scope_from_active_workspace_projects_personal_and_project() {
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("local-user"));
    let workspace = TestMemoryWorkspace::set(super::PERSONAL_WORKSPACE);

    let personal = super::scope_from_active_workspace();
    assert!(
        matches!(personal, super::MemoryScope::Personal),
        "workspace personale deve proiettarsi in MemoryScope::Personal"
    );

    workspace.switch("proj-acme");
    let project = super::scope_from_active_workspace();
    match project {
        super::MemoryScope::Project(ws) => {
            assert_eq!(ws.as_str(), "proj-acme");
        }
        other => panic!("workspace nominato deve proiettarsi in Project(_), got {other:?}"),
    }
}

/// Embedding client mock per i test del service: ritorna vettore vuoto (recall
/// cade sul solo passaggio FTS — deterministico, no HTTP).
struct NoopEmbeddingClient;
impl local_first_memory::EmbeddingClient for NoopEmbeddingClient {
    fn embed<'a>(&'a self, _text: &'a str) -> local_first_memory::BoxFuture<'a, Vec<f32>> {
        Box::pin(async move { Vec::new() })
    }
}

/// LLM client mock per i test del service: ritorna None (learn skippa — no HTTP).
struct NoopLlmClient;
impl local_first_memory::LlmClient for NoopLlmClient {
    fn chat<'a>(
        &'a self,
        _system: &'a str,
        _user: &'a str,
    ) -> local_first_memory::BoxFuture<'a, Option<String>> {
        Box::pin(async move { None })
    }
}

/// AppState di test con una `MemoryFacade` in-memory passata in input e tutti
/// gli altri store in-memory/empty. `brief()` tocca SOLO `memory_facade` +
/// globali (workspace/user id), quindi i campi non-memoria sono popolati con
/// valori cheap/default. Rende possibile il test di parità runtime
/// service-vs-inline (DoD Tappa 1) senza costruire store reali su disco.
fn test_app_state_for_brief(memory_facade: super::MemoryFacade) -> super::AppState {
    let secret_dir = isolated_gateway_test_dir("brief-parity-secrets");
    let secret_store = local_first_secrets::EncryptedFileSecretStore::open(
        secret_dir.join("secrets.json"),
        local_first_secrets::DevelopmentSecretKeyProvider::new([0u8; 32]),
    )
    .expect("secret store");
    let browser_checkpoint_secret_store =
        local_first_desktop_gateway::browser_checkpoint::BrowserCheckpointSecretStore::open(
            secret_dir.join("browser-checkpoint-secrets.json"),
            [0u8; 32],
        )
        .expect("browser checkpoint secret store");
    super::AppState {
        http: reqwest::Client::new(),
        usage_store: std::sync::Arc::new(std::sync::Mutex::new(
            super::usage_store::UsageStore::open_in_memory().expect("usage store"),
        )),
        usage_recorder: std::sync::Arc::new(local_first_inference_usage::NoopUsageRecorder),
        usage_pricing: std::sync::Arc::new(std::sync::RwLock::new(
            super::usage_pricing::PricingSnapshot::default(),
        )),
        chat_store: std::sync::Arc::new(std::sync::Mutex::new(
            super::ChatStore::in_memory().expect("chat store"),
        )),
        task_store: std::sync::Arc::new(std::sync::Mutex::new(
            local_first_task_runtime::TaskStore::open_in_memory().expect("task store"),
        )),
        computer_store: std::sync::Arc::new(std::sync::Mutex::new(
            super::LocalComputerSessionStore::open_in_memory().expect("computer store"),
        )),
        browser_url_policies: std::sync::Arc::new(std::sync::Mutex::new(
            super::BrowserUrlPolicyStore::open_in_memory().expect("browser url policy store"),
        )),
        memory_facade: std::sync::Arc::new(memory_facade),
        memory_service: None,
        vault_store: std::sync::Arc::new(std::sync::Mutex::new(
            local_first_vault::SQLiteVaultStore::open_in_memory().expect("vault store"),
        )),
        vault_wrap_key: std::sync::Arc::new([7u8; 32]),
        pending_vault_proposals: std::sync::Arc::new(
            crate::privacy_guard::PendingVaultProposalStore::default(),
        ),
        capability_registry: std::sync::Arc::new(std::sync::Mutex::new(
            super::CapabilityRegistryStore::open_in_memory().expect("capability registry"),
        )),
        task_executor_status: std::sync::Arc::new(std::sync::Mutex::new(
            super::TaskExecutorStatus::new(false),
        )),
        task_executor_registry: super::ExecutionRuntime::default_registry(),
        browser_capability_client: std::sync::Arc::new(std::sync::Mutex::new(None)),
        browser_thread_sessions: std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )),
        hitl_resume_by_thread: std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )),
        payment_approvals: std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )),
        setup_computer: std::sync::Arc::new(
            crate::setup_computer::SetupComputerCoordinator::default(),
        ),
        secret_store: std::sync::Arc::new(secret_store),
        browser_checkpoint_secret_store: std::sync::Arc::new(browser_checkpoint_secret_store),
        auth_token: "test-token".into(),
        novnc_tickets: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        novnc_view_ticket: std::sync::Arc::new(std::sync::Mutex::new(None)),
        ws_registry: std::sync::Arc::new(super::ws_gateway::WsRegistry::new()),
        recovered_stores: std::sync::Arc::new(Vec::new()),
    }
}

/// Ricostruisce l'assemblaggio inline del briefing (la sequenza che vive in
/// `stream_chat_via_openai`, `main.rs:19610+`) chiamando le stesse funzioni del
/// gateway. Serve da riferimento per il test di parità: l'impl delegante di
/// `brief()` DEVE produrre gli stessi blocchi, nello stesso ordine.
fn inline_briefing_blocks(state: &super::AppState, _user_message: &str) -> Vec<Option<String>> {
    let intent = super::semantic_decision::MemoryIntent {
        use_current_thread: true,
        search_personal: true,
        search_project: true,
        vault_value_requested: false,
        standalone_choice_request: false,
        durable_memory_candidate: false,
    };
    let (memory_personal, memory_project) = super::gather_profile_memory_for_prompt(state, &intent);
    let memory_open_loops = if intent.search_personal || intent.search_project {
        super::gather_open_loops(state, 6)
    } else {
        Vec::new()
    };
    let profile_block = super::format_memory_block(
        &memory_open_loops,
        &memory_personal,
        &memory_project,
        super::CHAT_MEMORY_BUDGET_CHARS,
    );
    vec![
        profile_block,
        super::project_objective_block(state),
        super::project_brief_block(state),
        super::recent_work_block(state),
    ]
}

fn insert_briefing_memory(
    facade: &super::MemoryFacade,
    user: &local_first_memory::UserId,
    workspace: &local_first_memory::WorkspaceId,
    key: &str,
    memory_type: &str,
    text: &str,
) {
    facade
        .upsert_memory(&local_first_memory::MemoryRecord {
            reference: local_first_memory::MemoryRef::new(
                local_first_memory::MemoryRefKind::Memory,
                user.clone(),
                workspace.clone(),
                key,
            ),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            memory_type: memory_type.to_string(),
            text: text.to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            status: local_first_memory::MemoryStatus::Confirmed,
            privacy_domain: local_first_memory::PrivacyDomain::new("personal"),
            sensitivity: local_first_memory::DataSensitivity::Private,
            metadata: serde_json::json!({}),
            created_at: "unix:1.000000000".to_string(),
            updated_at: "unix:1.000000000".to_string(),
            last_seen_at: None,
            supersedes: Vec::new(),
            superseded_by: None,
            correction_of: None,
        })
        .unwrap();
}

fn insert_briefing_memory_with_sensitivity(
    facade: &super::MemoryFacade,
    user: &local_first_memory::UserId,
    workspace: &local_first_memory::WorkspaceId,
    key: &str,
    text: &str,
    sensitivity: local_first_memory::DataSensitivity,
) -> local_first_memory::MemoryRef {
    let reference = local_first_memory::MemoryRef::new(
        local_first_memory::MemoryRefKind::Memory,
        user.clone(),
        workspace.clone(),
        key,
    );
    facade
        .upsert_memory(&local_first_memory::MemoryRecord {
            reference: reference.clone(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            memory_type: "preference".to_string(),
            text: text.to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            status: local_first_memory::MemoryStatus::Confirmed,
            privacy_domain: local_first_memory::PrivacyDomain::new("personal"),
            sensitivity,
            metadata: serde_json::json!({}),
            created_at: "unix:1.000000000".to_string(),
            updated_at: "unix:1.000000000".to_string(),
            last_seen_at: None,
            supersedes: Vec::new(),
            superseded_by: None,
            correction_of: None,
        })
        .unwrap();
    reference
}

fn insert_preferences_grant(
    facade: &super::MemoryFacade,
    user: &local_first_memory::UserId,
    consumer: &local_first_memory::WorkspaceId,
    id: &str,
) {
    facade
        .upsert_memory_source_grant(&local_first_memory::MemorySourceGrant {
            id: id.to_string(),
            consumer_user_id: user.clone(),
            consumer_workspace_id: consumer.clone(),
            source_user_id: user.clone(),
            source_workspace_id: local_first_memory::WorkspaceId::new(super::PERSONAL_WORKSPACE),
            collections: [local_first_memory::MemoryCollectionKey::Preferences]
                .into_iter()
                .collect(),
            max_sensitivity: local_first_memory::DataSensitivity::Private,
            overrides: std::collections::HashMap::new(),
            expires_at: None,
            revoked_at: None,
            policy_version: 1,
            created_by: user.as_str().to_string(),
            created_at: "unix:1.000000000".to_string(),
            updated_at: "unix:1.000000000".to_string(),
        })
        .unwrap();
}

fn insert_test_source_grant(
    facade: &super::MemoryFacade,
    user: &local_first_memory::UserId,
    consumer: &local_first_memory::WorkspaceId,
    source: &local_first_memory::WorkspaceId,
    id: &str,
    collection: local_first_memory::MemoryCollectionKey,
) {
    facade
        .upsert_memory_source_grant(&local_first_memory::MemorySourceGrant {
            id: id.to_string(),
            consumer_user_id: user.clone(),
            consumer_workspace_id: consumer.clone(),
            source_user_id: user.clone(),
            source_workspace_id: source.clone(),
            collections: [collection].into_iter().collect(),
            max_sensitivity: local_first_memory::DataSensitivity::Private,
            overrides: std::collections::HashMap::new(),
            expires_at: None,
            revoked_at: None,
            policy_version: 1,
            created_by: user.as_str().to_string(),
            created_at: "unix:1.000000000".to_string(),
            updated_at: "unix:1.000000000".to_string(),
        })
        .unwrap();
}

fn gather_profile_memory_for_test_scope(
    state: &super::AppState,
    user: &local_first_memory::UserId,
    workspace: &local_first_memory::WorkspaceId,
    personal_preferences_only_override: bool,
    include_project: bool,
) -> (Vec<String>, Vec<String>) {
    let (personal, project) = super::gather_profile_memory_for_workspace_with_provenance(
        state,
        user,
        workspace,
        personal_preferences_only_override,
        include_project,
    );
    (
        personal.into_iter().map(|item| item.text).collect(),
        project.into_iter().map(|item| item.text).collect(),
    )
}

#[test]
fn project_briefing_requires_personal_preferences_grant() {
    use local_first_memory::MemoryRecallService as _;

    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("briefing-grant-user"));
    let _workspace = TestMemoryWorkspace::set("project-a");

    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("briefing-grant-user");
    let personal = local_first_memory::WorkspaceId::new(super::PERSONAL_WORKSPACE);
    let project = local_first_memory::WorkspaceId::new("project-a");
    insert_briefing_memory(
        &facade,
        &user,
        &personal,
        "pref",
        "preference",
        "Prefers Italian",
    );
    insert_briefing_memory(
        &facade,
        &user,
        &personal,
        "profile",
        "fact",
        "Lives in Rome",
    );
    let state = test_app_state_for_brief(facade);

    let (before, project_before) =
        gather_profile_memory_for_test_scope(&state, &user, &project, true, true);
    assert!(before.is_empty());
    assert!(project_before.is_empty());

    insert_briefing_memory(
        super::memory_facade(&state),
        &user,
        &project,
        "local-project-fact",
        "fact",
        "Project-local fact",
    );
    insert_preferences_grant(super::memory_facade(&state), &user, &project, "prefs-grant");
    let (after, _) = gather_profile_memory_for_test_scope(&state, &user, &project, true, true);
    assert_eq!(after, vec!["Prefers Italian".to_string()]);
    let (structured, structured_project) =
        super::gather_profile_memory_with_provenance(&state, true, true);
    let hit = structured[0]
        .linked_hit
        .as_ref()
        .expect("linked provenance");
    assert_eq!(hit.source_workspace_id, personal);
    assert_eq!(hit.grant_id.as_deref(), Some("prefs-grant"));
    assert_eq!(hit.policy_version, Some(1));
    assert_eq!(
        hit.memory_ref,
        "memory:local:briefing-grant-user:__personal__:pref"
    );
    assert!(hit.source_revision.starts_with("sha256:"));
    assert_eq!(structured_project.len(), 1);
    assert!(structured_project[0].linked_hit.is_none());

    let service = super::InProcessMemoryRecallService::new(
        state.clone(),
        std::sync::Arc::new(NoopEmbeddingClient),
        std::sync::Arc::new(NoopLlmClient),
    );
    let scope = local_first_memory::MemoryScope::Project(project.clone());
    let first = service.brief(&scope, "Review the project status");
    let cached = service.brief(&scope, "Review the project status");
    assert_eq!(first.linked_hits, cached.linked_hits);
    assert_eq!(cached.linked_hits.len(), 1);
}

#[test]
fn project_briefing_enforces_compiled_personal_source_policy() {
    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("briefing-policy-user"));
    let _workspace = TestMemoryWorkspace::set("project-a");

    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("briefing-policy-user");
    let project = local_first_memory::WorkspaceId::new("project-a");
    let personal = local_first_memory::WorkspaceId::new(super::PERSONAL_WORKSPACE);
    let denied_ref = insert_briefing_memory_with_sensitivity(
        &facade,
        &user,
        &personal,
        "denied-pref",
        "Never include this denied preference",
        local_first_memory::DataSensitivity::Public,
    );
    insert_briefing_memory_with_sensitivity(
        &facade,
        &user,
        &personal,
        "private-pref",
        "Never include this private preference",
        local_first_memory::DataSensitivity::Private,
    );
    facade
        .upsert_memory_source_grant(&local_first_memory::MemorySourceGrant {
            id: "strict-preferences".to_string(),
            consumer_user_id: user.clone(),
            consumer_workspace_id: project.clone(),
            source_user_id: user.clone(),
            source_workspace_id: personal.clone(),
            collections: [local_first_memory::MemoryCollectionKey::Preferences]
                .into_iter()
                .collect(),
            max_sensitivity: local_first_memory::DataSensitivity::Public,
            overrides: [(
                denied_ref,
                local_first_memory::MemoryGrantOverrideEffect::Deny,
            )]
            .into_iter()
            .collect(),
            expires_at: None,
            revoked_at: None,
            policy_version: 1,
            created_by: user.as_str().to_string(),
            created_at: "unix:1.000000000".to_string(),
            updated_at: "unix:1.000000000".to_string(),
        })
        .unwrap();
    let state = test_app_state_for_brief(facade);
    let (personal_items, _) =
        gather_profile_memory_for_test_scope(&state, &user, &project, true, true);
    assert!(personal_items.is_empty());
}

#[test]
fn project_briefing_does_not_promote_individual_allow_outside_preferences_collection() {
    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("briefing-allow-user"));
    let _workspace = TestMemoryWorkspace::set("project-a");
    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("briefing-allow-user");
    let project = local_first_memory::WorkspaceId::new("project-a");
    let personal = local_first_memory::WorkspaceId::new(super::PERSONAL_WORKSPACE);
    let preference_ref = insert_briefing_memory_with_sensitivity(
        &facade,
        &user,
        &personal,
        "allowed-pref",
        "Do not promote through individual allow",
        local_first_memory::DataSensitivity::Public,
    );
    facade
        .upsert_memory_source_grant(&local_first_memory::MemorySourceGrant {
            id: "knowledge-with-allow".to_string(),
            consumer_user_id: user.clone(),
            consumer_workspace_id: project.clone(),
            source_user_id: user.clone(),
            source_workspace_id: personal,
            collections: [local_first_memory::MemoryCollectionKey::Knowledge]
                .into_iter()
                .collect(),
            max_sensitivity: local_first_memory::DataSensitivity::Public,
            overrides: [(
                preference_ref,
                local_first_memory::MemoryGrantOverrideEffect::Allow,
            )]
            .into_iter()
            .collect(),
            expires_at: None,
            revoked_at: None,
            policy_version: 1,
            created_by: user.as_str().to_string(),
            created_at: "unix:1.000000000".to_string(),
            updated_at: "unix:1.000000000".to_string(),
        })
        .unwrap();
    let state = test_app_state_for_brief(facade);
    let (personal_items, _) =
        gather_profile_memory_for_test_scope(&state, &user, &project, true, true);
    assert!(personal_items.is_empty());
}

#[test]
fn revoking_grant_changes_briefing_fingerprint() {
    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("briefing-revoke-user"));
    let _workspace = TestMemoryWorkspace::set("project-a");

    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("briefing-revoke-user");
    let project = local_first_memory::WorkspaceId::new("project-a");
    insert_preferences_grant(&facade, &user, &project, "revoke-grant");
    let state = test_app_state_for_brief(facade);
    let before = super::memory_briefing_source_fingerprint(&state, &user, &project, 10);
    super::memory_facade(&state)
        .revoke_memory_source_grant(&user, &project, "revoke-grant", 11)
        .unwrap();
    let after = super::memory_briefing_source_fingerprint(&state, &user, &project, 11);
    assert_ne!(before, after);
}

#[test]
fn expiry_and_source_update_change_briefing_fingerprint() {
    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("briefing-expiry-user"));
    let _workspace = TestMemoryWorkspace::set("project-a");

    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("briefing-expiry-user");
    let project = local_first_memory::WorkspaceId::new("project-a");
    let personal = local_first_memory::WorkspaceId::new(super::PERSONAL_WORKSPACE);
    insert_briefing_memory(
        &facade,
        &user,
        &personal,
        "preference",
        "preference",
        "Prefers Italian",
    );
    facade
        .upsert_memory_source_grant(&local_first_memory::MemorySourceGrant {
            id: "expiring-grant".to_string(),
            consumer_user_id: user.clone(),
            consumer_workspace_id: project.clone(),
            source_user_id: user.clone(),
            source_workspace_id: personal.clone(),
            collections: [local_first_memory::MemoryCollectionKey::Preferences]
                .into_iter()
                .collect(),
            max_sensitivity: local_first_memory::DataSensitivity::Private,
            overrides: std::collections::HashMap::new(),
            expires_at: Some(20),
            revoked_at: None,
            policy_version: 1,
            created_by: user.as_str().to_string(),
            created_at: "unix:1.000000000".to_string(),
            updated_at: "unix:1.000000000".to_string(),
        })
        .unwrap();
    let state = test_app_state_for_brief(facade);
    let before_update = super::memory_briefing_source_fingerprint(&state, &user, &project, 10);
    insert_briefing_memory(
        super::memory_facade(&state),
        &user,
        &personal,
        "preference-2",
        "preference",
        "Prefers concise answers",
    );
    let after_update = super::memory_briefing_source_fingerprint(&state, &user, &project, 10);
    assert_ne!(before_update, after_update);
    let after_expiry = super::memory_briefing_source_fingerprint(&state, &user, &project, 20);
    assert_ne!(after_update, after_expiry);
}

#[test]
fn cached_briefing_is_rejected_when_grant_is_revoked_after_lookup() {
    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("briefing-toctou-user"));
    let _workspace = TestMemoryWorkspace::set("project-a");
    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("briefing-toctou-user");
    let project = local_first_memory::WorkspaceId::new("project-a");
    insert_preferences_grant(&facade, &user, &project, "toctou-grant");
    let state = test_app_state_for_brief(facade);
    let generation = super::memory_facade(&state).briefing_generation(&user, &project);
    let source_fingerprint = super::memory_briefing_source_fingerprint(
        &state,
        &user,
        &project,
        i64::try_from(super::now_epoch_secs()).unwrap_or(i64::MAX),
    );
    let prompt_fingerprint = local_first_memory::prompt_fingerprint("same prompt");
    let scope_key = "briefing-toctou-user|project-a|quality-review";
    local_first_memory::briefing_cache().put(
        scope_key.to_string(),
        local_first_memory::CachedBriefing {
            generation,
            source_fingerprint,
            prompt_fingerprint,
            pack_sans_recent_work: local_first_memory::BriefingPack {
                profile_block: Some("Personal:\n- must not leak".to_string()),
                objective: None,
                brief: None,
                recent_work: None,
                linked_hits: Vec::new(),
            },
        },
    );

    let cached = super::revalidated_cached_briefing(
        &state,
        &user,
        &project,
        scope_key,
        generation,
        source_fingerprint,
        prompt_fingerprint,
        || {
            super::memory_facade(&state)
                .revoke_memory_source_grant(&user, &project, "toctou-grant", 2)
                .unwrap();
        },
    );
    assert!(cached.is_none());
}

#[test]
fn contact_memory_deny_cannot_use_linked_sources() {
    let perimeter =
        |contact_only, can_see_contacts, can_use_project_memory| super::ContactMemoryPerimeter {
            contact_only,
            can_see_contacts,
            can_see_calendar: true,
            can_use_project_memory,
        };
    assert!(!super::memory_perimeter_allows_recall(
        &perimeter(false, true, false),
        true
    ));
    assert!(!super::memory_perimeter_allows_recall(
        &perimeter(true, true, true),
        true
    ));
    assert!(!super::memory_perimeter_allows_recall(
        &perimeter(false, false, true),
        true
    ));
    assert!(super::memory_perimeter_allows_recall(
        &perimeter(false, true, true),
        true
    ));
    assert!(super::memory_perimeter_allows_recall(
        &perimeter(false, true, false),
        false
    ));
}

#[tokio::test]
async fn memory_service_on_and_off_use_same_linked_source_coordinator() {
    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("memory-service-source-parity");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("recall-parity-user"))
        .set("HOMUN_MEMORY_SERVICE", Some("on"));
    let _workspace = TestMemoryWorkspace::set("project-a");

    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("recall-parity-user");
    let consumer = local_first_memory::WorkspaceId::new("project-a");
    let source = local_first_memory::WorkspaceId::new("project-b");
    insert_briefing_memory(
        &facade,
        &user,
        &source,
        "launch",
        "decision",
        "Launch in September",
    );
    insert_test_source_grant(
        &facade,
        &user,
        &consumer,
        &source,
        "decision-grant",
        local_first_memory::MemoryCollectionKey::Decisions,
    );
    let mut state = test_app_state_for_brief(facade);
    super::install_memory_service_if_enabled(
        &mut state,
        std::sync::Arc::new(NoopEmbeddingClient),
        std::sync::Arc::new(NoopLlmClient),
    );
    let service_pack = state
        .memory_service
        .as_ref()
        .expect("HOMUN_MEMORY_SERVICE=on installs the runtime service")
        .recall(
            "When do we launch?",
            &local_first_memory::MemoryScope::Project(consumer.clone()),
        )
        .await;
    let last_available_access = super::memory_facade(&state)
        .last_memory_source_access("decision-grant")
        .unwrap()
        .expect("available source is audited");
    std::fs::write(
        dir.join("workspaces.json"),
        serde_json::to_vec(&WorkspacesFile {
            active: "project-a".to_string(),
            workspaces: vec![memory_source_test_workspace("project-a", "Alpha")],
        })
        .unwrap(),
    )
    .unwrap();
    let removed_service_pack = state
        .memory_service
        .as_ref()
        .expect("runtime service remains installed")
        .recall(
            "When do we launch?",
            &local_first_memory::MemoryScope::Project(consumer.clone()),
        )
        .await;
    env.set("HOMUN_MEMORY_SERVICE", Some("off"));
    let mut inline_state = state.clone();
    super::install_memory_service_if_enabled(
        &mut inline_state,
        std::sync::Arc::new(NoopEmbeddingClient),
        std::sync::Arc::new(NoopLlmClient),
    );
    assert!(inline_state.memory_service.is_none());
    let inline_pack = super::recall_pack_on_facade(
        super::memory_facade(&inline_state),
        &user,
        &consumer,
        "When do we launch?",
        &[],
        None,
    );
    assert_eq!(removed_service_pack.block, inline_pack.block);
    assert_eq!(
        removed_service_pack
            .hits
            .iter()
            .map(|hit| hit.memory_ref.as_str())
            .collect::<Vec<_>>(),
        inline_pack
            .hits
            .iter()
            .map(|hit| hit.memory_ref.as_str())
            .collect::<Vec<_>>()
    );
    assert!(
        service_pack
            .block
            .as_deref()
            .is_some_and(|block| block.contains("Launch in September"))
    );
    assert!(removed_service_pack.hits.is_empty());
    assert!(
        removed_service_pack
            .degraded_sources
            .iter()
            .any(|(workspace, reason)| {
                workspace.as_str() == "project-b" && reason == "source_unavailable"
            })
    );
    assert_eq!(
        removed_service_pack.degraded_sources,
        inline_pack.degraded_sources
    );
    assert_eq!(
        super::memory_facade(&state)
            .last_memory_source_access("decision-grant")
            .unwrap()
            .expect("removed source must not write a fresh audit")
            .id,
        last_available_access.id
    );
}

#[test]
fn memory_service_flag_off_keeps_single_scope_recall() {
    let _flag = TestMemorySourcesFlag::set(Some("off"));
    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("single-scope-user");
    let consumer = local_first_memory::WorkspaceId::new("project-a");
    let source = local_first_memory::WorkspaceId::new("project-b");
    insert_briefing_memory(
        &facade,
        &user,
        &source,
        "launch",
        "decision",
        "Launch in September",
    );
    insert_test_source_grant(
        &facade,
        &user,
        &consumer,
        &source,
        "disabled-grant",
        local_first_memory::MemoryCollectionKey::Decisions,
    );
    let pack =
        super::recall_pack_on_facade(&facade, &user, &consumer, "When do we launch?", &[], None);
    assert!(pack.hits.is_empty());
    assert!(pack.block.is_none());
}

#[test]
fn recall_excludes_removed_project_sources_but_keeps_local_and_available_sources() {
    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("recall-removed-source");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);

    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("removed-source-user");
    let consumer = local_first_memory::WorkspaceId::new("project-a");
    let source = local_first_memory::WorkspaceId::new("project-b");
    insert_briefing_memory(
        &facade,
        &user,
        &consumer,
        "local-launch",
        "decision",
        "Local launch in September",
    );
    insert_briefing_memory(
        &facade,
        &user,
        &source,
        "removed-launch",
        "decision",
        "Removed project launch in June",
    );
    insert_test_source_grant(
        &facade,
        &user,
        &consumer,
        &source,
        "removed-source-grant",
        local_first_memory::MemoryCollectionKey::Decisions,
    );

    let available = super::recall_pack_on_facade(
        &facade,
        &user,
        &consumer,
        "What launch date did we decide?",
        &[],
        None,
    );
    assert!(
        available
            .hits
            .iter()
            .any(|hit| hit.text.contains("Local launch in September"))
    );
    assert!(
        available
            .hits
            .iter()
            .any(|hit| hit.text.contains("Removed project launch in June"))
    );

    std::fs::write(
        dir.join("workspaces.json"),
        serde_json::to_vec(&WorkspacesFile {
            active: "project-a".to_string(),
            workspaces: vec![memory_source_test_workspace("project-a", "Alpha")],
        })
        .unwrap(),
    )
    .unwrap();

    let removed = super::recall_pack_on_facade(
        &facade,
        &user,
        &consumer,
        "What launch date did we decide?",
        &[],
        None,
    );
    assert!(
        removed
            .hits
            .iter()
            .any(|hit| hit.text.contains("Local launch in September"))
    );
    assert!(
        !removed
            .hits
            .iter()
            .any(|hit| hit.text.contains("Removed project launch in June"))
    );
    assert!(
        !removed
            .block
            .as_deref()
            .is_some_and(|block| block.contains("Removed project launch in June"))
    );
    assert!(removed.degraded_sources.iter().any(|(workspace, reason)| {
        workspace.as_str() == "project-b" && reason == "source_unavailable"
    }));
}

#[test]
fn removed_source_is_degraded_before_intent_filter_without_an_access_event() {
    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("recall-removed-source-no-candidates");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);
    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("removed-source-empty-user");
    let consumer = local_first_memory::WorkspaceId::new("project-a");
    let source = local_first_memory::WorkspaceId::new("project-b");
    insert_test_source_grant(
        &facade,
        &user,
        &consumer,
        &source,
        "removed-source-empty-grant",
        local_first_memory::MemoryCollectionKey::Preferences,
    );
    std::fs::write(
        dir.join("workspaces.json"),
        serde_json::to_vec(&WorkspacesFile {
            active: "project-a".to_string(),
            workspaces: vec![memory_source_test_workspace("project-a", "Alpha")],
        })
        .unwrap(),
    )
    .unwrap();

    let pack = super::recall_pack_on_facade(
        &facade,
        &user,
        &consumer,
        "What launch date did we decide?",
        &[],
        None,
    );

    assert!(pack.hits.is_empty());
    assert!(pack.degraded_sources.iter().any(|(workspace, reason)| {
        workspace.as_str() == "project-b" && reason == "source_unavailable"
    }));
    assert!(
        facade
            .last_memory_source_access("removed-source-empty-grant")
            .unwrap()
            .is_none()
    );
}

#[test]
fn missing_workspace_registry_never_authorizes_the_default_project_source() {
    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let previous_workspace = std::env::var("HOMUN_WORKSPACE_ID").ok();
    // SAFETY: TestMemorySourcesFlag holds TEST_ENV_LOCK for this test.
    unsafe {
        std::env::set_var("HOMUN_WORKSPACE_ID", "project-b");
    }
    let dir = isolated_gateway_test_dir("recall-missing-workspace-registry");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("missing-registry-user");
    let consumer = local_first_memory::WorkspaceId::new("project-a");
    let source = local_first_memory::WorkspaceId::new("project-b");
    insert_briefing_memory(
        &facade,
        &user,
        &source,
        "default-source-record",
        "decision",
        "Default project source must not be recalled",
    );
    insert_test_source_grant(
        &facade,
        &user,
        &consumer,
        &source,
        "missing-registry-grant",
        local_first_memory::MemoryCollectionKey::Decisions,
    );

    let pack = super::recall_pack_on_facade(
        &facade,
        &user,
        &consumer,
        "What launch date did we decide?",
        &[],
        None,
    );

    assert!(pack.hits.is_empty());
    assert!(pack.degraded_sources.iter().any(|(workspace, reason)| {
        workspace.as_str() == "project-b" && reason == "source_unavailable"
    }));
    assert!(
        facade
            .last_memory_source_access("missing-registry-grant")
            .unwrap()
            .is_none()
    );
    // SAFETY: restore process-global test state before TestMemorySourcesFlag releases its lock.
    unsafe {
        match previous_workspace {
            Some(value) => std::env::set_var("HOMUN_WORKSPACE_ID", value),
            None => std::env::remove_var("HOMUN_WORKSPACE_ID"),
        }
    }
}

#[test]
fn memory_source_authorization_registry_requires_a_nonempty_parseable_file() {
    let dir = isolated_gateway_test_dir("memory-source-strict-registry");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    let path = dir.join("workspaces.json");

    assert!(super::load_persisted_memory_source_workspace_ids().is_none());
    std::fs::write(&path, "not json").unwrap();
    assert!(super::load_persisted_memory_source_workspace_ids().is_none());
    std::fs::write(
        &path,
        serde_json::to_vec(&WorkspacesFile {
            active: String::new(),
            workspaces: Vec::new(),
        })
        .unwrap(),
    )
    .unwrap();
    assert!(super::load_persisted_memory_source_workspace_ids().is_none());
    std::fs::write(
        &path,
        serde_json::to_vec(&WorkspacesFile {
            active: "project-a".to_string(),
            workspaces: vec![memory_source_test_workspace("project-b", "Beta")],
        })
        .unwrap(),
    )
    .unwrap();
    assert!(
        super::load_persisted_memory_source_workspace_ids()
            .is_some_and(|workspaces| workspaces.contains("project-b"))
    );
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(super::load_persisted_memory_source_workspace_ids().is_none());
}

#[test]
fn recall_memory_tool_uses_linked_sources_only_from_projects() {
    let _flag = TestMemorySourcesFlag::set(Some("on"));
    let dir = isolated_gateway_test_dir("recall-memory-tool-sources");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    write_memory_source_workspaces(&dir, false);
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("tool-source-user"));
    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("tool-source-user");
    let consumer = local_first_memory::WorkspaceId::new("project-a");
    let source = local_first_memory::WorkspaceId::new("project-b");
    insert_briefing_memory(
        &facade,
        &user,
        &source,
        "launch",
        "decision",
        "Launch in September",
    );
    insert_test_source_grant(
        &facade,
        &user,
        &consumer,
        &source,
        "tool-grant",
        local_first_memory::MemoryCollectionKey::Decisions,
    );
    let state = test_app_state_for_brief(facade);

    let workspace = TestMemoryWorkspace::set("project-a");
    let project = super::recall_memory(&state, "When do we launch?", false);
    assert!(project.response.contains("Launch in September"));
    let payload = super::recall_stream_payload_from_outcome(&project, "When do we launch?");
    let hit = payload
        .hits
        .first()
        .expect("linked source hit is surfaced to UI");
    assert_eq!(hit.source_workspace_id, "project-b");
    assert_eq!(hit.source_label, "Beta");
    assert_eq!(hit.collection, "decisions");
    assert_eq!(hit.grant_id.as_deref(), Some("tool-grant"));
    assert!(!hit.conflict);
    assert!(hit.score > 0.0);
    assert!(!hit.r#ref.is_empty());
    assert_eq!(hit.kind, "decision");
    workspace.switch(super::PERSONAL_WORKSPACE);
    let personal = super::recall_memory(&state, "When do we launch?", false);
    assert!(!personal.response.contains("Launch in September"));
}

#[test]
fn recall_memory_does_not_relabel_thread_episodes_as_local_hits() {
    let _flag = TestMemorySourcesFlag::set(Some("off"));
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("episode-bypass-user"));
    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("episode-bypass-user");
    super::store_episode(
        &facade,
        &user,
        "thread-episode-bypass",
        "NEBULA-7429 appeared in an older conversation",
        "project-a",
    );
    let state = test_app_state_for_brief(facade);
    let _workspace = TestMemoryWorkspace::set("project-a");

    let outcome = super::recall_memory(&state, "NEBULA-7429", false);

    assert!(!outcome.response.contains("older conversation"));
    assert!(!outcome.payload.hits.iter().any(|hit| {
        hit.kind == "conversation" && hit.grant_id.is_none() && hit.r#ref.is_empty()
    }));
}

/// ADR 0022 — Tappa 1: TEST DI PARITÀ RUNTIME (DoD).
///
/// Per entrambi gli scope (Personal e Project), il briefing prodotto dal
/// service (`InProcessMemoryRecallService::brief`) DEVE essere identico —
/// blocco per blocco, nello stesso ordine — all'assemblaggio inline del
/// gateway. Se questo fallisce, l'incapsulamento ha cambiato semantics: NON
/// si aggiusta il service, si investiga (kickoff, stop-and-ask).
#[test]
fn brief_via_service_matches_inline_assembly_personal_and_project() {
    let env = TestEnv::acquire();
    // Il metodo brief() viene dal trait MemoryRecallService: portiamolo in scope.
    use super::MemoryRecallService;
    // User id stabile per entrambi gli scope (le funzioni leggono la globale).
    env.set("HOMUN_USER_ID", Some("parity-user"));
    let workspace = TestMemoryWorkspace::set(super::PERSONAL_WORKSPACE);

    // Messaggio "normale" (non-breve): attiva sia il profile-memory completo
    // sia gli open-loops. È il caso in cui i due gating prompt-dipendenti
    // hanno effetto, quindi la parità è significativa.
    let message = "Qual è lo stato del preventivo Rossi e cosa resta da fare?";

    // --- Scope PERSONAL ---
    {
        let facade = super::MemoryFacade::new(
            local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
        );
        let state = test_app_state_for_brief(facade);
        workspace.switch(super::PERSONAL_WORKSPACE);
        let scope = super::scope_from_active_workspace();
        let service = super::InProcessMemoryRecallService::new(
            state.clone(),
            std::sync::Arc::new(NoopEmbeddingClient),
            std::sync::Arc::new(NoopLlmClient),
        );
        let service_blocks = service.brief(&scope, message).ordered_blocks();
        let inline_blocks = inline_briefing_blocks(&state, message);
        assert_eq!(
            service_blocks, inline_blocks,
            "PARITÀ PERSONAL: service.brief() deve produrre gli stessi blocchi dell'inline"
        );
        // Invariant P1: per Personal, i blocchi project_* sono None.
        assert!(
            service_blocks[1].is_none()
                && service_blocks[2].is_none()
                && service_blocks[3].is_none(),
            "Personal briefing deve avere shape snella (objective/brief/recent_work = None)"
        );
    }

    // --- Scope PROJECT ---
    {
        let facade = super::MemoryFacade::new(
            local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
        );
        let state = test_app_state_for_brief(facade);
        workspace.switch("proj-parity");
        let scope = super::scope_from_active_workspace();
        let service = super::InProcessMemoryRecallService::new(
            state.clone(),
            std::sync::Arc::new(NoopEmbeddingClient),
            std::sync::Arc::new(NoopLlmClient),
        );
        let service_blocks = service.brief(&scope, message).ordered_blocks();
        let inline_blocks = inline_briefing_blocks(&state, message);
        assert_eq!(
            service_blocks, inline_blocks,
            "PARITÀ PROJECT: service.brief() deve produrre gli stessi blocchi dell'inline"
        );
    }
}

/// ADR 0022 (Tappa 1.5) — la cache del briefing si invalida a ogni scrittura
/// memoria via generation counter. Test end-to-end: dopo una scrittura nello
/// scope, la generation del facade incrementa → il `brief()` successivo NON
/// serve la cache stale (cache miss → rebuild che riflette la nuova memoria).
#[test]
fn briefing_cache_invalidates_after_memory_write() {
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("invalidate-user"));

    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let user = local_first_memory::UserId::new("invalidate-user");
    let workspace = local_first_memory::WorkspaceId::new(super::PERSONAL_WORKSPACE);

    // Generation 0 (store vuoto, nessuna scrittura).
    let gen_before = facade.briefing_generation(&user, &workspace);
    assert_eq!(gen_before, 0, "generation parte da 0");

    // Una scrittura invalidante: upsert di un record (come fa learn).
    // `created_at`/`updated_at` sono ISO strings; il valore esatto non conta
    // per questo test (verifica solo la generation counter).
    let now = "2026-07-01T00:00:00Z".to_string();
    let record = local_first_memory::MemoryRecord {
        reference: local_first_memory::MemoryRef::generated(
            local_first_memory::MemoryRefKind::Memory,
            user.clone(),
            workspace.clone(),
        ),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        memory_type: "fact".to_string(),
        text: "L'utente usa una Moto Guzzi V7".to_string(),
        aliases: vec![],
        language_hints: vec![],
        confidence: 0.9,
        status: local_first_memory::MemoryStatus::Confirmed,
        privacy_domain: local_first_memory::PrivacyDomain::new("personal"),
        sensitivity: local_first_memory::DataSensitivity::Private,
        metadata: serde_json::json!({}),
        created_at: now.clone(),
        updated_at: now,
        last_seen_at: None,
        supersedes: vec![],
        superseded_by: None,
        correction_of: None,
    };
    facade.upsert_memory(&record).unwrap();

    // La generation DEVE essere incrementata dalla scrittura.
    let gen_after = facade.briefing_generation(&user, &workspace);
    assert!(
        gen_after > gen_before,
        "una scrittura deve incrementare la generation (invalida la cache)"
    );
}

/// Task 3 (Working Island Redesign): the `/api/memory/goals` payload — the one
/// the UI already reads for `projectGoalCount` — must also carry the objective
/// TEXT, so the island can show it without a second round-trip. Reuses
/// `project_objective_block` as-is (converge, don't duplicate) rather than
/// deriving the text a second way.
#[tokio::test]
async fn project_context_exposes_objective_from_goal_memory() {
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("objective-user"));

    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let state = test_app_state_for_brief(facade);
    let user = super::gateway_memory_user_id();
    let ws = super::MemoryWorkspaceId::new("proj-island");

    let lifecycle = super::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: ws.clone(),
        purpose: "add_goal".to_string(),
    };
    {
        let facade_guard = super::memory_facade(&state);
        let record = facade_guard
            .create_memory_candidate(super::MemoryCreateRequest {
                request: lifecycle.clone(),
                memory_type: "goal".to_string(),
                text: "Ship the island redesign".to_string(),
                aliases: Vec::new(),
                language_hints: Vec::new(),
                confidence: 1.0,
                privacy_domain: super::PrivacyDomain::new("work"),
                sensitivity: super::MemoryDataSensitivity::Internal,
                evidence_refs: Vec::new(),
                metadata: serde_json::json!({ "source": "test" }),
            })
            .expect("create goal candidate");
        facade_guard
            .confirm_memory(&lifecycle, &record.reference, "test setup")
            .expect("confirm goal");
    }

    // project_objective_block reads the per-turn MEMORY_WORKSPACE global, not the
    // handler's query param, so both must point at the same project scope. Set it
    // only now (after all the SQLite setup above) to keep the window where this
    // process-global is non-default as short as possible — MEMORY_WORKSPACE is
    // shared with every other test in this binary running concurrently.
    let _workspace = TestMemoryWorkspace::set("proj-island");

    // Direct unit assertion on the reused derivation function.
    let objective = super::project_objective_block(&state);
    assert_eq!(
        objective,
        Some(
            "🎯 PROJECT OBJECTIVE — this is the NORTH STAR. Every implementation, change, or \
document must SERVE this objective. Stay focused: if the request seems to \
drift, expand beyond the objective, or reintroduce something that goes against it, \
POINT IT OUT before proceeding. The objectives:\n- Ship the island redesign"
                .to_string()
        ),
        "project_objective_block must build the objective text from the confirmed goal memory"
    );

    // Wiring assertion: the same payload that carries the goal count must also
    // carry the `objective` field, populated from project_objective_block.
    let response = super::memory_goals_list(
        axum::extract::State(state.clone()),
        axum::extract::Query(super::GoalsListQuery {
            thread: None,
            workspace: Some("proj-island".to_string()),
        }),
    )
    .await
    .expect("goals payload")
    .0;
    assert_eq!(
        response["objective"],
        serde_json::Value::String(objective.expect("objective present")),
        "the goals payload must expose the objective text alongside the goal count"
    );
    assert_eq!(
        response["goals"].as_array().map(|a| a.len()),
        Some(1),
        "sanity: the goal memory is also counted as before (projectGoalCount source)"
    );
}

/// Regression guard for the scope-consistency bug: the objective in the
/// `/api/memory/goals` payload MUST describe the request's workspace, not whatever
/// project the process-global `MEMORY_WORKSPACE` (owned by the run-turn writer)
/// happens to point at. Set the global to project A, put a goal in project B, resolve
/// the request to B, and assert the payload shows B's objective — never A's.
#[tokio::test]
async fn project_context_objective_follows_request_workspace_not_global() {
    let env = TestEnv::acquire();
    env.set("HOMUN_USER_ID", Some("objective-scope-user"));

    let facade =
        super::MemoryFacade::new(local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap());
    let state = test_app_state_for_brief(facade);
    let user = super::gateway_memory_user_id();

    // Helper: create + confirm a goal memory in a given workspace.
    let seed_goal = |ws: &super::MemoryWorkspaceId, text: &str| {
        let lifecycle = super::MemoryLifecycleRequest {
            actor_id: "test".to_string(),
            user_id: user.clone(),
            workspace_id: ws.clone(),
            purpose: "add_goal".to_string(),
        };
        let facade_guard = super::memory_facade(&state);
        let record = facade_guard
            .create_memory_candidate(super::MemoryCreateRequest {
                request: lifecycle.clone(),
                memory_type: "goal".to_string(),
                text: text.to_string(),
                aliases: Vec::new(),
                language_hints: Vec::new(),
                confidence: 1.0,
                privacy_domain: super::PrivacyDomain::new("work"),
                sensitivity: super::MemoryDataSensitivity::Internal,
                evidence_refs: Vec::new(),
                metadata: serde_json::json!({ "source": "test" }),
            })
            .expect("create goal candidate");
        facade_guard
            .confirm_memory(&lifecycle, &record.reference, "test setup")
            .expect("confirm goal");
    };

    let ws_a = super::MemoryWorkspaceId::new("proj-alpha");
    let ws_b = super::MemoryWorkspaceId::new("proj-beta");
    seed_goal(&ws_a, "Alpha objective");
    seed_goal(&ws_b, "Beta objective");

    // The process-global scope points at project A — as a concurrent run-turn on a
    // DIFFERENT project would leave it. The GET must ignore it.
    let _workspace = TestMemoryWorkspace::set("proj-alpha");

    let response = super::memory_goals_list(
        axum::extract::State(state.clone()),
        axum::extract::Query(super::GoalsListQuery {
            thread: None,
            workspace: Some("proj-beta".to_string()),
        }),
    )
    .await
    .expect("goals payload")
    .0;

    let objective = response["objective"].as_str().expect("objective present");
    assert!(
        objective.contains("Beta objective"),
        "objective must reflect the request's workspace (B), got: {objective}"
    );
    assert!(
        !objective.contains("Alpha objective"),
        "objective must NOT leak the process-global workspace's goal (A), got: {objective}"
    );
    assert_eq!(
        response["workspace"].as_str(),
        Some("proj-beta"),
        "sanity: the payload's workspace is the request's, matching its objective"
    );
}

#[test]
fn status_wiki_projects_open_loops_with_refs_and_dedup() {
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let first = local_first_memory::MemoryRef::generated(
        local_first_memory::MemoryRefKind::Memory,
        user.clone(),
        workspace.clone(),
    );
    let duplicate = local_first_memory::MemoryRef::generated(
        local_first_memory::MemoryRefKind::Memory,
        user.clone(),
        workspace.clone(),
    );
    let second = local_first_memory::MemoryRef::generated(
        local_first_memory::MemoryRefKind::Memory,
        user,
        workspace,
    );
    let loops = vec![
        (
            first.clone(),
            "Preventivo Rossi incompleto: manca assistenza".to_string(),
        ),
        (
            duplicate.clone(),
            "Rossi: preventivo incompleto, manca assistenza".to_string(),
        ),
        (
            second.clone(),
            "Bug gateway browser ancora da verificare in app".to_string(),
        ),
    ];

    let (body, linked) = super::status_wiki_body_from_open_loops(&loops);

    assert!(body.contains("# Stato lavori"));
    assert!(body.contains("## Loop aperti"));
    assert!(body.contains(&first.to_string()) || body.contains(&duplicate.to_string()));
    assert!(body.contains(&second.to_string()));
    assert!(body.contains("Preventivo Rossi") || body.contains("Rossi: preventivo"));
    assert!(body.contains("Bug gateway browser"));
    assert_eq!(
        linked.len(),
        2,
        "paraphrased open loops should be collapsed in the page"
    );
    assert!(linked.contains(&second));
    assert!(linked.contains(&first) || linked.contains(&duplicate));
}

#[test]
fn status_wiki_has_empty_state_when_no_open_loops_exist() {
    let (body, linked) = super::status_wiki_body_from_open_loops(&[]);

    assert!(body.contains("Nessun loop aperto"));
    assert!(linked.is_empty());
}

#[test]
fn artifact_memory_upsert_creates_single_record_and_graph_entity() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let first = super::upsert_artifact_memory_record(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        "project",
        "thread-1",
        "report.pdf",
        "Artifact report.pdf (pdf) creato nel thread thread-1.".to_string(),
        serde_json::json!({
            "source": "artifact_runtime",
            "producer": "make_deck",
            "thread_slug": "thread-1",
            "name": "report.pdf",
            "artifact_type": "pdf",
            "size_bytes": 120,
        }),
    )
    .unwrap();
    let second = super::upsert_artifact_memory_record(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        "project",
        "thread-1",
        "report.pdf",
        "Artifact report.pdf (pdf) aggiornato nel thread thread-1.".to_string(),
        serde_json::json!({
            "source": "artifact_runtime",
            "producer": "make_deck",
            "thread_slug": "thread-1",
            "name": "report.pdf",
            "artifact_type": "pdf",
            "project_relative_path": "reports/report.pdf",
            "project_path": "/tmp/project/reports/report.pdf",
            "size_bytes": 456,
            "updated": true,
        }),
    )
    .unwrap();

    let memories = facade.list_memories_for_ui(&user, &workspace).unwrap();
    let artifacts: Vec<_> = memories
        .iter()
        .filter(|memory| memory.memory_type == "artifact")
        .collect();
    let entities = facade.list_entities_for_ui(&user, &workspace).unwrap();
    let relations = facade.list_relations_for_ui(&user, &workspace).unwrap();

    assert_eq!(first, second);
    assert_eq!(artifacts.len(), 1);
    assert_eq!(
        artifacts[0].status,
        local_first_memory::MemoryStatus::Confirmed
    );
    assert_eq!(artifacts[0].metadata["size_bytes"], serde_json::json!(456));
    assert!(
        entities
            .iter()
            .any(|entity| entity.entity_type == "artifact" && entity.name == "report.pdf")
    );
    assert!(
        entities
            .iter()
            .any(|entity| entity.entity_type == "project" && entity.name == "project")
    );
    assert!(
        entities
            .iter()
            .any(|entity| entity.entity_type == "tool" && entity.name == "make_deck")
    );
    assert!(
        entities
            .iter()
            .any(|entity| entity.entity_type == "file" && entity.name == "reports/report.pdf")
    );
    assert!(
        relations
            .iter()
            .any(|relation| relation.relation_type == "describes")
    );
    assert!(
        relations
            .iter()
            .any(|relation| relation.relation_type == "belongs_to_project")
    );
    assert!(
        relations
            .iter()
            .any(|relation| relation.relation_type == "produced")
    );
    assert!(
        relations
            .iter()
            .any(|relation| relation.relation_type == "relates_to")
    );
}

#[test]
fn artifact_memory_links_explicit_decision_affects_to_provenance_graph() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let decision = facade
        .create_memory_candidate(local_first_memory::MemoryCreateRequest {
            request: lifecycle.clone(),
            memory_type: "decision".to_string(),
            text: "Generate the report artifact because the review needs a durable deliverable."
                .to_string(),
            aliases: vec!["reports/report.pdf".to_string()],
            language_hints: Vec::new(),
            confidence: 1.0,
            privacy_domain: local_first_memory::PrivacyDomain::new("project"),
            sensitivity: local_first_memory::DataSensitivity::Internal,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({
                "source": "record_decision",
                "scope": "project",
                "decision": {
                    "rationale": "The review needs a durable deliverable.",
                    "alternatives": []
                },
                "affects_labels": ["reports/report.pdf"],
            }),
        })
        .unwrap();
    facade
        .confirm_memory(&lifecycle, &decision.reference, "decision recorded")
        .unwrap();

    let artifact_memory = super::upsert_artifact_memory_record(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        "project",
        "thread-1",
        "reports/report.pdf",
        "Artifact reports/report.pdf (pdf) creato nel progetto.".to_string(),
        serde_json::json!({
            "source": "artifact_runtime",
            "producer": "mcp_filesystem",
            "thread_slug": "thread-1",
            "name": "reports/report.pdf",
            "artifact_type": "pdf",
            "project_relative_path": "reports/report.pdf",
            "project_path": "/tmp/project/reports/report.pdf",
            "size_bytes": 456,
        }),
    )
    .unwrap();

    let relations = facade.list_relations_for_ui(&user, &workspace).unwrap();
    let artifact_entity = local_first_memory::MemoryRef::new(
        local_first_memory::MemoryRefKind::Entity,
        user.clone(),
        workspace.clone(),
        "artifact:thread-1:reports/report.pdf",
    );
    assert!(relations.iter().any(|relation| {
        relation.relation_type == "affects"
            && relation.source_ref == decision.reference
            && relation.target_ref == artifact_entity
            && relation.evidence.contains(&decision.reference)
            && relation.evidence.contains(&artifact_memory)
    }));
    assert!(relations.iter().any(|relation| {
        relation.relation_type == "derived_from"
            && relation.source_ref == artifact_entity
            && relation.target_ref == decision.reference
            && relation.metadata["evidence"] == serde_json::json!("decision_affects_label_or_ref")
    }));
}

#[test]
fn artifact_memory_links_only_explicit_metadata_source_refs() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let decision = facade
        .create_memory_candidate(local_first_memory::MemoryCreateRequest {
            request: lifecycle.clone(),
            memory_type: "decision".to_string(),
            text: "Use the generated data file because the workflow needs a checkpoint."
                .to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            privacy_domain: local_first_memory::PrivacyDomain::new("project"),
            sensitivity: local_first_memory::DataSensitivity::Internal,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({
                "source": "record_decision",
                "scope": "project",
                "decision": {
                    "rationale": "The workflow needs a checkpoint.",
                    "alternatives": []
                }
            }),
        })
        .unwrap();
    facade
        .confirm_memory(&lifecycle, &decision.reference, "decision recorded")
        .unwrap();

    super::upsert_artifact_memory_record(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        "project",
        "thread-2",
        "data/checkpoint.json",
        "Artifact data/checkpoint.json (data) creato nel progetto.".to_string(),
        serde_json::json!({
            "source": "artifact_runtime",
            "producer": "workflow",
            "thread_slug": "thread-2",
            "name": "data/checkpoint.json",
            "artifact_type": "data",
            "project_relative_path": "data/checkpoint.json",
            "source_memory_refs": [decision.reference.to_string()],
            "size_bytes": 42,
        }),
    )
    .unwrap();

    let relations = facade.list_relations_for_ui(&user, &workspace).unwrap();
    assert!(relations.iter().any(|relation| {
        relation.relation_type == "affects"
            && relation.source_ref == decision.reference
            && relation.metadata["evidence"] == serde_json::json!("decision_affects_label_or_ref")
    }));
    assert!(relations.iter().any(|relation| {
        relation.relation_type == "derived_from"
            && relation.target_ref == decision.reference
            && relation.metadata["evidence"] == serde_json::json!("decision_affects_label_or_ref")
    }));
    assert!(!relations.iter().any(|relation| {
        relation.relation_type == "derived_from"
            && relation.target_ref == decision.reference
            && relation.metadata["evidence"] == serde_json::json!("explicit_metadata_ref")
    }));
}

#[test]
fn mcp_filesystem_artifact_detection_accepts_namespaced_provider() {
    let root = std::env::temp_dir().join(format!(
        "homun-artifact-memory-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("artifact-memory-gate.md");
    std::fs::write(&path, "test memoria artifact").unwrap();
    let args = serde_json::json!({
        "path": path.to_string_lossy().to_string(),
        "content": "test memoria artifact",
    });

    let detected = super::mcp_filesystem_project_relative_path_for_root(
        &root,
        "mcp:filesystem",
        "create",
        &args,
    );

    assert_eq!(detected.as_deref(), Some("artifact-memory-gate.md"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn artifact_memory_delete_path_is_jail_scoped() {
    let root = std::env::temp_dir().join(format!(
        "homun-artifact-delete-root-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let managed = std::env::temp_dir().join(format!(
        "homun-artifact-delete-managed-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::create_dir_all(&managed).unwrap();
    let project_file = root.join("sub").join("artifact.md");
    let managed_file = managed.join("artifact.md");
    let outside = std::env::temp_dir().join(format!(
        "homun-artifact-delete-outside-{}.md",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&project_file, "x").unwrap();
    std::fs::write(&managed_file, "x").unwrap();
    std::fs::write(&outside, "x").unwrap();

    assert!(super::artifact_memory_delete_path_allowed(
        Some(&root),
        &managed,
        &project_file
    ));
    assert!(super::artifact_memory_delete_path_allowed(
        Some(&root),
        &managed,
        &managed_file
    ));
    assert!(!super::artifact_memory_delete_path_allowed(
        Some(&root),
        &managed,
        &outside
    ));
    assert!(!super::artifact_memory_delete_path_allowed(
        None, &managed, &outside
    ));

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&managed);
    let _ = std::fs::remove_file(&outside);
}

#[test]
fn artifact_zip_entry_names_are_safe_and_unique() {
    let mut used = std::collections::HashSet::new();
    let first = super::artifact_unique_zip_entry_name(&mut used, "memory:test/homun", "../note.md");
    let second =
        super::artifact_unique_zip_entry_name(&mut used, "memory:test/homun", "../note.md");
    let weird = super::artifact_unique_zip_entry_name(&mut used, "../../", "résumé?.md");

    assert_eq!(first, "memory-test-homun/note.md");
    assert_eq!(second, "memory-test-homun/note-2.md");
    assert!(!weird.contains(".."));
    assert!(weird.starts_with("artifacts/"));
}

#[test]
fn managed_artifact_export_rejects_path_escape() {
    let request = super::ExportArtifactFileRequest {
        thread: "thread".to_string(),
        name: "../secret.txt".to_string(),
        source: Some("managed".to_string()),
        reference: None,
    };
    assert!(super::validate_managed_artifact_request(&request).is_err());
}

#[test]
fn open_loop_dedup_supersedes_duplicate_records() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    for text in [
        "Preventivo Rossi incompleto: manca assistenza",
        "Rossi: preventivo incompleto, manca assistenza",
        "Bug gateway browser ancora da verificare in app",
    ] {
        let record = facade
            .create_memory_candidate(local_first_memory::MemoryCreateRequest {
                request: lifecycle.clone(),
                memory_type: "open_loop".to_string(),
                text: text.to_string(),
                aliases: Vec::new(),
                language_hints: Vec::new(),
                confidence: 1.0,
                privacy_domain: local_first_memory::PrivacyDomain::new("work"),
                sensitivity: local_first_memory::DataSensitivity::Internal,
                evidence_refs: Vec::new(),
                metadata: serde_json::json!({ "source": "test" }),
            })
            .unwrap();
        facade
            .confirm_memory(&lifecycle, &record.reference, "test")
            .unwrap();
    }

    let merged = super::deduplicate_open_loops(&facade, &user, &workspace);
    let memories = facade.list_memories_for_ui(&user, &workspace).unwrap();
    let active = memories
        .iter()
        .filter(|memory| super::active_open_loop_record(memory))
        .count();
    let superseded = memories
        .iter()
        .filter(|memory| memory.memory_type == "open_loop" && memory.superseded_by.is_some())
        .count();

    assert_eq!(merged, 1);
    assert_eq!(active, 2);
    assert_eq!(superseded, 1);
}

#[test]
fn open_loop_closure_marks_matching_loop_stale_only_with_overlap() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    for text in [
        "Preventivo Rossi incompleto: manca assistenza",
        "Bug gateway browser ancora da verificare in app",
    ] {
        let record = facade
            .create_memory_candidate(local_first_memory::MemoryCreateRequest {
                request: lifecycle.clone(),
                memory_type: "open_loop".to_string(),
                text: text.to_string(),
                aliases: Vec::new(),
                language_hints: Vec::new(),
                confidence: 1.0,
                privacy_domain: local_first_memory::PrivacyDomain::new("work"),
                sensitivity: local_first_memory::DataSensitivity::Internal,
                evidence_refs: Vec::new(),
                metadata: serde_json::json!({ "source": "test" }),
            })
            .unwrap();
        facade
            .confirm_memory(&lifecycle, &record.reference, "test")
            .unwrap();
    }

    let closed_none = super::close_matching_open_loops(
        &facade,
        &user,
        &workspace,
        &["Tema non correlato".to_string()],
    );
    let closed = super::close_matching_open_loops(
        &facade,
        &user,
        &workspace,
        &["Preventivo Rossi assistenza completato".to_string()],
    );
    let memories = facade.list_memories_for_ui(&user, &workspace).unwrap();
    let active = memories
        .iter()
        .filter(|memory| super::active_open_loop_record(memory))
        .count();
    let stale = memories
        .iter()
        .filter(|memory| {
            memory.memory_type == "open_loop"
                && memory.status == local_first_memory::MemoryStatus::Stale
        })
        .count();

    assert_eq!(closed_none, 0);
    assert_eq!(closed, 1);
    assert_eq!(active, 1);
    assert_eq!(stale, 1);
}

#[test]
fn memory_block_respects_budget_and_marks_truncation() {
    let many: Vec<String> = (0..200)
        .map(|i| format!("fatto numero {i} con testo abbastanza lungo da occupare spazio"))
        .collect();
    let block = format_memory_block(&[], &many, &[], 300).expect("block");
    assert!(
        block.len() < 600,
        "block should be bounded, got {}",
        block.len()
    );
    assert!(block.contains("more available in memory"));
}

#[test]
fn memory_intent_drives_injection_without_prompt_keywords() {
    let mut intent = super::semantic_decision::MemoryIntent::safe_default();
    assert_eq!(
        super::memory_injection_policy(&intent),
        super::MemoryInjectionPolicy {
            include_current_thread: true,
            include_cross_thread: false,
        }
    );
    intent.search_project = true;
    assert!(super::memory_injection_policy(&intent).include_cross_thread);
}

#[test]
fn memory_recall_requires_validated_cross_thread_or_vault_intent() {
    let mut intent = super::semantic_decision::MemoryIntent::safe_default();
    assert!(!super::memory_intent_allows_recall(&intent));

    intent.search_personal = true;
    assert!(super::memory_intent_allows_recall(&intent));

    intent.search_personal = false;
    intent.search_project = true;
    assert!(super::memory_intent_allows_recall(&intent));

    intent.search_project = false;
    intent.vault_value_requested = true;
    assert!(super::memory_intent_allows_recall(&intent));
}

#[test]
fn memory_intent_standalone_choice_suppresses_unrelated_global_context() {
    let mut intent = super::semantic_decision::MemoryIntent::safe_default();
    intent.search_personal = true;
    intent.search_project = true;
    intent.standalone_choice_request = true;

    let policy = super::memory_injection_policy(&intent);
    assert!(policy.include_current_thread);
    assert!(!policy.include_cross_thread);
}

#[test]
fn auto_confirm_promotes_private_personal_facts_but_gates_pii() {
    // The "la mia moto" fix (C'): the extractor tags ordinary personal facts and
    // possessions as `private`, so the auto-confirm ceiling MUST be Private. An
    // `Internal` cap froze EVERY personal fact at `candidate`, invisible to the
    // always-on profile (which is confirmed-only).
    assert!(memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Private,
        0.9
    ));
    assert!(memory_auto_confirmable(
        "preference",
        MemoryDataSensitivity::Private,
        0.95
    ));
    assert!(memory_auto_confirmable(
        "decision",
        MemoryDataSensitivity::Private,
        0.85
    ));
    assert!(memory_auto_confirmable(
        "goal",
        MemoryDataSensitivity::Private,
        0.9
    ));
    // Less sensitive levels still auto-confirm.
    assert!(memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Internal,
        0.9
    ));
    assert!(memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Public,
        0.9
    ));
    // Real PII (codice fiscale, health, addresses) stays a candidate to confirm.
    assert!(!memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Confidential,
        0.99
    ));
    assert!(!memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Secret,
        0.99
    ));
    // Low confidence never auto-confirms.
    assert!(!memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Private,
        0.5
    ));
    // Only durable knowledge types auto-confirm — not raw topics/entities.
    assert!(!memory_auto_confirmable(
        "topic",
        MemoryDataSensitivity::Private,
        0.95
    ));
    assert!(!memory_auto_confirmable(
        "entity",
        MemoryDataSensitivity::Private,
        0.95
    ));
}

#[test]
fn owner_channel_match_accepts_configured_approval_identity() {
    let prefs = super::UserPrefs {
        approval_channel: Some("telegram".to_string()),
        approval_target: Some("8205578468".to_string()),
        ..Default::default()
    };

    assert!(super::channel_message_is_from_owner(
        &prefs,
        "telegram",
        "8205578468",
        None,
        None
    ));
    assert!(super::channel_message_is_from_owner(
        &prefs,
        "telegram",
        "different",
        Some("8205578468"),
        None
    ));
    assert!(!super::channel_message_is_from_owner(
        &prefs,
        "whatsapp",
        "8205578468",
        None,
        None
    ));
    assert!(!super::channel_message_is_from_owner(
        &prefs, "telegram", "123", None, None
    ));
}

#[test]
fn profile_wiki_excludes_candidate_memories() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("__personal__-profile-test");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let confirmed = facade
        .create_memory_candidate(local_first_memory::MemoryCreateRequest {
            request: lifecycle.clone(),
            memory_type: "fact".to_string(),
            text: "Fabio vive a Pomigliano d'Arco.".to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 0.95,
            privacy_domain: local_first_memory::PrivacyDomain::new("personal"),
            sensitivity: local_first_memory::DataSensitivity::Private,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({ "scope": "personal" }),
        })
        .unwrap();
    facade
        .confirm_memory(&lifecycle, &confirmed.reference, "test confirmed")
        .unwrap();
    facade
        .create_memory_candidate(local_first_memory::MemoryCreateRequest {
            request: lifecycle.clone(),
            memory_type: "fact".to_string(),
            text: "Fabio forse sta valutando una moto non confermata.".to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 0.4,
            privacy_domain: local_first_memory::PrivacyDomain::new("personal"),
            sensitivity: local_first_memory::DataSensitivity::Private,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({ "scope": "personal" }),
        })
        .unwrap();

    super::rebuild_profile_wiki(&facade, &user, &workspace);

    let page = facade
        .list_wiki_pages_for_ui(&user, &workspace)
        .unwrap()
        .into_iter()
        .find(|page| page.path == "profilo.md")
        .expect("profile page");
    assert!(page.body.contains("Fabio vive a Pomigliano"));
    assert!(!page.body.contains("forse sta valutando"));
    assert_eq!(page.linked_refs, vec![confirmed.reference]);
}

#[test]
fn workspace_root_entity_keeps_stable_key_and_aliases_across_updates() {
    let _env = TestEnv::acquire();
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let workspace = super::WorkspaceRecord {
        id: "workspace_test".to_string(),
        name: "Homun".to_string(),
        folder: Some("/Users/fabio/Projects/Homun/app".to_string()),
        sandbox_mode: None,
        approval_policy: None,
        writable_roots: None,
        skill_confirmations: None,
    };

    super::upsert_workspace_root_memory_entity(&facade, &workspace).unwrap();
    super::upsert_workspace_root_memory_entity(
        &facade,
        &super::WorkspaceRecord {
            id: workspace.id.clone(),
            name: "Homun App".to_string(),
            folder: Some("/Users/fabio/Projects/Homun".to_string()),
            sandbox_mode: None,
            approval_policy: None,
            writable_roots: None,
            skill_confirmations: None,
        },
    )
    .unwrap();

    let user = super::gateway_memory_user_id();
    let workspace_scope = local_first_memory::WorkspaceId::new("workspace_test");
    let entities = facade
        .list_entities_for_ui(&user, &workspace_scope)
        .unwrap();
    let roots: Vec<_> = entities
        .iter()
        .filter(|entity| entity.canonical_key == "workspace:workspace_test")
        .collect();
    assert_eq!(roots.len(), 1);
    let root = roots[0];
    assert_eq!(root.name, "Homun App");
    assert!(root.aliases.iter().any(|alias| alias == "Homun"));
    assert!(root.aliases.iter().any(|alias| alias == "Homun App"));
    assert!(root.aliases.iter().any(|alias| alias == "app"));
    assert!(
        root.aliases
            .iter()
            .any(|alias| alias == "/Users/fabio/Projects/Homun")
    );
}

#[test]
fn base_workspace_never_creates_a_legacy_memory_scope_root() {
    let _env = TestEnv::acquire();
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let base_workspace = super::base_workspace_id();
    let workspace = super::WorkspaceRecord {
        id: base_workspace.clone(),
        name: "Predefinito".to_string(),
        folder: None,
        sandbox_mode: None,
        approval_policy: None,
        writable_roots: None,
        skill_confirmations: None,
    };

    super::upsert_workspace_root_memory_entity(&facade, &workspace).unwrap();

    let user = super::gateway_memory_user_id();
    assert!(
        facade
            .list_entities_for_ui(&user, &local_first_memory::WorkspaceId::new(base_workspace))
            .unwrap()
            .is_empty()
    );
    assert!(
        facade
            .list_entities_for_ui(
                &user,
                &local_first_memory::WorkspaceId::new(local_first_memory::PERSONAL_WORKSPACE)
            )
            .unwrap()
            .is_empty()
    );
}

#[test]
fn project_scope_demotes_extracted_project_entities_that_are_not_workspace_root() {
    let ws = local_first_memory::WorkspaceId::new("workspace_homun");
    let entities = super::normalize_project_scope_entities(
        &ws,
        vec![
            local_first_memory::ExtractedEntity {
                entity_type: "project".to_string(),
                name: "Homun".to_string(),
                canonical_key: "project:homun".to_string(),
                aliases: vec!["homun".to_string()],
                privacy_domain: local_first_memory::PrivacyDomain::new("work"),
                sensitivity: local_first_memory::DataSensitivity::Private,
                metadata: serde_json::json!({ "scope": "project" }),
            },
            local_first_memory::ExtractedEntity {
                entity_type: "project".to_string(),
                name: "Workspace Root".to_string(),
                canonical_key: "workspace:workspace_homun".to_string(),
                aliases: Vec::new(),
                privacy_domain: local_first_memory::PrivacyDomain::new("work"),
                sensitivity: local_first_memory::DataSensitivity::Private,
                metadata: serde_json::json!({ "scope": "project" }),
            },
        ],
    );

    assert_eq!(entities[0].entity_type, "topic");
    assert_eq!(entities[0].canonical_key, "topic:homun");
    assert_eq!(entities[1].entity_type, "project");
    assert_eq!(entities[1].canonical_key, "workspace:workspace_homun");
}

#[test]
fn extracted_project_graph_stays_in_project_scope_with_evidence_and_deduplicates() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let personal = local_first_memory::WorkspaceId::new(local_first_memory::PERSONAL_WORKSPACE);
    let project = local_first_memory::WorkspaceId::new("workspace_homun");
    let evidence = local_first_memory::MemoryRef::generated(
        local_first_memory::MemoryRefKind::Event,
        user.clone(),
        project.clone(),
    );
    facade
        .record_event(&local_first_memory::MemoryEvent {
            reference: evidence.clone(),
            user_id: user.clone(),
            workspace_id: project.clone(),
            timestamp: "2026-07-21T00:00:00Z".to_string(),
            source: "test".to_string(),
            event_type: "admission".to_string(),
            payload: serde_json::json!({"bounded": true}),
            privacy_domain: local_first_memory::PrivacyDomain::new("work"),
            sensitivity: local_first_memory::DataSensitivity::Internal,
        })
        .unwrap();
    let entities = vec![
        local_first_memory::ExtractedEntity {
            entity_type: "tool".to_string(),
            name: "Rust".to_string(),
            canonical_key: "tool:rust".to_string(),
            aliases: Vec::new(),
            privacy_domain: local_first_memory::PrivacyDomain::new("work"),
            sensitivity: local_first_memory::DataSensitivity::Internal,
            metadata: serde_json::json!({"scope":"project"}),
        },
        local_first_memory::ExtractedEntity {
            entity_type: "topic".to_string(),
            name: "Memory engine".to_string(),
            canonical_key: "topic:memory-engine".to_string(),
            aliases: Vec::new(),
            privacy_domain: local_first_memory::PrivacyDomain::new("work"),
            sensitivity: local_first_memory::DataSensitivity::Internal,
            metadata: serde_json::json!({"scope":"project"}),
        },
    ];
    let relations = vec![local_first_memory::ExtractedRelation {
        source_ref: "tool:rust".to_string(),
        relation_type: "relates_to".to_string(),
        target_ref: "topic:memory-engine".to_string(),
        confidence: 0.9,
        privacy_domain: local_first_memory::PrivacyDomain::new("work"),
        sensitivity: local_first_memory::DataSensitivity::Internal,
        evidence_refs: vec![evidence.to_string()],
        metadata: serde_json::json!({"scope":"project"}),
    }];

    super::persist_graph(
        &facade,
        &user,
        &personal,
        entities.clone(),
        relations.clone(),
        Some(&project),
    );
    super::persist_graph(
        &facade,
        &user,
        &personal,
        entities,
        relations,
        Some(&project),
    );

    assert!(
        facade
            .list_entities_for_ui(&user, &personal)
            .unwrap()
            .is_empty()
    );
    assert!(
        facade
            .list_relations_for_ui(&user, &personal)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        facade.list_entities_for_ui(&user, &project).unwrap().len(),
        2
    );
    let project_relations = facade.list_relations_for_ui(&user, &project).unwrap();
    assert_eq!(project_relations.len(), 1);
    assert_eq!(project_relations[0].evidence, vec![evidence]);
}

#[test]
fn automation_memory_cleanup_tombstones_matching_records() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("workspace_auto");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let record = facade
        .create_memory_candidate(local_first_memory::MemoryCreateRequest {
            request: lifecycle.clone(),
            memory_type: "fact".to_string(),
            text: "Automation Mondiali aggiorna il briefing.".to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 0.95,
            privacy_domain: local_first_memory::PrivacyDomain::new("work"),
            sensitivity: local_first_memory::DataSensitivity::Private,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({ "automation_id": "auto_123" }),
        })
        .unwrap();
    facade
        .confirm_memory(&lifecycle, &record.reference, "test")
        .unwrap();

    let deleted =
        super::tombstone_automation_memory_records(&facade, &user, &workspace, "auto_123").unwrap();

    assert_eq!(deleted, 1);
    assert!(
        facade
            .list_memories_for_ui(&user, &workspace)
            .unwrap()
            .into_iter()
            .all(|memory| memory.reference != record.reference)
    );
}

#[test]
fn hygiene_suggestions_find_same_person_names_without_auto_merge() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("workspace_hygiene");
    let fabio_a = local_first_memory::MemoryEntity {
        reference: local_first_memory::MemoryRef::new(
            local_first_memory::MemoryRefKind::Entity,
            user.clone(),
            workspace.clone(),
            "person:fabio-a",
        ),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        entity_type: "person".to_string(),
        name: "Fabio".to_string(),
        canonical_key: "person:fabio-a".to_string(),
        aliases: vec!["Fabio".to_string()],
        privacy_domain: local_first_memory::PrivacyDomain::new("personal"),
        sensitivity: MemoryDataSensitivity::Private,
        metadata: serde_json::json!({}),
    };
    let mut fabio_b = fabio_a.clone();
    fabio_b.reference = local_first_memory::MemoryRef::new(
        local_first_memory::MemoryRefKind::Entity,
        user.clone(),
        workspace.clone(),
        "person:fabio-b",
    );
    fabio_b.canonical_key = "person:fabio-b".to_string();
    fabio_b.aliases = vec!["fabio".to_string()];
    facade.upsert_entity(&fabio_a).unwrap();
    facade.upsert_entity(&fabio_b).unwrap();

    let suggestions =
        super::memory_hygiene_suggestions_for_scope(&facade, &user, &workspace).unwrap();

    assert_eq!(suggestions.len(), 1);
    assert!(!suggestions[0].safe_auto_merge);
    assert_eq!(suggestions[0].reason, "same normalized person name");
}

#[test]
fn summarize_tool_action_captures_mutations_skips_reads() {
    // Reads / discovery → nothing to remember.
    for read in [
        "read_file",
        "list_directory",
        "list_files",
        "recall_memory",
        "suggest_capabilities",
    ] {
        assert!(
            crate::summarize_tool_action(read, "{}").is_none(),
            "{read} should be skipped"
        );
    }
    // Mutations (any domain) → a one-line action with the target.
    assert!(
        crate::summarize_tool_action("edit_file", "{\"path\":\"src/x.rs\"}")
            .unwrap()
            .contains("src/x.rs")
    );
    assert!(
        crate::summarize_tool_action("run_in_project", "{\"command\":\"cargo build\"}")
            .unwrap()
            .contains("cargo build")
    );
    assert!(
        crate::summarize_tool_action("save_artifact", "{\"name\":\"preventivo.pdf\"}").is_some()
    );
}

#[test]
fn dedup_folds_paraphrased_decisions() {
    let a = crate::dedup_tokens("Scelto JSON come formato di salvataggio per taskline");
    let b = crate::dedup_tokens("taskline usa JSON come formato di salvataggio");
    assert!(
        crate::jaccard(&a, &b) >= crate::DEDUP_JACCARD,
        "paraphrase: {}",
        crate::jaccard(&a, &b)
    );
    // A genuinely different decision in the same project must NOT be folded.
    let c = crate::dedup_tokens("Aggiunto supporto CLI con argparse e gestione errori");
    assert!(
        crate::jaccard(&a, &c) < crate::DEDUP_JACCARD,
        "distinct: {}",
        crate::jaccard(&a, &c)
    );
}

#[test]
fn format_recall_entry_surfaces_decision_why() {
    let meta = serde_json::json!({
        "decision": {
            "rationale": "ACME è un cliente storico",
            "alternatives": [{ "option": "sconto 5%", "rejected_because": "troppo basso" }]
        }
    });
    let out = crate::format_recall_entry("Applicato sconto 10% ad ACME", &meta);
    assert!(
        out.contains("why: ACME è un cliente storico"),
        "rationale mancante: {out}"
    );
    assert!(
        out.contains("rejected alternatives"),
        "alternative mancanti: {out}"
    );
    assert!(out.contains("sconto 5%") && out.contains("troppo basso"));
    // Non-decision memory → summary returned unchanged.
    assert_eq!(
        crate::format_recall_entry("ciao", &serde_json::json!({})),
        "ciao"
    );
    // Rationale already in the summary → not duplicated.
    let meta2 = serde_json::json!({ "decision": { "rationale": "perché sì" } });
    let out2 = crate::format_recall_entry("Scelta X perché sì", &meta2);
    assert_eq!(out2.matches("perché sì").count(), 1);
}

#[test]
fn memory_eval_surfaces_artifact_provenance_and_decision_why() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    let decision = facade
            .create_memory_candidate(local_first_memory::MemoryCreateRequest {
                request: lifecycle.clone(),
                memory_type: "decision".to_string(),
                text: "Create reports/report.pdf as the durable review artifact.".to_string(),
                aliases: vec!["reports/report.pdf".to_string()],
                language_hints: Vec::new(),
                confidence: 1.0,
                privacy_domain: local_first_memory::PrivacyDomain::new("project"),
                sensitivity: local_first_memory::DataSensitivity::Internal,
                evidence_refs: Vec::new(),
                metadata: serde_json::json!({
                    "source": "record_decision",
                    "scope": "project",
                    "decision": {
                        "rationale": "The review must survive a new chat and point to a concrete deliverable.",
                        "alternatives": [
                            {
                                "option": "Leave the result only in chat",
                                "rejected_because": "A chat transcript is not a governed deliverable."
                            }
                        ]
                    },
                    "affects_labels": ["reports/report.pdf"],
                }),
            })
            .unwrap();
    facade
        .confirm_memory(&lifecycle, &decision.reference, "decision recorded")
        .unwrap();
    super::upsert_artifact_memory_record(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        "project",
        "thread-1",
        "reports/report.pdf",
        "Artifact reports/report.pdf (pdf) creato nel progetto.".to_string(),
        serde_json::json!({
            "source": "artifact_runtime",
            "producer": "mcp_filesystem",
            "thread_slug": "thread-1",
            "name": "reports/report.pdf",
            "artifact_type": "pdf",
            "project_relative_path": "reports/report.pdf",
            "project_path": "/tmp/project/reports/report.pdf",
            "size_bytes": 456,
        }),
    )
    .unwrap();

    let context = super::artifact_provenance_context_for_query(
        &facade,
        &user,
        &workspace,
        "quali artifact esistono per il progetto e da quale decisione derivano?",
    )
    .expect("provenance context");

    assert!(context.contains("reports/report.pdf"), "{context}");
    assert!(context.contains("mcp_filesystem"), "{context}");
    assert!(context.contains("Create reports/report.pdf"), "{context}");
    assert!(
        context.contains("why: The review must survive a new chat"),
        "{context}"
    );
    assert!(
        context.contains("Leave the result only in chat"),
        "{context}"
    );
}

#[test]
fn artifact_provenance_context_surfaces_managed_path_and_make_deck_workflow() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    super::upsert_artifact_memory_record(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        "project",
        "thread-deck",
        "deck.pptx",
        "Artifact deck.pptx (presentation) creato nel thread thread-deck.".to_string(),
        serde_json::json!({
            "source": "artifact_runtime",
            "producer": "make_deck",
            "thread_slug": "thread-deck",
            "name": "deck.pptx",
            "artifact_type": "presentation",
            "path_ref": "thread-deck/deck.pptx",
            "managed_path": "/Users/fabio/.homun/artifacts/thread-deck/deck.pptx",
            "size_bytes": 456,
            "quality_status": "warning",
            "quality_slide_count": 3,
            "quality_issues": [
                {
                    "severity": "error",
                    "code": "low_contrast",
                    "message": "slide 2: contrast ratio 2.1 is below 4.5"
                }
            ],
        }),
    )
    .unwrap();

    let context = super::artifact_provenance_context_for_query(
        &facade,
        &user,
        &workspace,
        "quali artifact hai creato e dove sono salvati?",
    )
    .expect("artifact context");

    assert!(context.contains("deck.pptx"), "{context}");
    assert!(context.contains("local managed path"), "{context}");
    assert!(
        context.contains("/Users/fabio/.homun/artifacts/thread-deck/deck.pptx"),
        "{context}"
    );
    assert!(context.contains("produced by make_deck"), "{context}");
    assert!(
        context.contains("derives from workflow make_deck"),
        "{context}"
    );
    assert!(context.contains("quality: warning"), "{context}");
    assert!(context.contains("low_contrast"), "{context}");
}

#[test]
fn artifact_provenance_context_surfaces_make_document_workflow() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    super::upsert_artifact_memory_record(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        "project",
        "thread-doc",
        "document.md",
        "Artifact document.md (document) creato nel thread thread-doc.".to_string(),
        serde_json::json!({
            "source": "artifact_runtime",
            "producer": "make_document",
            "thread_slug": "thread-doc",
            "name": "document.md",
            "artifact_type": "document",
            "path_ref": "thread-doc/document.md",
            "managed_path": "/Users/fabio/.homun/artifacts/thread-doc/document.md",
            "size_bytes": 456,
        }),
    )
    .unwrap();

    let context = super::artifact_provenance_context_for_query(
        &facade,
        &user,
        &workspace,
        "quali artifact documenti hai creato e da quale workflow derivano?",
    )
    .expect("artifact context");

    assert!(context.contains("document.md"), "{context}");
    assert!(context.contains("produced by make_document"), "{context}");
    assert!(
        context.contains("derives from workflow make_document / DocumentWorkflow"),
        "{context}"
    );
}

#[test]
fn memory_eval_surfaces_workflow_status_and_why() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "test".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "test".to_string(),
    };
    for (memory_type, text, metadata) in [
        (
            "goal",
            "Homun must complete memory guardrails before adding new deliverable workflows.",
            serde_json::json!({ "source": "test", "scope": "project" }),
        ),
        (
            "open_loop",
            "WS5.6 workflow status eval remains open: prove a new chat can recover what is next and why.",
            serde_json::json!({ "source": "test", "scope": "project" }),
        ),
        (
            "decision",
            "Delay WS7 until memory can explain workflow state.",
            serde_json::json!({
                "source": "record_decision",
                "scope": "project",
                "decision": {
                    "rationale": "New deliverables would reopen fragility unless memory can recover state and why.",
                    "alternatives": [
                        {
                            "option": "Start WS7 immediately",
                            "rejected_because": "It would build on unverified memory foundations."
                        }
                    ]
                },
                "affects_labels": ["reports/status.md"],
            }),
        ),
        (
            "fact",
            "Runtime plan step completed: Render deck artifacts.",
            serde_json::json!({
                "source": "runtime_plan_step",
                "thread_id": "thread-1",
                "step_id": "render",
                "status": "done",
                "done_criterion": "deck.pptx, deck.html and deck.pdf exist"
            }),
        ),
    ] {
        let record = facade
            .create_memory_candidate(local_first_memory::MemoryCreateRequest {
                request: lifecycle.clone(),
                memory_type: memory_type.to_string(),
                text: text.to_string(),
                aliases: Vec::new(),
                language_hints: Vec::new(),
                confidence: 1.0,
                privacy_domain: local_first_memory::PrivacyDomain::new("project"),
                sensitivity: local_first_memory::DataSensitivity::Internal,
                evidence_refs: Vec::new(),
                metadata,
            })
            .unwrap();
        facade
            .confirm_memory(&lifecycle, &record.reference, "test")
            .unwrap();
    }
    super::upsert_artifact_memory_record(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        "project",
        "thread-1",
        "reports/status.md",
        "Artifact reports/status.md (document) creato nel progetto.".to_string(),
        serde_json::json!({
            "source": "artifact_runtime",
            "producer": "mcp_filesystem",
            "thread_slug": "thread-1",
            "name": "reports/status.md",
            "artifact_type": "document",
            "project_relative_path": "reports/status.md",
            "project_path": "/tmp/project/reports/status.md",
            "size_bytes": 456,
        }),
    )
    .unwrap();

    let context = super::workflow_status_context_for_query(
        &facade,
        &user,
        &workspace,
        "a che punto è il workflow e perché?",
    )
    .expect("workflow status context");

    assert!(
        context.contains("WORKFLOW STATUS FROM CANONICAL MEMORY"),
        "{context}"
    );
    assert!(context.contains("Objectives"), "{context}");
    assert!(context.contains("memory guardrails"), "{context}");
    assert!(context.contains("Open loops"), "{context}");
    assert!(
        context.contains("WS5.6 workflow status eval remains open"),
        "{context}"
    );
    assert!(context.contains("Verified outcomes"), "{context}");
    assert!(context.contains("Render deck artifacts"), "{context}");
    assert!(context.contains("Recent decisions"), "{context}");
    assert!(
        context.contains("why: New deliverables would reopen fragility"),
        "{context}"
    );
    assert!(context.contains("reports/status.md"), "{context}");
}

#[test]
fn memory_guardrail_release_gate_covers_artifact_and_workflow_recall() {
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local");
    let workspace = local_first_memory::WorkspaceId::new("project");
    let lifecycle = local_first_memory::MemoryLifecycleRequest {
        actor_id: "release-gate".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "release_memory_guardrail".to_string(),
    };

    for (memory_type, text, aliases, metadata) in [
        (
            "goal",
            "Ship Homun only when artifact provenance and workflow status survive a new chat.",
            Vec::<String>::new(),
            serde_json::json!({ "source": "release_gate", "scope": "project" }),
        ),
        (
            "open_loop",
            "Next release gate: prove a fresh chat can explain existing artifacts, current workflow state, and why.",
            Vec::<String>::new(),
            serde_json::json!({ "source": "release_gate", "scope": "project" }),
        ),
        (
            "decision",
            "Use make_document for the board brief artifact.",
            vec!["board-brief.docx".to_string()],
            serde_json::json!({
                "source": "record_decision",
                "scope": "project",
                "decision": {
                    "rationale": "The board needs an editable governed deliverable, not a chat-only answer.",
                    "alternatives": [
                        {
                            "option": "Leave the board brief in chat",
                            "rejected_because": "It would not be exportable, governed, or recoverable."
                        }
                    ]
                },
                "affects_labels": ["board-brief.docx"],
            }),
        ),
        (
            "fact",
            "Runtime plan step completed: make_document produced board-brief.docx.",
            Vec::<String>::new(),
            serde_json::json!({
                "source": "runtime_plan_step",
                "thread_id": "thread-board",
                "step_id": "materialize_docx",
                "status": "done",
                "certainty": "verified",
                "done_criterion": "board-brief.docx exists as a managed artifact"
            }),
        ),
    ] {
        let record = facade
            .create_memory_candidate(local_first_memory::MemoryCreateRequest {
                request: lifecycle.clone(),
                memory_type: memory_type.to_string(),
                text: text.to_string(),
                aliases,
                language_hints: Vec::new(),
                confidence: 1.0,
                privacy_domain: local_first_memory::PrivacyDomain::new("project"),
                sensitivity: local_first_memory::DataSensitivity::Internal,
                evidence_refs: Vec::new(),
                metadata,
            })
            .unwrap();
        facade
            .confirm_memory(&lifecycle, &record.reference, "release gate seed")
            .unwrap();
    }

    super::upsert_artifact_memory_record(
        &facade,
        &user,
        &workspace,
        &lifecycle,
        "project",
        "thread-board",
        "board-brief.docx",
        "Artifact board-brief.docx (document) creato nel thread thread-board.".to_string(),
        serde_json::json!({
            "source": "artifact_runtime",
            "producer": "make_document",
            "thread_slug": "thread-board",
            "name": "board-brief.docx",
            "artifact_type": "document",
            "path_ref": "thread-board/board-brief.docx",
            "managed_path": "/Users/fabio/.homun/artifacts/thread-board/board-brief.docx",
            "size_bytes": 1234,
        }),
    )
    .unwrap();

    let artifact_context = super::artifact_provenance_context_for_query(
        &facade,
        &user,
        &workspace,
        "quali artifact esistono per il progetto e da quale decisione o workflow derivano?",
    )
    .expect("artifact provenance release gate context");
    for expected in [
        "ARTIFACT PROVENANCE FROM CANONICAL MEMORY GRAPH",
        "board-brief.docx",
        "produced by make_document",
        "derives from workflow make_document / DocumentWorkflow",
        "Use make_document for the board brief artifact.",
        "why: The board needs an editable governed deliverable",
        "Leave the board brief in chat",
        "local managed path",
    ] {
        assert!(
            artifact_context.contains(expected),
            "missing {expected:?}: {artifact_context}"
        );
    }

    let status_context = super::workflow_status_context_for_query(
        &facade,
        &user,
        &workspace,
        "a che punto è il workflow e perché?",
    )
    .expect("workflow status release gate context");
    for expected in [
        "WORKFLOW STATUS FROM CANONICAL MEMORY",
        "Objectives",
        "artifact provenance and workflow status survive a new chat",
        "Open loops / next work",
        "fresh chat can explain existing artifacts",
        "Verified outcomes / current state",
        "make_document produced board-brief.docx",
        "Recent decisions / why",
        "why: The board needs an editable governed deliverable",
        "Evidence artifacts",
        "board-brief.docx",
    ] {
        assert!(
            status_context.contains(expected),
            "missing {expected:?}: {status_context}"
        );
    }
}

#[test]
fn reassemble_streamed_content_and_tool_calls() {
    // Plain content split across two SSE deltas + a finish_reason.
    let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Ciao \"}}]}\n\
data: {\"choices\":[{\"delta\":{\"content\":\"mondo\"}}]}\n\
data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\
data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":4}}\n\
data: [DONE]\n";
    let body = crate::reassemble_openai_stream(sse);
    assert_eq!(body["choices"][0]["message"]["content"], "Ciao mondo");
    assert_eq!(body["choices"][0]["finish_reason"], "stop");
    assert_eq!(body["usage"]["prompt_tokens"], 11);
    assert_eq!(body["usage"]["completion_tokens"], 4);

    // tool_calls whose JSON arguments arrive as fragments across chunks.
    let sse2 = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]}}]}\n\
data: [DONE]\n";
    let body2 = crate::reassemble_openai_stream(sse2);
    let call = &body2["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "read_file");
    assert_eq!(call["function"]["arguments"], "{\"path\":\"a.txt\"}");

    // A provider that ignored stream:true and returned a plain JSON body.
    let plain = "{\"choices\":[{\"message\":{\"content\":\"hi\"}}]}";
    let body3 = crate::reassemble_openai_stream(plain);
    assert_eq!(body3["choices"][0]["message"]["content"], "hi");
}

#[tokio::test]
async fn openai_stream_finishes_when_provider_sends_finish_reason_but_keeps_socket_open() {
    use tokio::io::AsyncWriteExt;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test stream");
    let address = listener.local_addr().expect("test stream address");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept test stream");
        let payload = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"final answer\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\n\r\n{:X}\r\n{}\r\n",
            payload.len(),
            payload,
        );
        socket
            .write_all(response.as_bytes())
            .await
            .expect("write test stream");
        socket.flush().await.expect("flush test stream");
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    });
    let response = reqwest::Client::new()
        .get(format!("http://{address}"))
        .send()
        .await
        .expect("open test stream");
    let (mpsc, _mpsc_rx) = tokio::sync::mpsc::channel(4);
    let (tx, _) = tokio::sync::broadcast::channel(4);
    let sink = super::StreamSink {
        mpsc,
        entry: std::sync::Arc::new(super::StreamEntry {
            lines: std::sync::Mutex::new(Vec::new()),
            tx,
            finished: std::sync::atomic::AtomicBool::new(false),
            last_event_at: std::sync::atomic::AtomicU64::new(super::now_epoch_secs()),
            thread_id: None,
            assistant_message_id: std::sync::Mutex::new(None),
            outcome: std::sync::Mutex::new(None),
            outcome_ready: tokio::sync::Notify::new(),
        }),
    };

    let body = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        super::collect_openai_stream(
            response,
            std::time::Duration::from_secs(1),
            std::time::Duration::from_secs(30),
            true,
            &sink,
        ),
    )
    .await
    .expect("finish_reason must terminate a stream without waiting for the idle timeout")
    .expect("stream is valid");

    server.abort();
    assert_eq!(body["choices"][0]["message"]["content"], "final answer");
    assert_eq!(body["choices"][0]["finish_reason"], "stop");
}

#[tokio::test]
async fn openai_tool_round_stream_reassembles_body_without_visible_delta() {
    use tokio::io::AsyncWriteExt;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test stream");
    let address = listener.local_addr().expect("test stream address");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept test stream");
        let payload = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"planning text\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            payload.len(),
            payload,
        );
        socket
            .write_all(response.as_bytes())
            .await
            .expect("write test stream");
        socket.flush().await.expect("flush test stream");
    });
    let response = reqwest::Client::new()
        .get(format!("http://{address}"))
        .send()
        .await
        .expect("open test stream");
    let (mpsc, mut rx) = tokio::sync::mpsc::channel(4);
    let (tx, _) = tokio::sync::broadcast::channel(4);
    let entry = std::sync::Arc::new(super::StreamEntry {
        lines: std::sync::Mutex::new(Vec::new()),
        tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(super::now_epoch_secs()),
        thread_id: None,
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    });
    let sink = super::StreamSink {
        mpsc,
        entry: entry.clone(),
    };

    let body = super::collect_openai_stream(
        response,
        std::time::Duration::from_secs(1),
        std::time::Duration::from_secs(30),
        false,
        &sink,
    )
    .await
    .expect("stream is valid");

    server.await.expect("server completes");
    assert_eq!(body["choices"][0]["message"]["content"], "planning text");
    assert_eq!(body["choices"][0]["finish_reason"], "tool_calls");
    assert!(rx.try_recv().is_err());
    assert!(entry.lines.lock().expect("stream lines").is_empty());
}

#[test]
fn ollama_native_routing_and_message_conversion() {
    // Detection: local daemon + cloud are Ollama; Z.ai / OpenAI are not.
    assert!(crate::is_ollama_base("http://127.0.0.1:11434/v1"));
    assert!(crate::is_ollama_base("https://ollama.com/v1"));
    assert!(!crate::is_ollama_base(
        "https://api.z.ai/api/coding/paas/v4"
    ));
    assert!(!crate::is_ollama_base("https://api.openai.com/v1"));
    // Endpoint: Ollama strips /v1 → native /api/chat; others → /chat/completions.
    assert_eq!(
        crate::model_client::chat_endpoint("http://127.0.0.1:11434/v1"),
        "http://127.0.0.1:11434/api/chat"
    );
    assert_eq!(
        crate::model_client::chat_endpoint("https://ollama.com/v1"),
        "https://ollama.com/api/chat"
    );
    assert_eq!(
        crate::model_client::chat_endpoint("https://api.z.ai/api/coding/paas/v4"),
        format!(
            "{}/{}",
            "https://api.z.ai/api/coding/paas/v4", "chat/completions"
        )
    );
    assert_eq!(
        crate::model_client::chat_endpoint("https://api.z.ai/api/paas/v4"),
        format!("{}/{}", "https://api.z.ai/api/paas/v4", "chat/completions")
    );
    // Message conversion: assistant tool_calls arguments STRING → OBJECT (native).
    let msgs = vec![serde_json::json!({
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "id": "x", "type": "function",
            "function": { "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" }
        }]
    })];
    let converted = crate::to_ollama_messages(&msgs);
    assert_eq!(
        converted[0]["tool_calls"][0]["function"]["arguments"]["path"],
        "a.txt"
    );
}

#[test]
fn auto_confirm_only_low_risk() {
    assert!(memory_auto_confirmable(
        "preference",
        MemoryDataSensitivity::Internal,
        0.9
    ));
    assert!(memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Public,
        0.85
    ));
    // Ordinary personal facts (possessions, family, city) are tagged `private` by
    // the extractor — they MUST auto-confirm, else they never reach the profile
    // and the assistant keeps re-asking what it already knows.
    assert!(memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Private,
        0.9
    ));
    // Real PII (codice fiscale, health docs, addresses) → confidential/secret →
    // still waits for explicit user confirmation.
    assert!(!memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Secret,
        0.99
    ));
    assert!(!memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Confidential,
        0.99
    ));
    // low confidence stays candidate
    assert!(!memory_auto_confirmable(
        "preference",
        MemoryDataSensitivity::Internal,
        0.5
    ));
    assert!(!memory_auto_confirmable(
        "fact",
        MemoryDataSensitivity::Private,
        0.5
    ));
    // decisions are factual records of work → auto-confirm when confident + low-risk
    assert!(memory_auto_confirmable(
        "decision",
        MemoryDataSensitivity::Internal,
        0.9
    ));
    // but a sensitive decision still waits for confirmation
    assert!(!memory_auto_confirmable(
        "decision",
        MemoryDataSensitivity::Confidential,
        0.99
    ));
}

#[test]
fn inbound_action_kill_switch_allowlist_and_master_toggle() {
    // Kill-switch off (default) → ignore everything.
    assert_eq!(
        inbound_action(&ChannelSettings::default(), "alice"),
        InboundAction::Ignore
    );

    let mut settings = ChannelSettings {
        enabled: true,
        auto_reply: true,
        allowlist: vec!["alice".to_string()],
    };
    // Allowlisted + master on → auto-reply (text only; tools still gated).
    assert_eq!(inbound_action(&settings, "alice"), InboundAction::AutoReply);
    assert_eq!(inbound_action(&settings, "ALICE"), InboundAction::AutoReply);
    // Not allowlisted → draft for review.
    assert_eq!(inbound_action(&settings, "bob"), InboundAction::Draft);
    // Master toggle off → draft even for allowlisted.
    settings.auto_reply = false;
    assert_eq!(inbound_action(&settings, "alice"), InboundAction::Draft);
}

#[test]
fn parse_approval_reply_parses_verb_and_code() {
    use super::parse_approval_reply;
    assert_eq!(
        parse_approval_reply("OK 7F3"),
        Some((true, "7F3".to_string()))
    );
    assert_eq!(
        parse_approval_reply("si a1b"),
        Some((true, "A1B".to_string()))
    );
    assert_eq!(
        parse_approval_reply("NO 7F3"),
        Some((false, "7F3".to_string()))
    );
    assert_eq!(
        parse_approval_reply("annulla 7f3"),
        Some((false, "7F3".to_string()))
    );
    // Not a control reply → None (handled as a normal conversation message).
    assert_eq!(parse_approval_reply("ciao come stai"), None);
    assert_eq!(parse_approval_reply("ok"), None); // no code
}

#[test]
fn bm25_rank_orders_by_relevance() {
    use super::{CapabilityEntry, CapabilitySource, bm25_rank};
    let entry = |key: &str, text: &str| CapabilityEntry {
        key: key.to_string(),
        desc: text.to_string(),
        text: text.to_string(),
        schema: None,
        is_skill: false,
        source: CapabilitySource::NativeTool,
    };
    let corpus = vec![
        entry("gmail_send", "send an email message via gmail"),
        entry(
            "calendar_list",
            "list upcoming calendar events and schedule",
        ),
        entry("weather", "current weather forecast and temperature"),
    ];
    // Query terms select the matching doc as #1.
    let top = bm25_rank(&corpus, "send email", 3);
    assert_eq!(top[0].key, "gmail_send");
    let top2 = bm25_rank(&corpus, "calendar event", 3);
    assert_eq!(top2[0].key, "calendar_list");
    // Empty query → a bounded sample (no panic, no ranking).
    let sample = bm25_rank(&corpus, "   ", 2);
    assert_eq!(sample.len(), 2);
}

#[test]
fn extract_poll_items_finds_array_by_key_field() {
    use super::extract_poll_items;
    // Items nested under data → found by the key field.
    let v = serde_json::json!({
        "data": { "messages": [{"messageId": "a", "subj": "x"}, {"messageId": "b"}] }
    });
    let items = extract_poll_items(&v, "messageId");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].get("messageId").unwrap(), "a");
    // Top-level array.
    let v2 = serde_json::json!([{"id": 1}, {"id": 2}, {"id": 3}]);
    assert_eq!(extract_poll_items(&v2, "id").len(), 3);
    // No matching key → empty.
    assert!(extract_poll_items(&v, "nope").is_empty());
}

#[test]
fn queue_hides_internal_subtasks_and_humanizes_kinds() {
    // Execution sub-tasks are internal → hidden from the user-facing queue.
    assert!(is_internal_task_kind("capability.browser.snapshot"));
    assert!(is_internal_task_kind("capability.github.search"));
    assert!(is_internal_task_kind("subagent.code_reviewer"));
    // User-meaningful runs are NOT internal.
    assert!(!is_internal_task_kind("proactive_prompt"));
    assert!(!is_internal_task_kind("browser_task"));
    // Human labels.
    assert_eq!(humanize_task_kind("proactive_prompt"), "Automation");
    assert_eq!(
        humanize_task_kind("capability.browser.snapshot"),
        "Browser: snapshot"
    );
    assert_eq!(
        humanize_task_kind("capability.github.find_repos"),
        "Github: find repos"
    );
    assert_eq!(
        humanize_task_kind("subagent.code_reviewer"),
        "Sub-agent: code_reviewer"
    );
}

#[test]
fn strip_fences_and_normalize() {
    assert_eq!(strip_json_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
    assert_eq!(strip_json_fences("```\n{\"a\":1}\n```"), "{\"a\":1}");
    assert_eq!(strip_json_fences("{\"a\":1}"), "{\"a\":1}");
    assert_eq!(
        normalize_for_dedup("  Preferisce   risposte  BREVI "),
        "preferisce risposte brevi"
    );
}

#[test]
fn deck_slide_image_prompt_avoids_rendering_title_text() {
    let prompt = super::deck_slide_image_prompt("Local-first AI for PMI 2026", "#14947d");

    assert!(
        !prompt.contains("\"Local-first AI for PMI 2026\""),
        "{prompt}"
    );
    assert!(!prompt.contains("PMI 2026"), "{prompt}");
    assert!(prompt.contains("themes:"), "{prompt}");
    assert!(prompt.contains("No typography of any kind"), "{prompt}");
    assert!(
        prompt.contains("Do not render the topic words as visible text"),
        "{prompt}"
    );
}

#[test]
fn aggregate_session_state_reflects_member_progress() {
    // No member terminal yet -> session stays Running at 0 completed.
    assert_eq!(
        aggregate_session_state_from_counts(5, 0, 0, false, false),
        (SessionStatus::Running, 0)
    );
    // Some done, others still running -> Running, progress = completed.
    assert_eq!(
        aggregate_session_state_from_counts(5, 2, 2, false, false),
        (SessionStatus::Running, 2)
    );
    // All members completed -> Completed at full progress.
    assert_eq!(
        aggregate_session_state_from_counts(5, 5, 5, false, false),
        (SessionStatus::Completed, 5)
    );
    // All terminal but one failed -> Failed (progress counts completed only).
    assert_eq!(
        aggregate_session_state_from_counts(5, 4, 5, true, false),
        (SessionStatus::Failed, 4)
    );
    // Any member awaiting approval wins regardless of the rest.
    assert_eq!(
        aggregate_session_state_from_counts(5, 1, 1, false, true),
        (SessionStatus::WaitingUser, 1)
    );
}

#[test]
fn mcp_stdio_config_parses_command_args_env() {
    let config = mcp_stdio_config_from_metadata(&serde_json::json!({
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        "env": { "FOO": "bar" }
    }))
    .unwrap();
    assert_eq!(config.command, "npx");
    assert_eq!(config.args.len(), 3);
    assert_eq!(config.env, vec![("FOO".to_string(), "bar".to_string())]);

    // Missing command is a hard error (cannot spawn a server).
    assert!(mcp_stdio_config_from_metadata(&serde_json::json!({})).is_err());
}

#[test]
fn capability_completed_outcome_keeps_raw_output_out_of_redacted_and_chat() {
    let task = TaskRecord::new(
        "t1",
        UserId::new("u"),
        WorkspaceId::new("w"),
        "capability.fs.read_file",
        "read a file",
        serde_json::json!({}),
    );
    let result = CapabilityCallResult {
        provider_id: CapProviderId::new("fs"),
        tool_name: "fs.read_file".to_string(),
        output: serde_json::json!({ "contents": "SECRET-CONTENTS" }),
    };
    let outcome = capability_call_completed_outcome(&task, &result);
    // Raw output is preserved in the audited checkpoint...
    assert_eq!(
        outcome.checkpoint_payload["output"]["contents"],
        "SECRET-CONTENTS"
    );
    // ...but never leaks into the redacted checkpoint or the chat message.
    assert!(outcome.checkpoint_redacted.get("output").is_none());
    assert!(!outcome.chat_message.contains("SECRET-CONTENTS"));
    assert!(outcome.chat_message.contains("fs.read_file"));
}

#[test]
fn budgets_scale_with_model_context_window() {
    // Small / unknown model -> keep the cheap gemma4-era defaults.
    let small = brain_budgets_for_context_window(Some(8_192));
    assert_eq!(small.max_planner_tokens, 768);
    assert_eq!(small.max_memory_context_chars, 2_000);
    let unknown = brain_budgets_for_context_window(None);
    assert_eq!(unknown.max_planner_tokens, 768);

    // Capable big-context model -> generous planner budget and unlimited
    // (0 = passthrough) context so promptjuice never clamps essential text.
    let capable = brain_budgets_for_context_window(Some(200_000));
    assert_eq!(capable.max_planner_tokens, 8_000);
    assert_eq!(capable.max_conversation_summary_chars, 0);
    assert_eq!(capable.max_memory_context_chars, 0);
    assert_eq!(capable.max_tool_cards_context_chars, 0);
    assert_eq!(capable.max_loaded_tool_context_chars, 0);
    assert!(capable.max_loaded_tools > small.max_loaded_tools);
}

#[test]
fn normalize_browser_call_manages_tab_for_planner_steps() {
    use super::{BROWSER_MANAGED_TARGET, normalize_browser_call};
    use local_first_browser_automation::BrowserMethod;

    // navigate {url} with no target -> idempotent open of the managed tab.
    let (method, params) = normalize_browser_call(
        BrowserMethod::Navigate,
        serde_json::json!({"url": "https://www.trenitalia.com"}),
    );
    assert_eq!(method, BrowserMethod::Open);
    assert_eq!(params["url"], "https://www.trenitalia.com");
    assert_eq!(params["label"], BROWSER_MANAGED_TARGET);

    // act with no target -> target injected, payload preserved.
    let (method, params) = normalize_browser_call(
        BrowserMethod::Act,
        serde_json::json!({"actions": [{"type": "click", "selector": "x"}]}),
    );
    assert_eq!(method, BrowserMethod::Act);
    assert_eq!(params["target_id"], BROWSER_MANAGED_TARGET);
    assert!(params["actions"].is_array());

    // an explicit target_id is never overridden.
    let (method, params) = normalize_browser_call(
        BrowserMethod::Snapshot,
        serde_json::json!({"target_id": "t7"}),
    );
    assert_eq!(method, BrowserMethod::Snapshot);
    assert_eq!(params["target_id"], "t7");

    // tabless calls pass through untouched.
    let (method, params) = normalize_browser_call(BrowserMethod::Tabs, serde_json::json!({}));
    assert_eq!(method, BrowserMethod::Tabs);
    assert!(params.get("target_id").is_none());
}

#[test]
fn dead_sidecar_errors_trigger_respawn_others_do_not() {
    // Broken pipe / garbled reply -> the single persistent sidecar is gone.
    assert!(browser_error_indicates_dead_sidecar(
        &BrowserAutomationError::Sidecar("broken pipe".into())
    ));
    assert!(browser_error_indicates_dead_sidecar(
        &BrowserAutomationError::InvalidResponse("EOF".into())
    ));
    // Our own bug or legitimate per-call policy errors must NOT drop the
    // shared client (the process is still alive and healthy).
    assert!(!browser_error_indicates_dead_sidecar(
        &BrowserAutomationError::InvalidRequest("bad params".into())
    ));
    assert!(!browser_error_indicates_dead_sidecar(
        &BrowserAutomationError::NavigationBlocked("blocked".into())
    ));
    assert!(!browser_error_indicates_dead_sidecar(
        &BrowserAutomationError::PrivateNetworkBlocked("ssrf".into())
    ));
}

#[test]
fn member_counts_read_real_task_statuses_and_drive_aggregate_state() {
    // A1.2 integration: exercise the actual store-reading path the worker
    // uses — link N member tasks to a thread, persist them with mixed
    // statuses in a real (in-memory) TaskStore, and confirm the aggregate
    // session state matches.
    let user = UserId::new("local-user");
    let workspace = WorkspaceId::new("local-workspace");
    let chat = ChatStore::in_memory().unwrap();
    let thread = chat.create_thread("default").unwrap();
    let tasks = TaskStore::open_in_memory().unwrap();

    // Three Brain-materialized member tasks for this thread.
    let members = ["orch_s1", "orch_s2", "orch_s3"];
    for id in members {
        chat.link_task_to_thread(id, &thread.thread_id).unwrap();
        tasks
            .insert_task(&TaskRecord::new(
                id,
                user.clone(),
                workspace.clone(),
                "capability.browser.navigate",
                "step",
                serde_json::json!({}),
            ))
            .unwrap();
    }

    let member_ids = chat.member_task_ids_for_thread(&thread.thread_id).unwrap();
    assert_eq!(member_ids.len(), 3);

    // All queued -> no terminal members -> session still Running at 0.
    let counts = collect_member_counts(&tasks, &member_ids, &user, &workspace).unwrap();
    assert_eq!(
        aggregate_session_state_from_counts(
            member_ids.len(),
            counts.completed,
            counts.terminal,
            counts.any_failed,
            counts.any_waiting_user,
        ),
        (SessionStatus::Running, 0)
    );

    // One completes -> Running, progress 1.
    tasks
        .update_task_status(
            &TaskId::new("orch_s1"),
            &user,
            &workspace,
            TaskStatus::Completed,
            None,
        )
        .unwrap();
    let counts = collect_member_counts(&tasks, &member_ids, &user, &workspace).unwrap();
    assert_eq!(
        aggregate_session_state_from_counts(
            member_ids.len(),
            counts.completed,
            counts.terminal,
            counts.any_failed,
            counts.any_waiting_user,
        ),
        (SessionStatus::Running, 1)
    );

    // Remaining complete + one fails -> all terminal with a failure -> Failed.
    tasks
        .update_task_status(
            &TaskId::new("orch_s2"),
            &user,
            &workspace,
            TaskStatus::Completed,
            None,
        )
        .unwrap();
    tasks
        .update_task_status(
            &TaskId::new("orch_s3"),
            &user,
            &workspace,
            TaskStatus::Failed,
            Some("boom"),
        )
        .unwrap();
    let counts = collect_member_counts(&tasks, &member_ids, &user, &workspace).unwrap();
    assert_eq!(
        aggregate_session_state_from_counts(
            member_ids.len(),
            counts.completed,
            counts.terminal,
            counts.any_failed,
            counts.any_waiting_user,
        ),
        (SessionStatus::Failed, 2)
    );
}

#[test]
fn runtime_log_redaction_hides_tokens() {
    assert_eq!(
        redact_sensitive_text("Authorization: Bearer secret-token next"),
        "Authorization:[REDACTED]"
    );
}

#[test]
fn runtime_log_redaction_strips_terminal_control_sequences() {
    assert_eq!(
        redact_sensitive_text("\u{1b}[2m  - navigating\u{1b}[22m\nok"),
        "  - navigating\nok"
    );
}

#[test]
fn uncertain_effect_projection_is_bounded_and_metadata_only() {
    let receipt = local_first_task_runtime::ExecutionEffectReceipt {
        receipt_ref: local_first_execution_protocol::EffectReceiptRef::from_store_id(
            "11111111111111111111111111111111",
        )
        .unwrap(),
        execution_id: "exec-1".to_string(),
        revision: 3,
        idempotency_key: "secret-idempotency-key".to_string(),
        run_id: Some("run-1".to_string()),
        thread_id: Some("thread-1".to_string()),
        user_id: "user-1".to_string(),
        workspace_id: "workspace-1".to_string(),
        effect_class: local_first_execution_protocol::EffectClass::ExternalWrite,
        operation: "channel.telegram.reply".to_string(),
        arguments_hash: "secret-arguments-hash".to_string(),
        status: local_first_execution_protocol::EffectReceiptStatus::Uncertain,
        result_json: Some(serde_json::json!({
            "recipient": "private-recipient"
        })),
        effects_json: Some(serde_json::json!({
            "attempted": true,
            "recipient_fingerprint": "private-recipient",
            "payload": "private-payload"
        })),
        error_json: None,
        compensation: None,
        prepared_at: 100,
        started_at: Some(120),
        resolved_at: None,
    };

    let value = serde_json::to_value(super::uncertain_effect_response(&receipt)).unwrap();

    assert_eq!(
        value["receipt_ref"],
        "effect:v1:32:11111111111111111111111111111111"
    );
    assert_eq!(value["operation_family"], "channel");
    assert_eq!(value["uncertain_at"], 120);
    assert_eq!(value["status"], "uncertain");
    assert_eq!(value["evidence"], serde_json::json!({ "attempted": true }));
    let encoded = value.to_string();
    for forbidden in [
        "secret-idempotency-key",
        "secret-arguments-hash",
        "private-recipient",
        "private-payload",
    ] {
        assert!(
            !encoded.contains(forbidden),
            "projection leaked {forbidden}"
        );
    }
}

#[test]
fn task_queue_scope_retains_only_matching_uncertain_effects() {
    let effect = |receipt_ref: &str, thread_id: &str| super::UncertainEffectResponse {
        receipt_ref: receipt_ref.to_string(),
        execution_id: format!("execution-{receipt_ref}"),
        thread_id: Some(thread_id.to_string()),
        operation_family: "browser",
        status: "uncertain",
        evidence: serde_json::json!({}),
        uncertain_at: 100,
    };
    let mut response = super::TaskQueueResponse {
        queued: Vec::new(),
        active: Vec::new(),
        blocked: Vec::new(),
        waiting_approvals: Vec::new(),
        uncertain_effects: vec![
            effect("effect-1", "thread-1"),
            effect("effect-2", "thread-2"),
        ],
        recent_failures: Vec::new(),
        resource_usage: Vec::new(),
    };

    super::retain_task_queue_scope(&mut response, &std::collections::HashSet::new(), "thread-1");

    assert_eq!(response.uncertain_effects.len(), 1);
    assert_eq!(response.uncertain_effects[0].receipt_ref, "effect-1");
}

#[test]
fn task_queue_response_serializes_ui_read_model_for_renderer() {
    let user = UserId::new("local-user");
    let workspace = WorkspaceId::new("local-workspace");
    let mut resource_usage = HashMap::new();
    resource_usage.insert(ResourceClass::LlmInference, 1);
    let response = task_queue_response(
        TaskQueueSnapshot {
            queued: vec![TaskUiItem {
                task_id: TaskId::new("task-1"),
                kind: "browser_automation".to_string(),
                goal: "Find train options".to_string(),
                thread_id: Some("thread-automation".to_string()),
                status: TaskStatus::Queued,
                priority: TaskPriority::High,
                blocked_reason: None,
            }],
            active: Vec::new(),
            blocked: Vec::new(),
            waiting_approvals: vec![ApprovalRequest::new(
                "approval-1",
                TaskId::new("task-2"),
                user,
                workspace,
                "book train",
                "high",
                "browser",
                "Purchase requires confirmation",
            )],
            recent_failures: Vec::new(),
            resource_usage,
        },
        &ResourceLimits::new().with_limit(ResourceClass::LlmInference, 4),
        Vec::new(),
    )
    .unwrap();

    assert_eq!(response.queued[0].task_id, "task-1");
    assert_eq!(
        response.queued[0].thread_id.as_deref(),
        Some("thread-automation")
    );
    assert_eq!(response.queued[0].status, "queued");
    assert_eq!(response.queued[0].priority, "high");
    assert_eq!(response.waiting_approvals[0].status, "pending");
    assert_eq!(response.resource_usage[0].resource_class, "llm_inference");
    assert_eq!(response.resource_usage[0].units, 1);
    assert_eq!(response.resource_usage[0].limit_units, Some(4));
    assert_eq!(response.resource_usage[0].available_units, Some(3));
    assert!(!response.resource_usage[0].saturated);
}

#[test]
fn task_goal_summary_redacts_and_compacts_prompt() {
    let summary = task_goal_summary(
        "cerca documenti con token=super-secret e poi mostrami le opzioni principali disponibili",
    );

    assert!(summary.contains("token=[REDACTED]"));
    assert!(!summary.contains("super-secret"));
    assert!(summary.chars().count() <= 44);
}

#[test]
fn browser_executor_uses_read_only_search_urls() {
    // De-gemma: the web-search URL is the goal verbatim — no hardcoded
    // "Trenitalia Italo" augmentation biasing every query toward trains.
    let url = browser_url_for_goal("Devo prenotare un treno Napoli Milano il 10 giugno");
    assert!(url.starts_with("https://duckduckgo.com/?q="));
    assert!(url.to_lowercase().contains("treno"));
    assert!(!url.contains("Trenitalia+Italo+orari"));
}

#[test]
fn browser_path_is_general_with_no_train_specialization() {
    // The train path is removed (user directive): EVERY goal — flights,
    // trains, anything — gets ONE generic web-search target, and there is no
    // train-search draft. The model decides where to go; no keyword/site
    // routing hijacks the intent (this is the bug where "voli Milano-Napoli"
    // returned trains).
    for goal in [
        "Cerca voli da Milano a Napoli per il 10 giugno",
        "Devo prenotare un treno Napoli Milano il 10 giugno",
        "trova un ristorante a Roma",
    ] {
        let targets = browser_targets_for_goal(goal);
        assert_eq!(targets.len(), 1, "goal: {goal}");
        assert_eq!(targets[0].label, "Web search", "goal: {goal}");
        assert!(
            targets[0].url.starts_with("https://duckduckgo.com/?q="),
            "goal: {goal}"
        );
    }
}

#[test]
fn capability_browser_tool_names_resolve_to_browser_methods() {
    assert_eq!(
        browser_method_for_capability_tool("browser.open"),
        Some(BrowserMethod::Open)
    );
    assert_eq!(
        browser_method_for_capability_tool("browser.act"),
        Some(BrowserMethod::Act)
    );
    assert_eq!(browser_method_for_capability_tool("github.search"), None);
}

// The durable capability-browser executor runs OUTSIDE any chat turn: it has no
// live page snapshot and can never hold a Payment Approval Card, so the
// interactive `browser_safety` gate (which needs both) cannot protect it. These
// tests pin the executor's own fail-closed refusal: a committing/payment
// `browser_act` must be refused before it can reach the sidecar `Act` call,
// while page reads and navigation stay allowed.
#[test]
fn capability_browser_executor_refuses_committing_act() {
    // A plain click is a committing action — refused in a non-interactive task.
    assert!(
        browser_capability_action_refusal(
            BrowserMethod::Act,
            &serde_json::json!({ "kind": "click", "ref": "e9" }),
        )
        .is_some()
    );
}

#[test]
fn capability_browser_executor_refuses_payment_bearing_act() {
    // A payment click carrying an approval id / vault secret that this context
    // could never legitimately have issued must still be refused (fail-closed:
    // presence of a payment field is a rejection, never an implicit unlock).
    assert!(
        browser_capability_action_refusal(
            BrowserMethod::Act,
            &serde_json::json!({
                "kind": "click",
                "ref": "e10",
                "payment_approval_id": "pay_123",
            }),
        )
        .is_some()
    );
    assert!(
        browser_capability_action_refusal(
            BrowserMethod::Act,
            &serde_json::json!({ "kind": "fill", "ref": "e2", "vault_secret": "cvv_one_shot" }),
        )
        .is_some()
    );
}

#[test]
fn capability_browser_executor_refuses_declared_payment_commit_on_any_method() {
    // A payment_commit-class action declared on ANY method is refused, even one
    // that is normally a read/navigation — the class, not the method, decides.
    assert!(browser_capability_action_refusal(
            BrowserMethod::Navigate,
            &serde_json::json!({ "url": "https://shop.example/pay", "action_class": "payment_commit" }),
        )
        .is_some());
}

#[test]
fn capability_browser_executor_allows_reads_and_navigation() {
    // Page reads and ordinary navigation carry no commit risk and stay allowed,
    // so read-oriented capability tasks are not collateral damage of the gate.
    assert!(
        browser_capability_action_refusal(BrowserMethod::Snapshot, &serde_json::json!({}))
            .is_none()
    );
    assert!(
        browser_capability_action_refusal(BrowserMethod::Tabs, &serde_json::json!({})).is_none()
    );
    assert!(
        browser_capability_action_refusal(
            BrowserMethod::Navigate,
            &serde_json::json!({ "url": "https://example.com" }),
        )
        .is_none()
    );
}

#[test]
fn executor_needs_approval_is_not_treated_as_generic_block() {
    let state = AppState::for_tests();
    let mut task = TaskRecord::new(
        "task_approval",
        UserId::new("user"),
        WorkspaceId::new("workspace"),
        "capability.browser.browser.act",
        "Click a protected browser control",
        serde_json::json!({}),
    );
    task.status = TaskStatus::Running;
    task.lease_owner = Some("test-worker".to_string());
    task.last_heartbeat_at = Some(super::OffsetDateTime::now_utc());
    state.task_store.lock().unwrap().insert_task(&task).unwrap();
    let contract = super::execution_runtime::contract_for_acquired_task(&task).unwrap();

    let outcome = task_execution_outcome_from_executor_result(
        &state,
        &task,
        &contract,
        "browser-capability-executor",
        "browser.act",
        ExecutorResult::NeedsApproval {
            action: "browser.manual_action".to_string(),
            risk_level: "medium".to_string(),
            data_boundary: "local_browser".to_string(),
            explanation: "Manual confirmation required".to_string(),
        },
    )
    .unwrap();

    assert!(matches!(
        &outcome,
        local_first_execution_protocol::ExecutionOutcome::Suspended {
            wake: local_first_execution_protocol::WakeCondition::Approval { .. },
            ..
        }
    ));
    let presentation =
        super::execution_runtime::task_execution_presentation(&state, &task, &outcome).unwrap();
    let pending = presentation
        .pending_approval
        .as_ref()
        .expect("executor approval should be preserved");
    assert_eq!(pending.action, "browser.manual_action");
    assert_eq!(pending.data_boundary, "local_browser");
    assert_eq!(
        presentation.checkpoint_payload["kind"],
        "executor_needs_approval"
    );
}

#[test]
fn task_effective_goal_uses_redacted_prompt_for_execution() {
    let task = TaskRecord::new(
        "task_1",
        UserId::new("user"),
        WorkspaceId::new("workspace"),
        "browser_task",
        "Devo prenotare un treno Napoli Milano il ...",
        serde_json::json!({
            "prompt_redacted": "Cerca voli Napoli Milano il 10 giugno, trova opzioni ma non acquistare nulla"
        }),
    );

    // task_effective_goal prefers the redacted prompt over the truncated goal.
    let effective = task_effective_goal(&task);
    assert!(effective.contains("voli"));
    assert!(effective.contains("10 giugno"));
    assert!(effective.contains("non acquistare"));
}

#[test]
fn fs_authorize_rewrite_drops_card_marker() {
    let text = "To access this folder I need your authorization.\n\
‹‹FS_AUTHORIZE››{\"path\":\"/Users/fabio/Projects\",\"op\":\"list\"}‹‹/FS_AUTHORIZE››\n";
    let out = crate::rewrite_fs_authorize_to_done(text, "/Users/fabio/Projects");
    assert!(!out.contains("FS_AUTHORIZE"), "marker removed");
    assert!(
        !out.contains("I need your authorization"),
        "prompt line removed"
    );
    assert!(out.contains("✓ Access granted to /Users/fabio/Projects"));
    // No-op when the marker is absent (idempotent on already-rewritten text).
    assert_eq!(crate::rewrite_fs_authorize_to_done("hi", "/x"), "hi");
}

#[test]
fn sandbox_escalate_matches_only_the_proposed_command() {
    let text = "I need your confirmation for the action below.\n\
‹‹SANDBOX_ESCALATE››{\"approval_id\":\"abc\",\"tool\":\"run_in_project\",\
\"arguments\":{\"command\":\"npm ci\",\"cwd\":\"/proj\"}}‹‹/SANDBOX_ESCALATE››\n";
    // Matches the exact command carried by the card.
    assert!(crate::sandbox_escalate_matches(
        text,
        "npm ci",
        Some("/proj")
    ));
    // Rejects any other command (the provenance gate).
    assert!(!crate::sandbox_escalate_matches(
        text,
        "rm -rf /",
        Some("/proj")
    ));
    // Rejects when the marker is missing entirely.
    assert!(!crate::sandbox_escalate_matches(
        "no card here",
        "npm ci",
        Some("/proj")
    ));
}

#[test]
fn sandbox_escalate_rewrite_drops_card_marker() {
    let text = "I need your confirmation for the action below.\n\
‹‹SANDBOX_ESCALATE››{\"tool\":\"run_in_project\",\
\"arguments\":{\"command\":\"npm ci\",\"cwd\":\"/proj\"}}‹‹/SANDBOX_ESCALATE››\n";
    let out = crate::rewrite_sandbox_escalate_to_done(text, "npm ci");
    assert!(!out.contains("SANDBOX_ESCALATE"), "marker removed");
    assert!(
        !out.contains("I need your confirmation"),
        "prompt line removed"
    );
    assert!(out.contains("✓ Ran unsandboxed: npm ci"));
    // No-op when the marker is absent (idempotent on already-rewritten text).
    assert_eq!(
        crate::rewrite_sandbox_escalate_to_done("hi", "npm ci"),
        "hi"
    );
}

#[test]
fn connect_suggest_mark_flags_only_the_matching_item() {
    let text = "Ecco cosa posso collegare.\n\
‹‹CONNECT_SUGGEST››{\"need\":\"browser\",\"items\":[\
{\"kind\":\"mcp\",\"name\":\"Playwright\",\"server\":{\"id\":\"io.mcp/playwright\"}},\
{\"kind\":\"skill\",\"name\":\"Pdf\",\"slug\":\"pdf-tools\"},\
{\"kind\":\"composio\",\"name\":\"Gmail\",\"slug\":\"gmail\"}\
]}‹‹/CONNECT_SUGGEST››\n";
    // Mark the MCP server by its registry id.
    let out = crate::rewrite_connect_suggest_mark(text, "mcp", "io.mcp/playwright");
    let card = &out[out.find("‹‹CONNECT_SUGGEST››").unwrap() + "‹‹CONNECT_SUGGEST››".len()
        ..out.find("‹‹/CONNECT_SUGGEST››").unwrap()];
    let parsed: serde_json::Value = serde_json::from_str(card).unwrap();
    let items = parsed["items"].as_array().unwrap();
    assert_eq!(items[0]["connected"], serde_json::json!(true), "mcp marked");
    assert!(items[1].get("connected").is_none(), "skill untouched");
    assert!(items[2].get("connected").is_none(), "composio untouched");
    // Marker stays present (other items remain actionable) and is still valid.
    assert!(out.contains("CONNECT_SUGGEST"));
    // Skill/Composio keyed by slug.
    let out2 = crate::rewrite_connect_suggest_mark(&out, "composio", "gmail");
    let card2 = &out2[out2.find("‹‹CONNECT_SUGGEST››").unwrap() + "‹‹CONNECT_SUGGEST››".len()
        ..out2.find("‹‹/CONNECT_SUGGEST››").unwrap()];
    let parsed2: serde_json::Value = serde_json::from_str(card2).unwrap();
    assert_eq!(parsed2["items"][2]["connected"], serde_json::json!(true));
    // No-op when the marker is absent.
    assert_eq!(
        crate::rewrite_connect_suggest_mark("ciao", "mcp", "x"),
        "ciao"
    );
}

#[test]
fn fs_native_jail_and_path_expansion() {
    // Path expansion: absolute kept, relative/empty rejected.
    assert!(crate::fs_expand_abs("/abs/path").is_some());
    assert!(crate::fs_expand_abs("relative/path").is_none());
    assert!(crate::fs_expand_abs("   ").is_none());

    // Authorization jail: inside the root OK, outside / non-existent rejected.
    let base = std::env::temp_dir().join(format!("lfpa-fs-jail-{}", std::process::id()));
    let inside = base.join("sub");
    std::fs::create_dir_all(&inside).expect("mkdir");
    let roots = vec![base.clone()];
    assert!(crate::fs_path_authorized(&base, &roots), "root itself");
    assert!(crate::fs_path_authorized(&inside, &roots), "subdir");
    assert!(
        !crate::fs_path_authorized(std::path::Path::new("/"), &roots),
        "outside"
    );
    assert!(
        !crate::fs_path_authorized(&base.join("does-not-exist"), &roots),
        "non-existent can't be authorized"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn mcp_chat_tool_name_round_trips_collision_safe() {
    let provider = local_first_capabilities::ProviderId::new("mcp:filesystem".to_string());
    // Encode → namespaced, decode → original provider + tool.
    let name = crate::mcp_chat_tool_name(&provider, "read_file");
    assert_eq!(name, "mcp__filesystem__read_file");
    let (back_provider, back_tool) = crate::parse_mcp_chat_name(&name).expect("parse");
    assert_eq!(back_provider.as_str(), "mcp:filesystem");
    assert_eq!(back_tool, "read_file");
    // A tool name containing the separator stays intact (splitn(2)).
    let name2 = crate::mcp_chat_tool_name(&provider, "weird__tool");
    let (_, back_tool2) = crate::parse_mcp_chat_name(&name2).expect("parse2");
    assert_eq!(back_tool2, "weird__tool");
    // Non-MCP names (Composio slugs, plain tools) are NOT claimed by the parser.
    assert!(crate::parse_mcp_chat_name("GMAIL_SEND_EMAIL").is_none());
    assert!(crate::parse_mcp_chat_name("use_skill").is_none());
    assert!(crate::parse_mcp_chat_name("mcp__only").is_none());
}

#[test]
fn mcp_metadata_round_trips_between_connect_and_executor() {
    // The contract: what mcp/connect writes (to_metadata) MUST be exactly
    // what the executor reads (from_metadata). A mismatch here = a connected
    // MCP server the executor can't launch.
    let original = local_first_capabilities::McpStdioConfig {
        command: "npx".to_string(),
        args: vec![
            "-y".to_string(),
            "@modelcontextprotocol/server-filesystem".to_string(),
            "/tmp".to_string(),
        ],
        env: vec![
            ("API_TOKEN".to_string(), "abc123".to_string()),
            ("MODE".to_string(), "ro".to_string()),
        ],
    };

    let metadata = mcp_stdio_config_to_metadata(&original);
    let restored = mcp_stdio_config_from_metadata(&metadata).expect("metadata should parse back");

    assert_eq!(restored.command, original.command);
    assert_eq!(restored.args, original.args);
    // env order is not significant (serde object → map); compare as sets.
    let mut a = original.env.clone();
    let mut b = restored.env.clone();
    a.sort();
    b.sort();
    assert_eq!(a, b);
}

#[test]
fn mcp_metadata_round_trips_with_empty_args_and_env() {
    let original = local_first_capabilities::McpStdioConfig {
        command: "my-server".to_string(),
        args: vec![],
        env: vec![],
    };
    let restored = mcp_stdio_config_from_metadata(&mcp_stdio_config_to_metadata(&original))
        .expect("empty config should parse back");
    assert_eq!(restored.command, "my-server");
    assert!(restored.args.is_empty());
    assert!(restored.env.is_empty());
}

#[test]
fn mcp_http_metadata_never_contains_headers() {
    let metadata = crate::mcp_http_config_to_metadata("https://example.com/mcp");
    let serialized = metadata.to_string();

    assert_eq!(metadata["transport"], "http");
    assert_eq!(metadata["url"], "https://example.com/mcp");
    assert!(metadata.get("headers").is_none());
    assert!(!serialized.contains("Authorization"));
}

#[test]
fn mcp_http_headers_round_trip_as_secret_material() {
    let headers = std::collections::HashMap::from([
        (
            "Authorization".to_string(),
            "Bearer orion-secret".to_string(),
        ),
        ("X-Tenant".to_string(), "idra".to_string()),
    ]);

    let material = crate::mcp_http_headers_to_secret(&headers).expect("serialize headers");
    let restored = crate::mcp_http_headers_from_secret(material).expect("decode headers");

    assert_eq!(restored, headers);
}

#[test]
fn mcp_http_headers_reject_malformed_secret_material() {
    let material = local_first_secrets::SecretMaterial::from_string("not-json");

    assert!(crate::mcp_http_headers_from_secret(material).is_err());
}

#[test]
fn mcp_http_connection_restores_headers_from_secret_store() {
    use local_first_secrets::{InMemorySecretStore, SecretRef, SecretStore};

    let secrets = InMemorySecretStore::default();
    let secret_ref =
        SecretRef::new("user", "workspace", "mcp-orion-moon", "default").expect("secret ref");
    let headers = std::collections::HashMap::from([(
        "Authorization".to_string(),
        "Bearer orion-secret".to_string(),
    )]);
    let material = crate::mcp_http_headers_to_secret(&headers).expect("secret material");
    secrets
        .put(secret_ref.clone(), material)
        .expect("store headers");
    let connection = local_first_capabilities::CapabilityConnectionConfig::new(
        "mcp-orion-moon",
        local_first_capabilities::ProviderId::new("mcp:orion-moon"),
        local_first_capabilities::UserId::new("user"),
        local_first_capabilities::WorkspaceId::new("workspace"),
        "Orion Moon",
        secret_ref.as_str(),
    )
    .with_metadata(crate::mcp_http_config_to_metadata(
        "https://example.com/mcp",
    ));

    let config =
        crate::mcp_http_config_from_connection(&connection, &secrets).expect("restore HTTP config");

    assert_eq!(config.url, "https://example.com/mcp");
    assert_eq!(
        config.headers,
        vec![(
            "Authorization".to_string(),
            "Bearer orion-secret".to_string(),
        )]
    );
}

#[test]
fn mcp_http_connection_without_secret_is_unauthenticated() {
    let secrets = local_first_secrets::InMemorySecretStore::default();
    let connection = local_first_capabilities::CapabilityConnectionConfig::new(
        "mcp-public",
        local_first_capabilities::ProviderId::new("mcp:public"),
        local_first_capabilities::UserId::new("user"),
        local_first_capabilities::WorkspaceId::new("workspace"),
        "Public",
        "http:public",
    )
    .with_metadata(crate::mcp_http_config_to_metadata(
        "https://example.com/mcp",
    ));

    let config =
        crate::mcp_http_config_from_connection(&connection, &secrets).expect("public HTTP config");

    assert!(config.headers.is_empty());
}

#[test]
fn mcp_http_connection_fails_closed_when_secret_is_missing() {
    let secrets = local_first_secrets::InMemorySecretStore::default();
    let secret_ref =
        local_first_secrets::SecretRef::new("user", "workspace", "mcp-orion-moon", "default")
            .expect("secret ref");
    let connection = local_first_capabilities::CapabilityConnectionConfig::new(
        "mcp-orion-moon",
        local_first_capabilities::ProviderId::new("mcp:orion-moon"),
        local_first_capabilities::UserId::new("user"),
        local_first_capabilities::WorkspaceId::new("workspace"),
        "Orion Moon",
        secret_ref.as_str(),
    )
    .with_metadata(crate::mcp_http_config_to_metadata(
        "https://example.com/mcp",
    ));

    let error = crate::mcp_http_config_from_connection(&connection, &secrets)
        .err()
        .expect("missing credential must fail");

    assert!(error.contains("MCP credential not found"));
    assert!(!error.contains("orion-secret"));
}

#[test]
fn mcp_secret_lifecycle_persists_outside_metadata_and_deletes_on_disconnect() {
    use local_first_secrets::SecretStore;

    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().expect("memory store"),
    );
    let state = test_app_state_for_brief(facade);
    let response = crate::connect_mcp_blocking(
        &state,
        crate::ConnectMcpRequest {
            name: "Orion Moon".to_string(),
            command: String::new(),
            args: Vec::new(),
            env: std::collections::HashMap::new(),
            url: Some("http://127.0.0.1:1/mcp".to_string()),
            headers: std::collections::HashMap::from([(
                "Authorization".to_string(),
                "Bearer orion-secret".to_string(),
            )]),
        },
    )
    .expect("register MCP connection");
    assert!(response.discovery_error.is_some());

    let user = crate::gateway_capability_user_id();
    let workspace = crate::gateway_capability_workspace_id();
    let connection = state
        .capability_registry
        .lock()
        .expect("registry lock")
        .connection_configs(&user, &workspace)
        .expect("connection configs")
        .into_iter()
        .find(|connection| connection.provider_id.as_str() == "mcp:orion-moon")
        .expect("Orion Moon connection");
    let serialized = serde_json::to_string(&connection).expect("serialize connection");
    assert_eq!(connection.metadata["transport"], "http");
    assert!(connection.metadata.get("headers").is_none());
    assert!(!serialized.contains("orion-secret"));

    let secret_ref = connection
        .secret_ref
        .parse::<local_first_secrets::SecretRef>()
        .expect("persisted secret ref");
    let stored = state
        .secret_store
        .get(&secret_ref)
        .expect("read secret")
        .expect("stored MCP credential");
    let headers = crate::mcp_http_headers_from_secret(stored).expect("decode headers");
    assert_eq!(headers["Authorization"], "Bearer orion-secret");

    let removed =
        crate::mcp_disconnect_blocking(&state, "mcp:orion-moon").expect("disconnect MCP provider");
    assert_eq!(removed, 1);
    assert!(
        state
            .secret_store
            .get(&secret_ref)
            .expect("read deleted secret")
            .is_none()
    );
}

#[test]
fn mcp_reconnect_without_auth_deletes_previous_secret() {
    use local_first_secrets::SecretStore;

    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().expect("memory store"),
    );
    let state = test_app_state_for_brief(facade);
    crate::connect_mcp_blocking(
        &state,
        crate::ConnectMcpRequest {
            name: "Orion Moon".to_string(),
            command: String::new(),
            args: Vec::new(),
            env: std::collections::HashMap::new(),
            url: Some("http://127.0.0.1:1/mcp".to_string()),
            headers: std::collections::HashMap::from([(
                "Authorization".to_string(),
                "Bearer replaced-secret".to_string(),
            )]),
        },
    )
    .expect("register authenticated MCP");
    let secret_ref = local_first_secrets::SecretRef::new(
        crate::gateway_capability_user_id().as_str(),
        crate::gateway_capability_workspace_id().as_str(),
        "mcp:orion-moon",
        "mcp-orion-moon",
    )
    .expect("secret ref");
    assert!(
        state
            .secret_store
            .get(&secret_ref)
            .expect("read secret")
            .is_some()
    );

    crate::connect_mcp_blocking(
        &state,
        crate::ConnectMcpRequest {
            name: "Orion Moon".to_string(),
            command: String::new(),
            args: Vec::new(),
            env: std::collections::HashMap::new(),
            url: Some("http://127.0.0.1:1/mcp".to_string()),
            headers: std::collections::HashMap::new(),
        },
    )
    .expect("replace with unauthenticated MCP");

    assert!(
        state
            .secret_store
            .get(&secret_ref)
            .expect("read replaced secret")
            .is_none()
    );
}

#[test]
fn mcp_legacy_header_migration_moves_plaintext_into_secret_store() {
    use local_first_secrets::SecretStore;

    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().expect("memory store"),
    );
    let state = test_app_state_for_brief(facade);
    let user = crate::gateway_capability_user_id();
    let workspace = crate::gateway_capability_workspace_id();
    let provider = local_first_capabilities::ProviderId::new("mcp:legacy");
    let legacy = local_first_capabilities::CapabilityConnectionConfig::new(
        "mcp-legacy",
        provider.clone(),
        user.clone(),
        workspace.clone(),
        "Legacy MCP",
        "http:legacy",
    )
    .with_metadata(serde_json::json!({
        "transport": "http",
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "Bearer legacy-secret" }
    }));
    {
        let registry = state.capability_registry.lock().expect("registry lock");
        registry
            .upsert_provider_config(&local_first_capabilities::CapabilityProviderConfig::new(
                provider.clone(),
                local_first_capabilities::CapabilityProviderKind::Mcp,
                "Legacy MCP".to_string(),
                true,
            ))
            .expect("provider config");
        registry
            .upsert_connection_config(&legacy)
            .expect("legacy connection");
    }

    assert_eq!(
        crate::migrate_legacy_mcp_http_header_secrets(&state).expect("migration"),
        1
    );

    let migrated = state
        .capability_registry
        .lock()
        .expect("registry lock")
        .connection_configs(&user, &workspace)
        .expect("connection configs")
        .into_iter()
        .find(|connection| connection.provider_id == provider)
        .expect("migrated connection");
    let serialized = serde_json::to_string(&migrated).expect("serialize connection");
    assert!(migrated.metadata.get("headers").is_none());
    assert!(!serialized.contains("legacy-secret"));
    let secret_ref = migrated
        .secret_ref
        .parse::<local_first_secrets::SecretRef>()
        .expect("secret ref");
    let material = state
        .secret_store
        .get(&secret_ref)
        .expect("read secret")
        .expect("migrated secret");
    let headers = crate::mcp_http_headers_from_secret(material).expect("decode headers");
    assert_eq!(headers["Authorization"], "Bearer legacy-secret");
    assert_eq!(
        crate::migrate_legacy_mcp_http_header_secrets(&state).expect("idempotent migration"),
        0
    );
}

#[test]
fn browser_is_headless_by_default() {
    // Phase 1: the automated browser must not open a focus-stealing OS
    // window by default; visibility comes from the in-chat live view.
    assert_eq!(default_browser_headless_value(), "1");
}

#[test]
fn mcp_provider_slug_sanitizes_names() {
    assert_eq!(mcp_provider_slug("GitHub MCP"), "github-mcp");
    assert_eq!(mcp_provider_slug("  Filesystem!! "), "filesystem");
    assert_eq!(mcp_provider_slug("a/b\\c"), "a-b-c");
    assert_eq!(mcp_provider_slug("Wiki (local)"), "wiki-local");
    // Never empty, even for all-punctuation input.
    assert_eq!(mcp_provider_slug("***"), "server");
    assert_eq!(mcp_provider_slug(""), "server");
}

fn catalog_entry(slug: &str, desc: &str) -> (String, String, serde_json::Value) {
    (
        slug.to_string(),
        format!("{slug} {desc}").to_lowercase(),
        serde_json::json!({ "type": "function", "function": { "name": slug, "description": desc } }),
    )
}

#[test]
fn discovery_search_ranks_relevant_tools_first() {
    let index = vec![
        catalog_entry(
            "GMAIL_FETCH_EMAILS",
            "Fetch a list of email messages from Gmail",
        ),
        catalog_entry("GMAIL_SEND_EMAIL", "Send an email message via Gmail"),
        catalog_entry(
            "GOOGLECALENDAR_EVENTS_LIST",
            "List calendar events in a time range",
        ),
    ];
    let hits = search_composio_catalog(&index, "unread emails", 5);
    assert_eq!(
        hits.first().map(|(s, _)| s.as_str()),
        Some("GMAIL_FETCH_EMAILS")
    );
    // Calendar tool has no overlap with "email" tokens → excluded.
    assert!(hits.iter().all(|(s, _)| s.starts_with("GMAIL")));

    let cal = search_composio_catalog(&index, "calendar events", 5);
    assert_eq!(
        cal.first().map(|(s, _)| s.as_str()),
        Some("GOOGLECALENDAR_EVENTS_LIST")
    );

    // Empty query is a harmless browse (returns up to k), never panics.
    assert!(!search_composio_catalog(&index, "", 2).is_empty());
}

#[test]
fn rewrite_confirm_marker_to_done() {
    let original = "Ok.\n\nI need your confirmation for the action below.\n‹‹COMPOSIO_CONFIRM››{\"tool\":\"GMAIL_SEND_EMAIL\",\"arguments\":{}}‹‹/COMPOSIO_CONFIRM››\n";
    let done = rewrite_confirm_to_done(original, "GMAIL_SEND_EMAIL");
    assert!(done.contains("‹‹COMPOSIO_DONE››GMAIL_SEND_EMAIL‹‹/COMPOSIO_DONE››"));
    assert!(!done.contains("COMPOSIO_CONFIRM"));
    assert!(!done.contains("I need your confirmation"));
    assert!(done.starts_with("Ok."));
    // Idempotent when there is no confirm marker.
    assert_eq!(rewrite_confirm_to_done("plain", "X"), "plain");
}

#[test]
fn composio_tool_read_write_classification() {
    assert!(composio_tool_is_read("GMAIL_FETCH_EMAILS"));
    assert!(composio_tool_is_read("GOOGLECALENDAR_EVENTS_LIST"));
    assert!(!composio_tool_is_read("GMAIL_SEND_EMAIL"));
    assert!(!composio_tool_is_read("GMAIL_DELETE_MESSAGE"));
    assert!(!composio_tool_is_read("GOOGLECALENDAR_CREATE_EVENT"));
}

#[test]
fn prune_keeps_only_latest_browser_snapshot() {
    let ids: std::collections::BTreeSet<String> =
        ["b1".to_string(), "b2".to_string()].into_iter().collect();
    let mut messages = vec![
        serde_json::json!({ "role": "system", "content": "sys" }),
        serde_json::json!({ "role": "user", "content": "original" }),
        serde_json::json!({ "role": "assistant", "content": null }),
        // Older browser snapshot — should be stubbed.
        serde_json::json!({ "role": "tool", "tool_call_id": "b1", "content": "SNAP-OLD huge" }),
        // A non-browser tool result — must NOT be touched.
        serde_json::json!({ "role": "tool", "tool_call_id": "x9", "content": "composio result" }),
        // Latest browser snapshot — kept verbatim.
        serde_json::json!({ "role": "tool", "tool_call_id": "b2", "content": "SNAP-NEW huge" }),
    ];
    prune_browser_history(&mut messages, &ids);
    assert_eq!(messages[1]["content"], serde_json::json!("original"));
    assert_eq!(
        messages[3]["content"],
        serde_json::json!(PRUNED_SNAPSHOT_STUB)
    );
    assert_eq!(messages[4]["content"], serde_json::json!("composio result"));
    assert_eq!(messages[5]["content"], serde_json::json!("SNAP-NEW huge"));
}

#[test]
fn prune_keeps_only_latest_image_message() {
    let ids: std::collections::BTreeSet<String> = ["b1".to_string()].into_iter().collect();
    let mut messages = vec![
        serde_json::json!({ "role": "tool", "tool_call_id": "b1", "content": "snap" }),
        serde_json::json!({ "role": "user", "content": [
            { "type": "text", "text": "Screenshot 1:" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } }
        ]}),
        serde_json::json!({ "role": "user", "content": [
            { "type": "text", "text": "Screenshot 2:" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,BBB" } }
        ]}),
    ];
    prune_browser_history(&mut messages, &ids);
    // Older image message: image_url stripped to a text stub.
    assert!(!message_has_image_url(&messages[1]));
    // Latest image message: untouched.
    assert!(message_has_image_url(&messages[2]));
}

#[test]
fn prune_noop_without_browser_ids() {
    let ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut messages =
        vec![serde_json::json!({ "role": "tool", "tool_call_id": "b1", "content": "snap" })];
    let before = messages.clone();
    prune_browser_history(&mut messages, &ids);
    assert_eq!(messages, before);
}

#[test]
fn successor_checkpoint_restore_keeps_the_new_wake_input() {
    let mut prior = local_first_engine::LoopState::new();
    prior.messages = vec![
        serde_json::json!({ "role": "system", "content": "system" }),
        serde_json::json!({ "role": "user", "content": "original objective" }),
        serde_json::json!({ "role": "assistant", "content": "awaiting approval" }),
    ];
    let checkpoint = local_first_engine::LoopCheckpoint::from_state(1, &prior);

    let mut successor = local_first_engine::LoopState::new();
    successor.messages = vec![
        serde_json::json!({ "role": "system", "content": "system" }),
        serde_json::json!({
            "role": "user",
            "content": "Recent chat context:\nUser: original objective\n\nUser: The approved action failed. Continue from the durable checkpoint."
        }),
    ];

    super::gateway_agent_turn_outcomes::apply_agent_recovery_checkpoint(
        &mut successor,
        Some(checkpoint),
        Some(serde_json::json!({
            "role": "user",
            "content": "The approved action failed. Continue from the durable checkpoint."
        })),
    );

    assert_eq!(successor.messages.len(), 4);
    assert_eq!(
        successor.messages.last().unwrap()["content"],
        "The approved action failed. Continue from the durable checkpoint."
    );
}

#[test]
fn same_attempt_checkpoint_restore_does_not_duplicate_the_original_input() {
    let mut prior = local_first_engine::LoopState::new();
    prior.messages = vec![
        serde_json::json!({ "role": "system", "content": "system" }),
        serde_json::json!({ "role": "user", "content": "original objective" }),
    ];
    let checkpoint = local_first_engine::LoopCheckpoint::from_state(1, &prior);

    let mut recovered = prior.clone();
    super::gateway_agent_turn_outcomes::apply_agent_recovery_checkpoint(
        &mut recovered,
        Some(checkpoint),
        None,
    );

    assert_eq!(recovered.messages, prior.messages);
}

#[test]
fn act_gate_blocks_final_payment_click_without_approval() {
    // Machine floor marks e9 as the payment control — never label text.
    let floor: std::collections::HashSet<String> =
        std::collections::HashSet::from(["e9".to_string()]);
    let action = serde_json::json!({
        "kind": "click", "ref": "e9", "target_id": "chat_0", "action_class": "payment_commit"
    });
    assert!(browser_safety::evaluate_browser_action(&action, &floor, false, None).is_some());
}

#[test]
fn act_gate_allows_ordinary_click_before_payment() {
    let action = serde_json::json!({
        "kind": "click", "ref": "e9", "target_id": "chat_0", "action_class": "ordinary"
    });
    assert!(
        browser_safety::evaluate_browser_action(
            &action,
            &std::collections::HashSet::new(),
            false,
            None
        )
        .is_none()
    );
}

#[test]
fn act_gate_allows_typing_into_field() {
    let action =
        serde_json::json!({ "kind": "type", "ref": "e1", "text": "Napoli", "target_id": "chat_0" });
    assert!(
        browser_safety::evaluate_browser_action(
            &action,
            &std::collections::HashSet::new(),
            false,
            None
        )
        .is_none()
    );
}

#[test]
fn read_only_blocks_any_committing_action() {
    // In read-only (channel) turns, a plain click (even on a benign label) is a
    // committing action and must be refused.
    let action = serde_json::json!({ "kind": "click", "ref": "e7", "target_id": "chat_0" });
    assert!(browser_safety::is_committing_action(&action));
}

#[test]
fn snapshot_text_reads_snapshot_field() {
    let value = serde_json::json!({ "snapshot": "- page", "url": "https://x" });
    assert_eq!(browser_snapshot_text(&value), "- page");
    assert_eq!(browser_snapshot_text(&serde_json::json!({})), "");
}

#[test]
fn browser_floor_refs_reads_sidecar_payment_floor() {
    let value = serde_json::json!({
        "snapshot": "- button \"Conferma\" [ref=e9]",
        "paymentFloorRefs": ["e9"]
    });
    let refs = super::browser_floor_refs(&value);
    assert!(refs.contains("e9"));
    assert_eq!(refs.len(), 1);

    let empty = serde_json::json!({ "snapshot": "- button \"Cerca\" [ref=e7]" });
    assert!(super::browser_floor_refs(&empty).is_empty());
}

#[test]
fn sidecar_deadlines_match_the_budget() {
    use std::time::Duration;
    assert_eq!(
        super::browser_call_deadline(local_first_browser_automation::BrowserMethod::Navigate),
        Duration::from_secs(25)
    );
    // Open creates+navigates a fresh tab (heavier than Navigate) → same 25s, not the 10s catch-all.
    assert_eq!(
        super::browser_call_deadline(local_first_browser_automation::BrowserMethod::Open),
        Duration::from_secs(25)
    );
    assert_eq!(
        super::browser_call_deadline(local_first_browser_automation::BrowserMethod::Act),
        Duration::from_secs(15)
    );
    assert_eq!(
        super::browser_call_deadline(local_first_browser_automation::BrowserMethod::Snapshot),
        Duration::from_secs(10)
    );
}

#[test]
fn active_llm_concurrency_honors_env_override() {
    // The env override is the deterministic path (registry state is shared
    // across tests and depends on the on-disk file). Restore it after.
    // SAFETY: env mutation is `unsafe` under edition 2024; these tests run
    // single-threaded within the gateway test binary so there is no data race
    // with concurrent readers of the process environment.
    let env = TestEnv::acquire();
    env.set("HOMUN_LLM_CONCURRENCY", Some("7"));
    assert_eq!(active_llm_concurrency(), 7);
    env.set("HOMUN_LLM_CONCURRENCY", Some("1"));
    assert_eq!(active_llm_concurrency(), 1);
    // 0 must be ignored (would stall the LLM resource) — fall back to the
    // registry/locality path, which is >= 1 by construction.
    env.set("HOMUN_LLM_CONCURRENCY", Some("0"));
    assert!(active_llm_concurrency() >= 1);
}

#[test]
fn llm_concurrency_view_reports_effective_and_locality() {
    // The view is self-consistent regardless of registry state: `effective`
    // equals the override when set, otherwise 1 (local) or 4 (cloud) from the
    // inferred locality, and `effective` is always >= 1.
    let view = llm_concurrency_view();
    assert!(view.effective >= 1);
    if let Some(forced) = view.r#override {
        assert_eq!(view.effective, forced);
    } else {
        assert_eq!(view.effective, if view.inferred_local { 1 } else { 4 });
    }
}

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
    let lease = local_first_task_runtime::LeaseManager::new(time::Duration::minutes(5));
    let selected = next_ready_task_across_workspaces(
        &store,
        &user,
        time::OffsetDateTime::now_utc(),
        &governor,
        &lease,
    )
    .unwrap()
    .expect("personal task is visible");

    assert_eq!(selected.task_id.as_str(), "turn_channel_1");
    assert_eq!(selected.workspace_id, personal);
    assert_ne!(selected.workspace_id, project);
}

#[test]
fn task_executor_requeues_waiting_resource_before_scheduling() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let running = TaskRecord::new(
        "running",
        user.clone(),
        workspace.clone(),
        "test.task",
        "Running",
        serde_json::json!({}),
    )
    .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    let blocked = TaskRecord::new(
        "blocked",
        user.clone(),
        workspace.clone(),
        "test.task",
        "Blocked",
        serde_json::json!({}),
    )
    .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    store.insert_task(&running).unwrap();
    store.insert_task(&blocked).unwrap();
    let governor =
        ResourceGovernor::new(ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1));

    governor.reserve(&store, &running, "worker_a").unwrap();
    governor
        .mark_waiting_if_unavailable(&store, &blocked)
        .unwrap();
    governor.release(&store, &running).unwrap();

    assert_eq!(
        requeue_waiting_resource_tasks(&store, &user, &workspace, &governor).unwrap(),
        1
    );
    let ready = local_first_task_runtime::TaskScheduler::new()
        .ready_tasks(
            &store,
            &user,
            &workspace,
            time::OffsetDateTime::now_utc(),
            10,
        )
        .unwrap();

    assert!(ready.iter().any(|task| task.task_id.as_str() == "blocked"));
}

#[test]
fn scheduled_automation_materializes_visible_proactive_task() {
    let store = TaskStore::open_in_memory().unwrap();
    let now = time::OffsetDateTime::now_utc();
    let automation = Automation {
        id: "auto_sched".to_string(),
        user_id: UserId::new("user_auto"),
        workspace_id: WorkspaceId::new("workspace_auto"),
        title: "Daily check".to_string(),
        trigger: AutomationTrigger::Schedule {
            recurrence: "every 1d".to_string(),
            tz: None,
        },
        prompt: "Check the project and report status".to_string(),
        approval: ApprovalPolicy::Confirm,
        enabled: true,
        source: AutomationSource::Manual,
        task_id: None,
        created_at: now,
        updated_at: now,
        last_fired_at: None,
        state: None,
    };

    let task_id = super::materialize_automation_task(&store, &automation)
        .unwrap()
        .expect("scheduled automation creates a driving task");
    let task = store
        .get_task(
            &TaskId::new(task_id.clone()),
            &UserId::new("user_auto"),
            &WorkspaceId::new("workspace_auto"),
        )
        .unwrap()
        .expect("driving task is persisted");

    assert!(task_id.starts_with("autorun_"));
    assert_eq!(task.kind, "proactive_prompt");
    assert_eq!(task.user_id.as_str(), "user_auto");
    assert_eq!(task.workspace_id.as_str(), "workspace_auto");
    assert_eq!(task.goal, automation.prompt);
    assert_eq!(task.recurrence.as_deref(), Some("every 1d"));
    assert!(task.not_before.expect("first run scheduled") > now);
    assert_eq!(task.input_json["automation_id"], "auto_sched");
    assert_eq!(task.input_json["approval"], "confirm");
    let thread_id = task.input_json["thread_id"]
        .as_str()
        .expect("scheduled task has canonical thread scope");
    assert_eq!(thread_id, format!("channel_scheduled_{task_id}"));
    let mut acquired = task.clone();
    acquired.status = TaskStatus::Running;
    acquired.lease_owner = Some("worker-test".into());
    acquired.lease_fencing_token = Some(1);
    let contract = super::execution_runtime::contract_for_acquired_task(&acquired)
        .expect("scoped proactive contract");
    assert_eq!(
        contract.as_ref().scope.thread_id.as_deref(),
        Some(thread_id)
    );
    let queue = local_first_task_runtime::TaskUiReadModel::new(&store)
        .queue_snapshot(
            &UserId::new("user_auto"),
            &WorkspaceId::new("workspace_auto"),
        )
        .unwrap();
    assert_eq!(queue.queued.len(), 1);
    assert_eq!(queue.queued[0].thread_id.as_deref(), Some(thread_id));
    let queue_item = super::task_item_response(queue.queued[0].clone()).unwrap();
    assert_eq!(queue_item.thread_id.as_deref(), Some(thread_id));

    let mut visible_turn = TaskRecord::new(
        "turn_auto_sched",
        UserId::new("user_auto"),
        WorkspaceId::new("workspace_auto"),
        "chat_turn",
        "Visible automation turn",
        serde_json::json!({ "thread_id": thread_id }),
    );
    visible_turn.status = TaskStatus::WaitingUserApproval;
    store
        .insert_chat_turn(
            &visible_turn,
            thread_id,
            "req-auto-sched",
            "automation",
            "confirm",
        )
        .unwrap();
    let projection = store.project_kernel_thread(thread_id, 200).unwrap();
    assert_eq!(projection.thread_id, thread_id);
    assert_eq!(
        projection.turn.status, "waiting_approval",
        "automation-started visible turns must use the same kernel status vocabulary as chat turns"
    );
    assert_eq!(task.retry_policy.max_attempts, 3);
    assert_eq!(task.retry_policy.backoff_seconds, 120);
}

#[tokio::test(flavor = "current_thread")]
async fn automation_dry_run_validates_without_materializing_task() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let dir = isolated_gateway_test_dir("automation-dry-run");
    std::fs::create_dir_all(&dir).unwrap();
    let _data = TestGatewayDataDir::new(&dir);
    let state = super::AppState::for_tests();
    let app = automation_route_test_app(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/automations/dry-run")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "workspace_id": "workspace_auto",
                        "title": "Daily check",
                        "trigger": {
                            "type": "schedule",
                            "recurrence": "every 1d",
                            "tz": "Europe/Rome"
                        },
                        "prompt": "Check the project and report status",
                        "approval": "confirm",
                        "source": "manual"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = memory_source_response_json(response).await;

    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(body["valid"], true);
    assert_eq!(body["workspace_id"], "workspace_auto");
    assert_eq!(body["trigger_kind"], "schedule");
    assert_eq!(body["approval"], "confirm");
    assert_eq!(body["source"], "manual");
    assert_eq!(body["would_create_automation"], true);
    assert_eq!(body["would_materialize_task"], true);
    assert!(body["next_run"].as_i64().is_some());
    assert!(body.get("title").is_none());
    assert!(body.get("prompt").is_none());
    assert!(body.get("trigger").is_none());

    {
        let store = super::lock_task_store(&state).unwrap();
        assert!(
            store
                .list_tasks(
                    &super::gateway_user_id(),
                    &WorkspaceId::new("workspace_auto")
                )
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .list_automations(
                    &super::gateway_user_id(),
                    &WorkspaceId::new("workspace_auto")
                )
                .unwrap()
                .is_empty()
        );
    }

    let invalid = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/automations/dry-run?workspace_id=workspace_auto")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "title": "Broken schedule",
                        "trigger": {
                            "type": "schedule",
                            "recurrence": "not a recurrence"
                        },
                        "prompt": "This should not materialize anything"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = memory_source_response_json(invalid).await;

    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "bad_recurrence");
    let store = super::lock_task_store(&state).unwrap();
    assert!(
        store
            .list_tasks(
                &super::gateway_user_id(),
                &WorkspaceId::new("workspace_auto")
            )
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_automations(
                &super::gateway_user_id(),
                &WorkspaceId::new("workspace_auto")
            )
            .unwrap()
            .is_empty()
    );
}

#[test]
fn automation_json_exposes_workspace_scope() {
    let now = time::OffsetDateTime::now_utc();
    let automation = Automation {
        id: "auto_project".to_string(),
        user_id: UserId::new("user_auto"),
        workspace_id: WorkspaceId::new("workspace_project"),
        title: "Project automation".to_string(),
        trigger: AutomationTrigger::Schedule {
            recurrence: "every 1d".to_string(),
            tz: None,
        },
        prompt: "Check project status".to_string(),
        approval: ApprovalPolicy::Confirm,
        enabled: true,
        source: AutomationSource::Manual,
        task_id: Some("autorun_project".to_string()),
        created_at: now,
        updated_at: now,
        last_fired_at: None,
        state: None,
    };

    let json = super::automation_to_json(&automation);

    assert_eq!(json["workspace_id"], "workspace_project");
}

#[test]
fn automation_projection_uses_kernel_contract_for_waiting_and_completed_turns() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_auto");
    let workspace = WorkspaceId::new("workspace_auto");
    let thread_id = "channel_scheduled_autorun_projection";
    let automation_task = TaskRecord::new(
        "autorun_projection",
        user.clone(),
        workspace.clone(),
        "proactive_prompt",
        "Run projected automation",
        serde_json::json!({
            "automation_id": "auto_projection",
            "thread_id": thread_id,
            "approval": "confirm",
        }),
    );
    store.insert_task(&automation_task).unwrap();

    let visible_turn = TaskRecord::new(
        "turn_auto_projection",
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "Visible projected automation turn",
        serde_json::json!({ "thread_id": thread_id }),
    );
    store
        .insert_chat_turn(
            &visible_turn,
            thread_id,
            "req-auto-projection",
            "automation",
            "confirm",
        )
        .unwrap();
    let approval = local_first_task_runtime::ApprovalGate::new()
        .request_approval(
            &store,
            &visible_turn.task_id,
            &user,
            &workspace,
            "connector.write",
            "high",
            "connector",
            "Automation write requires confirmation",
        )
        .unwrap();

    let queue = local_first_task_runtime::TaskUiReadModel::new(&store)
        .queue_snapshot(&user, &workspace)
        .unwrap();
    assert_eq!(queue.queued[0].thread_id.as_deref(), Some(thread_id));
    let waiting_projection = store.project_kernel_thread(thread_id, 200).unwrap();
    assert_eq!(waiting_projection.turn.status, "waiting_approval");
    assert_eq!(
        waiting_projection.actions.composer_mode,
        "reply_to_user_wait"
    );
    assert!(waiting_projection.attention.awaiting_user);

    local_first_task_runtime::ApprovalGate::new()
        .approve(&store, &approval.approval_id, "tester")
        .unwrap();
    store
        .insert_turn_event(
            visible_turn.task_id.as_str(),
            local_first_task_runtime::TurnEventKind::Done,
            serde_json::json!({ "text": "Automation completed." }),
        )
        .unwrap();
    store
        .update_task_status(
            &visible_turn.task_id,
            &user,
            &workspace,
            TaskStatus::Completed,
            None,
        )
        .unwrap();

    let completed_projection = store.project_kernel_thread(thread_id, 200).unwrap();
    assert_eq!(completed_projection.turn.status, "completed");
    assert_eq!(completed_projection.turn.active_turn_id, None);
    assert_eq!(completed_projection.actions.composer_mode, "new_turn");
}

#[test]
fn cancelling_automation_cancels_every_open_occurrence_only() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_auto");
    let workspace = WorkspaceId::new("workspace_auto");
    let automation_id = "auto_sched";

    let mut completed = TaskRecord::new(
        "autorun_sched",
        user.clone(),
        workspace.clone(),
        "proactive_prompt",
        "Completed occurrence",
        serde_json::json!({"automation_id": automation_id}),
    );
    completed.status = TaskStatus::Completed;
    let queued = TaskRecord::new(
        "autorun_sched@occ@200",
        user.clone(),
        workspace.clone(),
        "proactive_prompt",
        "Future occurrence",
        serde_json::json!({"automation_id": automation_id}),
    );
    let unrelated = TaskRecord::new(
        "autorun_other",
        user.clone(),
        workspace.clone(),
        "proactive_prompt",
        "Other automation",
        serde_json::json!({"automation_id": "auto_other"}),
    );
    store.insert_task(&completed).unwrap();
    store.insert_task(&queued).unwrap();
    store.insert_task(&unrelated).unwrap();

    let cancelled = super::cancel_automation_tasks(
        &store,
        automation_id,
        &user,
        &workspace,
        "automation disabled or deleted",
    )
    .unwrap();

    assert_eq!(cancelled, 1);
    assert_eq!(
        store
            .get_task(&completed.task_id, &user, &workspace)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Completed
    );
    assert_eq!(
        store
            .get_task(&queued.task_id, &user, &workspace)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Cancelled
    );
    assert_eq!(
        store
            .get_task(&unrelated.task_id, &user, &workspace)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Queued
    );
}

#[test]
fn recurring_automation_requeues_only_while_rule_is_enabled() {
    let store = TaskStore::open_in_memory().unwrap();
    let now = time::OffsetDateTime::now_utc();
    let mut automation = Automation {
        id: "auto_sched".to_string(),
        user_id: UserId::new("user_auto"),
        workspace_id: WorkspaceId::new("workspace_auto"),
        title: "Daily check".to_string(),
        trigger: AutomationTrigger::Schedule {
            recurrence: "every 1d".to_string(),
            tz: None,
        },
        prompt: "Check the project".to_string(),
        approval: ApprovalPolicy::Confirm,
        enabled: false,
        source: AutomationSource::Manual,
        task_id: Some("autorun_sched".to_string()),
        created_at: now,
        updated_at: now,
        last_fired_at: None,
        state: None,
    };
    store.upsert_automation(&automation).unwrap();
    let mut completed = TaskRecord::new(
        "autorun_sched",
        automation.user_id.clone(),
        automation.workspace_id.clone(),
        "proactive_prompt",
        &automation.prompt,
        serde_json::json!({"automation_id": automation.id}),
    );
    completed.status = TaskStatus::Completed;
    completed.recurrence = Some("every 1d".to_string());

    assert!(
        super::insert_next_recurrence_if_active(&store, &completed, now)
            .unwrap()
            .is_none()
    );

    automation.enabled = true;
    store.upsert_automation(&automation).unwrap();
    let next = super::insert_next_recurrence_if_active(&store, &completed, now)
        .unwrap()
        .expect("enabled automation must enqueue the next occurrence");
    assert!(next.as_str().starts_with("autorun_sched@occ@"));
}

#[test]
fn evented_proactive_task_uses_owning_thread_metadata() {
    let task = TaskRecord::new(
        "autorun_event",
        UserId::new("user_auto"),
        WorkspaceId::new("workspace_project"),
        "proactive_prompt",
        "Summarize the inbound WhatsApp message",
        serde_json::json!({
            "automation_id": "auto_channel",
            "source": "channel_event",
            "thread_id": "channel_whatsapp_39333",
            "thread_source": "whatsapp",
            "thread_channel": "whatsapp",
            "thread_title": "WhatsApp · Elena",
        }),
    );

    let plan = super::proactive_thread_plan(&task, &task.goal);

    assert_eq!(plan.thread_id.as_deref(), Some("channel_whatsapp_39333"));
    assert_eq!(plan.workspace_id, "workspace_project");
    assert_eq!(plan.source, "whatsapp");
    assert_eq!(plan.channel.as_deref(), Some("whatsapp"));
    assert_eq!(plan.title, "WhatsApp · Elena");
    assert!(plan.scheduled_root.is_none());
}

#[test]
fn automation_run_updates_rule_in_task_scope_not_gateway_scope() {
    let _env = TestEnv::acquire();
    let store = TaskStore::open_in_memory().unwrap();
    let now = time::OffsetDateTime::now_utc();
    let mut project_automation = Automation {
        id: "auto_channel".to_string(),
        user_id: UserId::new("user_auto"),
        workspace_id: WorkspaceId::new("workspace_project"),
        title: "Summarize Elena".to_string(),
        trigger: AutomationTrigger::Event {
            event: local_first_task_runtime::EventTrigger::ChannelMessage {
                channel: Some("whatsapp".to_string()),
                from: Some("Elena".to_string()),
            },
        },
        prompt: "Summarize the inbound WhatsApp message".to_string(),
        approval: ApprovalPolicy::Confirm,
        enabled: true,
        source: AutomationSource::Manual,
        task_id: None,
        created_at: now,
        updated_at: now,
        last_fired_at: None,
        state: None,
    };
    let mut gateway_automation = project_automation.clone();
    gateway_automation.user_id = super::gateway_user_id();
    gateway_automation.workspace_id = super::gateway_workspace_id();
    gateway_automation.title = "Gateway shadow".to_string();
    store.upsert_automation(&project_automation).unwrap();
    store.upsert_automation(&gateway_automation).unwrap();

    let task = TaskRecord::new(
        "autorun_event",
        project_automation.user_id.clone(),
        project_automation.workspace_id.clone(),
        "proactive_prompt",
        &project_automation.prompt,
        serde_json::json!({
            "automation_id": project_automation.id,
            "source": "channel_event",
        }),
    );
    super::record_automation_run_in_store(
        &store,
        "auto_channel",
        &task,
        true,
        "",
        now + time::Duration::seconds(3),
    );

    project_automation = store
        .get_automation(
            "auto_channel",
            &UserId::new("user_auto"),
            &WorkspaceId::new("workspace_project"),
        )
        .unwrap()
        .expect("project automation");
    gateway_automation = store
        .get_automation(
            "auto_channel",
            &super::gateway_user_id(),
            &super::gateway_workspace_id(),
        )
        .unwrap()
        .expect("gateway automation");

    assert!(project_automation.last_fired_at.is_some());
    assert!(gateway_automation.last_fired_at.is_none());
    assert_eq!(
        store
            .recent_automation_runs("auto_channel", 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn create_automation_from_chat_uses_active_scope() {
    let _env = TestEnv::acquire();
    let store = TaskStore::open_in_memory().unwrap();
    let args = serde_json::json!({
        "title": "Project channel summary",
        "prompt": "Summarize inbound project messages.",
        "trigger_type": "event",
        "event_channel": "whatsapp",
        "event_from": "Elena"
    })
    .to_string();

    let response = super::create_automation_from_chat_with_store(
        &store,
        &args,
        &UserId::new("user_project"),
        &WorkspaceId::new("workspace_project"),
    );

    assert!(response.contains("Automation created"), "{response}");
    assert!(
        store
            .list_automations(
                &UserId::new("user_project"),
                &WorkspaceId::new("workspace_project"),
            )
            .unwrap()
            .iter()
            .any(|automation| automation.title == "Project channel summary")
    );
    assert!(
        store
            .list_automations(&super::gateway_user_id(), &super::gateway_workspace_id())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn create_automation_from_chat_can_create_disabled_without_materializing_schedule() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_project");
    let workspace = WorkspaceId::new("workspace_project");
    let args = serde_json::json!({
        "title": "Disabled smoke automation",
        "prompt": "Summarize a smoke signal.",
        "trigger_type": "schedule",
        "recurrence": "every 1d",
        "enabled": false,
        "require_confirmation": true
    })
    .to_string();

    let response = super::create_automation_from_chat_with_store(&store, &args, &user, &workspace);

    assert!(response.contains("Automation created"), "{response}");
    assert!(response.contains("disabled"), "{response}");
    let automations = store.list_automations(&user, &workspace).unwrap();
    assert_eq!(automations.len(), 1);
    assert_eq!(automations[0].title, "Disabled smoke automation");
    assert!(!automations[0].enabled);
    assert_eq!(automations[0].task_id, None);
}

#[test]
fn channel_message_event_envelope_is_stable_and_visible() {
    let message = super::ChannelInbound {
        sender: "393331234567@lid".to_string(),
        sender_name: "Elena".to_string(),
        content: "Please summarize this".to_string(),
        chat: Some("393331234567@lid".to_string()),
        sender_pn: Some("393331234567@s.whatsapp.net".to_string()),
        message_id: Some("wamid.42".to_string()),
        ts: Some(1_782_500_000),
    };

    let key = super::channel_message_event_key("whatsapp", &message);
    let envelope = super::channel_message_event_envelope(
        "whatsapp",
        &message,
        "workspace_project",
        "channel_whatsapp_elena",
        "WhatsApp · Elena",
        "Elena",
    );

    assert_eq!(key, "whatsapp:message:wamid.42");
    assert_eq!(envelope["event_id"], key);
    assert_eq!(envelope["dedup_key"], key);
    assert_eq!(envelope["source_kind"], "channel");
    assert_eq!(envelope["provider_id"], "whatsapp");
    assert_eq!(envelope["event_type"], "message.received");
    assert_eq!(envelope["workspace_id"], "workspace_project");
    assert_eq!(envelope["actor"]["display_name"], "Elena");
    assert_eq!(envelope["actor"]["identifier"], "393331234567@lid");
    assert_eq!(
        envelope["visibility"]["thread_id"],
        "channel_whatsapp_elena"
    );
    assert_eq!(envelope["visibility"]["title"], "WhatsApp · Elena");
    assert_eq!(envelope["payload"]["message_id"], "wamid.42");
    assert_eq!(envelope["payload"]["has_content"], true);
}

#[test]
fn connector_poll_event_envelope_is_stable_and_visible() {
    let now = time::OffsetDateTime::now_utc();
    let automation = Automation {
        id: "auto_connector".to_string(),
        user_id: UserId::new("user"),
        workspace_id: WorkspaceId::new("workspace_project"),
        title: "Unread Gmail".to_string(),
        trigger: AutomationTrigger::Event {
            event: local_first_task_runtime::EventTrigger::ConnectorPoll {
                tool: "GMAIL_FETCH_EMAILS".to_string(),
                args: serde_json::json!({"query": "is:unread"}),
                key_field: "messageId".to_string(),
                label: Some("Gmail".to_string()),
            },
        },
        prompt: "Summarize it".to_string(),
        approval: ApprovalPolicy::Confirm,
        enabled: true,
        source: AutomationSource::Manual,
        task_id: None,
        created_at: now,
        updated_at: now,
        last_fired_at: None,
        state: None,
    };
    let item = serde_json::json!({
        "messageId": "msg_42",
        "subject": "Quarterly update"
    });
    let envelope = super::connector_poll_event_envelope(
        &automation,
        "GMAIL_FETCH_EMAILS",
        "Gmail",
        "messageId",
        &item,
    );

    assert_eq!(
        envelope["event_id"],
        "connector:GMAIL_FETCH_EMAILS:messageId:msg_42"
    );
    assert_eq!(
        envelope["dedup_key"],
        "connector:GMAIL_FETCH_EMAILS:messageId:msg_42"
    );
    assert_eq!(envelope["source_kind"], "connector");
    assert_eq!(envelope["provider_id"], "GMAIL_FETCH_EMAILS");
    assert_eq!(envelope["event_type"], "item.detected");
    assert_eq!(envelope["workspace_id"], "workspace_project");
    assert_eq!(envelope["actor"]["display_name"], "Gmail");
    assert_eq!(envelope["actor"]["identifier"], "GMAIL_FETCH_EMAILS");
    assert_eq!(envelope["payload"]["key_field"], "messageId");
    assert_eq!(envelope["payload"]["key_value"], "msg_42");
    assert_eq!(envelope["payload"]["item"]["subject"], "Quarterly update");
    assert_eq!(envelope["visibility"]["title"], "Automation · Gmail");
}

#[test]
fn scheduled_proactive_task_keeps_stable_scheduled_thread_plan() {
    let task = TaskRecord::new(
        "autorun_sched@occ@123",
        UserId::new("user_auto"),
        WorkspaceId::new("workspace_project"),
        "proactive_prompt",
        "Check the project status",
        serde_json::json!({ "automation_id": "auto_sched" }),
    );

    let plan = super::proactive_thread_plan(&task, &task.goal);

    assert!(plan.thread_id.is_none());
    assert_eq!(plan.workspace_id, "workspace_project");
    assert_eq!(plan.source, "scheduled");
    assert_eq!(plan.channel, None);
    assert_eq!(plan.title, "Pianificato · Check the project status");
    assert_eq!(plan.scheduled_root.as_deref(), Some("autorun_sched"));
}

#[test]
fn scheduled_occurrences_reuse_one_visible_thread() {
    let chat = ChatStore::in_memory().unwrap();
    let root = scheduled_thread_sender_for_task_id("autorun_abc@occ@123");
    let next = scheduled_thread_sender_for_task_id("autorun_abc@occ@456");
    let title = scheduled_thread_title("Check the project and report status");

    assert_eq!(root, "autorun_abc");
    assert_eq!(next, root);
    let first = chat
        .find_or_create_channel_thread(&super::base_workspace_id(), "scheduled", &root, &title)
        .unwrap();
    let second = chat
        .find_or_create_channel_thread(&super::base_workspace_id(), "scheduled", &next, &title)
        .unwrap();

    assert_eq!(first.thread_id, "channel_scheduled_autorun_abc");
    assert_eq!(second.thread_id, first.thread_id);
    assert_eq!(second.source.as_deref(), Some("scheduled"));
}

#[test]
fn thread_turn_started_event_carries_visible_message_ids() {
    let turn = super::VisibleConversationTurn {
        turn_id: "turn_1".to_string(),
        user_message_id: "msg_user".to_string(),
        assistant_message_id: "msg_assistant".to_string(),
    };

    let event = super::thread_turn_started_event(
        "thread_1",
        "__personal__",
        "whatsapp",
        Some("whatsapp"),
        "WhatsApp · Fabio",
        &turn,
    );

    assert_eq!(event["type"], "thread.turn_started");
    assert_eq!(event["thread_id"], "thread_1");
    assert_eq!(event["workspace"], "__personal__");
    assert_eq!(event["source"], "whatsapp");
    assert_eq!(event["channel"], "whatsapp");
    assert_eq!(event["title"], "WhatsApp · Fabio");
    assert_eq!(event["turn_id"], "turn_1");
    assert_eq!(event["user_message_id"], "msg_user");
    assert_eq!(event["assistant_message_id"], "msg_assistant");
}

#[test]
fn visible_turn_reuses_preseeded_assistant_across_retries() {
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .create_thread("workspace_test")
        .unwrap();
    let user = super::channel_chat_message_with_id("user", "prompt", "local_user_r1");
    let mut assistant = super::channel_chat_message_with_id("assistant", "", "local_assistant_r1");
    assistant.text.clear();
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Streaming;
    super::lock_store(&state)
        .unwrap()
        .commit_prompt_result(&thread.thread_id, &user, &assistant, None)
        .unwrap();

    let first = super::start_visible_conversation_turn(
        &state,
        &thread.thread_id,
        "workspace_test",
        "interactive",
        None,
        "Thread",
        "prompt",
        Some("local_user_r1"),
        Some("local_assistant_r1"),
        Some("turn_r1"),
        None,
    )
    .unwrap();
    let retry = super::start_visible_conversation_turn(
        &state,
        &thread.thread_id,
        "workspace_test",
        "interactive",
        None,
        "Thread",
        "prompt",
        Some("local_user_r1"),
        Some("local_assistant_r1"),
        Some("turn_r1"),
        None,
    )
    .unwrap();

    assert_eq!(first.user_message_id, "local_user_r1");
    assert_eq!(first.assistant_message_id, "local_assistant_r1");
    assert_eq!(retry.assistant_message_id, first.assistant_message_id);
    let messages = super::lock_store(&state)
        .unwrap()
        .messages(&thread.thread_id)
        .unwrap()
        .messages;
    assert_eq!(
        messages
            .iter()
            .filter(|message| message.id == "local_assistant_r1")
            .count(),
        1
    );
    assert_eq!(
        messages
            .iter()
            .find(|message| message.id == "local_assistant_r1")
            .expect("stable assistant placeholder")
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Streaming
    );
}

#[test]
fn broker_enqueue_preallocates_one_linked_user_and_assistant() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-preallocated-visible-turn");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let thread = chat.create_thread("workspace_test").unwrap();
    let input = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: thread.thread_id.clone(),
        request_id: "r1".to_string(),
        assistant_message_id: "local_assistant_r1".to_string(),
        prompt: "prompt".to_string(),
        visible_prompt: None,
        images: Vec::new(),
        attachments: None,
        mode: None,
        model: None,
        source: local_first_task_runtime::broker::ChatTurnSource::Interactive,
        approval: local_first_task_runtime::broker::TurnApproval::Full,
    };
    let user_id = super::gateway_user_id();
    let workspace_id = local_first_task_runtime::WorkspaceId::new("workspace_test");

    local_first_task_runtime::broker::enqueue_chat_turn_atomic(
        &tasks,
        &user_id,
        &workspace_id,
        &input,
        |tx| super::insert_broker_turn_messages(tx, &input),
    )
    .unwrap();

    let messages = chat.messages(&thread.thread_id).unwrap().messages;
    assert_eq!(
        messages
            .iter()
            .filter(|message| message.id == "local_user_r1")
            .count(),
        1
    );
    assert_eq!(
        messages
            .iter()
            .filter(|message| message.id == "local_assistant_r1")
            .count(),
        1
    );
    assert_eq!(
        messages.last().map(|message| message.id.as_str()),
        Some("local_assistant_r1")
    );
    assert_eq!(
        chat.message(&thread.thread_id, "local_assistant_r1")
            .unwrap()
            .unwrap()
            .memory_reuse
            .unwrap()
            .write_policy,
        local_first_memory::MemoryWritePolicy::BlockedUnknown
    );
    assert_eq!(
        chat.message(&thread.thread_id, "local_assistant_r1")
            .unwrap()
            .unwrap()
            .linked_task_id
            .as_deref(),
        Some(local_first_task_runtime::broker::chat_turn_task_id(&input.request_id).as_str())
    );
    assert_eq!(
        chat.message(&thread.thread_id, "local_assistant_r1")
            .unwrap()
            .unwrap()
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Streaming
    );
}

#[tokio::test]
async fn broker_temporal_preflight_completes_past_slot_without_task_or_browser_lease() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-temporal-preflight");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let workspace_id = super::gateway_workspace_id();
    let thread = chat.create_thread(workspace_id.as_str()).unwrap();
    let mut state = AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let request_id = "past-slot";
    let turn_id = local_first_task_runtime::broker::chat_turn_task_id(request_id);
    let user_id = super::gateway_user_id();

    let (status, Json(body)) = super::enqueue_turn(
        State(state.clone()),
        Json(local_first_desktop_gateway::EnqueueTurnRequest {
            thread_id: thread.thread_id.clone(),
            request_id: Some(request_id.to_string()),
            prompt: "mi trovi un treno da Milano a Roma per il 1 gennaio 2020 verso le 8 del mattino. Cerca e leggi i risultati, non prenotare e non comprare nulla.".to_string(),
            visible_prompt: None,
            images: Vec::new(),
            attachments: None,
            mode: None,
            model: None,
            source: Some("interactive".to_string()),
            routing_binding: None,
        }),
    )
    .await
    .unwrap();

    assert_eq!(status, axum::http::StatusCode::CREATED);
    assert_eq!(body["status"], "completed");
    assert_eq!(body["turn_id"], turn_id.as_str());

    {
        let task_store = state.task_store.lock().unwrap();
        let turn = task_store
            .get_task(&turn_id, &user_id, &workspace_id)
            .unwrap()
            .expect("temporal preflight must create an inspectable terminal chat_turn");
        assert_eq!(
            turn.status,
            local_first_task_runtime::TaskStatus::Completed,
            "temporal preflight must be terminal and must not enter the worker queue",
        );
        assert_eq!(
            turn.input_json["thread_id"].as_str(),
            Some(thread.thread_id.as_str())
        );
        assert_eq!(turn.input_json["request_id"].as_str(), Some(request_id));
        assert_eq!(
            task_store
                .resource_usage(
                    &user_id,
                    &workspace_id,
                    local_first_task_runtime::ResourceClass::BrowserSession,
                )
                .unwrap(),
            0,
            "temporal preflight must not reserve the browser",
        );
        let events = task_store.read_turn_events(turn_id.as_str(), 0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].kind,
            local_first_task_runtime::TurnEventKind::Done
        );
        assert!(
            events[0].payload["text"]
                .as_str()
                .unwrap_or_default()
                .contains("gia' nel passato")
        );
    }

    let Json(turn_body) = super::get_turn(
        Path(turn_id.as_str().to_string()),
        State(state.clone()),
        Query(super::TurnSinceQuery::default()),
    )
    .await
    .unwrap();
    assert_eq!(turn_body["status"], "completed");
    assert_eq!(turn_body["thread_id"], thread.thread_id);
    assert_eq!(turn_body["request_id"], request_id);

    let messages = super::lock_store(&state)
        .unwrap()
        .messages(&thread.thread_id)
        .unwrap()
        .messages;
    let assistant = messages
        .iter()
        .find(|message| message.id == "local_assistant_past-slot")
        .expect("preflight assistant message");
    assert_eq!(
        assistant.delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Delivered
    );
    assert!(assistant.text.contains("gia' nel passato"));
}

#[tokio::test]
async fn broker_get_turn_honors_workspace_query_for_non_default_workspace() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-turn-workspace-query");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let workspace_id = local_first_task_runtime::WorkspaceId::new("workspace_turn_scope_query");
    let thread = chat.create_thread(workspace_id.as_str()).unwrap();
    let mut state = AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let request_id = "workspace-scope-past-slot";
    let turn_id = local_first_task_runtime::broker::chat_turn_task_id(request_id);

    let (status, Json(body)) = super::enqueue_turn(
        State(state.clone()),
        Json(local_first_desktop_gateway::EnqueueTurnRequest {
            thread_id: thread.thread_id.clone(),
            request_id: Some(request_id.to_string()),
            prompt: "mi trovi un treno da Milano a Roma per il 1 gennaio 2020 verso le 8 del mattino. Cerca e leggi i risultati, non prenotare e non comprare nulla.".to_string(),
            visible_prompt: None,
            images: Vec::new(),
            attachments: None,
            mode: None,
            model: None,
            source: Some("interactive".to_string()),
            routing_binding: None,
        }),
    )
    .await
    .unwrap();

    assert_eq!(status, axum::http::StatusCode::CREATED);
    assert_eq!(body["status"], "completed");
    assert_eq!(body["turn_id"], turn_id.as_str());

    let missing = super::get_turn(
        Path(turn_id.as_str().to_string()),
        State(state.clone()),
        Query(super::TurnSinceQuery::default()),
    )
    .await
    .unwrap_err();
    assert_eq!(missing.status, axum::http::StatusCode::NOT_FOUND);
    assert_eq!(missing.code, "turn_not_found");

    let Json(turn_body) = super::get_turn(
        Path(turn_id.as_str().to_string()),
        State(state.clone()),
        Query(super::TurnSinceQuery {
            since: None,
            workspace: Some(workspace_id.as_str().to_string()),
        }),
    )
    .await
    .unwrap();
    assert_eq!(turn_body["status"], "completed");
    assert_eq!(turn_body["thread_id"], thread.thread_id);
    assert_eq!(turn_body["request_id"], request_id);
}

#[tokio::test]
async fn broker_get_turn_prefers_terminal_event_status_over_stale_task_status() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-turn-terminal-read-model");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let workspace_id = super::gateway_workspace_id();
    let thread = chat.create_thread(workspace_id.as_str()).unwrap();
    let mut state = AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let turn_id = "turn-terminal-read-model";

    {
        let task_store = state.task_store.lock().unwrap();
        let mut task = TaskRecord::new(
            turn_id,
            super::gateway_user_id(),
            workspace_id.clone(),
            "chat_turn",
            "seed running turn with terminal event",
            serde_json::json!({
                "thread_id": thread.thread_id,
                "request_id": "terminal-read-model",
            }),
        );
        task.status = TaskStatus::Running;
        task_store
            .insert_chat_turn(
                &task,
                &thread.thread_id,
                "terminal-read-model",
                "interactive",
                "full",
            )
            .unwrap();
        task_store
            .insert_turn_event(
                turn_id,
                local_first_task_runtime::TurnEventKind::Cancelled,
                serde_json::json!({"text": "cancelled"}),
            )
            .unwrap();
    }

    let Json(turn_body) = super::get_turn(
        Path(turn_id.to_string()),
        State(state),
        Query(super::TurnSinceQuery::default()),
    )
    .await
    .unwrap();

    assert_eq!(turn_body["status"], "cancelled");
}

#[tokio::test]
async fn broker_get_turn_reads_active_turns_in_non_default_workspace() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-turn-active-workspace-query");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let workspace_id = local_first_task_runtime::WorkspaceId::new("workspace_active_query");
    let thread = chat.create_thread(workspace_id.as_str()).unwrap();
    let mut state = AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let turn_id = "turn-active-workspace-query";

    {
        let task_store = state.task_store.lock().unwrap();
        let mut task = TaskRecord::new(
            turn_id,
            super::gateway_user_id(),
            workspace_id.clone(),
            "chat_turn",
            "seed active workspace turn",
            serde_json::json!({
                "thread_id": thread.thread_id,
                "request_id": "active-workspace-query",
            }),
        );
        task.status = TaskStatus::Running;
        task_store
            .insert_chat_turn(
                &task,
                &thread.thread_id,
                "active-workspace-query",
                "interactive",
                "full",
            )
            .unwrap();
    }

    let Json(turn_body) = super::get_turn(
        Path(turn_id.to_string()),
        State(state),
        Query(super::TurnSinceQuery {
            since: None,
            workspace: Some(workspace_id.as_str().to_string()),
        }),
    )
    .await
    .unwrap();

    assert_eq!(turn_body["status"], "running");
    assert_eq!(turn_body["thread_id"], thread.thread_id);
    assert_eq!(turn_body["request_id"], "active-workspace-query");
}

#[tokio::test]
async fn broker_get_turn_http_route_parses_workspace_query_for_active_turns() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-turn-active-workspace-http-query");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let workspace_id = local_first_task_runtime::WorkspaceId::new("workspace_active_http_query");
    let thread = chat.create_thread(workspace_id.as_str()).unwrap();
    let mut state = AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let turn_id = "turn-active-workspace-http-query";

    {
        let task_store = state.task_store.lock().unwrap();
        let mut task = TaskRecord::new(
            turn_id,
            super::gateway_user_id(),
            workspace_id.clone(),
            "chat_turn",
            "seed active workspace turn",
            serde_json::json!({
                "thread_id": thread.thread_id,
                "request_id": "active-workspace-http-query",
            }),
        );
        task.status = TaskStatus::Running;
        task_store
            .insert_chat_turn(
                &task,
                &thread.thread_id,
                "active-workspace-http-query",
                "interactive",
                "full",
            )
            .unwrap();
    }

    let response = super::gateway_routes::build_gateway_router(state)
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/chat/turns/{turn_id}?workspace={}",
                    workspace_id.as_str()
                ))
                .header("Authorization", "Bearer test-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let turn_body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(turn_body["status"], "running");
    assert_eq!(turn_body["thread_id"], thread.thread_id);
}

#[tokio::test]
async fn broker_get_turn_preserves_timed_retry_status_for_suspended_turns() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-turn-suspended-timed-retry");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let workspace_id = local_first_task_runtime::WorkspaceId::new("workspace_timed_retry");
    let thread = chat.create_thread(workspace_id.as_str()).unwrap();
    let mut state = AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let turn_id = "turn-suspended-timed-retry";

    {
        let task_store = state.task_store.lock().unwrap();
        let mut task = TaskRecord::new(
            turn_id,
            super::gateway_user_id(),
            workspace_id.clone(),
            "chat_turn",
            "seed timed retry turn",
            serde_json::json!({
                "thread_id": thread.thread_id,
                "request_id": "timed-retry",
            }),
        );
        task.status = TaskStatus::WaitingTime;
        task_store
            .insert_chat_turn(
                &task,
                &thread.thread_id,
                "timed-retry",
                "interactive",
                "full",
            )
            .unwrap();
        task_store
            .insert_turn_event(
                turn_id,
                local_first_task_runtime::TurnEventKind::Suspended,
                serde_json::json!({
                    "execution_id": turn_id,
                    "revision": 1,
                    "wake_kind": "at",
                }),
            )
            .unwrap();
    }

    let Json(turn_body) = super::get_turn(
        Path(turn_id.to_string()),
        State(state),
        Query(super::TurnSinceQuery {
            since: None,
            workspace: Some(workspace_id.as_str().to_string()),
        }),
    )
    .await
    .unwrap();

    assert_eq!(turn_body["status"], "waiting_time");
}

#[tokio::test]
async fn broker_model_preflight_fails_without_configured_provider() {
    let root = isolated_gateway_test_dir("broker-model-preflight");
    std::fs::create_dir_all(&root).unwrap();
    let data_dir = TestGatewayDataDir::new(&root);
    data_dir
        .env()
        .set("HOMUN_INFERENCE_BASE_URL", None)
        .set("HOMUN_INFERENCE_MODEL", None)
        .set("HOMUN_INFERENCE_API_KEY", None)
        .set("HOMUN_INFERENCE_API_KEY_FILE", None)
        .set("HOMUN_INFERENCE_BACKEND", None);
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let workspace_id = super::gateway_workspace_id();
    let thread = chat.create_thread(workspace_id.as_str()).unwrap();
    let mut state = AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let request_id = "missing-provider";
    let turn_id = local_first_task_runtime::broker::chat_turn_task_id(request_id);
    let user_id = super::gateway_user_id();

    let (status, Json(body)) = super::enqueue_turn(
        State(state.clone()),
        Json(local_first_desktop_gateway::EnqueueTurnRequest {
            thread_id: thread.thread_id.clone(),
            request_id: Some(request_id.to_string()),
            prompt: "Rispondi solo: ok".to_string(),
            visible_prompt: None,
            images: Vec::new(),
            attachments: None,
            mode: None,
            model: None,
            source: Some("interactive".to_string()),
            routing_binding: None,
        }),
    )
    .await
    .unwrap();

    assert_eq!(status, axum::http::StatusCode::CREATED);
    assert_eq!(body["status"], "failed");
    assert_eq!(body["turn_id"], turn_id.as_str());

    let task_store = state.task_store.lock().unwrap();
    let turn = task_store
        .get_task(&turn_id, &user_id, &workspace_id)
        .unwrap()
        .expect("model preflight must create an inspectable terminal chat_turn");
    assert_eq!(
        turn.status,
        local_first_task_runtime::TaskStatus::Failed,
        "model preflight must not enter the worker queue",
    );
    assert_eq!(
        task_store
            .resource_usage(
                &user_id,
                &workspace_id,
                local_first_task_runtime::ResourceClass::BrowserSession,
            )
            .unwrap(),
        0,
        "model preflight must not reserve the browser",
    );
    let events = task_store.read_turn_events(turn_id.as_str(), 0).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].kind,
        local_first_task_runtime::TurnEventKind::Error
    );
    let text = events[0].payload["text"].as_str().unwrap_or_default();
    assert!(text.contains("No model provider is configured"), "{text}");
    drop(task_store);

    let messages = super::lock_store(&state)
        .unwrap()
        .messages(&thread.thread_id)
        .unwrap()
        .messages;
    let assistant = messages
        .iter()
        .find(|message| message.id == "local_assistant_missing-provider")
        .expect("assistant message");
    assert_eq!(
        assistant.delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Failed
    );
    assert!(assistant.text.contains("No model provider is configured"));
}

#[test]
fn chat_turn_delivery_transitions_target_the_preallocated_assistant() {
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .create_thread("workspace_test")
        .unwrap();
    let mut assistant =
        super::channel_chat_message_with_id("assistant", "", "local_assistant_delivery_transition");
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Streaming;
    super::lock_store(&state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();
    let task = TaskRecord::new(
        "turn_delivery_transition",
        UserId::new("user_test"),
        WorkspaceId::new("workspace_test"),
        "chat_turn",
        "prompt",
        serde_json::json!({
            "thread_id": thread.thread_id.clone(),
            "assistant_message_id": assistant.id.clone(),
        }),
    );

    super::set_chat_turn_message_delivery_state(
        &state,
        &task,
        local_first_desktop_gateway::MessageDeliveryState::Retrying,
    );
    super::set_chat_turn_message_delivery_state(
        &state,
        &task,
        local_first_desktop_gateway::MessageDeliveryState::Cancelled,
    );

    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread.thread_id, &assistant.id)
            .unwrap()
            .expect("stable assistant")
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Cancelled
    );
}

#[test]
fn resolving_an_actionable_source_unblocks_only_its_exact_waiting_turn() {
    let _env = TestEnv::acquire();
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .find_or_create_channel_thread("workspace_test", "test", "approval", "Approval")
        .unwrap();
    let other_thread = super::lock_store(&state)
        .unwrap()
        .find_or_create_channel_thread("workspace_test", "test", "other", "Other")
        .unwrap();
    let source_task_id = "turn_actionable_source";
    let other_task_id = "turn_unrelated_waiting";
    let mut source = super::channel_chat_message_with_id(
        "assistant",
        "Approve. ‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{}}‹‹/MCP_CONFIRM››",
        "source_actionable_card",
    );
    source.linked_task_id = Some(source_task_id.to_string());
    source.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    let mut unrelated = super::channel_chat_message_with_id(
        "assistant",
        "Approve. ‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{}}‹‹/MCP_CONFIRM››",
        "unrelated_actionable_card",
    );
    unrelated.linked_task_id = Some(other_task_id.to_string());
    unrelated.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    {
        let store = super::lock_store(&state).unwrap();
        store
            .append_assistant_message(&thread.thread_id, &source)
            .unwrap();
        store
            .append_assistant_message(&other_thread.thread_id, &unrelated)
            .unwrap();
    }
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace_test");
    for (task_id, thread_id, message_id) in [
        (
            source_task_id,
            thread.thread_id.as_str(),
            source.id.as_str(),
        ),
        (
            other_task_id,
            other_thread.thread_id.as_str(),
            unrelated.id.as_str(),
        ),
    ] {
        let mut task = TaskRecord::new(
            task_id,
            user.clone(),
            workspace.clone(),
            "chat_turn",
            "approval source",
            serde_json::json!({
                "thread_id": thread_id,
                "assistant_message_id": message_id,
            }),
        );
        task.status = TaskStatus::WaitingUserApproval;
        state
            .task_store
            .lock()
            .unwrap()
            .insert_chat_turn(&task, thread_id, task_id, "interactive", "full")
            .unwrap();
    }

    super::claim_actionable_source(&state, &thread.thread_id, &source.id, |text| {
        super::mcp_confirm_matches(text, "mcp__filesystem__create", &serde_json::json!({}))
    })
    .unwrap();

    super::resolve_actionable_source(
        &state,
        &thread.thread_id,
        &source.id,
        |_| "✓ MCP tool executed: mcp__filesystem__create".to_string(),
        super::ActionableSourceResolution::Succeeded,
    )
    .unwrap();

    let source_message = super::lock_store(&state)
        .unwrap()
        .message(&thread.thread_id, &source.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        source_message.delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Delivered
    );
    assert!(!source_message.text.contains("MCP_CONFIRM"));
    let task_store = state.task_store.lock().unwrap();
    assert_eq!(
        task_store
            .get_task(
                &local_first_task_runtime::TaskId::new(source_task_id),
                &user,
                &workspace
            )
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Completed
    );
    assert_eq!(
        task_store
            .active_chat_turn_for_thread(&thread.thread_id)
            .unwrap(),
        None,
        "the continuation must not hit ThreadBusy"
    );
    assert_eq!(
        task_store
            .get_task(
                &local_first_task_runtime::TaskId::new(other_task_id),
                &user,
                &workspace
            )
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::WaitingUserApproval,
        "a matching-looking card in another thread must stay untouched"
    );
}

#[test]
fn cancelling_an_actionable_source_leaves_no_waiting_message_or_task() {
    let _env = TestEnv::acquire();
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .find_or_create_channel_thread("workspace_test", "test", "cancel", "Cancel")
        .unwrap();
    let task_id = "turn_cancelled_actionable_source";
    let mut message = super::channel_chat_message_with_id(
        "assistant",
        "Approve. ‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{}}‹‹/MCP_CONFIRM››",
        "cancel_actionable_card",
    );
    message.linked_task_id = Some(task_id.to_string());
    message.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    super::lock_store(&state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &message)
        .unwrap();
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace_test");
    let mut task = TaskRecord::new(
        task_id,
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "approval source",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "assistant_message_id": message.id,
        }),
    );
    task.status = TaskStatus::WaitingUserApproval;
    state
        .task_store
        .lock()
        .unwrap()
        .insert_chat_turn(&task, &thread.thread_id, task_id, "interactive", "full")
        .unwrap();

    super::resolve_actionable_source(
        &state,
        &thread.thread_id,
        &message.id,
        |text| super::actionable_source_terminal_text(text, "Action cancelled."),
        super::ActionableSourceResolution::Cancelled,
    )
    .unwrap();

    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread.thread_id, &message.id)
            .unwrap()
            .unwrap()
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Cancelled
    );
    let task_store = state.task_store.lock().unwrap();
    assert_eq!(
        task_store
            .get_task(
                &local_first_task_runtime::TaskId::new(task_id),
                &user,
                &workspace
            )
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Cancelled
    );
    assert_eq!(
        task_store
            .active_chat_turn_for_thread(&thread.thread_id)
            .unwrap(),
        None
    );
}

#[test]
fn fs_authorize_card_requires_the_exact_path_and_operation() {
    let card = "‹‹FS_AUTHORIZE››{\"path\":\"/tmp/demo-a\",\"op\":\"read\"}‹‹/FS_AUTHORIZE››";

    assert!(super::fs_authorize_matches(card, "/tmp/demo-a", "read"));
    assert!(!super::fs_authorize_matches(card, "/tmp/demo-b", "read"));
    assert!(!super::fs_authorize_matches(card, "/tmp/demo-a", "list"));
}

#[tokio::test]
async fn fs_authorize_rejects_mismatched_card_without_grant_or_lifecycle_change() {
    let _env = TestEnv::acquire();
    let dir = isolated_gateway_test_dir("fs-authorize-provenance");
    std::fs::create_dir_all(&dir).unwrap();
    let _data_dir = TestGatewayDataDir::new(&dir);
    let target = dir.join("requested-folder");
    std::fs::create_dir_all(&target).unwrap();
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .create_thread("workspace_test")
        .unwrap();
    let task_id = "turn_fs_provenance";
    let mut message = super::channel_chat_message_with_id(
        "assistant",
        format!(
            "Authorize. ‹‹FS_AUTHORIZE››{{\"path\":\"{}-other\",\"op\":\"read\"}}‹‹/FS_AUTHORIZE››",
            target.display()
        )
        .as_str(),
        "fs_provenance_card",
    );
    message.linked_task_id = Some(task_id.to_string());
    message.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    super::lock_store(&state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &message)
        .unwrap();
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace_test");
    let mut task = TaskRecord::new(
        task_id,
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "filesystem approval source",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "assistant_message_id": message.id,
        }),
    );
    task.status = TaskStatus::WaitingUserApproval;
    state
        .task_store
        .lock()
        .unwrap()
        .insert_chat_turn(&task, &thread.thread_id, task_id, "interactive", "full")
        .unwrap();

    let error = super::fs_authorize(
        axum::extract::State(state.clone()),
        axum::Json(super::FsAuthorizeRequest {
            path: target.display().to_string(),
            op: "read".to_string(),
            thread_id: Some(thread.thread_id.clone()),
            message_id: Some(message.id.clone()),
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, "fs_authorize_confirmation_required");
    assert!(
        !super::load_artifact_destinations()
            .iter()
            .any(|destination| destination.path == target.display().to_string())
    );
    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread.thread_id, &message.id)
            .unwrap()
            .unwrap()
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::WaitingUser
    );
    assert_eq!(
        state
            .task_store
            .lock()
            .unwrap()
            .get_task(
                &local_first_task_runtime::TaskId::new(task_id),
                &user,
                &workspace
            )
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::WaitingUserApproval
    );
    drop(_data_dir);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn resolving_linked_proactive_action_card_terminalizes_its_exact_task_and_bubble() {
    let _env = TestEnv::acquire();
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .find_or_create_channel_thread("workspace_test", "test", "proactive", "Proactive")
        .unwrap();
    let task_id = "proactive_actionable_source";
    let mut message = super::channel_chat_message_with_id(
        "assistant",
        "Approve. ‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{}}‹‹/MCP_CONFIRM››",
        "proactive_actionable_card",
    );
    message.linked_task_id = Some(task_id.to_string());
    message.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    super::lock_store(&state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &message)
        .unwrap();

    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace_test");
    let mut task = TaskRecord::new(
        task_id,
        user.clone(),
        workspace.clone(),
        "proactive_prompt",
        "proactive approval source",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "assistant_message_id": message.id,
        }),
    );
    task.status = TaskStatus::WaitingUserApproval;
    state.task_store.lock().unwrap().insert_task(&task).unwrap();

    super::claim_actionable_source(&state, &thread.thread_id, &message.id, |text| {
        super::mcp_confirm_matches(text, "mcp__filesystem__create", &serde_json::json!({}))
    })
    .unwrap();
    super::resolve_actionable_source(
        &state,
        &thread.thread_id,
        &message.id,
        |_| "✓ MCP tool executed".to_string(),
        super::ActionableSourceResolution::Succeeded,
    )
    .unwrap();

    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread.thread_id, &message.id)
            .unwrap()
            .unwrap()
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Delivered
    );
    assert_eq!(
        state
            .task_store
            .lock()
            .unwrap()
            .get_task(
                &local_first_task_runtime::TaskId::new(task_id),
                &user,
                &workspace
            )
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Completed
    );
}

#[test]
fn cancelling_linked_proactive_action_card_terminalizes_its_exact_task_and_bubble() {
    let _env = TestEnv::acquire();
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .find_or_create_channel_thread("workspace_test", "test", "proactive-cancel", "Proactive")
        .unwrap();
    let task_id = "proactive_cancelled_source";
    let mut message = super::channel_chat_message_with_id(
        "assistant",
        "Approve. ‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{}}‹‹/MCP_CONFIRM››",
        "proactive_cancelled_card",
    );
    message.linked_task_id = Some(task_id.to_string());
    message.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    super::lock_store(&state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &message)
        .unwrap();

    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace_test");
    let mut task = TaskRecord::new(
        task_id,
        user.clone(),
        workspace.clone(),
        "proactive_prompt",
        "proactive approval source",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "assistant_message_id": message.id,
        }),
    );
    task.status = TaskStatus::WaitingUserApproval;
    state.task_store.lock().unwrap().insert_task(&task).unwrap();

    super::resolve_actionable_source(
        &state,
        &thread.thread_id,
        &message.id,
        |text| super::actionable_source_terminal_text(text, "Action cancelled."),
        super::ActionableSourceResolution::Cancelled,
    )
    .unwrap();

    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread.thread_id, &message.id)
            .unwrap()
            .unwrap()
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Cancelled
    );
    assert_eq!(
        state
            .task_store
            .lock()
            .unwrap()
            .get_task(
                &local_first_task_runtime::TaskId::new(task_id),
                &user,
                &workspace
            )
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Cancelled
    );
}

#[test]
fn terminal_execution_error_fails_the_exact_actionable_source() {
    let _env = TestEnv::acquire();
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .create_thread("workspace_test")
        .unwrap();
    let task_id = "turn_terminal_execution_error";
    let mut message = super::channel_chat_message_with_id(
        "assistant",
        "Approve. ‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{}}‹‹/MCP_CONFIRM››",
        "terminal_execution_error_card",
    );
    message.linked_task_id = Some(task_id.to_string());
    message.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    super::lock_store(&state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &message)
        .unwrap();
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace_test");
    let mut task = TaskRecord::new(
        task_id,
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "approval source",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "assistant_message_id": message.id,
        }),
    );
    task.status = TaskStatus::WaitingUserApproval;
    state
        .task_store
        .lock()
        .unwrap()
        .insert_chat_turn(&task, &thread.thread_id, task_id, "interactive", "full")
        .unwrap();

    super::claim_actionable_source(&state, &thread.thread_id, &message.id, |text| {
        super::mcp_confirm_matches(text, "mcp__filesystem__create", &serde_json::json!({}))
    })
    .unwrap();

    let error = super::terminal_actionable_execution_error(
        &state,
        Some(&thread.thread_id),
        Some(&message.id),
        "mcp_execute_join",
        "executor join failed",
        "Action failed.",
    );

    assert_eq!(error.code, "mcp_execute_join");
    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread.thread_id, &message.id)
            .unwrap()
            .unwrap()
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Failed
    );
    assert_eq!(
        state
            .task_store
            .lock()
            .unwrap()
            .get_task(
                &local_first_task_runtime::TaskId::new(task_id),
                &user,
                &workspace
            )
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Failed
    );
}

#[test]
fn proactive_visible_turn_persists_generated_source_ids_on_owning_task() {
    let _env = TestEnv::acquire();
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .find_or_create_channel_thread("workspace_test", "scheduled", "schedule-1", "Schedule")
        .unwrap();
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace_test");
    let task = TaskRecord::new(
        "proactive_production_shape",
        user.clone(),
        workspace.clone(),
        "proactive_prompt",
        "production-shaped proactive task",
        serde_json::json!({"automation_id": "schedule-1"}),
    );
    state.task_store.lock().unwrap().insert_task(&task).unwrap();
    let plan = super::proactive_thread_plan(&task, &task.goal);

    let turn =
        super::start_proactive_visible_turn(&state, &task, &thread.thread_id, &plan, &task.goal)
            .unwrap();
    let mut runner_task = task.clone();
    super::request_task_executor_approval(
        &state,
        &mut runner_task,
        &super::PendingExecutorApproval {
            action: "MCP_CONFIRM".to_string(),
            risk_level: "high".to_string(),
            data_boundary: "in-chat action card".to_string(),
            explanation: "waiting on the persisted card".to_string(),
            inline_action_card: true,
        },
    )
    .unwrap();

    let saved = state
        .task_store
        .lock()
        .unwrap()
        .get_task(&task.task_id, &user, &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(saved.input_json["thread_id"], thread.thread_id);
    assert_eq!(
        saved.input_json["assistant_message_id"],
        turn.assistant_message_id
    );
    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread.thread_id, &turn.assistant_message_id)
            .unwrap()
            .unwrap()
            .linked_task_id
            .as_deref(),
        Some(task.task_id.as_str())
    );
}

fn seed_sandbox_escalation_source(
    state: &AppState,
    command: &str,
    cwd: Option<&str>,
) -> (
    String,
    String,
    String,
    local_first_task_runtime::UserId,
    local_first_task_runtime::WorkspaceId,
) {
    let thread = super::lock_store(state)
        .unwrap()
        .create_thread("workspace_test")
        .unwrap();
    let task_id = format!("turn_sandbox_{}", uuid::Uuid::new_v4().simple());
    let message_id = format!("sandbox_card_{}", uuid::Uuid::new_v4().simple());
    let mut arguments = serde_json::json!({ "command": command });
    if let Some(cwd) = cwd {
        arguments["cwd"] = serde_json::Value::String(cwd.to_string());
    }
    let marker = serde_json::json!({
        "tool": "run_in_project",
        "arguments": arguments,
    });
    let mut message = super::channel_chat_message_with_id(
        "assistant",
        &format!("Approve. ‹‹SANDBOX_ESCALATE››{marker}‹‹/SANDBOX_ESCALATE››"),
        &message_id,
    );
    message.linked_task_id = Some(task_id.clone());
    message.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    super::lock_store(state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &message)
        .unwrap();
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace_test");
    let mut task = TaskRecord::new(
        &task_id,
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "sandbox escalation",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "assistant_message_id": message_id,
        }),
    );
    task.status = TaskStatus::WaitingUserApproval;
    state
        .task_store
        .lock()
        .unwrap()
        .insert_chat_turn(&task, &thread.thread_id, &task_id, "interactive", "full")
        .unwrap();
    (thread.thread_id, message_id, task_id, user, workspace)
}

#[tokio::test]
async fn sandbox_escalation_missing_root_fails_exact_source() {
    let _env = TestEnv::acquire();
    let state = AppState::for_tests();
    let (thread_id, message_id, task_id, user, workspace) =
        seed_sandbox_escalation_source(&state, "pwd", None);

    let error = super::run_escalate(
        axum::extract::State(state.clone()),
        axum::Json(super::RunEscalateRequest {
            command: "pwd".to_string(),
            cwd: None,
            thread_id: Some(thread_id.clone()),
            message_id: Some(message_id.clone()),
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, "sandbox_escalate_no_root");
    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread_id, &message_id)
            .unwrap()
            .unwrap()
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Failed
    );
    assert_eq!(
        state
            .task_store
            .lock()
            .unwrap()
            .get_task(
                &local_first_task_runtime::TaskId::new(task_id),
                &user,
                &workspace
            )
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Failed
    );
}

#[tokio::test]
async fn sandbox_escalation_nonzero_exit_fails_source_without_continuation() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("sandbox-escalation-failure");
    std::fs::create_dir_all(&root).unwrap();
    let state = AppState::for_tests();
    let (thread_id, message_id, task_id, user, workspace) =
        seed_sandbox_escalation_source(&state, "exit 7", Some(root.to_string_lossy().as_ref()));

    let response = super::run_escalate(
        axum::extract::State(state.clone()),
        axum::Json(super::RunEscalateRequest {
            command: "exit 7".to_string(),
            cwd: Some(root.display().to_string()),
            thread_id: Some(thread_id.clone()),
            message_id: Some(message_id.clone()),
        }),
    )
    .await
    .unwrap()
    .0;

    assert_eq!(response["ok"], false);
    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread_id, &message_id)
            .unwrap()
            .unwrap()
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Failed
    );
    assert_eq!(
        state
            .task_store
            .lock()
            .unwrap()
            .get_task(
                &local_first_task_runtime::TaskId::new(task_id),
                &user,
                &workspace
            )
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Failed
    );
    assert_eq!(
        state
            .task_store
            .lock()
            .unwrap()
            .active_chat_turn_for_thread(&thread_id)
            .unwrap(),
        None,
        "failed execution must release the source without enqueuing a continuation"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn concurrent_actionable_claim_allows_exactly_one_execution() {
    use std::sync::{
        Arc, Barrier,
        atomic::{AtomicUsize, Ordering},
    };

    let _env = TestEnv::acquire();
    let state = AppState::for_tests();
    let (thread_id, message_id, _task_id, _user, _workspace) =
        seed_sandbox_escalation_source(&state, "pwd", None);
    let barrier = Arc::new(Barrier::new(3));
    let executions = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let state = state.clone();
        let thread_id = thread_id.clone();
        let message_id = message_id.clone();
        let barrier = barrier.clone();
        let executions = executions.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            if super::claim_actionable_source(&state, &thread_id, &message_id, |text| {
                super::sandbox_escalate_matches(text, "pwd", None)
            })
            .is_ok()
            {
                executions.fetch_add(1, Ordering::SeqCst);
            }
        }));
    }
    barrier.wait();
    for handle in handles {
        handle.join().unwrap();
    }

    assert_eq!(executions.load(Ordering::SeqCst), 1);
}

#[test]
fn stale_actionable_claim_after_cancel_executes_nothing() {
    let _env = TestEnv::acquire();
    let state = AppState::for_tests();
    let (thread_id, message_id, _task_id, _user, _workspace) =
        seed_sandbox_escalation_source(&state, "pwd", None);
    super::resolve_actionable_source(
        &state,
        &thread_id,
        &message_id,
        |text| super::actionable_source_terminal_text(text, "Action cancelled."),
        super::ActionableSourceResolution::Cancelled,
    )
    .unwrap();

    assert!(
        super::claim_actionable_source(&state, &thread_id, &message_id, |text| {
            super::sandbox_escalate_matches(text, "pwd", None)
        })
        .is_err()
    );
}

#[test]
fn remote_actionable_claim_after_stop_executes_nothing() {
    let _env = TestEnv::acquire();
    let state = AppState::for_tests();
    let (thread_id, message_id, _task_id, _user, _workspace) =
        seed_sandbox_escalation_source(&state, "pwd", None);
    super::resolve_actionable_source(
        &state,
        &thread_id,
        &message_id,
        |text| super::actionable_source_terminal_text(text, "Stopped."),
        super::ActionableSourceResolution::Cancelled,
    )
    .unwrap();

    let executions = std::sync::atomic::AtomicUsize::new(0);
    if super::claim_actionable_source(&state, &thread_id, &message_id, |text| {
        super::sandbox_escalate_matches(text, "pwd", None)
    })
    .is_ok()
    {
        executions.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    assert_eq!(executions.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn sandbox_escalation_provenance_rejects_substituted_cwd() {
    let text = "‹‹SANDBOX_ESCALATE››{\"arguments\":{\"command\":\"pwd\",\"cwd\":\"/tmp/approved\"}}‹‹/SANDBOX_ESCALATE››";
    assert!(super::sandbox_escalate_matches(
        text,
        "pwd",
        Some("/tmp/approved")
    ));
    assert!(!super::sandbox_escalate_matches(
        text,
        "pwd",
        Some("/tmp/substituted")
    ));
}

#[test]
fn runner_does_not_duplicate_linked_proactive_approval_already_persisted_in_chat() {
    let state = super::AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .find_or_create_channel_thread("project-a", "test", "proactive", "Proactive test thread")
        .unwrap();
    let task_id = "proactive_approval_already_persisted";
    let mut approval = super::channel_chat_message_with_id(
        "assistant",
        "Approve this. ‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{\"path\":\"/tmp/a\"}}‹‹/MCP_CONFIRM››",
        "proactive_approval_card",
    );
    approval.linked_task_id = Some(task_id.to_string());
    approval.delivery_state = local_first_desktop_gateway::MessageDeliveryState::WaitingUser;
    {
        let store = super::lock_store(&state).unwrap();
        store
            .append_assistant_message(&thread.thread_id, &approval)
            .unwrap();
        store
            .link_task_to_thread(task_id, &thread.thread_id)
            .unwrap();
    }

    let outcome = super::TaskExecutionPresentation {
        pending_approval: None,
        summary: "Scheduled task is waiting for a user action.".to_string(),
        checkpoint_payload: serde_json::json!({}),
        checkpoint_redacted: serde_json::json!({}),
        chat_message: approval.text.clone(),
        result_surfacing: super::TaskResultSurfacing::AlreadyPersisted,
        surface: super::SurfaceKind::Logs,
        event_kind: "proactive_prompt_waiting_approval".to_string(),
        event_title: "Scheduled task waiting approval".to_string(),
        event_subtitle: "A persisted action card requires user confirmation.".to_string(),
        event_payload: serde_json::json!({}),
        artifacts: vec![],
    };

    super::surface_task_execution_outcome(&state, task_id, &outcome).unwrap();

    let messages = super::lock_store(&state)
        .unwrap()
        .messages(&thread.thread_id)
        .unwrap()
        .messages;
    let assistants: Vec<_> = messages
        .iter()
        .filter(|message| message.role == "assistant")
        .collect();
    assert_eq!(assistants.len(), 1);
    assert_eq!(assistants[0].id, approval.id);
    assert_eq!(
        assistants[0].delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::WaitingUser
    );
    assert!(!assistants.iter().any(|message| {
        message.delivery_state == local_first_desktop_gateway::MessageDeliveryState::Delivered
    }));

    let context = super::thread_context_for_model(&state, &thread.thread_id, &[], None)
        .expect("thread context");
    assert!(
        !context
            .iter()
            .any(|message| message.text.contains("MCP_CONFIRM"))
    );
}

#[test]
fn chat_turn_retry_and_terminal_failure_update_the_stable_assistant() {
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .create_thread("workspace_test")
        .unwrap();
    let mut assistant =
        super::channel_chat_message_with_id("assistant", "", "local_assistant_retry_failure");
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Streaming;
    super::lock_store(&state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();
    let initial_assistant_count = super::lock_store(&state)
        .unwrap()
        .messages(&thread.thread_id)
        .unwrap()
        .messages
        .iter()
        .filter(|message| message.role == "assistant")
        .count();
    let mut task = TaskRecord::new(
        "turn_retry_failure",
        UserId::new("user_test"),
        WorkspaceId::new("workspace_test"),
        "chat_turn",
        "prompt",
        serde_json::json!({
            "thread_id": thread.thread_id.clone(),
            "assistant_message_id": assistant.id.clone(),
        }),
    );
    task.retry_policy = local_first_task_runtime::RetryPolicy {
        max_attempts: 2,
        backoff_seconds: 0,
    };

    super::handle_failed_task_run(&state, &mut task, true, "temporary failure").unwrap();
    assert_eq!(task.status, TaskStatus::Queued);
    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread.thread_id, &assistant.id)
            .unwrap()
            .expect("stable assistant")
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Retrying
    );
    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .messages(&thread.thread_id)
            .unwrap()
            .messages
            .iter()
            .filter(|message| message.role == "assistant")
            .count(),
        initial_assistant_count,
        "retry must update the stable assistant instead of appending a bubble"
    );

    super::handle_failed_task_run(&state, &mut task, true, "terminal failure").unwrap();
    assert_eq!(task.status, TaskStatus::Failed);
    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .message(&thread.thread_id, &assistant.id)
            .unwrap()
            .expect("stable assistant")
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Failed
    );
    assert_eq!(
        super::lock_store(&state)
            .unwrap()
            .messages(&thread.thread_id)
            .unwrap()
            .messages
            .iter()
            .filter(|message| message.role == "assistant")
            .count(),
        initial_assistant_count,
        "terminal failure must update the same assistant bubble"
    );
}

#[test]
fn executor_wait_until_outcome_preserves_scheduled_resume() {
    let state = AppState::for_tests();
    let mut task = TaskRecord::new(
        "wait-until-task",
        UserId::new("user_test"),
        WorkspaceId::new("workspace_test"),
        "capability.browser",
        "wait for scheduled availability",
        serde_json::json!({}),
    );
    task.status = TaskStatus::Running;
    task.lease_owner = Some("test-worker".to_string());
    task.last_heartbeat_at = Some(super::OffsetDateTime::now_utc());
    state.task_store.lock().unwrap().insert_task(&task).unwrap();
    let contract = super::execution_runtime::contract_for_acquired_task(&task).unwrap();
    let not_before = super::OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();

    let outcome = task_execution_outcome_from_executor_result(
        &state,
        &task,
        &contract,
        "executor-test",
        "wait_tool",
        ExecutorResult::WaitUntil {
            not_before,
            reason: "remote system asked us to retry later".to_string(),
        },
    )
    .unwrap();

    assert!(matches!(
        &outcome,
        local_first_execution_protocol::ExecutionOutcome::Suspended {
            wake: local_first_execution_protocol::WakeCondition::At { unix_seconds },
            ..
        } if *unix_seconds == not_before.unix_timestamp()
    ));
    let presentation =
        super::execution_runtime::task_execution_presentation(&state, &task, &outcome).unwrap();
    assert_eq!(
        presentation.summary,
        "remote system asked us to retry later"
    );
    assert_eq!(
        presentation
            .checkpoint_payload
            .get("kind")
            .and_then(|v| v.as_str()),
        Some("executor_waiting_time")
    );
    assert_eq!(
        presentation
            .checkpoint_payload
            .pointer("/output/not_before")
            .and_then(|v| v.as_i64()),
        Some(not_before.unix_timestamp())
    );
    assert_eq!(presentation.event_kind, "computer_executor_waiting_time");
}

#[test]
fn mark_task_waiting_time_persists_resume_time_and_releases_lease() {
    let state = AppState::for_tests();
    let user = UserId::new("user_test");
    let workspace = WorkspaceId::new("workspace_test");
    let not_before = super::OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
    let mut task = TaskRecord::new(
        "wait-time-task",
        user.clone(),
        workspace.clone(),
        "capability.browser",
        "wait for scheduled availability",
        serde_json::json!({}),
    );
    task.status = TaskStatus::Running;
    task.lease_owner = Some("worker-test".to_string());
    task.lease_expires_at = Some(super::OffsetDateTime::now_utc());
    task.last_heartbeat_at = Some(super::OffsetDateTime::now_utc());

    super::mark_task_waiting_time(
        &state,
        &mut task,
        not_before,
        "remote system asked us to retry later",
    )
    .unwrap();

    assert_eq!(task.status, TaskStatus::WaitingTime);
    assert_eq!(task.not_before, Some(not_before));
    assert_eq!(
        task.blocked_reason.as_deref(),
        Some("remote system asked us to retry later")
    );
    assert!(task.lease_owner.is_none());
    assert!(task.lease_expires_at.is_none());
    assert!(task.last_heartbeat_at.is_none());

    let persisted = super::lock_task_store(&state)
        .unwrap()
        .get_task(&task.task_id, &user, &workspace)
        .unwrap()
        .expect("waiting task persisted");
    assert_eq!(persisted.status, TaskStatus::WaitingTime);
    assert_eq!(persisted.not_before, Some(not_before));
}

#[test]
fn recovery_reuses_the_existing_assistant_message() {
    let state = AppState::for_tests();
    let thread = super::lock_store(&state)
        .unwrap()
        .create_thread("workspace_test")
        .unwrap();
    let mut assistant =
        super::channel_chat_message_with_id("assistant", "", "local_assistant_recovery");
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Streaming;
    super::lock_store(&state)
        .unwrap()
        .append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();
    let initial_count = super::lock_store(&state)
        .unwrap()
        .messages(&thread.thread_id)
        .unwrap()
        .messages
        .len();

    let mut task = TaskRecord::new(
        "turn_recovery",
        UserId::new("user_test"),
        WorkspaceId::new("workspace_test"),
        "chat_turn",
        "prompt",
        serde_json::json!({
            "thread_id": thread.thread_id,
            "request_id": "recovery",
            "assistant_message_id": assistant.id,
            "source": "interactive",
            "approval": "full",
        }),
    );
    task.status = TaskStatus::Running;
    task.lease_owner = Some("1:worker".to_string());
    {
        let store = super::lock_task_store(&state).unwrap();
        store
            .insert_chat_turn(&task, &thread.thread_id, "recovery", "interactive", "full")
            .unwrap();
        store.bump_process_generation().unwrap();
        let generation = store.bump_process_generation().unwrap();
        let recovered = local_first_task_runtime::broker::recover_chat_turns_at_boot(
            &store,
            &UserId::new("user_test"),
            &WorkspaceId::new("workspace_test"),
            generation,
        )
        .unwrap();
        assert_eq!(recovered, vec![task.task_id.clone()]);
        task = store
            .get_task(
                &task.task_id,
                &UserId::new("user_test"),
                &WorkspaceId::new("workspace_test"),
            )
            .unwrap()
            .unwrap();
    }

    super::set_chat_turn_message_delivery_state(
        &state,
        &task,
        local_first_desktop_gateway::MessageDeliveryState::Retrying,
    );
    let messages = super::lock_store(&state)
        .unwrap()
        .messages(&thread.thread_id)
        .unwrap()
        .messages;
    assert_eq!(messages.len(), initial_count);
    assert_eq!(
        messages
            .iter()
            .find(|message| message.id == "local_assistant_recovery")
            .expect("recovered assistant")
            .delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Retrying
    );
}

#[test]
fn broker_enqueue_rejects_cross_thread_request_id_collision_without_mutating_first_turn() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-cross-thread-request-id-collision");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let thread_a = chat.create_thread("workspace_test").unwrap();
    let thread_b = chat.create_thread("workspace_test").unwrap();
    let leaf_b_before = chat
        .messages(&thread_b.thread_id)
        .unwrap()
        .messages
        .last()
        .unwrap()
        .id
        .clone();
    let input_a = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: thread_a.thread_id.clone(),
        request_id: "same-request".to_string(),
        assistant_message_id: "local_assistant_same-request".to_string(),
        prompt: "first prompt".to_string(),
        visible_prompt: None,
        images: Vec::new(),
        attachments: None,
        mode: None,
        model: None,
        source: local_first_task_runtime::broker::ChatTurnSource::Interactive,
        approval: local_first_task_runtime::broker::TurnApproval::Full,
    };
    let user_id = super::gateway_user_id();
    let workspace_id = local_first_task_runtime::WorkspaceId::new("workspace_test");

    local_first_task_runtime::broker::enqueue_chat_turn_atomic(
        &tasks,
        &user_id,
        &workspace_id,
        &input_a,
        |tx| super::insert_broker_turn_messages(tx, &input_a),
    )
    .unwrap();
    let task_id = local_first_task_runtime::TaskId::new("turn_same-request");
    let task_before = tasks
        .get_task(&task_id, &user_id, &workspace_id)
        .unwrap()
        .unwrap();
    let input_b = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: thread_b.thread_id.clone(),
        prompt: "second prompt".to_string(),
        ..input_a.clone()
    };

    let error = local_first_task_runtime::broker::enqueue_chat_turn_atomic(
        &tasks,
        &user_id,
        &workspace_id,
        &input_b,
        |tx| super::insert_broker_turn_messages(tx, &input_b),
    )
    .unwrap_err();

    assert!(matches!(
        error,
        local_first_task_runtime::broker::EnqueueError::Store(_)
    ));
    let task_after = tasks
        .get_task(&task_id, &user_id, &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(task_after.status, task_before.status);
    assert_eq!(task_after.input_json["thread_id"], thread_a.thread_id);
    assert_eq!(task_after.input_json["request_id"], "same-request");
    assert!(
        chat.message(&thread_a.thread_id, "local_user_same-request")
            .unwrap()
            .is_some()
    );
    assert!(
        chat.message(&thread_a.thread_id, "local_assistant_same-request")
            .unwrap()
            .is_some()
    );
    let (assistant_parent, leaf_a): (Option<String>, Option<String>) =
        rusqlite::Connection::open(&database)
            .unwrap()
            .query_row(
                "select message.parent_id, thread.active_leaf_id
                       from chat_messages message
                       join chat_threads thread on thread.thread_id = message.thread_id
                      where message.id = ?1",
                ["local_assistant_same-request"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
    assert_eq!(assistant_parent.as_deref(), Some("local_user_same-request"));
    assert_eq!(leaf_a.as_deref(), Some("local_assistant_same-request"));
    assert!(
        chat.message(&thread_b.thread_id, "local_user_same-request")
            .unwrap()
            .is_none()
    );
    assert!(
        chat.message(&thread_b.thread_id, "local_assistant_same-request")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        chat.messages(&thread_b.thread_id)
            .unwrap()
            .messages
            .last()
            .map(|message| message.id.as_str()),
        Some(leaf_b_before.as_str())
    );
    let b_task_count: i64 = rusqlite::Connection::open(&database)
        .unwrap()
        .query_row(
            "select count(*) from tasks where thread_id = ?1",
            [thread_b.thread_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(b_task_count, 0);
}

#[test]
fn broker_enqueue_rejects_changed_payload_for_terminal_same_thread_turn() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-same-thread-payload-collision");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let thread = chat.create_thread("workspace_test").unwrap();
    let input = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: thread.thread_id.clone(),
        request_id: "r1".to_string(),
        assistant_message_id: "local_assistant_r1".to_string(),
        prompt: "original prompt".to_string(),
        visible_prompt: None,
        images: Vec::new(),
        attachments: None,
        mode: Some("chat".to_string()),
        model: None,
        source: local_first_task_runtime::broker::ChatTurnSource::Interactive,
        approval: local_first_task_runtime::broker::TurnApproval::Full,
    };
    let user_id = super::gateway_user_id();
    let workspace_id = local_first_task_runtime::WorkspaceId::new("workspace_test");

    let first = local_first_task_runtime::broker::enqueue_chat_turn_atomic(
        &tasks,
        &user_id,
        &workspace_id,
        &input,
        |tx| super::insert_broker_turn_messages(tx, &input),
    )
    .unwrap();
    tasks
        .update_task_status(
            &first.task_id,
            &user_id,
            &workspace_id,
            local_first_task_runtime::TaskStatus::Completed,
            None,
        )
        .unwrap();
    let task_before = tasks
        .get_task(&first.task_id, &user_id, &workspace_id)
        .unwrap()
        .unwrap();
    let messages_before: Vec<(String, String)> = chat
        .messages(&thread.thread_id)
        .unwrap()
        .messages
        .into_iter()
        .map(|message| (message.id, message.text))
        .collect();
    let leaf_before = messages_before.last().unwrap().0.clone();
    let changed = local_first_task_runtime::broker::ChatTurnInput {
        prompt: "changed prompt".to_string(),
        attachments: Some(serde_json::json!({ "document": "new" })),
        mode: Some("plan".to_string()),
        ..input.clone()
    };

    let error = local_first_task_runtime::broker::enqueue_chat_turn_atomic(
        &tasks,
        &user_id,
        &workspace_id,
        &changed,
        |tx| super::insert_broker_turn_messages(tx, &changed),
    )
    .unwrap_err();

    assert!(matches!(
        error,
        local_first_task_runtime::broker::EnqueueError::Store(_)
    ));
    let task_after = tasks
        .get_task(&first.task_id, &user_id, &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(task_after.status, task_before.status);
    assert_eq!(task_after.input_json, task_before.input_json);
    let messages_after: Vec<(String, String)> = chat
        .messages(&thread.thread_id)
        .unwrap()
        .messages
        .into_iter()
        .map(|message| (message.id, message.text))
        .collect();
    assert_eq!(messages_after, messages_before);
    assert_eq!(
        messages_after.last().map(|message| message.0.as_str()),
        Some(leaf_before.as_str())
    );
}

#[test]
fn broker_steering_stays_out_of_transcript_until_claim() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-steering-no-assistant");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let thread = chat.create_thread("workspace_test").unwrap();
    let user_id = super::gateway_user_id();
    let workspace_id = local_first_task_runtime::WorkspaceId::new("workspace_test");
    let first = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: thread.thread_id.clone(),
        request_id: "r1".to_string(),
        assistant_message_id: "local_assistant_r1".to_string(),
        prompt: "first prompt".to_string(),
        visible_prompt: None,
        images: Vec::new(),
        attachments: None,
        mode: None,
        model: None,
        source: local_first_task_runtime::broker::ChatTurnSource::Interactive,
        approval: local_first_task_runtime::broker::TurnApproval::Full,
    };
    let first_outcome = local_first_task_runtime::broker::enqueue_or_steer_chat_turn_atomic(
        &tasks,
        &user_id,
        &workspace_id,
        &first,
        |tx| super::insert_broker_turn_messages(tx, &first),
        |tx| super::insert_broker_steering_user_message(tx, &first),
    )
    .unwrap();
    assert!(matches!(
        first_outcome,
        local_first_task_runtime::broker::EnqueueTurnOutcome::Enqueued(_)
    ));
    let steering = local_first_task_runtime::broker::ChatTurnInput {
        request_id: "r2".to_string(),
        assistant_message_id: "local_assistant_r2".to_string(),
        prompt: "steer the active turn".to_string(),
        ..first.clone()
    };

    let outcome = local_first_task_runtime::broker::enqueue_or_steer_chat_turn_atomic(
        &tasks,
        &user_id,
        &workspace_id,
        &steering,
        |tx| super::insert_broker_turn_messages(tx, &steering),
        |tx| super::insert_broker_steering_user_message(tx, &steering),
    )
    .unwrap();

    assert!(matches!(
        outcome,
        local_first_task_runtime::broker::EnqueueTurnOutcome::SteeringQueued { .. }
    ));
    let messages = chat.messages(&thread.thread_id).unwrap().messages;
    assert_eq!(
        messages
            .iter()
            .filter(|message| message.id == "local_user_r2")
            .count(),
        0
    );
    assert!(
        messages
            .iter()
            .all(|message| message.id != "local_assistant_r2")
    );
    assert_eq!(
        messages.last().map(|message| message.id.as_str()),
        Some("local_assistant_r1")
    );
    assert!(
        tasks
            .get_task(
                &local_first_task_runtime::TaskId::new("turn_r2"),
                &user_id,
                &workspace_id,
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn broker_enqueue_rolls_back_user_assistant_and_task_when_placeholder_is_rejected() {
    let _env = TestEnv::acquire();
    let root = isolated_gateway_test_dir("broker-preallocated-rollback");
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let thread = chat.create_thread("workspace_test").unwrap();
    let leaf_before = chat
        .messages(&thread.thread_id)
        .unwrap()
        .messages
        .last()
        .unwrap()
        .id
        .clone();
    rusqlite::Connection::open(&database)
        .unwrap()
        .execute_batch(
            "create trigger reject_preallocated_assistant
                 before insert on chat_messages
                 when new.id = 'local_assistant_rejected'
                 begin select raise(abort, 'assistant rejected'); end;",
        )
        .unwrap();
    let input = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: thread.thread_id.clone(),
        request_id: "rejected".to_string(),
        assistant_message_id: "local_assistant_rejected".to_string(),
        prompt: "prompt".to_string(),
        visible_prompt: None,
        images: Vec::new(),
        attachments: None,
        mode: None,
        model: None,
        source: local_first_task_runtime::broker::ChatTurnSource::Interactive,
        approval: local_first_task_runtime::broker::TurnApproval::Full,
    };
    let user_id = super::gateway_user_id();
    let workspace_id = local_first_task_runtime::WorkspaceId::new("workspace_test");

    let error = local_first_task_runtime::broker::enqueue_chat_turn_atomic(
        &tasks,
        &user_id,
        &workspace_id,
        &input,
        |tx| super::insert_broker_turn_messages(tx, &input),
    )
    .unwrap_err();

    assert!(error.to_string().contains("assistant rejected"));
    assert!(
        chat.message(&thread.thread_id, "local_user_rejected")
            .unwrap()
            .is_none()
    );
    assert!(
        chat.message(&thread.thread_id, "local_assistant_rejected")
            .unwrap()
            .is_none()
    );
    let messages = chat.messages(&thread.thread_id).unwrap().messages;
    assert_eq!(
        messages.last().map(|message| message.id.as_str()),
        Some(leaf_before.as_str())
    );
    assert!(
        tasks
            .get_task(
                &local_first_task_runtime::TaskId::new("turn_rejected"),
                &user_id,
                &workspace_id,
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn approval_continuation_visible_text_is_short_and_explicit() {
    assert_eq!(
        super::approval_continuation_visible_text("mcp__filesystem__create"),
        "Continue after approved action `mcp__filesystem__create`."
    );
    assert_eq!(
        super::approval_continuation_visible_text("   "),
        "Continue after the approved action."
    );

    let long_tool = "x".repeat(120);
    let text = super::approval_continuation_visible_text(&long_tool);
    assert!(text.contains(&"x".repeat(80)));
    assert!(!text.contains(&"x".repeat(81)));

    let input = super::approval_continuation_turn_input(
        "thread-1",
        "filesystem_authorize",
        "internal grounded continuation".to_string(),
    );
    assert_eq!(input.thread_id, "thread-1");
    assert_eq!(input.prompt, "internal grounded continuation");
    assert_eq!(
        input.visible_prompt.as_deref(),
        Some("Continue after approved action `filesystem_authorize`.")
    );
    assert_eq!(input.source.as_str(), "interactive");
    assert_eq!(input.approval.as_str(), "full");
}

#[test]
fn agent_output_plan_guard_rejects_incomplete_plan_answer() {
    let answer = "‹‹PLAN››- [x] **Read sources** (`s1`): done\n\
- [-] **Check standings** (`s2`): still running\n\
- [ ] **Write briefing** (`s3`): pending‹‹/PLAN››\
Sky Sport ha solo il menu. Vado direttamente alla pagina dei Mondiali.";

    let reason = super::agent_output_incomplete_reason(answer).expect("incomplete plan");

    assert!(reason.contains("plan is incomplete"), "{reason}");
    assert!(reason.contains("1/3"), "{reason}");
    assert!(reason.contains("Check standings"), "{reason}");
}

#[test]
fn agent_output_plan_guard_allows_completed_plan_answer() {
    let answer = "‹‹PLAN››- [x] **Read sources** (`s1`): done\n\
- [x] **Write briefing** (`s2`): done‹‹/PLAN››\
\n\n## Briefing finale\nTutto completato.";

    assert!(super::agent_output_incomplete_reason(answer).is_none());
}

#[test]
fn agent_output_plan_guard_rejects_missing_reply() {
    assert_eq!(
        super::agent_output_incomplete_reason("No reply generated for the scheduled task.")
            .as_deref(),
        Some("scheduled task produced no final reply"),
    );
}

#[test]
fn hybrid_memory_ranking_fuses_then_refines_by_importance_and_recency() {
    let mk = |fts: Option<usize>, dense: Option<usize>, imp: f32, age: f32| MemoryCandidate {
        reference: "mem_ref".to_string(),
        fts_rank: fts,
        dense_rank: dense,
        importance: imp,
        age_days: age,
    };
    // A memory matched by BOTH passes beats one matched by a single pass (RRF, not concat).
    assert!(
        hybrid_memory_score(&mk(Some(1), Some(1), 0.5, 1.0))
            > hybrid_memory_score(&mk(Some(1), None, 0.5, 1.0))
    );
    // Equal relevance → higher importance wins (importance was captured but unused before).
    assert!(
        hybrid_memory_score(&mk(Some(2), None, 0.9, 10.0))
            > hybrid_memory_score(&mk(Some(2), None, 0.1, 10.0))
    );
    // Equal relevance + importance → fresher wins.
    assert!(
        hybrid_memory_score(&mk(Some(2), None, 0.5, 1.0))
            > hybrid_memory_score(&mk(Some(2), None, 0.5, 400.0))
    );
    // Relevance still dominates: a rank-1 both-pass hit beats a rank-3 max-importance one.
    assert!(
        hybrid_memory_score(&mk(Some(1), Some(1), 0.2, 30.0))
            > hybrid_memory_score(&mk(Some(3), None, 1.0, 1.0))
    );
    // Age helper: 86_400s == 1 day.
    assert!((memory_age_days("unix:999913600", 1_000_000_000) - 1.0).abs() < 0.01);
}

fn initialise_fingerprint_test_repository(name: &str) -> std::path::PathBuf {
    let root = isolated_gateway_test_dir(name);
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/lib.rs"), "fn alpha() {}\n").unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "Homun Tests"]);
    git(&["config", "user.email", "tests@homun.local"]);
    git(&["add", "src/lib.rs"]);
    git(&["commit", "--quiet", "-m", "baseline"]);
    root
}

#[test]
fn project_change_fingerprint_tracks_repeated_content_edits_to_the_same_dirty_file() {
    let root = initialise_fingerprint_test_repository("project-fingerprint-dirty-content");
    let clean = super::project_change_fingerprint(&root);

    std::fs::write(root.join("src/lib.rs"), "fn beta() {}\n").unwrap();
    let first_dirty = super::project_change_fingerprint(&root);
    assert_ne!(clean, first_dirty);

    // The porcelain status line remains ` M src/lib.rs`; only its contents change.
    std::fs::write(root.join("src/lib.rs"), "fn gamma() {}\n").unwrap();
    let second_dirty = super::project_change_fingerprint(&root);
    assert_ne!(first_dirty, second_dirty);
}

#[test]
fn project_change_fingerprint_tracks_repeated_content_edits_to_an_untracked_file() {
    let root = initialise_fingerprint_test_repository("project-fingerprint-untracked-content");
    let note = root.join("src/notes.rs");

    std::fs::write(&note, "const NOTE: &str = \"one\";\n").unwrap();
    let first_untracked = super::project_change_fingerprint(&root);
    std::fs::write(&note, "const NOTE: &str = \"two\";\n").unwrap();
    let second_untracked = super::project_change_fingerprint(&root);

    assert_ne!(first_untracked, second_untracked);
}

#[test]
fn project_change_fingerprint_tracks_git_ignored_source_content() {
    let root = initialise_fingerprint_test_repository("project-fingerprint-ignored-content");
    std::fs::write(root.join(".gitignore"), "src/generated.rs\n").unwrap();
    let generated = root.join("src/generated.rs");

    std::fs::write(&generated, "fn generated_one() {}\n").unwrap();
    let first_ignored = super::project_change_fingerprint(&root);
    std::fs::write(&generated, "fn generated_two() {}\n").unwrap();
    let second_ignored = super::project_change_fingerprint(&root);

    assert_ne!(first_ignored, second_ignored);
}

#[test]
fn project_change_fingerprint_tracks_repeated_staged_content_edits() {
    let root = initialise_fingerprint_test_repository("project-fingerprint-staged-content");
    let git_add = || {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["add", "src/lib.rs"])
            .output()
            .unwrap();
        assert!(output.status.success());
    };

    std::fs::write(root.join("src/lib.rs"), "fn beta() {}\n").unwrap();
    git_add();
    let first_staged = super::project_change_fingerprint(&root);
    assert_eq!(first_staged, super::project_change_fingerprint(&root));

    std::fs::write(root.join("src/lib.rs"), "fn gamma() {}\n").unwrap();
    git_add();
    let second_staged = super::project_change_fingerprint(&root);
    assert_ne!(first_staged, second_staged);
}

#[test]
fn project_change_fingerprint_tracks_repeated_edits_in_a_scoped_subdirectory() {
    let root = initialise_fingerprint_test_repository("project-fingerprint-subdirectory");
    let scoped_root = root.join("src");

    std::fs::write(scoped_root.join("lib.rs"), "fn beta() {}\n").unwrap();
    let first_dirty = super::project_change_fingerprint(&scoped_root);
    std::fs::write(scoped_root.join("lib.rs"), "fn gamma() {}\n").unwrap();
    let second_dirty = super::project_change_fingerprint(&scoped_root);

    assert_ne!(first_dirty, second_dirty);
}

#[test]
fn project_graph_end_to_end_reanalysis_converges_and_failed_import_never_publishes_ready() {
    let root = isolated_gateway_test_dir("project-graph-end-to-end");
    let repository = root.join("repository");
    let published = root.join("published");
    std::fs::create_dir_all(repository.join("src")).unwrap();
    std::fs::write(repository.join("src/lib.rs"), "fn alpha() {}\n").unwrap();
    let facade = local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open_in_memory().unwrap(),
    );
    let user = local_first_memory::UserId::new("local-user");
    let workspace = local_first_memory::WorkspaceId::new("project-a");
    let graph = |reversed: bool| {
        let mut nodes = vec![
            serde_json::json!({"id":"a","label":"alpha"}),
            serde_json::json!({"id":"a","label":"alpha"}),
            serde_json::json!({"id":"b","label":"beta"}),
        ];
        let mut links = vec![
            serde_json::json!({"source":"a","target":"b","relation":"calls"}),
            serde_json::json!({"source":"a","target":"b","relation":"calls"}),
            serde_json::json!({"source":"a","target":"missing","relation":"calls"}),
        ];
        if reversed {
            nodes.reverse();
            links.reverse();
        }
        serde_json::json!({"nodes": nodes, "links": links})
    };
    let analyze = |fingerprint: &str, output: serde_json::Value| {
        local_first_desktop_gateway::project_graph_commit::stage_project_graph_build(
            &published,
            fingerprint,
            |staging| {
                assert!(repository.join("src/lib.rs").is_file());
                std::fs::write(staging.join("graph.json"), output.to_string())
                    .map_err(|error| error.to_string())
            },
            |value| {
                facade
                        .import_graphify_value(&user, &workspace, value)
                        .map_err(|error| {
                            local_first_desktop_gateway::project_graph_commit::ProjectGraphCommitError::Import(
                                error.to_string(),
                            )
                        })
            },
        )
    };

    let first = analyze("fingerprint-1", graph(false)).unwrap();
    assert_eq!(first.duplicate_nodes, 1);
    assert_eq!(first.duplicate_edges, 1);
    assert_eq!(first.dangling_edges, 1);
    let entity_refs = facade
        .list_entities_for_ui(&user, &workspace)
        .unwrap()
        .into_iter()
        .map(|entity| entity.reference)
        .collect::<Vec<_>>();
    let relation_refs = facade
        .list_relations_for_ui(&user, &workspace)
        .unwrap()
        .into_iter()
        .map(|relation| relation.reference)
        .collect::<Vec<_>>();

    let second = analyze("fingerprint-2", graph(true)).unwrap();
    assert_eq!(second.checksum, first.checksum);
    assert_eq!(
        facade
            .list_entities_for_ui(&user, &workspace)
            .unwrap()
            .into_iter()
            .map(|entity| entity.reference)
            .collect::<Vec<_>>(),
        entity_refs
    );
    assert_eq!(
        facade
            .list_relations_for_ui(&user, &workspace)
            .unwrap()
            .into_iter()
            .map(|relation| relation.reference)
            .collect::<Vec<_>>(),
        relation_refs
    );

    let changed = serde_json::json!({
        "nodes": [
            {"id":"a","label":"alpha"},
            {"id":"c","label":"gamma"}
        ],
        "links": [{"source":"a","target":"c","relation":"calls"}]
    });
    let third = analyze("fingerprint-3", changed).unwrap();
    assert_ne!(third.checksum, first.checksum);
    let mut keys = facade
        .list_entities_for_ui(&user, &workspace)
        .unwrap()
        .into_iter()
        .map(|entity| entity.canonical_key)
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, vec!["code:a", "code:c"]);
    assert_eq!(
        facade
            .list_relations_for_ui(&user, &workspace)
            .unwrap()
            .len(),
        1
    );
    let published_graph = std::fs::read(published.join("graph.json")).unwrap();
    let published_fingerprint = std::fs::read_to_string(published.join(".fingerprint")).unwrap();
    let failed = local_first_desktop_gateway::project_graph_commit::stage_project_graph_build(
        &published,
        "fingerprint-4",
        |staging| {
            std::fs::write(
                staging.join("graph.json"),
                serde_json::json!({"nodes":[{"id":"z"}],"links":[]}).to_string(),
            )
            .map_err(|error| error.to_string())
        },
        |_| {
            Err(
                local_first_desktop_gateway::project_graph_commit::ProjectGraphCommitError::Import(
                    "forced import failure".to_string(),
                ),
            )
        },
    );
    assert!(failed.is_err());
    assert_eq!(
        std::fs::read(published.join("graph.json")).unwrap(),
        published_graph
    );
    assert_eq!(
        std::fs::read_to_string(published.join(".fingerprint")).unwrap(),
        published_fingerprint
    );
    assert_eq!(
        facade
            .list_entities_for_ui(&user, &workspace)
            .unwrap()
            .len(),
        2
    );

    let mut events = super::app_events_tx().subscribe();
    let failure: Result<
        Option<local_first_memory::ProjectGraphImportReport>,
        local_first_desktop_gateway::project_graph_commit::ProjectGraphCommitError,
    > = Err(
        local_first_desktop_gateway::project_graph_commit::ProjectGraphCommitError::Import(
            "forced import failure".to_string(),
        ),
    );
    super::publish_project_graph_result("project-a", &failure);
    let event = events.try_recv().expect("project graph failure event");
    assert!(event.contains("project_graph.failed"));
    assert!(!event.contains("project_graph.ready"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn vault_end_to_end_encrypts_deduplicates_recalls_reveals_and_deletes_without_leakage() {
    let root = isolated_gateway_test_dir("vault-end-to-end");
    std::fs::create_dir_all(&root).unwrap();
    let db_path = root.join("vault.sqlite");
    let vault = local_first_vault::SQLiteVaultStore::open(&db_path).unwrap();
    super::apply_vault_pin_setup(
        &vault,
        &TEST_VAULT_WRAP_KEY,
        &super::VaultPinSetupRequest {
            pin: "123456".to_string(),
            current_pin: None,
        },
    )
    .expect("vault pin setup");
    let request = vault_action_request(
        "identity",
        "Codice fiscale Atlas",
        "[VAULT:identity:fiscal_code]",
        Some("VAULT_SECRET_SENTINEL"),
    );
    let saved = super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request)
        .expect("vault proposal save");
    assert_eq!(saved.status, "created");
    let duplicate = super::accept_vault_proposal(&vault, None, &TEST_VAULT_WRAP_KEY, &request)
        .expect("vault duplicate");
    assert_eq!(duplicate.status, "ignored");
    assert_eq!(duplicate.record_id, saved.record_id);
    let conflict = super::accept_vault_proposal(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &vault_action_request(
            "identity",
            "Codice fiscale Atlas",
            "[VAULT:identity:fiscal_code]",
            Some("DIFFERENT_VALUE"),
        ),
    )
    .expect("vault key conflict");
    assert_eq!(conflict.status, "conflict");
    assert_eq!(conflict.match_type.as_deref(), Some("key"));
    assert_eq!(vault.list().unwrap().len(), 1);

    let recall = super::recall_memory_response_with_vault_fallback(
        &vault,
        "mostra il codice fiscale Atlas",
        Vec::new(),
        false,
        true,
    );
    assert!(recall.contains("reveal_card"));
    assert!(recall.contains("[VAULT:identity:fiscal_code]"));
    assert!(!recall.contains("VAULT_SECRET_SENTINEL"));
    for response in [
        serde_json::to_string(&saved).unwrap(),
        serde_json::to_string(&duplicate).unwrap(),
        serde_json::to_string(&conflict).unwrap(),
    ] {
        assert!(!response.contains("VAULT_SECRET_SENTINEL"));
    }

    let connection = rusqlite::Connection::open(&db_path).unwrap();
    for sql in [
        "select coalesce(group_concat(id || category || label || secret_ref || metadata_json), '') from vault_records",
        "select coalesce(group_concat(verifier_json), '') from vault_local_pin",
        "select coalesce(group_concat(algorithm || nonce || ciphertext), '') from vault_local_keyring",
        "select coalesce(group_concat(algorithm || nonce || ciphertext), '') from vault_secret_material",
    ] {
        let stored: String = connection.query_row(sql, [], |row| row.get(0)).unwrap();
        assert!(!stored.contains("VAULT_SECRET_SENTINEL"), "{sql}");
    }

    let record_id = saved.record_id.parse().unwrap();
    let revealed = super::reveal_vault_record_secret(
        &vault,
        None,
        &TEST_VAULT_WRAP_KEY,
        &record_id,
        &super::VaultRecordRevealRequest {
            pin: "123456".to_string(),
        },
    )
    .expect("authorized reveal");
    assert_eq!(revealed.secret_value, "VAULT_SECRET_SENTINEL");
    vault.delete(&record_id).expect("vault delete");
    assert!(vault.list().unwrap().is_empty());
    let secret_rows: u64 = connection
        .query_row("select count(*) from vault_secret_material", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(secret_rows, 0);
    drop(connection);
    drop(vault);
    let _ = std::fs::remove_dir_all(root);
}

fn integrity_route_test_app(state: super::AppState) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/integrity/audit",
            axum::routing::get(super::integrity_audit),
        )
        .route(
            "/api/integrity/repair/preview",
            axum::routing::post(super::integrity_repair_preview),
        )
        .route(
            "/api/integrity/repair/apply",
            axum::routing::post(super::integrity_repair_apply),
        )
        .with_state(state)
}

#[tokio::test]
async fn integrity_audit_returns_counts_and_graph_freshness_without_content() {
    use tower::ServiceExt;

    let dir = isolated_gateway_test_dir("integrity-audit");
    std::fs::create_dir_all(&dir).unwrap();
    let _data_dir = TestGatewayDataDir::new(&dir);
    let project = dir.join("fixture-project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(
        dir.join("workspaces.json"),
        serde_json::to_vec(&WorkspacesFile {
            active: "project-a".to_string(),
            workspaces: vec![WorkspaceRecord {
                id: "project-a".to_string(),
                name: "Alpha".to_string(),
                folder: Some(project.to_string_lossy().into_owned()),
                sandbox_mode: None,
                approval_policy: None,
                writable_roots: None,
                skill_confirmations: None,
            }],
        })
        .unwrap(),
    )
    .unwrap();

    let state = super::AppState::for_tests();
    create_publication_route_memory(
        &state.memory_facade,
        super::gateway_memory_user_id(),
        "project-a",
        "PRIVATE_SENTINEL",
        local_first_memory::DataSensitivity::Private,
    );
    let response = integrity_route_test_app(state)
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/integrity/audit")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let (status, body) = memory_source_response_json(response).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(body["memory"]["integrity_ok"], true);
    assert_eq!(body["vault"]["integrity_ok"], true);
    assert_eq!(body["runtime"]["integrity_ok"], true);
    assert_eq!(body["graphs"][0]["status"], "missing");
    assert!(!body.to_string().contains("PRIVATE_SENTINEL"));
    assert!(
        !body
            .to_string()
            .contains(project.to_string_lossy().as_ref())
    );

    drop(_data_dir);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn integrity_audit_reports_runtime_lifecycle_findings_without_content() {
    use tower::ServiceExt;

    let dir = isolated_gateway_test_dir("integrity-audit-runtime");
    std::fs::create_dir_all(&dir).unwrap();
    let _data_dir = TestGatewayDataDir::new(&dir);
    let state = super::AppState::for_tests();
    let user = super::gateway_user_id();
    let workspace = WorkspaceId::new("workspace_test");
    let mut task = TaskRecord::new(
        "turn_runtime_integrity",
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "Runtime lifecycle sentinel",
        serde_json::json!({
            "thread_id": "thread_runtime_integrity",
            "secret": "RUNTIME_SECRET_SENTINEL",
        }),
    );
    task.status = TaskStatus::Completed;
    {
        let store = state.task_store.lock().unwrap();
        store
            .insert_chat_turn(
                &task,
                "thread_runtime_integrity",
                "req-runtime-integrity",
                "interactive",
                "full",
            )
            .unwrap();
        store
            .create_agent_run(&local_first_task_runtime::NewAgentRun {
                run_id: "run_runtime_integrity".to_string(),
                turn_id: "turn_runtime_integrity".to_string(),
                thread_id: "thread_runtime_integrity".to_string(),
                user_id: user.as_str().to_string(),
                workspace_id: workspace.as_str().to_string(),
                role: Some("orchestrator".to_string()),
                model: Some("qwen".to_string()),
                provider: Some("ollama".to_string()),
                prompt_fingerprint: None,
            })
            .unwrap();
        store
            .insert_turn_event(
                "turn_runtime_integrity",
                local_first_task_runtime::TurnEventKind::Activity,
                serde_json::json!({"status": "browser_budget_exceeded:stall"}),
            )
            .unwrap();
    }

    let response = integrity_route_test_app(state)
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/integrity/audit")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let (status, body) = memory_source_response_json(response).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(body["runtime"]["integrity_ok"], false);
    assert_eq!(
        body["runtime"]["finding_counts"]["terminal_task_with_running_agent_run"],
        1
    );
    assert_eq!(
        body["runtime"]["finding_counts"]["completed_task_with_browser_budget_exceeded"],
        1
    );
    assert!(!body.to_string().contains("RUNTIME_SECRET_SENTINEL"));

    drop(_data_dir);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn integrity_repair_apply_requires_matching_preview_token_and_confirmation() {
    use tower::ServiceExt;

    let dir = isolated_gateway_test_dir("integrity-repair");
    std::fs::create_dir_all(&dir).unwrap();
    let _data_dir = TestGatewayDataDir::new(&dir);
    let state = super::AppState::for_tests();
    let app = integrity_route_test_app(state);
    let preview_response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/integrity/repair/preview")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "actions": [{ "type": "rebuild_fts" }]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (preview_status, preview) = memory_source_response_json(preview_response).await;
    assert_eq!(preview_status, axum::http::StatusCode::OK);

    let mut without_confirmation = preview.clone();
    without_confirmation["confirm"] = serde_json::json!(false);
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/integrity/repair/apply")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(without_confirmation.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);

    let mut stale = preview;
    stale["confirm"] = serde_json::json!(true);
    stale["approval_token"] = serde_json::json!("stale-token");
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/integrity/repair/apply")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(stale.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);

    drop(_data_dir);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn integrity_repair_apply_creates_private_backup_without_exposing_paths() {
    use tower::ServiceExt;

    let dir = isolated_gateway_test_dir("integrity-repair-success");
    std::fs::create_dir_all(&dir).unwrap();
    let _data_dir = TestGatewayDataDir::new(&dir);
    let memory_path = dir.join("memory.sqlite");
    let mut state = super::AppState::for_tests();
    state.memory_facade = std::sync::Arc::new(local_first_memory::MemoryFacade::new(
        local_first_memory::SQLiteMemoryStore::open(&memory_path).unwrap(),
    ));
    create_publication_route_memory(
        &state.memory_facade,
        super::gateway_memory_user_id(),
        local_first_memory::PERSONAL_WORKSPACE,
        "PRIVATE_SENTINEL",
        local_first_memory::DataSensitivity::Private,
    );
    let app = integrity_route_test_app(state);
    let preview_response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/integrity/repair/preview")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "actions": [{ "type": "rebuild_fts" }]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (preview_status, mut preview) = memory_source_response_json(preview_response).await;
    assert_eq!(preview_status, axum::http::StatusCode::OK);
    preview["confirm"] = serde_json::json!(true);

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/integrity/repair/apply")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(preview.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = memory_source_response_json(response).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(body["backup"]["created"], true);
    assert!(body["backup"]["bytes"].as_u64().unwrap() > 0);
    let encoded = body.to_string();
    assert!(!encoded.contains("PRIVATE_SENTINEL"));
    assert!(!encoded.contains(memory_path.to_string_lossy().as_ref()));
    assert!(!encoded.contains("destination_path"));
    let backup_root = dir.join("backups").join("integrity");
    let backup_directories = std::fs::read_dir(&backup_root)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(backup_directories.len(), 1);
    assert!(backup_directories[0].path().join("memory.sqlite").is_file());

    drop(_data_dir);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn integrity_repair_apply_fails_stale_streaming_assistant_without_exposing_content() {
    use tower::ServiceExt;

    let dir = isolated_gateway_test_dir("integrity-repair-runtime");
    std::fs::create_dir_all(&dir).unwrap();
    let _data_dir = TestGatewayDataDir::new(&dir);
    let database = dir.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let thread = chat.create_thread("workspace_runtime_repair").unwrap();
    let mut assistant = local_first_desktop_gateway::seeded_ready_message(
        &thread.thread_id,
        "unix:100.000000000".to_string(),
    );
    assistant.id = "assistant_runtime_repair".to_string();
    assistant.text = "SECRET_RUNTIME_REPAIR_SENTINEL".to_string();
    assistant.linked_task_id = Some("turn_without_active_run".to_string());
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Streaming;
    chat.append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();

    let mut state = super::AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let app = integrity_route_test_app(state.clone());

    let preview_response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/integrity/repair/preview")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "actions": [{ "type": "fail_stale_streaming_assistants" }]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (preview_status, mut preview) = memory_source_response_json(preview_response).await;
    assert_eq!(preview_status, axum::http::StatusCode::OK);
    assert_eq!(preview["estimates"][0]["estimated_rows"], 1);
    assert!(
        !preview
            .to_string()
            .contains("SECRET_RUNTIME_REPAIR_SENTINEL")
    );
    preview["confirm"] = serde_json::json!(true);

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/integrity/repair/apply")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(preview.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = memory_source_response_json(response).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(body["backup"]["created"], true);
    assert!(body["backup"]["bytes"].as_u64().unwrap() > 0);
    assert_eq!(body["runtime_before"]["integrity_ok"], false);
    assert_eq!(body["runtime_after"]["integrity_ok"], true);
    let encoded = body.to_string();
    assert!(!encoded.contains("SECRET_RUNTIME_REPAIR_SENTINEL"));
    assert!(!encoded.contains(database.to_string_lossy().as_ref()));
    let backup_root = dir.join("backups").join("integrity-runtime");
    let backup_directories = std::fs::read_dir(&backup_root)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(backup_directories.len(), 1);
    assert!(backup_directories[0].path().join("homun.sqlite").is_file());
    let delivery_state = state
        .chat_store
        .lock()
        .unwrap()
        .message(&thread.thread_id, "assistant_runtime_repair")
        .unwrap()
        .unwrap()
        .delivery_state;
    assert_eq!(
        delivery_state,
        local_first_desktop_gateway::MessageDeliveryState::Failed
    );

    drop(_data_dir);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn integrity_repair_apply_fails_orphaned_waiting_approval_without_exposing_paths() {
    use tower::ServiceExt;

    let dir = isolated_gateway_test_dir("integrity-repair-orphaned-approval");
    std::fs::create_dir_all(&dir).unwrap();
    let _data_dir = TestGatewayDataDir::new(&dir);
    let database = dir.join("homun.sqlite");
    let chat = ChatStore::open(&database).unwrap();
    let tasks = local_first_task_runtime::TaskStore::open(&database).unwrap();
    let thread = chat
        .create_thread("workspace_orphaned_approval_repair")
        .unwrap();
    let task_id = local_first_task_runtime::TaskId::new("turn_orphaned_approval_repair");
    let user = super::gateway_user_id();
    let workspace = local_first_task_runtime::WorkspaceId::new("workspace_orphaned_approval");
    let mut task = local_first_task_runtime::TaskRecord::new(
        task_id.as_str(),
        user.clone(),
        workspace.clone(),
        "chat_turn",
        "orphaned approval repair",
        serde_json::json!({
            "thread_id": thread.thread_id.clone(),
        }),
    );
    task.status = local_first_task_runtime::TaskStatus::WaitingUserApproval;
    tasks
        .insert_chat_turn(
            &task,
            &thread.thread_id,
            task_id.as_str(),
            "interactive",
            "full",
        )
        .unwrap();

    let mut state = super::AppState::for_tests();
    state.chat_store = std::sync::Arc::new(std::sync::Mutex::new(chat));
    state.task_store = std::sync::Arc::new(std::sync::Mutex::new(tasks));
    let app = integrity_route_test_app(state.clone());

    let preview_response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/integrity/repair/preview")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "actions": [{ "type": "fail_orphaned_waiting_approvals" }]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (preview_status, mut preview) = memory_source_response_json(preview_response).await;
    assert_eq!(preview_status, axum::http::StatusCode::OK);
    assert_eq!(preview["estimates"][0]["estimated_rows"], 1);
    preview["confirm"] = serde_json::json!(true);

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/integrity/repair/apply")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(preview.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = memory_source_response_json(response).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(body["backup"]["created"], true);
    assert!(body["backup"]["bytes"].as_u64().unwrap() > 0);
    assert_eq!(body["applied"][0]["estimated_rows"], 1);
    let encoded = body.to_string();
    assert!(!encoded.contains(database.to_string_lossy().as_ref()));
    let repaired = state
        .task_store
        .lock()
        .unwrap()
        .get_task(&task_id, &user, &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(
        repaired.status,
        local_first_task_runtime::TaskStatus::Failed
    );
    assert_eq!(
        repaired.blocked_reason.as_deref(),
        Some("orphaned_waiting_approval_repaired")
    );
    let backup_root = dir.join("backups").join("integrity-runtime");
    let backup_directories = std::fs::read_dir(&backup_root)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(backup_directories.len(), 1);
    assert!(backup_directories[0].path().join("homun.sqlite").is_file());

    drop(_data_dir);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn browser_anti_loop_nudge_injects_after_threshold_consecutive_snapshots() {
    let threshold = 3;
    // First snapshot: count goes to 1, no nudge.
    let (count, nudge, hard_capped) = browser_anti_loop_nudge(0, "browser_snapshot", threshold);
    assert_eq!(count, 1);
    assert!(nudge.is_none());
    assert!(!hard_capped);
    // Second snapshot: count goes to 2, no nudge.
    let (count, nudge, hard_capped) = browser_anti_loop_nudge(count, "browser_snapshot", threshold);
    assert_eq!(count, 2);
    assert!(nudge.is_none());
    assert!(!hard_capped);
    // Third snapshot: count reaches threshold, soft nudge injected, counter NOT reset.
    let (count, nudge, hard_capped) = browser_anti_loop_nudge(count, "browser_snapshot", threshold);
    assert_eq!(count, 3);
    let msg = nudge.expect("soft nudge should be injected at threshold");
    assert!(msg.contains("ANTI-LOOP"));
    assert!(msg.contains("3 consecutive"));
    assert!(msg.contains("Do NOT call browser_snapshot again"));
    assert!(!hard_capped);
    // Fourth snapshot: counter stays above threshold, soft nudge repeats, NOT reset.
    let (count, nudge, hard_capped) = browser_anti_loop_nudge(count, "browser_snapshot", threshold);
    assert_eq!(count, 4);
    assert!(nudge.is_some());
    assert!(!hard_capped);
    // Fifth snapshot: hard cap fires (threshold + 2 = 5), counter NOT reset, hard_capped.
    let (count, nudge, hard_capped) = browser_anti_loop_nudge(count, "browser_snapshot", threshold);
    assert_eq!(count, 5);
    let msg = nudge.expect("hard cap nudge should be injected at threshold + 2");
    assert!(msg.contains("ANTI-LOOP"));
    assert!(msg.contains("5 consecutive"));
    assert!(msg.contains("TERMINATED"));
    assert!(hard_capped);
}

#[test]
fn browser_anti_loop_nudge_resets_on_meaningful_action() {
    let threshold = 3;
    // Accumulate two consecutive snapshots.
    let (count, _, _) = browser_anti_loop_nudge(0, "browser_snapshot", threshold);
    let (count, _, _) = browser_anti_loop_nudge(count, "browser_snapshot", threshold);
    assert_eq!(count, 2);
    // A browser_act (e.g. click) resets the counter to 0 — no nudge.
    let (count, nudge, hard_capped) = browser_anti_loop_nudge(count, "browser_act", threshold);
    assert_eq!(count, 0);
    assert!(nudge.is_none());
    assert!(!hard_capped);
    // Even right after reset, a single snapshot does not trigger.
    let (count, nudge, _) = browser_anti_loop_nudge(count, "browser_snapshot", threshold);
    assert_eq!(count, 1);
    assert!(nudge.is_none());
    // Other meaningful actions also reset.
    let (count, nudge, _) = browser_anti_loop_nudge(2, "browser_navigate", threshold);
    assert_eq!(count, 0);
    assert!(nudge.is_none());
    let (count, nudge, _) = browser_anti_loop_nudge(2, "browser_done", threshold);
    assert_eq!(count, 0);
    assert!(nudge.is_none());
    let (count, nudge, _) = browser_anti_loop_nudge(2, "browser_screenshot", threshold);
    assert_eq!(count, 0);
    assert!(nudge.is_none());
}

#[test]
fn repeated_browser_action_nudge_survives_interleaved_snapshots() {
    let mut recent = std::collections::VecDeque::new();
    let same_type = r#"{"kind":"type","ref":"e65","text":"Milano","action_class":"ordinary"}"#;

    let (nudge, hard_capped) =
        repeated_browser_action_nudge(&mut recent, "browser_act", same_type, 3);
    assert!(nudge.is_none());
    assert!(!hard_capped);

    let (nudge, hard_capped) =
        repeated_browser_action_nudge(&mut recent, "browser_snapshot", "{}", 3);
    assert!(nudge.is_none());
    assert!(!hard_capped);

    let (nudge, hard_capped) =
        repeated_browser_action_nudge(&mut recent, "browser_act", same_type, 3);
    let msg = nudge.expect("second identical browser action should nudge even after snapshot");
    assert!(msg.contains("same browser action"));
    assert!(!hard_capped);

    let (nudge, hard_capped) =
        repeated_browser_action_nudge(&mut recent, "browser_act", same_type, 3);
    let msg = nudge.expect("third identical browser action should hard-cap");
    assert!(msg.contains("TERMINATED"));
    assert!(hard_capped);
}

#[test]
fn repeated_browser_action_nudge_resets_on_different_action_signature() {
    let mut recent = std::collections::VecDeque::new();
    let milano = r#"{"kind":"type","ref":"e65","text":"Milano"}"#;
    let roma = r#"{"kind":"type","ref":"e65","text":"Roma"}"#;

    assert!(
        repeated_browser_action_nudge(&mut recent, "browser_act", milano, 3)
            .0
            .is_none()
    );
    assert!(
        repeated_browser_action_nudge(&mut recent, "browser_act", roma, 3)
            .0
            .is_none()
    );
    assert!(
        repeated_browser_action_nudge(&mut recent, "browser_act", milano, 3)
            .0
            .is_none()
    );
}

#[test]
fn browser_snapshot_semantic_fingerprint_ignores_ref_churn_and_headers() {
    let first = r#"
title: Biglietti treni e pullman in Italia e Europa, orari e offerte | Trainline
[page stats: scrollY=0 scrollHeight=4210 clientHeight=900 interactive=91 total=550]
- textbox "Da" [ref=e12]: Milano Centrale
- option "Milano Centrale" [ref=e51*]
- textbox "A" [ref=e15]: Roma Termini
- button "Cerca" [ref=e80]
"#;
    let second = r#"
title: Biglietti treni e pullman in Italia e Europa, orari e offerte | Trainline
[page stats: scrollY=12 scrollHeight=4218 clientHeight=900 interactive=93 total=557]
- textbox "Da" [ref=e112]: Milano Centrale
- option "Milano Centrale" [ref=e151]
- textbox "A" [ref=e115]: Roma Termini
- button "Cerca" [ref=e180*]
"#;

    assert_eq!(
        browser_snapshot_semantic_fingerprint(first),
        browser_snapshot_semantic_fingerprint(second)
    );
}

#[test]
fn browser_snapshot_semantic_fingerprint_changes_for_real_page_progress() {
    let form = r#"
- textbox "Da" [ref=e12]: Milano Centrale
- textbox "A" [ref=e15]: Roma Termini
- button "Cerca" [ref=e80]
"#;
    let results = r#"
- heading "Milano Centrale a Roma Termini" [ref=e12]
- text "08:10 Frecciarossa 9613 durata 3h 10m" [ref=e15]
- button "Seleziona" [ref=e80]
"#;

    assert_ne!(
        browser_snapshot_semantic_fingerprint(form),
        browser_snapshot_semantic_fingerprint(results)
    );
}

#[test]
fn browser_cached_snapshot_fallback_returns_last_observation_refs() {
    let fallback = super::browser_cached_snapshot_fallback(
        "Snapshot",
        "target temporarily unavailable",
        "textbox \"Text input\" [ref=e7]",
    )
    .expect("fallback");

    assert!(fallback.contains("Snapshot failed"));
    assert!(fallback.contains("last successful browser observation"));
    assert!(fallback.contains("browser_act"));
    assert!(fallback.contains("textbox \"Text input\" [ref=e7]"));
    assert!(fallback.contains("target temporarily unavailable"));
}

#[test]
fn browser_cached_snapshot_fallback_refuses_empty_snapshot() {
    assert!(super::browser_cached_snapshot_fallback("Snapshot", "boom", "   ").is_none());
}

#[test]
fn browser_navigation_timeout_triggers_recycle_recovery() {
    assert!(super::browser_navigation_should_recycle_after_error(
        "connectOverCDP timeout while attaching"
    ));
    assert!(super::browser_navigation_should_recycle_after_error(
        super::BROWSER_SIDECAR_TIMEOUT_ERROR
    ));
    assert!(!super::browser_navigation_should_recycle_after_error(
        "Navigation failed: net::ERR_NAME_NOT_RESOLVED"
    ));
}

#[test]
fn repeated_browser_failed_action_nudge_survives_interleaved_actions() {
    let mut recent = std::collections::VecDeque::new();
    let set_date = r#"{"kind":"set_date","date":"2026-08-25","action_class":"ordinary"}"#;
    let click = r#"{"kind":"click","ref":"e41","action_class":"ordinary"}"#;

    let (nudge, hard_capped) =
        repeated_browser_failed_action_nudge(&mut recent, "browser_act", set_date, true, 3);
    assert!(nudge.is_none());
    assert!(!hard_capped);

    let (nudge, hard_capped) =
        repeated_browser_failed_action_nudge(&mut recent, "browser_act", click, false, 3);
    assert!(nudge.is_none());
    assert!(!hard_capped);

    let (nudge, hard_capped) =
        repeated_browser_failed_action_nudge(&mut recent, "browser_navigate", "{}", false, 3);
    assert!(nudge.is_none());
    assert!(!hard_capped);

    let (nudge, hard_capped) =
        repeated_browser_failed_action_nudge(&mut recent, "browser_act", set_date, true, 3);
    let msg = nudge.expect("second failed set_date should nudge even after other actions");
    assert!(msg.contains("set_date"));
    assert!(!hard_capped);

    let (nudge, hard_capped) =
        repeated_browser_failed_action_nudge(&mut recent, "browser_act", set_date, true, 3);
    let msg = nudge.expect("third failed set_date should hard-cap the sub-turn");
    assert!(msg.contains("TERMINATED"));
    assert!(hard_capped);
}

#[test]
fn browser_anti_loop_nudge_threshold_zero_disables_nudge() {
    // A threshold of 0 disables both nudge and hard cap entirely.
    let (count, nudge, hard_capped) = browser_anti_loop_nudge(0, "browser_snapshot", 0);
    assert_eq!(count, 1);
    assert!(nudge.is_none());
    assert!(!hard_capped);
    let (count, nudge, hard_capped) = browser_anti_loop_nudge(99, "browser_snapshot", 0);
    assert_eq!(count, 100);
    assert!(nudge.is_none());
    assert!(!hard_capped);
}

#[test]
fn browser_anti_loop_nudge_respects_custom_threshold() {
    // A custom threshold of 5 fires a soft nudge on the 5th consecutive snapshot,
    // and the hard cap fires at threshold + 2 = 7.
    let threshold = 5;
    let mut count = 0u32;
    for i in 1..threshold {
        let (c, nudge, _) = browser_anti_loop_nudge(count, "browser_snapshot", threshold);
        count = c;
        assert_eq!(count, i);
        assert!(nudge.is_none(), "no nudge expected at count {}", i);
    }
    // Snapshot 5: soft nudge fires, counter NOT reset.
    let (c, nudge, hard_capped) = browser_anti_loop_nudge(count, "browser_snapshot", threshold);
    count = c;
    assert_eq!(count, threshold);
    assert!(!hard_capped);
    let msg = nudge.expect("soft nudge at threshold");
    assert!(msg.contains("5 consecutive"));
    // Snapshot 6: soft nudge repeats, counter NOT reset.
    let (c, nudge, hard_capped) = browser_anti_loop_nudge(count, "browser_snapshot", threshold);
    count = c;
    assert_eq!(count, threshold + 1);
    assert!(nudge.is_some());
    assert!(!hard_capped);
    // Snapshot 7: hard cap fires (threshold + 2 = 7).
    let (c, nudge, hard_capped) = browser_anti_loop_nudge(count, "browser_snapshot", threshold);
    count = c;
    assert_eq!(count, threshold + 2);
    assert!(hard_capped);
    let msg = nudge.expect("hard cap nudge at threshold + 2");
    assert!(msg.contains("7 consecutive"));
    assert!(msg.contains("TERMINATED"));
}
