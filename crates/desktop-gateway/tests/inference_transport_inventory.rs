use std::path::{Path, PathBuf};

const APPROVED: &[&str] = &[
    "crates/desktop-gateway/src/model_client.rs",
    "crates/desktop-gateway/src/inference_transport.rs",
    "crates/inference/src/openai_compat.rs",
    "crates/inference/src/anthropic.rs",
];

const TEST_ONLY: &[&str] = &["crates/desktop-gateway/src/gateway_main_tests.rs"];

fn workspace_root() -> PathBuf {
    let current = std::env::current_dir().expect("test current directory");
    for candidate in current.ancestors() {
        if candidate.join("Cargo.lock").is_file()
            && candidate.join("crates/desktop-gateway/src").is_dir()
            && candidate.join("crates/inference/src").is_dir()
        {
            return candidate.to_path_buf();
        }
    }
    panic!(
        "could not locate Homun workspace root from {}",
        current.display()
    );
}

fn rust_files(root: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

#[test]
fn inventory_root_uses_runtime_checkout_not_compiled_worktree_path() {
    let current = std::env::current_dir().expect("test current directory");
    let runtime_root = current
        .ancestors()
        .find(|candidate| {
            candidate.join("Cargo.lock").is_file()
                && candidate.join("crates/desktop-gateway/src").is_dir()
                && candidate.join("crates/inference/src").is_dir()
        })
        .expect("runtime workspace ancestor")
        .canonicalize()
        .expect("canonical runtime root");

    assert_eq!(
        workspace_root()
            .canonicalize()
            .expect("canonical inventory root"),
        runtime_root
    );
}

#[test]
fn inference_transport_inventory() {
    let workspace = workspace_root();
    let roots = [
        workspace.join("crates/desktop-gateway/src"),
        workspace.join("crates/inference/src"),
    ];
    let mut files = Vec::new();
    for root in roots {
        rust_files(&root, &mut files);
    }

    let mut violations = Vec::new();
    for path in files {
        let relative = path.strip_prefix(&workspace).unwrap().to_string_lossy();
        if TEST_ONLY.iter().any(|test_only| *test_only == relative) {
            continue;
        }
        if APPROVED.iter().any(|approved| *approved == relative) {
            continue;
        }
        let source = std::fs::read_to_string(&path).unwrap();
        let production = source
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap_or(&source);
        for (index, line) in production.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with('*') {
                continue;
            }
            let direct_endpoint = ["/chat/completions", "/v1/messages", "/api/embed"]
                .iter()
                .any(|needle| line.contains(needle));
            if direct_endpoint || line.contains("send_chat_request(") {
                violations.push(format!("{relative}:{}: {trimmed}", index + 1));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "direct inference transports must use an approved adapter:\n{}",
        violations.join("\n")
    );
}

#[test]
fn retired_in_process_mistralrs_transport_stays_removed() {
    let workspace = workspace_root();
    let manifest = std::fs::read_to_string(workspace.join("crates/inference/Cargo.toml")).unwrap();

    assert!(!manifest.contains("mistralrs"));
    assert!(
        !workspace
            .join("crates/inference/src/mistralrs_provider.rs")
            .exists()
    );
    assert!(
        !workspace
            .join("crates/inference/examples/mistralrs_smoke.rs")
            .exists()
    );
}
