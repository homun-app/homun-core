use super::*;

#[derive(Debug, Clone)]
struct WorkflowStepDefinition {
    id: &'static str,
    title: &'static str,
    depends_on: &'static [&'static str],
}

#[derive(Debug, Clone)]
pub(crate) struct WorkflowDefinition {
    pub(crate) id: &'static str,
    pub(crate) tool_name: &'static str,
    contract: &'static str,
    steps: &'static [WorkflowStepDefinition],
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct NativeWorkflowCapability {
    pub(crate) workflow_id: &'static str,
    pub(crate) tool_name: &'static str,
    pub(crate) contract: &'static str,
    pub(crate) scaffolding_tier: &'static str,
    pub(crate) description: &'static str,
    pub(crate) route_text: &'static str,
    pub(crate) schema: fn() -> serde_json::Value,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct NativeAtomicCapability {
    pub(crate) key: &'static str,
    pub(crate) tool_name: &'static str,
    pub(crate) description: &'static str,
    pub(crate) route_text: &'static str,
    pub(crate) schema: fn() -> serde_json::Value,
}

const MAKE_DECK_WORKFLOW_STEPS: &[WorkflowStepDefinition] = &[
    WorkflowStepDefinition {
        id: "brand",
        title: "Materialize brand kit",
        depends_on: &[],
    },
    WorkflowStepDefinition {
        id: "content",
        title: "Generate schema-enforced slide content",
        depends_on: &["brand"],
    },
    WorkflowStepDefinition {
        id: "images",
        title: "Generate requested slide images",
        depends_on: &["content"],
    },
    WorkflowStepDefinition {
        id: "deck_json",
        title: "Write deck.json",
        depends_on: &["content"],
    },
    WorkflowStepDefinition {
        id: "render",
        title: "Render deck artifacts",
        depends_on: &["deck_json", "images"],
    },
    WorkflowStepDefinition {
        id: "register_artifacts",
        title: "Register deck artifacts in memory",
        depends_on: &["render"],
    },
];

const MAKE_DOCUMENT_WORKFLOW_STEPS: &[WorkflowStepDefinition] = &[
    WorkflowStepDefinition {
        id: "brief",
        title: "Normalize document brief",
        depends_on: &[],
    },
    WorkflowStepDefinition {
        id: "draft_markdown",
        title: "Draft structured Markdown document",
        depends_on: &["brief"],
    },
    WorkflowStepDefinition {
        id: "write_artifact",
        title: "Write document artifact",
        depends_on: &["draft_markdown"],
    },
    WorkflowStepDefinition {
        id: "register_artifact",
        title: "Register document artifact in memory",
        depends_on: &["write_artifact"],
    },
];

pub(crate) fn make_deck_workflow_definition() -> WorkflowDefinition {
    WorkflowDefinition {
        id: "make_deck",
        tool_name: "make_deck",
        contract: "DeckWorkflow",
        steps: MAKE_DECK_WORKFLOW_STEPS,
    }
}

pub(crate) fn make_document_workflow_definition() -> WorkflowDefinition {
    WorkflowDefinition {
        id: "make_document",
        tool_name: "make_document",
        contract: "DocumentWorkflow",
        steps: MAKE_DOCUMENT_WORKFLOW_STEPS,
    }
}

fn native_workflow_capabilities() -> &'static [NativeWorkflowCapability] {
    &[
        NativeWorkflowCapability {
            workflow_id: "make_deck",
            tool_name: "make_deck",
            contract: "DeckWorkflow",
            scaffolding_tier: "maximum",
            description: "Create an editable presentation deck, pitch deck, sales deck or slide deck from a brief.",
            // Keep tokens SPECIFIC to a deck. Generic verbs (crea/genera/prepara/
            // presentare/illustrare) collided with everything and over-triggered the
            // one-shot workflow on plain requests — do not re-add them.
            route_text: "make_deck DeckWorkflow presentation presentazione deck slide slides slideshow ppt pptx keynote pitch investor deck sales deck",
            schema: make_deck_tool_schema,
        },
        NativeWorkflowCapability {
            workflow_id: "make_document",
            tool_name: "make_document",
            contract: "DocumentWorkflow",
            scaffolding_tier: "document",
            description: "Create a structured document, report, memo, meeting minutes or relazione from a brief.",
            // Specific document nouns only — generic verbs removed (see make_deck note).
            route_text: "make_document DocumentWorkflow document documento docx markdown report relazione memo verbale meeting minutes rapporto whitepaper brief",
            schema: make_document_tool_schema,
        },
    ]
}

pub(crate) fn native_workflow_by_tool_name(tool_name: &str) -> Option<NativeWorkflowCapability> {
    native_workflow_capabilities()
        .iter()
        .copied()
        .find(|capability| capability.tool_name == tool_name)
}

pub(crate) fn native_workflow_capability_entries() -> Vec<CapabilityEntry> {
    native_workflow_capabilities()
        .iter()
        .map(|capability| CapabilityEntry {
            key: capability.tool_name.to_string(),
            desc: capability.description.to_string(),
            text: format!(
                "{} {} {} {}",
                capability.tool_name,
                capability.contract,
                capability.description,
                capability.route_text
            ),
            schema: Some((capability.schema)()),
            is_skill: false,
            source: CapabilitySource::NativeWorkflow,
        })
        .collect()
}

pub(crate) fn semantic_capability_registry() -> Vec<semantic_decision::CapabilitySemanticEntry> {
    let mut registry = native_workflow_capabilities()
        .iter()
        .map(|capability| semantic_decision::CapabilitySemanticEntry {
            key: capability.tool_name.to_string(),
            description: capability.description.to_string(),
            effects: vec![
                semantic_decision::EffectClass::ArtifactCreation,
                semantic_decision::EffectClass::FilesystemWrite,
            ],
            enabled: true,
        })
        .collect::<Vec<_>>();
    registry.extend(native_atomic_capabilities().iter().map(|capability| {
        semantic_decision::CapabilitySemanticEntry {
            key: capability.key.to_string(),
            description: capability.description.to_string(),
            effects: vec![semantic_decision::EffectClass::FilesystemWrite],
            enabled: true,
        }
    }));
    registry
}

fn bounded_thread_context(state: &AppState, thread_id: Option<&str>) -> Option<String> {
    let thread_id = thread_id?;
    let snapshot = lock_store(state).ok()?.messages(thread_id).ok()?;
    let mut lines = snapshot
        .messages
        .iter()
        .rev()
        .take(8)
        .map(|message| {
            format!(
                "{}: {}",
                message.role,
                message.text.chars().take(600).collect::<String>()
            )
        })
        .collect::<Vec<_>>();
    lines.reverse();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

pub(crate) fn resolve_semantic_decision(
    state: &AppState,
    thread_id: Option<&str>,
    prompt: &str,
    active: Option<&local_first_task_runtime::ObjectiveContractRecord>,
    binding: Option<&RoutingBinding>,
) -> semantic_decision::ValidatedSemanticDecision {
    resolve_semantic_decision_for_context(state, thread_id, prompt, active, binding, false)
}

pub(crate) fn resolve_steering_semantic_decision(
    state: &AppState,
    thread_id: Option<&str>,
    prompt: &str,
    active: Option<&local_first_task_runtime::ObjectiveContractRecord>,
    binding: Option<&RoutingBinding>,
) -> semantic_decision::ValidatedSemanticDecision {
    resolve_semantic_decision_for_context(state, thread_id, prompt, active, binding, true)
}

#[derive(Debug)]
pub(crate) enum SemanticJsonGenerationError<E> {
    Runtime(E),
    Invalid(Vec<String>),
}

pub(crate) fn generate_semantic_json_with_invalid_retry<E>(
    mut generate: impl FnMut() -> Result<GenerateJsonResponse, E>,
) -> Result<serde_json::Value, SemanticJsonGenerationError<E>> {
    let mut errors = Vec::new();
    for attempt in 1..=2 {
        match generate() {
            Ok(response) if response.valid => return Ok(response.json),
            Ok(response) => {
                if response.errors.is_empty() {
                    errors.push(format!(
                        "attempt {attempt}: invalid response without diagnostics"
                    ));
                } else {
                    errors.extend(
                        response
                            .errors
                            .into_iter()
                            .map(|error| format!("attempt {attempt}: {error}")),
                    );
                }
            }
            Err(error) => return Err(SemanticJsonGenerationError::Runtime(error)),
        }
    }
    Err(SemanticJsonGenerationError::Invalid(errors))
}

fn resolve_semantic_decision_for_context(
    state: &AppState,
    thread_id: Option<&str>,
    prompt: &str,
    active: Option<&local_first_task_runtime::ObjectiveContractRecord>,
    binding: Option<&RoutingBinding>,
    steering_control: bool,
) -> semantic_decision::ValidatedSemanticDecision {
    // Turn Contract ResumeBinding: an open Choice wait + matching resolution skips the
    // semantic model entirely — disposition is continue_current_work by construction.
    if !steering_control
        && let Some(tid) = thread_id
        && let Some(resume) = try_resume_open_wait(state, tid, prompt, active)
    {
        return resume;
    }
    let capabilities = semantic_capability_registry();
    let recent_thread_context = bounded_thread_context(state, thread_id);
    let input = semantic_decision::SemanticDecisionInput {
        latest_message: prompt,
        active_objective: active,
        recent_thread_context: recent_thread_context.as_deref(),
        explicit_binding: binding.and_then(|value| serde_json::to_value(value).ok()),
        capabilities: &capabilities,
    };
    let semantic_prompt = semantic_decision::semantic_decision_prompt(&input);
    // Semantic interpretation is part of orchestration itself: honor the canonical
    // orchestrator binding instead of asking the per-task model router to select a
    // second model before the turn has even been understood. Besides respecting a
    // manual role binding, this keeps the contract preflight bounded and predictable.
    let resolved = load_provider_registry().resolve_role("orchestrator");
    let router = resolved
        .as_ref()
        .map(build_router_for_resolved)
        .unwrap_or_else(|| router_for_role("orchestrator"));
    let request = GenerateJsonRequest {
        usage: {
            let mut usage = local_first_inference_usage::UsageContext::new(
                uuid::Uuid::new_v4().to_string(),
                local_first_inference_usage::InferencePurpose::IntentRouting,
                gateway_user_id().as_str(),
            );
            usage.purpose_detail = Some("semantic_turn_decision".to_string());
            usage.workspace_id = Some(gateway_memory_workspace_id().as_str().to_string());
            usage
        },
        prompt: semantic_prompt,
        // Reasoning models can spend most of a small budget before emitting the
        // schema-bound JSON. A truncated contract is safe-fallback only, so leave
        // enough room for reasoning plus the complete decision object.
        max_tokens: 6_000,
        temperature: 0.0,
        wait_if_busy: true,
        request_timeout_seconds: Some(75.0),
        json_schema: Some(semantic_decision::semantic_decision_schema()),
        required_keys: vec![
            "objective".to_string(),
            "relationship_to_active_objective".to_string(),
            "mode".to_string(),
            "scope".to_string(),
            "allowed_effect_classes".to_string(),
            "forbidden_effect_classes".to_string(),
            "deliverable".to_string(),
            "execution_shape".to_string(),
            "memory_intent".to_string(),
            "steering_disposition".to_string(),
            "requires_user_confirmation".to_string(),
            "confidence".to_string(),
            "rationale".to_string(),
        ],
        repair: true,
    };
    let mut effective_resolved = resolved.clone();
    let model_value = match generate_semantic_json_with_invalid_retry(|| {
        router.generate_json_with(&Requirements::default(), &request)
    }) {
        Ok(value) => Ok(value),
        Err(SemanticJsonGenerationError::Invalid(errors)) => {
            tracing::warn!(
                target: "semantic::decision",
                ?errors,
                "semantic decision did not satisfy the structured contract after retry"
            );
            Err("invalid_model_output".to_string())
        }
        Err(SemanticJsonGenerationError::Runtime(error)) => {
            if let Some(fallback) = semantic_decision_auth_fallback(&error, resolved.as_ref()) {
                tracing::warn!(
                    target: "semantic::decision",
                    ?error,
                    from_model = resolved.as_ref().map(|value| value.model.as_str()),
                    to_model = %fallback.model,
                    "semantic decision model auth failed; retrying with auth fallback"
                );
                let fallback_router = build_router_for_resolved(&fallback);
                effective_resolved = Some(fallback);
                match generate_semantic_json_with_invalid_retry(|| {
                    fallback_router.generate_json_with(&Requirements::default(), &request)
                }) {
                    Ok(value) => Ok(value),
                    Err(SemanticJsonGenerationError::Invalid(errors)) => {
                        tracing::warn!(
                            target: "semantic::decision",
                            ?errors,
                            "semantic fallback decision did not satisfy the structured contract after retry"
                        );
                        Err("invalid_model_output".to_string())
                    }
                    Err(SemanticJsonGenerationError::Runtime(fallback_error)) => {
                        tracing::warn!(
                            target: "semantic::decision",
                            ?fallback_error,
                            "semantic fallback decision model unavailable; steering will remain pending"
                        );
                        Err("model_unavailable".to_string())
                    }
                }
            } else {
                tracing::warn!(
                    target: "semantic::decision",
                    ?error,
                    "semantic decision model unavailable; steering will remain pending"
                );
                Err("model_unavailable".to_string())
            }
        }
    };
    let provider = effective_resolved
        .as_ref()
        .map(|value| value.provider_id.as_str());
    let model = effective_resolved
        .as_ref()
        .map(|value| value.model.as_str());
    if steering_control {
        semantic_decision::resolve_steering_model_value(
            model_value,
            &capabilities,
            active,
            provider,
            model,
        )
    } else {
        semantic_decision::resolve_model_value(model_value, &capabilities, active, provider, model)
    }
}

/// If the thread has an open HITL wait and `prompt` resolves it, consume the wait and
/// return the harness resume decision. Otherwise `None` (normal semantic path).
fn try_resume_open_wait(
    state: &AppState,
    thread_id: &str,
    prompt: &str,
    active: Option<&local_first_task_runtime::ObjectiveContractRecord>,
) -> Option<semantic_decision::ValidatedSemanticDecision> {
    let store = lock_store(state).ok()?;
    let wait = store.open_hitl_wait(thread_id).ok().flatten()?;
    if !hitl_resume::prompt_resolves_hitl_wait(prompt, &wait) {
        return None;
    }
    let decision = hitl_resume::hitl_resume_semantic_decision(&wait, prompt, active);
    if let Err(error) = store.resolve_open_hitl_wait(thread_id, &wait.wait_id) {
        eprintln!("[hitl] failed to resolve wait {}: {error}", wait.wait_id);
    }
    if let Ok(mut map) = state.hitl_resume_by_thread.lock() {
        map.insert(
            thread_id.to_string(),
            HitlResumeTurnContext {
                wait,
                resolution: prompt.trim().to_string(),
            },
        );
    }
    Some(decision)
}

/// Per-turn stash: open Choice wait just consumed for this thread's next generate.
#[derive(Debug, Clone)]
pub(crate) struct HitlResumeTurnContext {
    pub(crate) wait: hitl_resume::OpenHitlWait,
    pub(crate) resolution: String,
}

pub(crate) fn take_hitl_resume_turn_context(
    state: &AppState,
    thread_id: Option<&str>,
) -> Option<HitlResumeTurnContext> {
    let thread_id = thread_id.filter(|id| !id.trim().is_empty())?;
    state.hitl_resume_by_thread.lock().ok()?.remove(thread_id)
}

/// Error classes eligible for the semantic-decision auth/availability fallback:
/// explicit auth/quota/server rejections (401/403/429/5xx) and transport-level
/// failures (connection refused, timeout, an `Io` error reading the stream, or a
/// stream that ended without a terminal `done`). A malformed response body
/// (`Json`) or an explicit runtime-reported error code (`Runtime`) is deliberately
/// excluded — those reflect a provider-specific bug rather than an availability
/// signal, and retrying on a different model would mask it instead of surfacing it.
pub(crate) fn semantic_decision_auth_fallback_applies(
    error: &local_first_subagents::RuntimeClientError,
) -> bool {
    use local_first_subagents::RuntimeClientError;
    match error {
        RuntimeClientError::Status(401 | 403 | 429) => true,
        RuntimeClientError::Status(status) => (500..=599).contains(status),
        RuntimeClientError::Request(_)
        | RuntimeClientError::Io(_)
        | RuntimeClientError::StreamEndedWithoutDone => true,
        RuntimeClientError::Json(_) | RuntimeClientError::Runtime { .. } => false,
    }
}

// Injectable core (mirrors `auth_fallback_resolved_role_from_registry` /
// `semantic_decision_auth_fallback_resolved_role_from_registry`): lets tests supply
// a deterministic registry + key predicate instead of depending on
// `load_provider_registry()` / `provider_api_key()` global state.
pub(crate) fn semantic_decision_auth_fallback_from_registry(
    error: &local_first_subagents::RuntimeClientError,
    resolved: Option<&ResolvedRole>,
    registry: &ProviderRegistry,
    provider_has_key: impl FnMut(&str) -> bool,
) -> Option<ResolvedRole> {
    if !semantic_decision_auth_fallback_applies(error) {
        return None;
    }
    // No distinct fallback model configured: stay pending on genuine unavailability
    // rather than fabricate one (per spec).
    semantic_decision_auth_fallback_resolved_role_from_registry(
        registry,
        resolved?.model.as_str(),
        provider_has_key,
    )
}

fn semantic_decision_auth_fallback(
    error: &local_first_subagents::RuntimeClientError,
    resolved: Option<&ResolvedRole>,
) -> Option<ResolvedRole> {
    semantic_decision_auth_fallback_from_registry(
        error,
        resolved,
        &load_provider_registry(),
        |provider_id| provider_api_key(provider_id).is_some(),
    )
}

fn native_atomic_capabilities() -> &'static [NativeAtomicCapability] {
    &[
        NativeAtomicCapability {
            key: "pdf_atomic",
            tool_name: "run_in_sandbox",
            description: "Inspect, extract, merge, split, compress or convert existing PDF files as an atomic file operation.",
            route_text: "pdf_atomic PDF extract estrai read leggi merge unisci combine combina split dividi convert converti compress comprimi text testo pages pagine images immagini existing file existing document",
            schema: run_in_sandbox_tool_schema,
        },
        NativeAtomicCapability {
            key: "run_in_sandbox",
            tool_name: "run_in_sandbox",
            description: "Execute one bounded command in the isolated contained computer and return its real stdout and stderr.",
            route_text: "run_in_sandbox sandbox contained computer isolated command shell execute run stdout stderr verify test compile",
            schema: run_in_sandbox_tool_schema,
        },
    ]
}

pub(crate) fn native_atomic_by_key(key: &str) -> Option<NativeAtomicCapability> {
    native_atomic_capabilities()
        .iter()
        .copied()
        .find(|capability| capability.key == key)
}

pub(crate) fn native_atomic_capability_entries() -> Vec<CapabilityEntry> {
    native_atomic_capabilities()
        .iter()
        .map(|capability| CapabilityEntry {
            key: capability.key.to_string(),
            desc: capability.description.to_string(),
            text: format!(
                "{} {} {} {}",
                capability.key, capability.tool_name, capability.description, capability.route_text
            ),
            schema: Some((capability.schema)()),
            is_skill: false,
            source: CapabilitySource::NativeAtomic,
        })
        .collect()
}

pub(crate) fn workflow_execution_plan(
    definition: &WorkflowDefinition,
    arguments: serde_json::Value,
) -> ExecutionPlan {
    ExecutionPlan {
        route: OrchestratorRoute::MixedWorkflow,
        direct_answer: None,
        plan_propose: None,
        steps: definition
            .steps
            .iter()
            .map(|step| PlanStep {
                step_id: step.id.to_string(),
                kind: PlanStepKind::DirectAnswer,
                depends_on: step
                    .depends_on
                    .iter()
                    .map(|value| value.to_string())
                    .collect(),
                provider_id: None,
                tool_name: Some(definition.tool_name.to_string()),
                arguments: serde_json::json!({
                    "workflow_id": definition.id,
                    "step_title": step.title,
                    "input": arguments,
                }),
                execution_policy: StepExecutionPolicy::Immediate,
                risk_level: "low".to_string(),
                expected_duration_seconds: 0,
                agent_id: None,
                goal: Some(step.title.to_string()),
                contract: Some(definition.contract.to_string()),
                allowed_actions: vec![],
                requires_user_approval: None,
                timeout_seconds: None,
                max_tokens: None,
            })
            .collect(),
        needs_more_tools: None,
    }
}

pub(crate) fn run_static_workflow_plan_through_brain(
    goal: &str,
    plan: ExecutionPlan,
) -> Result<ExecutionPlan, String> {
    let router = build_browser_inference_router();
    let mut brain = OrchestratorBrain::new(
        router,
        GatewayBrainMemory(None),
        CapabilityFacade::new(CapabilityPolicy, InMemoryCapabilityAudit::default()),
        TaskStore::open_in_memory().map_err(|error| error.to_string())?,
    );
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let request = OrchestratorRequest {
        request_id: format!("static_workflow_{}", uuid::Uuid::new_v4().simple()),
        policy_context: PolicyContext {
            user_id: user,
            workspace_id: workspace,
            enabled_providers: Vec::new(),
            privacy_domains: vec!["work".to_string()],
            allowed_actions: vec![ActionClass::Read, ActionClass::Draft],
            max_autonomy_level: 0,
            allow_managed_cloud: false,
        },
        user_message: goal.to_string(),
        conversation_summary: None,
        attachments: Vec::new(),
        budgets: brain_budgets_for_context_window(None),
        language: effective_user_language(),
    };
    let outcome = brain
        .run_plan(request, plan)
        .map_err(|error| error.to_string())?;
    Ok(outcome.plan)
}

pub(crate) async fn run_static_workflow_plan_through_brain_async(
    goal: String,
    plan: ExecutionPlan,
) -> Result<ExecutionPlan, String> {
    tokio::task::spawn_blocking(move || run_static_workflow_plan_through_brain(&goal, plan))
        .await
        .map_err(|error| format!("static workflow validation join error: {error}"))?
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WorkflowRouteDecision {
    Workflow {
        workflow_id: &'static str,
        tool_name: &'static str,
        scaffolding_tier: &'static str,
    },
    AgentLoop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CapabilityRouteDecision {
    Workflow {
        workflow_id: &'static str,
        tool_name: &'static str,
        scaffolding_tier: &'static str,
        reason: String,
        alternatives: Vec<String>,
    },
    AtomicTool {
        capability_key: &'static str,
        reason: String,
    },
    AgentLoop {
        reason: String,
    },
}

pub(crate) fn workflow_route_from_capability(
    decision: &CapabilityRouteDecision,
) -> WorkflowRouteDecision {
    match decision {
        CapabilityRouteDecision::Workflow {
            workflow_id,
            tool_name,
            scaffolding_tier,
            ..
        } => WorkflowRouteDecision::Workflow {
            workflow_id,
            tool_name,
            scaffolding_tier,
        },
        CapabilityRouteDecision::AtomicTool { .. } | CapabilityRouteDecision::AgentLoop { .. } => {
            WorkflowRouteDecision::AgentLoop
        }
    }
}

pub(crate) fn route_capability_from_semantic(
    semantic: Option<&semantic_decision::ValidatedSemanticDecision>,
) -> CapabilityRouteDecision {
    let Some(semantic) = semantic else {
        return CapabilityRouteDecision::AgentLoop {
            reason: "No validated semantic decision; safe agent-loop fallback.".to_string(),
        };
    };
    match semantic.decision.execution_shape {
        semantic_decision::ExecutionShape::AgentLoop => CapabilityRouteDecision::AgentLoop {
            reason: semantic.decision.rationale.clone(),
        },
        semantic_decision::ExecutionShape::Workflow => {
            let Some(tool_name) = semantic.decision.selected_capability.as_deref() else {
                return CapabilityRouteDecision::AgentLoop {
                    reason: "Validated workflow decision omitted its capability; safe fallback."
                        .to_string(),
                };
            };
            let Some(capability) = native_workflow_by_tool_name(tool_name) else {
                return CapabilityRouteDecision::AgentLoop {
                    reason: "Validated workflow capability is unavailable; safe fallback."
                        .to_string(),
                };
            };
            CapabilityRouteDecision::Workflow {
                workflow_id: capability.workflow_id,
                tool_name: capability.tool_name,
                scaffolding_tier: capability.scaffolding_tier,
                reason: format!(
                    "Selected by semantic decision schema v{}: {}",
                    semantic.provenance.schema_version, semantic.decision.rationale
                ),
                alternatives: Vec::new(),
            }
        }
        semantic_decision::ExecutionShape::AtomicCapability => {
            if let Some(capability_key) = semantic
                .decision
                .selected_capability
                .as_deref()
                .and_then(native_atomic_by_key)
                .map(|capability| capability.key)
            {
                CapabilityRouteDecision::AtomicTool {
                    capability_key,
                    reason: semantic.decision.rationale.clone(),
                }
            } else {
                CapabilityRouteDecision::AgentLoop {
                    reason: "Validated atomic capability is unavailable; safe fallback."
                        .to_string(),
                }
            }
        }
    }
}

/// S2 (plugin-owned deterministic routing): an active `RoutingBinding` — thread-scoped,
/// set once when the user picks a template/route (e.g. "Use template"; see
/// `RoutingBinding` in lib.rs, `ChatStore::thread_routing_binding`) — decides the route
/// DIRECTLY when it resolves to a registered `WorkflowRouting`. This is not natural-language
/// inference: the binding records an exact route the user already selected.
///
/// `enabled: &|_| true` — not a plugin-enablement gate — because the persisted binding
/// itself IS the enablement signal: the user already chose this route this thread.
///
/// Without a valid explicit binding, routing consumes the validated model-owned semantic
/// decision. It never derives a route from prompt keywords or retrieval rank.
pub(crate) fn route_capability_with_binding(
    semantic: Option<&semantic_decision::ValidatedSemanticDecision>,
    binding: Option<&RoutingBinding>,
) -> CapabilityRouteDecision {
    if let Some(binding) = binding {
        let registry = WorkflowRoutingRegistry::system();
        let forced = registry
            .routings(&|_| true)
            .into_iter()
            .find(|routing| routing.deterministic && routing.route_id == binding.route_id)
            .and_then(|routing| {
                native_workflow_by_tool_name(&routing.tool_name)
                    .map(|capability| (routing, capability))
            });
        if let Some((routing, capability)) = forced {
            return CapabilityRouteDecision::Workflow {
                workflow_id: capability.workflow_id,
                tool_name: capability.tool_name,
                scaffolding_tier: capability.scaffolding_tier,
                reason: format!("deterministic plugin routing: {}", routing.route_id),
                alternatives: vec![],
            };
        }
    }
    route_capability_from_semantic(semantic)
}

/// S2 T4: read the thread's active deterministic `RoutingBinding`, if any. Single fail-open
/// helper (no thread_id / no store lock / no persisted binding / malformed JSON → `None`,
/// ordinary unbound behaviour) shared by the router seam and the `make_deck`/`make_document`
/// dispatch arms, which both need the SAME binding read (previously only the router read it —
/// duplicating the lock-and-parse there and in the two tool-exec arms was the alternative).
pub(crate) fn active_routing_binding(
    state: &AppState,
    thread_id: Option<&str>,
) -> Option<RoutingBinding> {
    thread_id
        .and_then(|tid| {
            lock_store(state)
                .ok()
                .and_then(|store| store.thread_routing_binding(tid).ok().flatten())
        })
        .and_then(|json| serde_json::from_str::<RoutingBinding>(&json).ok())
}

/// S2 T4: resolve an active binding back to its registered `WorkflowRouting` (for
/// `deny_tools`/`tool_name`). Mirrors the lookup inside `route_capability_with_binding`, which
/// only needs to know THAT a match exists to force the route; the hard-prune call site needs
/// the full routing (its `deny_tools`), hence the separate accessor.
pub(crate) fn resolve_workflow_routing(
    binding: &RoutingBinding,
) -> Option<local_first_capabilities::WorkflowRouting> {
    WorkflowRoutingRegistry::system()
        .routings(&|_| true)
        .into_iter()
        .find(|routing| routing.deterministic && routing.route_id == binding.route_id)
        .cloned()
}

/// S2 T5: the forced-`tool_choice` decision for THIS turn, pure and independent of the store —
/// given the turn's resolved routing (if any) and how many user messages the thread already
/// carries. `Specific` forcing pins the model to `tool_name`, but only once the intake exchange
/// is past its first round (see the call site for the exact turn-index rationale); every other
/// combination (no routing, non-`Specific` forcing, still on turn 1) stays `None` = "auto".
pub(crate) fn forced_tool_for_turn(
    routing: Option<&local_first_capabilities::WorkflowRouting>,
    user_message_count: usize,
) -> Option<String> {
    let routing = routing?;
    if routing.forcing != local_first_capabilities::Forcing::Specific {
        return None;
    }
    if user_message_count < 2 {
        return None;
    }
    Some(routing.tool_name.clone())
}

/// S2 T5: how many USER messages a thread has, from an already-loaded snapshot. Pure (no store),
/// so the turn-index heuristic is trivially testable independent of `ChatStore`/`AppState`.
pub(crate) fn thread_user_message_count(snapshot: &ChatMessagesSnapshot) -> usize {
    snapshot
        .messages
        .iter()
        .filter(|message| message.role == "user")
        .count()
}

/// S2 T5: fail-open wrapper reading the thread's message count off the real store. No thread_id /
/// no store lock / no rows → 0 — the safe default, since `forced_tool_for_turn` treats a count
/// below 2 as "still the first turn" and keeps `tool_choice` on "auto". Mirrors the fail-open
/// shape of `active_routing_binding` just above.
pub(crate) fn thread_user_message_count_fail_open(
    state: &AppState,
    thread_id: Option<&str>,
) -> usize {
    thread_id
        .and_then(|tid| {
            lock_store(state)
                .ok()
                .and_then(|store| store.messages(tid).ok())
        })
        .map(|snapshot| thread_user_message_count(&snapshot))
        .unwrap_or(0)
}

pub(crate) fn capability_router_instruction_for_decision(
    decision: &CapabilityRouteDecision,
) -> Option<String> {
    match decision {
        CapabilityRouteDecision::Workflow {
            workflow_id,
            tool_name,
            scaffolding_tier,
            reason,
            ..
        } => Some(format!(
            "CAPABILITY ROUTER: this request is routed by the harness to workflow `{workflow_id}` \
with `{scaffolding_tier}` scaffolding. Reason: {reason} Call `{tool_name}` exactly once with the user's brief; \
do not create a separate plan, do not decompose it into lower-level tools, and do not use shell/file tools for this workflow."
        )),
        CapabilityRouteDecision::AtomicTool {
            capability_key,
            reason,
        } => Some(format!(
            "CAPABILITY ROUTER: this request is classified as atomic capability `{capability_key}`. \
Reason: {reason} Do not call end-to-end deliverable workflows such as `make_document` for this request. \
Use the most specific atomic/tool capability available, or call `find_capability` if it is not already loaded."
        )),
        CapabilityRouteDecision::AgentLoop { .. } => None,
    }
}

pub(crate) fn capability_route_trace_line(decision: &CapabilityRouteDecision) -> Option<String> {
    match decision {
        CapabilityRouteDecision::Workflow {
            workflow_id,
            tool_name,
            reason,
            alternatives,
            ..
        } => Some(format!(
            "capability route: workflow {workflow_id}/{tool_name}; reason={reason}; alternatives={}",
            if alternatives.is_empty() {
                "none".to_string()
            } else {
                alternatives.join(",")
            }
        )),
        CapabilityRouteDecision::AtomicTool {
            capability_key,
            reason,
        } => Some(format!(
            "capability route: atomic {capability_key}; reason={reason}"
        )),
        CapabilityRouteDecision::AgentLoop { .. } => None,
    }
}

pub(crate) fn prune_tools_for_workflow_route(
    tools: &mut Vec<serde_json::Value>,
    route: &WorkflowRouteDecision,
) {
    if let WorkflowRouteDecision::Workflow { tool_name, .. } = route {
        tools.retain(|schema| {
            schema
                .pointer("/function/name")
                .and_then(|value| value.as_str())
                == Some(*tool_name)
        });
    }
}

/// S2 T4: hard prune for a deterministic plugin routing — retains ONLY `route_tool` and
/// explicitly denies anything matching the resolved `WorkflowRouting`'s `deny_tools`
/// (`local_first_capabilities::tool_matches_deny`: `skill:*`, `run_command`, `shell`, the
/// sibling `make_*`). The deny check is evaluated first so a hard-denied name can never slip
/// through even if it happened to equal `route_tool` — belt-and-suspenders against a
/// misconfigured registry entry. Functionally this retains the same single tool
/// `prune_tools_for_workflow_route` does today (kept unchanged as the plain wrapper for the
/// non-plugin-routed case); this variant exists so the registry's `deny_tools` — not ad hoc
/// gateway logic — is what a plugin route can rely on to starve every other tool, including
/// ones a later stage of tool assembly (MCP/Composio) might reintroduce by name.
pub(crate) fn prune_tools_for_route_and_deny(
    tools: &mut Vec<serde_json::Value>,
    route_tool: &str,
    deny: &[String],
) {
    tools.retain(|schema| {
        let name = schema
            .pointer("/function/name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        !local_first_capabilities::tool_matches_deny(deny, name) && name == route_tool
    });
}

/// S2 T4: single call-site dispatcher for the two prune call sites in the tool-assembly
/// pipeline — plain retain-only-route-tool (`deny_tools` empty, i.e. no deterministic
/// binding survived plan-precedence) or the hard deny-aware prune (binding active).
pub(crate) fn prune_tools_for_route(
    tools: &mut Vec<serde_json::Value>,
    route: &WorkflowRouteDecision,
    deny_tools: &[String],
) {
    if deny_tools.is_empty() {
        prune_tools_for_workflow_route(tools, route);
        return;
    }
    if let WorkflowRouteDecision::Workflow { tool_name, .. } = route {
        prune_tools_for_route_and_deny(tools, tool_name, deny_tools);
    }
}

pub(crate) fn workflow_route_blocked_tool_message(
    route: &CapabilityRouteDecision,
    tool_name: &str,
) -> Option<String> {
    match route {
        CapabilityRouteDecision::Workflow {
            workflow_id,
            tool_name: workflow_tool,
            ..
        } if tool_name != *workflow_tool => Some(format!(
            "WORKFLOW_ROUTE_BLOCKED_TOOL: this turn is routed to workflow `{workflow_id}`. \
Tool `{tool_name}` is not allowed here. Do not create files manually, do not use shell/filesystem \
fallbacks, and do not decompose the workflow. Use `{workflow_tool}` exactly once; if `{workflow_tool}` \
already failed because the provider is unavailable, stop and tell the user to choose a reachable \
provider or start the required local service."
        )),
        _ => None,
    }
}

/// Gateway `TurnPolicy` adapter for turn-level capability routing.
///
/// The engine consults this port for synchronous routing checks. Keeping it in
/// the capability routing owner ensures workflow route enforcement has one
/// authority, while the vision predicate remains delegated to model routing.
pub(crate) struct GatewayTurnPolicy {
    pub(crate) route: CapabilityRouteDecision,
    workflow_tool_calls: std::sync::atomic::AtomicUsize,
}

impl GatewayTurnPolicy {
    pub(crate) fn new(route: CapabilityRouteDecision) -> Self {
        Self {
            route,
            workflow_tool_calls: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

impl local_first_engine::TurnPolicy for GatewayTurnPolicy {
    fn route_blocked(&self, tool: &str) -> Option<String> {
        if let CapabilityRouteDecision::Workflow {
            workflow_id,
            tool_name,
            ..
        } = &self.route
            && tool == *tool_name
            && self
                .workflow_tool_calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                > 0
        {
            return Some(format!(
                "WORKFLOW_ROUTE_ALREADY_CALLED: workflow `{workflow_id}` already called `{tool_name}` in this turn. Do not retry or change parameters. Report the first result accurately and stop."
            ));
        }
        workflow_route_blocked_tool_message(&self.route, tool)
    }

    fn route_block_ends_turn(&self) -> bool {
        matches!(self.route, CapabilityRouteDecision::Workflow { .. })
            && self
                .workflow_tool_calls
                .load(std::sync::atomic::Ordering::Relaxed)
                > 0
    }

    fn supports_vision(&self, base_url: &str, model: &str) -> bool {
        // The browser's screenshot gate: skip the image ONLY for a model the catalog confidently calls
        // text-only. `Unknown` still sends — a screenshot wasted on a blind model costs one round,
        // whereas withholding it from a model that CAN see blinds the whole browsing turn. (The user's
        // own uploads make the opposite trade: see `vision::plan_attachments`.)
        model_supports_vision(base_url, model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_capability_routing_owner_smoke() {
        assert_eq!(
            native_workflow_by_tool_name("make_document").map(|capability| capability.workflow_id),
            Some("make_document")
        );
        assert_eq!(
            native_atomic_by_key("pdf_atomic").map(|capability| capability.tool_name),
            Some("run_in_sandbox")
        );
        let decision = route_capability_from_semantic(None);
        assert!(matches!(
            decision,
            CapabilityRouteDecision::AgentLoop { .. }
        ));
    }
}
