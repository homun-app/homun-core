use std::{fs, os::unix::fs::MetadataExt};

use local_first_host_computer::supervisor::{
    HostComputerSupervisorConfig, RestartBudget, prepare_launch,
};

#[test]
fn launch_material_keeps_token_out_of_arguments_and_environment() {
    let root = tempfile::tempdir().unwrap();
    let helper = root.path().join("HomunComputerService.app");
    fs::create_dir(&helper).unwrap();
    let config = HostComputerSupervisorConfig {
        helper_bundle: helper,
        runtime_root: root.path().join("runtime"),
        parent_pid: 1234,
    };

    let launch = prepare_launch(&config).unwrap();
    let token = fs::read_to_string(&launch.token_file).unwrap();

    assert!(!token.trim().is_empty());
    assert!(
        launch
            .arguments
            .iter()
            .all(|argument| !argument.contains(token.trim()))
    );
    assert!(launch.environment.is_empty());
    assert!(launch.arguments.contains(&"--auth-token-file".to_string()));
    assert!(launch.arguments.contains(&"--socket".to_string()));
}

#[test]
fn launch_material_is_owner_only() {
    let root = tempfile::tempdir().unwrap();
    let helper = root.path().join("HomunComputerService.app");
    fs::create_dir(&helper).unwrap();
    let config = HostComputerSupervisorConfig {
        helper_bundle: helper,
        runtime_root: root.path().join("runtime"),
        parent_pid: 1234,
    };

    let launch = prepare_launch(&config).unwrap();
    let directory_mode = fs::metadata(&launch.session_root).unwrap().mode() & 0o777;
    let artifact_mode = fs::metadata(&launch.artifact_root).unwrap().mode() & 0o777;
    let token_mode = fs::metadata(&launch.token_file).unwrap().mode() & 0o777;

    assert_eq!(directory_mode, 0o700);
    assert_eq!(artifact_mode, 0o700);
    assert_eq!(token_mode, 0o600);
    assert!(launch.socket_path.starts_with(&launch.session_root));
}

#[test]
fn restart_budget_allows_exactly_one_retry() {
    let mut budget = RestartBudget::new(1);

    assert!(budget.consume());
    assert!(!budget.consume());
}
