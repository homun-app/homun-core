use crate::{
    SkillRuntimeError, SkillRuntimeOutput, SkillRuntimeRequest, SkillRuntimeResult,
    SkillSandboxPolicy,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub trait SkillRunner: Send + Sync {
    fn run(&self, request: &SkillRuntimeRequest) -> SkillRuntimeResult<SkillRuntimeOutput>;
}

pub struct SkillRuntime {
    policy: SkillSandboxPolicy,
    runner: Arc<dyn SkillRunner>,
}

impl SkillRuntime {
    pub fn new(runner: Arc<dyn SkillRunner>) -> Self {
        Self {
            policy: SkillSandboxPolicy::new(),
            runner,
        }
    }

    pub fn execute(&self, request: SkillRuntimeRequest) -> SkillRuntimeResult<SkillRuntimeOutput> {
        let validated = self.policy.validate_request(request)?;
        let output = self.runner.run(&validated.request)?;
        self.policy.validate_output(&validated, &output)?;
        Ok(output)
    }
}

#[derive(Default)]
pub struct InMemorySkillRunner {
    responses: Mutex<HashMap<(String, String), SkillRuntimeOutput>>,
}

impl InMemorySkillRunner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_response(
        &self,
        skill_id: impl Into<String>,
        tool_name: impl Into<String>,
        output: SkillRuntimeOutput,
    ) {
        self.responses
            .lock()
            .expect("in-memory skill runner lock")
            .insert((skill_id.into(), tool_name.into()), output);
    }
}

impl SkillRunner for InMemorySkillRunner {
    fn run(&self, request: &SkillRuntimeRequest) -> SkillRuntimeResult<SkillRuntimeOutput> {
        self.responses
            .lock()
            .expect("in-memory skill runner lock")
            .get(&(request.manifest.id.clone(), request.tool_name.clone()))
            .cloned()
            .ok_or_else(|| {
                SkillRuntimeError::RunnerFailed(format!(
                    "response_not_found:{}:{}",
                    request.manifest.id, request.tool_name
                ))
            })
    }
}
