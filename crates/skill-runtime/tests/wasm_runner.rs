use local_first_skill_runtime::{SkillRuntimeError, WasmSkillRunnerConfig};
use std::path::Path;

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

fn write_wasm(path: &Path, wat_source: &str) {
    let wasm = wat::parse_str(wat_source).unwrap();
    std::fs::write(path, wasm).unwrap();
}
