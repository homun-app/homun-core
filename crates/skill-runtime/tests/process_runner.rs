use local_first_capabilities::{ActionClass, SkillManifest, SkillPermissions, SkillToolManifest};
use local_first_skill_runtime::{
    ProcessSkillRunner, ProcessSkillRunnerConfig, SkillRuntime, SkillRuntimeError,
    SkillRuntimeRequest,
};
use std::path::PathBuf;
use std::sync::Arc;

#[test]
fn config_rejects_executable_outside_allowed_roots() {
    let temp = tempfile::tempdir().unwrap();
    let allowed_root = temp.path().join("allowed");
    let outside_root = temp.path().join("outside");
    std::fs::create_dir_all(&allowed_root).unwrap();
    std::fs::create_dir_all(&outside_root).unwrap();
    let executable = outside_root.join("handler");
    std::fs::write(&executable, "#!/bin/sh\n").unwrap();

    let error = ProcessSkillRunnerConfig::new(
        executable,
        allowed_root.clone(),
        vec![allowed_root.clone()],
        vec![allowed_root],
    )
    .unwrap_err();

    assert_eq!(
        error,
        SkillRuntimeError::RunnerFailed("executable_outside_allowed_roots".to_string())
    );
}

#[test]
fn config_rejects_working_directory_outside_allowed_roots() {
    let temp = tempfile::tempdir().unwrap();
    let executable_root = temp.path().join("bin");
    let working_root = temp.path().join("work");
    let outside_root = temp.path().join("outside");
    std::fs::create_dir_all(&executable_root).unwrap();
    std::fs::create_dir_all(&working_root).unwrap();
    std::fs::create_dir_all(&outside_root).unwrap();
    let executable = executable_root.join("handler");
    std::fs::write(&executable, "#!/bin/sh\n").unwrap();

    let error = ProcessSkillRunnerConfig::new(
        executable,
        outside_root,
        vec![executable_root],
        vec![working_root],
    )
    .unwrap_err();

    assert_eq!(
        error,
        SkillRuntimeError::RunnerFailed("working_dir_outside_allowed_roots".to_string())
    );
}

#[test]
fn config_canonicalizes_allowed_executable_and_working_directory() {
    let temp = tempfile::tempdir().unwrap();
    let executable_root = temp.path().join("bin");
    let working_root = temp.path().join("work");
    std::fs::create_dir_all(&executable_root).unwrap();
    std::fs::create_dir_all(&working_root).unwrap();
    let executable = executable_root.join("handler");
    std::fs::write(&executable, "#!/bin/sh\n").unwrap();

    let config = ProcessSkillRunnerConfig::new(
        executable.clone(),
        working_root.clone(),
        vec![executable_root.clone()],
        vec![working_root.clone()],
    )
    .unwrap();

    assert_eq!(config.executable(), executable.canonicalize().unwrap());
    assert_eq!(config.working_dir(), working_root.canonicalize().unwrap());
    assert_eq!(config.env().len(), 0);
}

#[test]
fn config_accepts_explicit_env_values() {
    let temp = tempfile::tempdir().unwrap();
    let executable_root = temp.path().join("bin");
    let working_root = temp.path().join("work");
    std::fs::create_dir_all(&executable_root).unwrap();
    std::fs::create_dir_all(&working_root).unwrap();
    let executable = executable_root.join("handler");
    std::fs::write(&executable, "#!/bin/sh\n").unwrap();

    let config = ProcessSkillRunnerConfig::new(
        executable,
        working_root,
        vec![executable_root],
        vec![PathBuf::from(temp.path()).join("work")],
    )
    .unwrap()
    .with_env("SKILL_MODE", "test");

    assert_eq!(config.env().get("SKILL_MODE").unwrap(), "test");
}

#[test]
fn process_runner_sends_request_json_and_parses_output_json() {
    let fixture = process_fixture(
        r#"
read input
python3 -c 'import json,sys; data=json.loads(sys.argv[1]); print(json.dumps({"output":{"tool":data["tool_name"],"query":data["arguments"]["query"]},"trace":{"accessed_network":[],"accessed_filesystem":[]}}))' "$input"
"#,
    );
    let runtime = SkillRuntime::new(Arc::new(ProcessSkillRunner::new(fixture.config)));

    let output = runtime
        .execute(SkillRuntimeRequest::new(
            sample_skill_manifest(),
            "calendar.search",
            serde_json::json!({"query": "standup"}),
        ))
        .unwrap();

    assert_eq!(output.output["tool"], "calendar.search");
    assert_eq!(output.output["query"], "standup");
}

