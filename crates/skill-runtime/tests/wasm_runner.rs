use local_first_capabilities::{ActionClass, SkillManifest, SkillPermissions, SkillToolManifest};
use local_first_skill_runtime::{
    SkillRuntime, SkillRuntimeError, SkillRuntimeLimits, SkillRuntimeRequest, WasmSkillRunner,
    WasmSkillRunnerConfig,
};
use std::path::Path;
use std::sync::Arc;

#[test]
fn config_rejects_module_outside_allowed_roots() {
    let temp = tempfile::tempdir().unwrap();
    let allowed = temp.path().join("allowed");
    let outside = temp.path().join("outside");
    std::fs::create_dir_all(&allowed).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let module = outside.join("skill.wasm");
    write_wasm(&module, "(module)");

    let error = WasmSkillRunnerConfig::new(module, vec![allowed]).unwrap_err();

    assert_eq!(
        error,
        SkillRuntimeError::RunnerFailed("wasm_module_outside_allowed_roots".to_string())
    );
}

#[test]
fn config_rejects_modules_with_host_imports() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("skills");
    std::fs::create_dir_all(&root).unwrap();
    let module = root.join("skill.wasm");
    write_wasm(
        &module,
        r#"
        (module
          (import "wasi_snapshot_preview1" "fd_write"
            (func $fd_write (param i32 i32 i32 i32) (result i32)))
        )
        "#,
    );

    let error = WasmSkillRunnerConfig::new(module, vec![root]).unwrap_err();

    assert_eq!(
        error,
        SkillRuntimeError::RunnerFailed("wasm_imports_not_allowed".to_string())
    );
}

#[test]
fn config_accepts_import_free_module_inside_allowed_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("skills");
    std::fs::create_dir_all(&root).unwrap();
    let module = root.join("skill.wasm");
    write_wasm(
        &module,
        r#"
        (module
          (memory (export "memory") 1)
          (func (export "run") (param i32 i32) (result i64)
            i64.const 0)
        )
        "#,
    );

    let config = WasmSkillRunnerConfig::new(module.clone(), vec![root]).unwrap();

    assert_eq!(config.module_path(), module.canonicalize().unwrap());
    assert_eq!(config.max_fuel(), 1_000_000);
    assert_eq!(config.max_memory_pages(), 4);
}

#[test]
fn wasm_runner_calls_run_and_reads_output_json_from_guest_memory() {
    let fixture = wasm_fixture(&wasm_module_returning_json(
        r#"{"output":{"ok":true},"trace":{"accessed_network":[],"accessed_filesystem":[]}}"#,
    ));
    let config = WasmSkillRunnerConfig::new(fixture.module.clone(), vec![fixture.root]).unwrap();
    let runtime = SkillRuntime::new(Arc::new(WasmSkillRunner::new(config)));

    let output = runtime
        .execute(SkillRuntimeRequest::new(
            sample_skill_manifest(),
            "calendar.search",
            serde_json::json!({"query": "standup"}),
        ))
        .unwrap();

    assert_eq!(output.output["ok"], true);
}

#[test]
fn wasm_runner_rejects_output_larger_than_limit_before_json_parse() {
    let large_json = format!(
        r#"{{"output":{{"blob":"{}"}},"trace":{{"accessed_network":[],"accessed_filesystem":[]}}}}"#,
        "x".repeat(4096)
    );
    let large_json_len = large_json.as_bytes().len();
    let fixture = wasm_fixture(&wasm_module_returning_json(&large_json));
    let config = WasmSkillRunnerConfig::new(fixture.module.clone(), vec![fixture.root]).unwrap();
    let runtime = SkillRuntime::new(Arc::new(WasmSkillRunner::new(config)));

    let error = runtime
        .execute(
            SkillRuntimeRequest::new(
                sample_skill_manifest(),
                "calendar.search",
                serde_json::json!({"query": "standup"}),
            )
            .with_limits(SkillRuntimeLimits {
                timeout_seconds: 30,
                max_output_bytes: 256,
            }),
        )
        .unwrap_err();

    assert_eq!(error, SkillRuntimeError::OutputTooLarge(large_json_len));
}

