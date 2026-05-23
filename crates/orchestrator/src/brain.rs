use crate::{
    EnqueuedSubagentTaskSummary, EnqueuedTaskSummary, ExecutionPlan, MemoryContextProvider,
    OrchestratorAudit, OrchestratorAuditStore, OrchestratorError, OrchestratorOutcome,
    OrchestratorRequest, OrchestratorResult, OrchestratorRoute, PlanStep, PlanStepKind, ToolCard,
    ToolSearchIndexStore,
    execution::{
        can_execute_immediately, provider_id_for_step, task_id_for_step, task_user_id,
        task_workspace_id, tool_for_step, tool_name_for_step,
    },
    planner::{planner_prompt, planner_schema},
    subagent_workflow::{enqueue_subagent_spec, subagent_workflow_spec},
};
use local_first_capabilities::{
    CapabilityCall, CapabilityCallResult, CapabilityFacade, CapabilityTool, PolicyContext,
    ToolAccessPlan,
};
use local_first_subagents::{GenerateJsonRequest, JsonRuntime, TokenMetrics};
use local_first_task_runtime::{TaskId, TaskStore};
use std::collections::{BTreeMap, BTreeSet};

pub struct OrchestratorBrain<R, M> {
    runtime: R,
    memory: M,
    capabilities: CapabilityFacade,
    tool_index: ToolSearchIndexStore,
    task_store: TaskStore,
    task_bridge: local_first_capabilities::CapabilityTaskRuntimeBridge,
    subagent_bridge: local_first_subagents::SubagentTaskRuntimeBridge,
    audit_store: Option<OrchestratorAuditStore>,
}

impl<R: JsonRuntime, M: MemoryContextProvider> OrchestratorBrain<R, M> {
    pub fn new(
        runtime: R,
        memory: M,
        capabilities: CapabilityFacade,
        tool_index: ToolSearchIndexStore,
        task_store: TaskStore,
    ) -> Self {
        Self {
            runtime,
            memory,
            capabilities,
            tool_index,
            task_store,
            task_bridge: local_first_capabilities::CapabilityTaskRuntimeBridge::new(),
            subagent_bridge: local_first_subagents::SubagentTaskRuntimeBridge::new(),
            audit_store: None,
        }
    }

    pub fn with_audit_store(mut self, audit_store: OrchestratorAuditStore) -> Self {
        self.audit_store = Some(audit_store);
        self
    }

    pub fn runtime(&self) -> &R {
        &self.runtime
    }

    pub fn task_store(&self) -> &TaskStore {
        &self.task_store
    }

    pub fn audit_store(&self) -> Option<&OrchestratorAuditStore> {
        self.audit_store.as_ref()
    }

    pub fn run(&mut self, request: OrchestratorRequest) -> OrchestratorResult<OrchestratorOutcome> {
        let audit_request = request.clone();
        let result = self.run_inner(request);
        if let Some(audit_store) = &self.audit_store {
            match &result {
                Ok(outcome) => audit_store.record_outcome(&audit_request, outcome)?,
                Err(error) => {
                    let _ = audit_store.record_failure(&audit_request, error);
                }
            }
        }
        result
    }

