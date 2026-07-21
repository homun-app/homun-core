use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

use rand::RngCore;

use crate::client::SecretToken;

#[derive(Debug, Clone)]
pub struct HostComputerSupervisorConfig {
    pub helper_bundle: PathBuf,
    pub runtime_root: PathBuf,
    pub parent_pid: u32,
}

#[derive(Debug)]
pub struct PreparedLaunch {
    pub session_root: PathBuf,
    pub socket_path: PathBuf,
    pub token_file: PathBuf,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    token: SecretToken,
}

impl PreparedLaunch {
    pub fn into_token(self) -> SecretToken {
        self.token
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    #[error("host helper bundle is invalid: {0}")]
    InvalidHelper(String),
    #[error("host helper runtime I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("host helper launch failed: {0}")]
    Launch(String),
}

pub fn prepare_launch(
    config: &HostComputerSupervisorConfig,
) -> Result<PreparedLaunch, SupervisorError> {
    validate_helper_bundle(&config.helper_bundle)?;
    create_owner_only_directory(&config.runtime_root)?;

    let mut session_bytes = [0_u8; 12];
    rand::thread_rng().fill_bytes(&mut session_bytes);
    let session_root = config
        .runtime_root
        .join(format!("session-{}", encode_hex(&session_bytes)));
    create_owner_only_directory(&session_root)?;

    let socket_path = session_root.join("computer.sock");
    let token_file = session_root.join("session-token");
    let mut token_bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token = SecretToken::from_bytes(token_bytes);
    write_owner_only_file(&token_file, token.encoded().as_bytes())?;

    let arguments = vec![
        "-n".to_string(),
        "-a".to_string(),
        config.helper_bundle.to_string_lossy().into_owned(),
        "--args".to_string(),
        "--socket".to_string(),
        socket_path.to_string_lossy().into_owned(),
        "--auth-token-file".to_string(),
        token_file.to_string_lossy().into_owned(),
        "--parent-pid".to_string(),
        config.parent_pid.to_string(),
    ];

    Ok(PreparedLaunch {
        session_root,
        socket_path,
        token_file,
        arguments,
        environment: BTreeMap::new(),
        token,
    })
}

pub struct SystemHelperLauncher;

impl SystemHelperLauncher {
    pub fn launch(prepared: &PreparedLaunch) -> Result<Child, SupervisorError> {
        Command::new("/usr/bin/open")
            .args(&prepared.arguments)
            .env_clear()
            .envs(&prepared.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(SupervisorError::Io)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RestartBudget {
    remaining: u8,
}

impl RestartBudget {
    pub fn new(maximum_restarts: u8) -> Self {
        Self {
            remaining: maximum_restarts,
        }
    }

    pub fn consume(&mut self) -> bool {
        if self.remaining == 0 {
            return false;
        }
        self.remaining -= 1;
        true
    }
}

fn validate_helper_bundle(path: &Path) -> Result<(), SupervisorError> {
    if path.extension().and_then(|extension| extension.to_str()) != Some("app") || !path.is_dir() {
        return Err(SupervisorError::InvalidHelper(path.display().to_string()));
    }
    Ok(())
}

fn create_owner_only_directory(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;

    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

fn write_owner_only_file(path: &Path, value: &[u8]) -> Result<(), std::io::Error> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(value)?;
    file.sync_all()
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}
