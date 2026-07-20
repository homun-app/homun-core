use crate::{
    CapabilityStepExecutor, DriveOutcome, EnqueuedSubagentTaskSummary, EnqueuedTaskSummary,
    ExecutionPlan, MemoryContextProvider, OrchestratorAudit, OrchestratorAuditStore,
    OrchestratorError, OrchestratorOutcome, OrchestratorRequest, OrchestratorResult,
    OrchestratorRoute, PassThroughVerifier, PlanStep, PlanStepKind, ToolCard, ToolCorpus,
    driver::drive_plan,
    execution::{
        can_execute_immediately, provider_id_for_step, task_id_for_step, task_user_id,
        task_workspace_id, tool_for_step, tool_name_for_step,
    },
    planner::{planner_prompt, planner_schema},
    subagent_workflow::{
        enqueue_subagent_spec, subagent_workflow_spec, validate_single_threaded_writes,
    },
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
    tool_corpus: ToolCorpus,
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
        task_store: TaskStore,
    ) -> Self {
        Self {
            runtime,
            memory,
            capabilities,
            // Rebuilt from the policy-visible tools at every planning entry (F1.a): no
            // index to inject, no persistence — just an in-memory corpus ranked by the
            // shared BM25.
            tool_corpus: ToolCorpus::default(),
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

    /// Produces a validated [`ExecutionPlan`] WITHOUT materializing durable
    /// tasks or executing immediate steps. For callers (e.g. the desktop
    /// gateway) that adapt the plan into their own execution model and must not
    /// trigger the Brain's side effects.
    pub fn plan_only(
        &mut self,
        request: &OrchestratorRequest,
    ) -> OrchestratorResult<ExecutionPlan> {
        let access = self.capabilities.list_tools(&request.policy_context)?;
        self.tool_corpus.rebuild_from_tools(&access.visible_tools);
        let memory = self.memory.load_context(request)?;
        let (initial_cards, initial_tools) = self.load_initial_tools(request, &access)?;
        let (plan, _metrics, _rounds, _cards, loaded_tools, _budget) =
            self.plan_with_retry(request, &memory, &initial_cards, &initial_tools)?;
        self.validate_plan(&plan, &loaded_tools, request.budgets.max_steps)?;
        Ok(plan)
    }

    /// Executes a caller-provided [`ExecutionPlan`] through the same capability,
    /// task-runtime and subagent paths used by planner-generated plans. This is
    /// the declarative workflow entry point: the caller owns plan construction,
    /// the Brain owns validation and materialization.
    pub fn run_plan(
        &mut self,
        request: OrchestratorRequest,
        plan: ExecutionPlan,
    ) -> OrchestratorResult<OrchestratorOutcome> {
        let access = self.capabilities.list_tools(&request.policy_context)?;
        self.tool_corpus.rebuild_from_tools(&access.visible_tools);
        let memory = self.memory.load_context(&request)?;
        self.validate_plan(&plan, &access.visible_tools, request.budgets.max_steps)?;
        let loaded_cards = access
            .visible_tools
            .iter()
            .map(ToolCard::from_tool)
            .collect();
        let loaded_tools = access.visible_tools.clone();
        self.execute_plan(
            request,
            plan,
            memory,
            access,
            loaded_cards,
            loaded_tools,
            TokenMetrics {
                prompt_tokens: 0,
                generation_tokens: 0,
                prompt_tps: 0.0,
                generation_tps: 0.0,
                peak_memory_gb: 0.0,
                elapsed_seconds: 0.0,
            },
            0,
            Vec::new(),
        )
    }

    /// Drives a validated [`ExecutionPlan`] to completion IN-TURN: every step is
    /// executed synchronously through the shared capability facade, and the
    /// runtime marks a step `done` only after the verify gate passes. This is the
    /// synchronous driver of ADR 0020 — the harness owning the control flow of a
    /// turn — as opposed to [`Self::execute_plan`], which materializes durable
    /// background tasks and returns without driving anything.
    ///
    /// The plan is validated first (unique ids, every dependency preceding its
    /// dependent) so the driver's single forward pass is a valid topological
    /// execution. Uses the capability-only executor: `SubagentTask` steps fail
    /// here because they need the model + the chat loop's tool dispatch (the
    /// gateway-side executor, F3.2b). The gateway composes a richer executor over
    /// the same [`crate::drive_plan`] seam.
    pub fn drive(
        &mut self,
        request: &OrchestratorRequest,
        plan: &ExecutionPlan,
    ) -> OrchestratorResult<DriveOutcome> {
        let access = self.capabilities.list_tools(&request.policy_context)?;
        self.validate_plan(plan, &access.visible_tools, request.budgets.max_steps)?;
        // Disjoint field borrows: the executor reads the runtime (arg-fill) and
        // mutates the facade (call_tool) — distinct fields, so both coexist.
        let mut executor = CapabilityStepExecutor::new(
            &self.runtime,
            &mut self.capabilities,
            &request.policy_context,
            &access.visible_tools,
        );
        let mut verifier = PassThroughVerifier;
        Ok(drive_plan(plan, &mut executor, &mut verifier))
    }

    fn run_inner(
        &mut self,
        request: OrchestratorRequest,
    ) -> OrchestratorResult<OrchestratorOutcome> {
        let access = self.capabilities.list_tools(&request.policy_context)?;
        self.tool_corpus.rebuild_from_tools(&access.visible_tools);
        let memory = self.memory.load_context(&request)?;
        let (initial_cards, initial_tools) = self.load_initial_tools(&request, &access)?;
        let (plan, metrics, planner_rounds, loaded_cards, loaded_tools, context_budget) =
            self.plan_with_retry(&request, &memory, &initial_cards, &initial_tools)?;
        self.validate_plan(&plan, &loaded_tools, request.budgets.max_steps)?;
        self.execute_plan(
            request,
            plan,
            memory,
            access,
            loaded_cards,
            loaded_tools,
            metrics,
            planner_rounds,
            context_budget,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_plan(
        &mut self,
        request: OrchestratorRequest,
        plan: ExecutionPlan,
        memory: Vec<crate::MemoryContextSnippet>,
        access: ToolAccessPlan,
        loaded_cards: Vec<ToolCard>,
        loaded_tools: Vec<CapabilityTool>,
        metrics: TokenMetrics,
        planner_rounds: usize,
        context_budget: Vec<crate::ContextBudgetUsage>,
    ) -> OrchestratorResult<OrchestratorOutcome> {
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
                context_budget,
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
            .tool_corpus
            .search(&request.user_message, request.budgets.max_loaded_tools);
        let mut tools = Vec::new();
        for card in &cards {
            if let Some(tool) = self.tool_corpus.tool_detail(&card.provider_id, &card.tool_name) {
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
        Vec<crate::ContextBudgetUsage>,
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
                first.2,
            ));
        }
        if request.budgets.max_tool_search_rounds == 0 {
            return Ok((
                first.0,
                first.1,
                rounds,
                initial_cards.to_vec(),
                initial_tools.to_vec(),
                first.2,
            ));
        }

        let query = first
            .0
            .needs_more_tools
            .as_ref()
            .map(|request| request.query.as_str())
            .unwrap_or(&request.user_message);
        let cards = self
            .tool_corpus
            .search(query, request.budgets.max_loaded_tools);
        let mut tools = Vec::new();
        for card in &cards {
            if let Some(tool) = self.tool_corpus.tool_detail(&card.provider_id, &card.tool_name) {
                tools.push(tool);
            }
        }
        rounds += 1;
        let second = self.call_planner(request, memory, &cards, &tools)?;
        let mut context_budget = first.2;
        context_budget.extend(second.2);
        Ok((second.0, second.1, rounds, cards, tools, context_budget))
    }

    fn call_planner(
        &self,
        request: &OrchestratorRequest,
        memory: &[crate::MemoryContextSnippet],
        loaded_cards: &[ToolCard],
        loaded_tools: &[CapabilityTool],
    ) -> OrchestratorResult<(ExecutionPlan, TokenMetrics, Vec<crate::ContextBudgetUsage>)> {
        let prompt = planner_prompt(request, memory, loaded_cards, loaded_tools)?;
        // Constrain tool_name to the actually-loaded tools (caposaldo #6): the enum stops a
        // weak model from cramming arguments into the name. Empty → free string (planner.rs).
        let tool_names: Vec<&str> = loaded_tools.iter().map(|tool| tool.name.as_str()).collect();
        let planner_request = GenerateJsonRequest {
            usage: {
                let mut usage = local_first_inference_usage::UsageContext::new(
                    uuid::Uuid::new_v4().to_string(),
                    local_first_inference_usage::InferencePurpose::Planning,
                    request.policy_context.user_id.as_str(),
                );
                usage.purpose_detail = Some("plan_proposal".to_string());
                usage.workspace_id = Some(request.policy_context.workspace_id.as_str().to_string());
                usage.task_id = Some(request.request_id.clone());
                usage
            },
            prompt: prompt.prompt,
            max_tokens: request.budgets.max_planner_tokens,
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: Some(request.budgets.planner_timeout_seconds as f64),
            json_schema: Some(planner_schema(&tool_names)),
            // Only "route" is mandatory. "steps" is optional (ExecutionPlan
            // defaults it to []): a direct_answer/ask_clarification plan
            // legitimately has no steps, and the model (esp. reasoning models)
            // often omits the empty array — that must NOT hard-fail the planner
            // (it did: "missing required keys: steps" → fell back to legacy).
            required_keys: vec!["route".to_string()],
            repair: true,
        };
        let response = self
            .runtime
            .generate_json(&planner_request)
            .map_err(|error| OrchestratorError::Planner(format!("{error:?}")))?;
        if !response.valid {
            return Err(OrchestratorError::Planner(response.errors.join("; ")));
        }
        // Tolerant where it can be (PlanStepWire coerces weak-model field shapes);
        // when it still can't deserialize (e.g. a required enum emitted as a map),
        // surface the RAW planner output in the error so the failing field is
        // diagnosable instead of an opaque "invalid type: map".
        let plan = serde_json::from_value(response.json.clone()).map_err(|error| {
            let raw: String = serde_json::to_string(&response.json)
                .unwrap_or_default()
                .chars()
                .take(800)
                .collect();
            OrchestratorError::Planner(format!("plan_deserialize: {error}; raw={raw}"))
        })?;
        Ok((plan, response.metrics, prompt.context_budget))
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
        // ADR 0018 Pilastro 3: writes stay single-threaded — no two write-capable
        // subagent steps may run in parallel. Read/Draft gatherers fan out freely.
        validate_single_threaded_writes(&plan.steps)?;
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