    fn run_inner(
        &mut self,
        request: OrchestratorRequest,
    ) -> OrchestratorResult<OrchestratorOutcome> {
        let access = self.capabilities.list_tools(&request.policy_context)?;
        self.tool_index.rebuild_from_tools(&access.visible_tools)?;
        let memory = self.memory.load_context(&request)?;
        let (initial_cards, initial_tools) = self.load_initial_tools(&request, &access)?;
        let (plan, metrics, planner_rounds, loaded_cards, loaded_tools) =
            self.plan_with_retry(&request, &memory, &initial_cards, &initial_tools)?;
        self.validate_plan(&plan, &loaded_tools, request.budgets.max_steps)?;

        let mut immediate_results = Vec::new();
        let mut enqueued_tasks = Vec::new();
        let mut enqueued_subagent_tasks = Vec::new();
        let mut durable_step_task_ids = BTreeMap::new();
        for step in &plan.steps {
            match step.kind {
                PlanStepKind::CapabilityCall => {
                    let tool = tool_for_step(step, &loaded_tools)?;
                    if can_execute_immediately(step, tool, &access.executable_tools) {
                        immediate_results
                            .push(self.execute_immediate(&request.policy_context, step)?);
                    } else {
                        let summary = self.enqueue_step(&request, step, tool)?;
                        durable_step_task_ids
                            .insert(step.step_id.clone(), summary.task_id.as_str().to_string());
                        enqueued_tasks.push(summary);
                    }
                }
                PlanStepKind::SubagentTask => {
                    let spec = subagent_workflow_spec(&request, step, &durable_step_task_ids)?;
                    let summary = self.enqueue_subagent_step(&request, step, spec)?;
                    durable_step_task_ids
                        .insert(step.step_id.clone(), summary.task_id.as_str().to_string());
                    enqueued_subagent_tasks.push(summary);
                }
                PlanStepKind::MemoryLookup | PlanStepKind::DirectAnswer => {}
            }
        }

        Ok(OrchestratorOutcome {
            direct_answer: plan.direct_answer.clone(),
            memory_refs: memory
                .iter()
                .map(|snippet| snippet.reference.clone())
                .collect(),
            audit: OrchestratorAudit {
                request_id: request.request_id,
                loaded_tool_count: loaded_cards.len(),
                immediate_execution_count: immediate_results.len(),
                enqueued_task_count: enqueued_tasks.len(),
                subagent_task_count: enqueued_subagent_tasks.len(),
                planner_rounds,
            },
            loaded_tools: loaded_cards,
            immediate_results,
            enqueued_tasks,
            enqueued_subagent_tasks,
            blocked_reason: None,
            metrics,
            plan,
        })
    }

    fn load_initial_tools(
        &self,
        request: &OrchestratorRequest,
        access: &ToolAccessPlan,
    ) -> OrchestratorResult<(Vec<ToolCard>, Vec<CapabilityTool>)> {
        if access.visible_tools.len() <= 10 {
            let cards = access
                .visible_tools
                .iter()
                .map(ToolCard::from_tool)
                .collect::<Vec<_>>();
            return Ok((cards, access.visible_tools.clone()));
        }

        let cards = self
            .tool_index
            .search(&request.user_message, request.budgets.max_loaded_tools)?;
        let mut tools = Vec::new();
        for card in &cards {
            if let Some(tool) = self
                .tool_index
                .tool_detail(&card.provider_id, &card.tool_name)?
            {
                tools.push(tool);
            }
        }
        Ok((cards, tools))
    }

    fn plan_with_retry(
        &self,
        request: &OrchestratorRequest,
        memory: &[crate::MemoryContextSnippet],
        initial_cards: &[ToolCard],
        initial_tools: &[CapabilityTool],
    ) -> OrchestratorResult<(
        ExecutionPlan,
        TokenMetrics,
        usize,
        Vec<ToolCard>,
        Vec<CapabilityTool>,
    )> {
        let mut rounds = 1;
        let first = self.call_planner(request, memory, initial_cards, initial_tools)?;
        if first.0.route != OrchestratorRoute::NeedsMoreTools {
            return Ok((
                first.0,
                first.1,
                rounds,
                initial_cards.to_vec(),
                initial_tools.to_vec(),
            ));
        }
        if request.budgets.max_tool_search_rounds == 0 {
            return Ok((
                first.0,
                first.1,
                rounds,
                initial_cards.to_vec(),
                initial_tools.to_vec(),
            ));
        }

        let query = first
            .0
            .needs_more_tools
            .as_ref()
            .map(|request| request.query.as_str())
            .unwrap_or(&request.user_message);
        let cards = self
            .tool_index
            .search(query, request.budgets.max_loaded_tools)?;
        let mut tools = Vec::new();
        for card in &cards {
            if let Some(tool) = self
                .tool_index
                .tool_detail(&card.provider_id, &card.tool_name)?
            {
                tools.push(tool);
            }
        }
        rounds += 1;
        let second = self.call_planner(request, memory, &cards, &tools)?;
        Ok((second.0, second.1, rounds, cards, tools))
    }

    fn call_planner(
        &self,
        request: &OrchestratorRequest,
        memory: &[crate::MemoryContextSnippet],
        loaded_cards: &[ToolCard],
        loaded_tools: &[CapabilityTool],
    ) -> OrchestratorResult<(ExecutionPlan, TokenMetrics)> {
        let planner_request = GenerateJsonRequest {
            prompt: planner_prompt(request, memory, loaded_cards, loaded_tools)?,
            max_tokens: request.budgets.max_planner_tokens,
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: Some(30.0),
            json_schema: Some(planner_schema()),
            required_keys: vec!["route".to_string(), "steps".to_string()],
            repair: true,
        };
        let response = self
            .runtime
            .generate_json(&planner_request)
            .map_err(|error| OrchestratorError::Planner(format!("{error:?}")))?;
        if !response.valid {
            return Err(OrchestratorError::Planner(response.errors.join("; ")));
        }
        let plan = serde_json::from_value(response.json)?;
        Ok((plan, response.metrics))
    }

