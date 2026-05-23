use local_first_skill_runtime::{ProcessSkillRunnerConfig, SkillRuntimeError};
use std::path::PathBuf;

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