#[test]
fn process_runner_clears_inherited_environment_and_keeps_explicit_env() {
    unsafe {
        std::env::set_var("SHOULD_NOT_LEAK_TO_SKILL", "secret");
    }
    let fixture = process_fixture(
        r#"
read input
python3 -c 'import json,os; print(json.dumps({"output":{"leaked":os.environ.get("SHOULD_NOT_LEAK_TO_SKILL"),"mode":os.environ.get("SKILL_MODE")},"trace":{"accessed_network":[],"accessed_filesystem":[]}}))'
"#,
    );
    let config = fixture.config.with_env("SKILL_MODE", "test");
    let runtime = SkillRuntime::new(Arc::new(ProcessSkillRunner::new(config)));

    let output = runtime
        .execute(SkillRuntimeRequest::new(
            sample_skill_manifest(),
            "calendar.search",
            serde_json::json!({"query": "standup"}),
        ))
        .unwrap();

    assert!(output.output["leaked"].is_null());
    assert_eq!(output.output["mode"], "test");
}

#[test]
fn process_runner_kills_child_on_timeout() {
    let fixture = process_fixture(
        r#"
sleep 5
"#,
    );
    let runtime = SkillRuntime::new(Arc::new(ProcessSkillRunner::new(fixture.config)));

    let error = runtime
        .execute(
            SkillRuntimeRequest::new(
                sample_skill_manifest(),
                "calendar.search",
                serde_json::json!({"query": "standup"}),
            )
            .with_limits(local_first_skill_runtime::SkillRuntimeLimits {
                timeout_seconds: 1,
                max_output_bytes: 4096,
            }),
        )
        .unwrap_err();

    assert_eq!(
        error,
        SkillRuntimeError::RunnerFailed("process_timeout".to_string())
    );
}

#[test]
fn process_runner_reports_non_zero_exit_and_bad_json() {
    let non_zero = process_fixture("echo no >&2\nexit 12\n");
    let non_zero_runtime = SkillRuntime::new(Arc::new(ProcessSkillRunner::new(non_zero.config)));
    let bad_json = process_fixture("echo not-json\n");
    let bad_json_runtime = SkillRuntime::new(Arc::new(ProcessSkillRunner::new(bad_json.config)));

    let non_zero_error = non_zero_runtime
        .execute(SkillRuntimeRequest::new(
            sample_skill_manifest(),
            "calendar.search",
            serde_json::json!({"query": "standup"}),
        ))
        .unwrap_err();
    let bad_json_error = bad_json_runtime
        .execute(SkillRuntimeRequest::new(
            sample_skill_manifest(),
            "calendar.search",
            serde_json::json!({"query": "standup"}),
        ))
        .unwrap_err();

    assert_eq!(
        non_zero_error,
        SkillRuntimeError::RunnerFailed("process_exit:12:no".to_string())
    );
    assert!(matches!(
        bad_json_error,
        SkillRuntimeError::RunnerFailed(message) if message.starts_with("process_output_json:")
    ));
}

#[test]
fn process_runner_rejects_stdout_larger_than_limit() {
    let fixture = process_fixture(
        r#"
python3 -c 'print("x" * 10000)'
"#,
    );
    let runtime = SkillRuntime::new(Arc::new(ProcessSkillRunner::new(fixture.config)));

    let error = runtime
        .execute(
            SkillRuntimeRequest::new(
                sample_skill_manifest(),
                "calendar.search",
                serde_json::json!({"query": "standup"}),
            )
            .with_limits(local_first_skill_runtime::SkillRuntimeLimits {
                timeout_seconds: 5,
                max_output_bytes: 512,
            }),
        )
        .unwrap_err();

    assert_eq!(error, SkillRuntimeError::OutputTooLarge(10001));
}

struct ProcessFixture {
    config: ProcessSkillRunnerConfig,
}

fn process_fixture(script_body: &str) -> ProcessFixture {
    let temp = tempfile::tempdir().unwrap().keep();
    let bin = temp.join("bin");
    let work = temp.join("work");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let script = bin.join("handler.sh");
    std::fs::write(&script, format!("#!/bin/sh\n{script_body}")).unwrap();
    make_executable(&script);
    ProcessFixture {
        config: ProcessSkillRunnerConfig::new(script, work, vec![bin], vec![temp]).unwrap(),
    }
}

#[cfg(unix)]
fn make_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(path, permissions).unwrap();
}

#[cfg(not(unix))]
fn make_executable(_path: &std::path::Path) {}

fn sample_skill_manifest() -> SkillManifest {
    SkillManifest {
        id: "calendar-local".to_string(),
        version: "0.1.0".to_string(),
        description: "Local calendar search".to_string(),
        runtime: "process".to_string(),
        tools: vec![SkillToolManifest {
            name: "calendar.search".to_string(),
            description: "Search local calendar events".to_string(),
            action: ActionClass::Read,
            privacy_domains: vec!["work".to_string()],
            sensitivity: "private".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["query"],
                "properties": {"query": {"type": "string"}}
            }),
        }],
        permissions: SkillPermissions {
            network: Vec::new(),
            filesystem: Vec::new(),
            privacy_domains: vec!["work".to_string()],
        },
    }
}
