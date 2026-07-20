use std::path::{Path, PathBuf};

const APPROVED: &[&str] = &[
    "crates/desktop-gateway/src/model_client.rs",
    "crates/desktop-gateway/src/inference_transport.rs",
    "crates/inference/src/openai_compat.rs",
    "crates/inference/src/anthropic.rs",
    "crates/inference/src/mistralrs_provider.rs",
];

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
fn inference_transport_inventory() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
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
