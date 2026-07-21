use std::{fs, time::Duration};

use local_first_host_computer::{artifact::ArtifactManager, protocol::ArtifactRef};
use tempfile::tempdir;

#[test]
fn screenshot_response_contains_an_opaque_reference_only() {
    let artifact = ArtifactRef {
        artifact_ref: "host-computer:abc123".to_string(),
        mime_type: "image/png".to_string(),
        size_bytes: 42,
        sha256: "abc123".to_string(),
    };
    let json = serde_json::to_value(artifact).unwrap();

    assert!(json.get("artifact_ref").is_some());
    assert!(json.get("data").is_none());
    assert!(!json.to_string().contains("/Users/"));
}

#[test]
fn staged_capture_is_validated_and_content_addressed() {
    let root = tempdir().unwrap();
    fs::write(root.path().join("capture.png"), b"png bytes").unwrap();
    let manager = ArtifactManager::new(root.path().to_path_buf(), Duration::from_secs(1_800));

    let artifact = manager.adopt_staged("capture.png").unwrap();

    assert_eq!(artifact.mime_type, "image/png");
    assert_eq!(artifact.size_bytes, 9);
    assert!(manager.path_for(&artifact).unwrap().is_file());
    assert!(!root.path().join("capture.png").exists());
}

#[test]
fn traversal_absolute_paths_and_symlinks_are_rejected() {
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(outside.path().join("outside.png"), b"secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        outside.path().join("outside.png"),
        root.path().join("linked.png"),
    )
    .unwrap();
    let manager = ArtifactManager::new(root.path().to_path_buf(), Duration::from_secs(1_800));

    assert!(manager.adopt_staged("../outside.png").is_err());
    assert!(manager.adopt_staged("/tmp/outside.png").is_err());
    assert!(manager.adopt_staged("linked.png").is_err());
}

#[test]
fn zero_ttl_removes_unreferenced_session_artifacts() {
    let root = tempdir().unwrap();
    fs::write(root.path().join("old.png"), b"old").unwrap();
    let manager = ArtifactManager::new(root.path().to_path_buf(), Duration::ZERO);

    assert_eq!(
        manager
            .remove_expired(std::time::SystemTime::now())
            .unwrap(),
        1
    );
    assert!(!root.path().join("old.png").exists());
}
