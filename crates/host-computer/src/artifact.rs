use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};

use sha2::{Digest, Sha256};

use crate::protocol::ArtifactRef;

#[derive(Debug, thiserror::Error)]
pub enum ArtifactError {
    #[error("invalid staged artifact path")]
    InvalidPath,
    #[error("artifact I/O failed: {0}")]
    Io(#[from] io::Error),
}

#[derive(Debug, Clone)]
pub struct ArtifactManager {
    root: PathBuf,
    ttl: Duration,
}

impl ArtifactManager {
    pub fn new(root: PathBuf, ttl: Duration) -> Self {
        Self { root, ttl }
    }

    pub fn adopt_staged(&self, relative_path: &str) -> Result<ArtifactRef, ArtifactError> {
        let relative = Path::new(relative_path);
        if relative.components().count() != 1
            || !matches!(relative.components().next(), Some(Component::Normal(_)))
            || relative.extension().and_then(|value| value.to_str()) != Some("png")
        {
            return Err(ArtifactError::InvalidPath);
        }

        let staged = self.root.join(relative);
        let metadata = fs::symlink_metadata(&staged)?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(ArtifactError::InvalidPath);
        }

        let mut file = fs::File::open(&staged)?;
        let mut hasher = Sha256::new();
        let size_bytes = io::copy(&mut file, &mut hasher)?;
        let sha256 = encode_hex(&hasher.finalize());
        let managed = self.root.join(format!("{sha256}.png"));
        if managed != staged {
            if managed.exists() {
                fs::remove_file(&staged)?;
            } else {
                fs::rename(&staged, &managed)?;
            }
        }

        Ok(ArtifactRef {
            artifact_ref: format!("host-computer:{sha256}"),
            mime_type: "image/png".to_string(),
            size_bytes,
            sha256,
        })
    }

    pub fn path_for(&self, artifact: &ArtifactRef) -> Result<PathBuf, ArtifactError> {
        let Some(identifier) = artifact.artifact_ref.strip_prefix("host-computer:") else {
            return Err(ArtifactError::InvalidPath);
        };
        if identifier.len() != 64 || !identifier.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ArtifactError::InvalidPath);
        }
        Ok(self.root.join(format!("{identifier}.png")))
    }

    pub fn remove_expired(&self, now: SystemTime) -> Result<usize, ArtifactError> {
        let mut removed = 0;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if !metadata.is_file() {
                continue;
            }
            let age = now.duration_since(metadata.modified()?).unwrap_or_default();
            if age >= self.ttl {
                fs::remove_file(entry.path())?;
                removed += 1;
            }
        }
        Ok(removed)
    }
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
