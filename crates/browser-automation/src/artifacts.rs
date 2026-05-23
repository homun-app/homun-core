use crate::{BrowserAutomationError, BrowserResult};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserArtifactRoot {
    root: PathBuf,
    upload_roots: Vec<PathBuf>,
}

impl BrowserArtifactRoot {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            upload_roots: Vec::new(),
        }
    }

    pub fn with_upload_roots(mut self, upload_roots: Vec<PathBuf>) -> Self {
        self.upload_roots = upload_roots;
        self
    }

    pub fn output_path(&self, kind: &str, file_name: &str) -> BrowserResult<PathBuf> {
        if Path::new(file_name)
            .file_name()
            .and_then(|value| value.to_str())
            != Some(file_name)
        {
            return Err(BrowserAutomationError::ArtifactPath(
                "outside artifact root".to_string(),
            ));
        }
        let path = self.root.join(kind).join(file_name);
        if !path.starts_with(self.root.join(kind)) {
            return Err(BrowserAutomationError::ArtifactPath(
                "outside artifact root".to_string(),
            ));
        }
        Ok(path)
    }

    pub fn validate_upload_path(&self, path: &Path) -> BrowserResult<()> {
        if self.upload_roots.iter().any(|root| path.starts_with(root)) {
            Ok(())
        } else {
            Err(BrowserAutomationError::ArtifactPath(
                "outside upload roots".to_string(),
            ))
        }
    }
}