    fn validate_plan(
        &self,
        plan: &ExecutionPlan,
        loaded_tools: &[CapabilityTool],
        max_steps: usize,
    ) -> OrchestratorResult<()> {
        if plan.steps.len() > max_steps {
            return Err(OrchestratorError::Planner(format!(
                "too_many_steps:{}",
                plan.steps.len()
            )));
        }
        let mut seen = BTreeSet::new();
        for step in &plan.steps {
            if !seen.insert(step.step_id.clone()) {
                return Err(OrchestratorError::Planner(format!(
                    "duplicate_step:{}",
                    step.step_id
                )));
            }
            for dependency in &step.depends_on {
                if !seen.contains(dependency) {
                    return Err(OrchestratorError::Planner(format!(
                        "dependency_not_previous:{dependency}"
                    )));
                }
            }
            if step.kind == PlanStepKind::CapabilityCall {
                let _ = tool_for_step(step, loaded_tools)?;
            } else if step.kind == PlanStepKind::SubagentTask {
                if step.agent_id.is_none() {
                    return Err(OrchestratorError::Planner(format!(
                        "subagent_step_missing_agent:{}",
                        step.step_id
                    )));
                }
                if step.goal.is_none() {
                    return Err(OrchestratorError::Planner(format!(
                        "subagent_step_missing_goal:{}",
                        step.step_id
                    )));
                }
                if step.contract.is_none() {
                    return Err(OrchestratorError::Planner(format!(
                        "subagent_step_missing_contract:{}",
                        step.step_id
                    )));
                }
            }
        }
        Ok(())
    }

    fn execute_immediate(
        &mut self,
        context: &PolicyContext,
        step: &PlanStep,
    ) -> OrchestratorResult<CapabilityCallResult> {
        let provider_id = provider_id_for_step(step)?;
        let tool_name = tool_name_for_step(step)?.to_string();
        Ok(self.capabilities.call_tool(
            context,
            CapabilityCall {
                provider_id,
                tool_name,
                arguments: step.arguments.clone(),
            },
        )?)
    }

    fn enqueue_step(
        &self,
        request: &OrchestratorRequest,
        step: &PlanStep,
        tool: &CapabilityTool,
    ) -> OrchestratorResult<EnqueuedTaskSummary> {
        let provider_id = provider_id_for_step(step)?;
        let tool_name = tool_name_for_step(step)?.to_string();
        let call = CapabilityCall {
            provider_id: provider_id.clone(),
            tool_name: tool_name.clone(),
            arguments: step.arguments.clone(),
        };
        let task_id = task_id_for_step(&request.request_id, &step.step_id);
        let mut record = self.task_bridge.enqueue_call(
            &self.task_store,
            task_id.clone(),
            &request.policy_context,
            &call,
            tool,
        )?;
        record.risk_level = step.risk_level.clone();
        self.task_store.insert_task(&record)?;
        for dependency in &step.depends_on {
            let dependency_task_id = TaskId::new(task_id_for_step(&request.request_id, dependency));
            if self
                .task_store
                .get_task(
                    &dependency_task_id,
                    &task_user_id(&request.policy_context),
                    &task_workspace_id(&request.policy_context),
                )?
                .is_some()
            {
                self.task_store.add_dependency(
                    &record.task_id,
                    &dependency_task_id,
                    &task_user_id(&request.policy_context),
                    &task_workspace_id(&request.policy_context),
                )?;
            }
        }
        Ok(EnqueuedTaskSummary {
            step_id: step.step_id.clone(),
            task_id: record.task_id,
            provider_id,
            tool_name,
        })
    }

    fn enqueue_subagent_step(
        &self,
        request: &OrchestratorRequest,
        step: &PlanStep,
        spec: local_first_subagents::WorkflowTaskSpec,
    ) -> OrchestratorResult<EnqueuedSubagentTaskSummary> {
        enqueue_subagent_spec(&self.subagent_bridge, &self.task_store, request, step, spec)
    }
}