#[test]
fn wasm_runner_stops_modules_that_exhaust_fuel() {
    let fixture = wasm_fixture(
        r#"
        (module
          (memory (export "memory") 1)
          (func (export "run") (param i32 i32) (result i64)
            (loop $spin
              br $spin)
            i64.const 0)
        )
        "#,
    );
    let config = WasmSkillRunnerConfig::new(fixture.module.clone(), vec![fixture.root])
        .unwrap()
        .with_max_fuel(10);
    let runtime = SkillRuntime::new(Arc::new(WasmSkillRunner::new(config)));

    let error = runtime
        .execute(SkillRuntimeRequest::new(
            sample_skill_manifest(),
            "calendar.search",
            serde_json::json!({"query": "standup"}),
        ))
        .unwrap_err();

    assert!(matches!(
        error,
        SkillRuntimeError::RunnerFailed(message) if message.starts_with("wasm_trap:")
    ));
}

#[test]
fn wasm_runner_rejects_missing_memory_or_run_export() {
    let missing_memory = wasm_fixture(
        r#"
        (module
          (func (export "run") (param i32 i32) (result i64)
            i64.const 0)
        )
        "#,
    );
    let missing_run = wasm_fixture(
        r#"
        (module
          (memory (export "memory") 1)
        )
        "#,
    );
    let missing_memory_runtime = SkillRuntime::new(Arc::new(WasmSkillRunner::new(
        WasmSkillRunnerConfig::new(missing_memory.module, vec![missing_memory.root]).unwrap(),
    )));
    let missing_run_runtime = SkillRuntime::new(Arc::new(WasmSkillRunner::new(
        WasmSkillRunnerConfig::new(missing_run.module, vec![missing_run.root]).unwrap(),
    )));

    let missing_memory_error = missing_memory_runtime
        .execute(SkillRuntimeRequest::new(
            sample_skill_manifest(),
            "calendar.search",
            serde_json::json!({"query": "standup"}),
        ))
        .unwrap_err();
    let missing_run_error = missing_run_runtime
        .execute(SkillRuntimeRequest::new(
            sample_skill_manifest(),
            "calendar.search",
            serde_json::json!({"query": "standup"}),
        ))
        .unwrap_err();

    assert_eq!(
        missing_memory_error,
        SkillRuntimeError::RunnerFailed("wasm_memory_export_missing".to_string())
    );
    assert_eq!(
        missing_run_error,
        SkillRuntimeError::RunnerFailed("wasm_run_export_missing".to_string())
    );
}

fn write_wasm(path: &Path, wat_source: &str) {
    let wasm = wat::parse_str(wat_source).unwrap();
    std::fs::write(path, wasm).unwrap();
}

struct WasmFixture {
    root: std::path::PathBuf,
    module: std::path::PathBuf,
}

fn wasm_fixture(wat_source: &str) -> WasmFixture {
    let temp = tempfile::tempdir().unwrap().keep();
    let root = temp.join("skills");
    std::fs::create_dir_all(&root).unwrap();
    let module = root.join("skill.wasm");
    write_wasm(&module, wat_source);
    WasmFixture { root, module }
}

fn wasm_module_returning_json(json: &str) -> String {
    let escaped = json.replace('\\', "\\\\").replace('"', "\\\"");
    let output_ptr = 1024u64;
    let output_len = json.as_bytes().len() as u64;
    let packed = (output_ptr << 32) | output_len;
    format!(
        r#"
        (module
          (memory (export "memory") 1)
          (data (i32.const {output_ptr}) "{escaped}")
          (func (export "run") (param i32 i32) (result i64)
            i64.const {packed})
        )
        "#
    )
}

fn sample_skill_manifest() -> SkillManifest {
    SkillManifest {
        id: "calendar-local".to_string(),
        version: "0.1.0".to_string(),
        description: "Local calendar search".to_string(),
        runtime: "wasm".to_string(),
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
