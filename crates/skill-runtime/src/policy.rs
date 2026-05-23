use crate::{
    SkillAccess, SkillAccessKind, SkillRuntimeError, SkillRuntimeOutput, SkillRuntimeRequest,
    SkillRuntimeResult, ValidatedSkillRequest,
};
use local_first_capabilities::SkillToolManifest;
use std::path::{Path, PathBuf};
use url::Url;

#[derive(Debug, Clone, Default)]
pub struct SkillSandboxPolicy;

impl SkillSandboxPolicy {
    pub fn new() -> Self {
        Self
    }

    pub fn validate_request(
        &self,
        request: SkillRuntimeRequest,
    ) -> SkillRuntimeResult<ValidatedSkillRequest> {
        let tool = request
            .manifest
            .tools
            .iter()
            .find(|tool| tool.name == request.tool_name)
            .cloned()
            .ok_or_else(|| SkillRuntimeError::ToolNotFound(request.tool_name.clone()))?;
        validate_arguments(&tool, &request.arguments)?;
        for access in &request.declared_access {
            self.validate_access(&request, access)?;
        }
        Ok(ValidatedSkillRequest { request, tool })
    }

    pub fn validate_output(
        &self,
        validated: &ValidatedSkillRequest,
        output: &SkillRuntimeOutput,
    ) -> SkillRuntimeResult<()> {
        let encoded = serde_json::to_vec(&output.output)
            .map_err(|error| SkillRuntimeError::RunnerFailed(error.to_string()))?;
        if encoded.len() > validated.request.limits.max_output_bytes {
            return Err(SkillRuntimeError::OutputTooLarge(encoded.len()));
        }
        for host in &output.trace.accessed_network {
            self.validate_network(&validated.request, host)?;
        }
        for path in &output.trace.accessed_filesystem {
            self.validate_filesystem(&validated.request, path)?;
        }
        Ok(())
    }

    fn validate_access(
        &self,
        request: &SkillRuntimeRequest,
        access: &SkillAccess,
    ) -> SkillRuntimeResult<()> {
        match access.kind {
            SkillAccessKind::Network => self.validate_network(request, &access.target),
            SkillAccessKind::Filesystem => {
                self.validate_filesystem(request, &PathBuf::from(&access.target))
            }
        }
    }

    fn validate_network(
        &self,
        request: &SkillRuntimeRequest,
        target: &str,
    ) -> SkillRuntimeResult<()> {
        let host = normalize_host(target)?;
        let allowed = request
            .manifest
            .permissions
            .network
            .iter()
            .any(|allowed| allowed == &host);
        if allowed {
            Ok(())
        } else {
            Err(SkillRuntimeError::NetworkDenied(host))
        }
    }

    fn validate_filesystem(
        &self,
        request: &SkillRuntimeRequest,
        target: &Path,
    ) -> SkillRuntimeResult<()> {
        let target = normalize_path(target);
        let allowed = request
            .manifest
            .permissions
            .filesystem
            .iter()
            .map(PathBuf::from)
            .map(|root| normalize_path(&root))
            .any(|root| target.starts_with(root));
        if allowed {
            Ok(())
        } else {
            Err(SkillRuntimeError::FilesystemDenied(
                target.to_string_lossy().to_string(),
            ))
        }
    }
}

fn validate_arguments(
    tool: &SkillToolManifest,
    arguments: &serde_json::Value,
) -> SkillRuntimeResult<()> {
    if tool
        .input_schema
        .get("type")
        .and_then(|value| value.as_str())
        == Some("object")
        && !arguments.is_object()
    {
        return Err(SkillRuntimeError::SchemaValidationFailed(
            "arguments must be object".to_string(),
        ));
    }

    if let Some(required) = tool
        .input_schema
        .get("required")
        .and_then(|value| value.as_array())
    {
        for field in required.iter().filter_map(|value| value.as_str()) {
            if arguments.get(field).is_none() {
                return Err(SkillRuntimeError::SchemaValidationFailed(format!(
                    "{field} is required"
                )));
            }
        }
    }
    Ok(())
}

fn normalize_host(target: &str) -> SkillRuntimeResult<String> {
    if let Ok(url) = Url::parse(target) {
        return url
            .host_str()
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| SkillRuntimeError::NetworkDenied(target.to_string()));
    }
    Ok(target.to_ascii_lowercase())
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        normalized.push(component.as_os_str());
    }
    normalized
}
