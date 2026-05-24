use local_first_local_computer_session::{
    ComputerEventCreate, ComputerSessionSnapshot, LocalComputerSessionManager, SurfaceKind,
};
use local_first_subagents::{GenerateJsonRequest, JsonRuntime};
use serde::Deserialize;
use serde::Serialize;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct PromptSubmissionResult {
    pub user_message: PromptMessage,
    pub assistant_message: PromptMessage,
    pub computer_session: ComputerSessionSnapshot,
    pub plan: Option<PromptExecutionPlan>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: String,
    pub metadata: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptExecutionPlan {
    pub title: String,
    pub summary: String,
    pub risk_level: String,
    pub steps: Vec<PromptPlanStep>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptPlanStep {
    pub step_id: String,
    pub title: String,
    pub detail: String,
    pub surface: String,
    pub action_kind: String,
    pub requires_user_approval: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_url: Option<String>,
}

pub trait PromptBrain {
    fn understand(&mut self, prompt: &str) -> Result<BrainUnderstanding, String>;
}

pub trait PromptTaskPlanner {
    fn plan(&mut self, prompt: &str, summary: &str) -> Result<PromptExecutionPlan, String>;
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "route", rename_all = "snake_case")]
pub enum BrainUnderstanding {
    DirectAnswer {
        answer: String,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        confidence: Option<f64>,
    },
    LocalTime {
        #[serde(default)]
        reason: Option<String>,
    },
    LocalCalculation {
        calculation_left: i64,
        calculation_operator: String,
        calculation_right: i64,
        #[serde(default)]
        reason: Option<String>,
    },
    NeedsPlanning {
        summary: String,
        #[serde(default)]
        reason: Option<String>,
    },
    AskClarification {
        question: String,
        #[serde(default)]
        reason: Option<String>,
    },
    Refuse {
        answer: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

pub struct RuntimePromptBrain<R> {
    runtime: R,
}

pub struct RuntimePromptTaskPlanner<R> {
    runtime: R,
}

impl<R> RuntimePromptBrain<R> {
    pub fn new(runtime: R) -> Self {
        Self { runtime }
    }
}

impl<R> RuntimePromptTaskPlanner<R> {
    pub fn new(runtime: R) -> Self {
        Self { runtime }
    }
}

impl<R: JsonRuntime> PromptBrain for RuntimePromptBrain<R> {
    fn understand(&mut self, prompt: &str) -> Result<BrainUnderstanding, String> {
        let request = GenerateJsonRequest {
            prompt: brain_prompt(prompt),
            max_tokens: 384,
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: Some(30.0),
            json_schema: Some(brain_schema()),
            required_keys: vec![
                "route".to_string(),
                "calculation_left".to_string(),
                "calculation_operator".to_string(),
                "calculation_right".to_string(),
            ],
            repair: true,
        };
        let response = self
            .runtime
            .generate_json(&request)
            .map_err(|error| format!("brain_runtime_unavailable:{error:?}"))?;
        if !response.valid {
            return Err(format!("brain_invalid_json:{}", response.errors.join("; ")));
        }
        serde_json::from_value(response.json)
            .map_err(|error| format!("brain_understanding_invalid:{error}"))
    }
}

impl<R: JsonRuntime> PromptTaskPlanner for RuntimePromptTaskPlanner<R> {
    fn plan(&mut self, prompt: &str, summary: &str) -> Result<PromptExecutionPlan, String> {
        let request = GenerateJsonRequest {
            prompt: planner_prompt(prompt, summary),
            max_tokens: 768,
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: Some(45.0),
            json_schema: Some(planner_schema()),
            required_keys: vec![
                "title".to_string(),
                "summary".to_string(),
                "risk_level".to_string(),
                "steps".to_string(),
            ],
            repair: true,
        };
        let response = self
            .runtime
            .generate_json(&request)
            .map_err(|error| format!("planner_runtime_unavailable:{error:?}"))?;
        if !response.valid {
            return Err(format!(
                "planner_invalid_json:{}",
                response.errors.join("; ")
            ));
        }
        let plan = serde_json::from_value(response.json)
            .map_err(|error| format!("planner_plan_invalid:{error}"))?;
        validate_prompt_plan(&plan)?;
        Ok(plan)
    }
}

pub fn submit_user_prompt(
    manager: &LocalComputerSessionManager,
    brain: &mut impl PromptBrain,
    planner: &mut impl PromptTaskPlanner,
    user_id: &str,
    workspace_id: &str,
    session_id: &str,
    prompt: &str,
) -> Result<PromptSubmissionResult, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("prompt is empty".to_string());
    }
    if prompt.chars().count() > 4_000 {
        return Err("prompt is too long".to_string());
    }

    manager.append_event(ComputerEventCreate {
        session_id: session_id.to_string(),
        surface: SurfaceKind::Logs,
        kind: "user_prompt_received".to_string(),
        status: "done".to_string(),
        title: "Prompt utente ricevuto".to_string(),
        subtitle: format!("Prompt redatto, {} caratteri", prompt.chars().count()),
        payload: serde_json::json!({
            "raw_prompt_stored": false,
            "prompt_chars": prompt.chars().count()
        }),
        artifact_refs: vec![],
        approval_required: false,
    })?;

    let understanding = match brain.understand(prompt) {
        Ok(understanding) => understanding,
        Err(error) => {
            manager.append_event(ComputerEventCreate {
                session_id: session_id.to_string(),
                surface: SurfaceKind::Logs,
                kind: "brain_understanding_failed".to_string(),
                status: "waiting".to_string(),
                title: "Brain locale non raggiungibile".to_string(),
                subtitle: "Avvia il runtime Gemma 4 locale per comprendere il prompt.".to_string(),
                payload: serde_json::json!({
                    "raw_prompt_stored": false,
                    "error": error
                }),
                artifact_refs: vec![],
                approval_required: false,
            })?;
            return prompt_result(
                manager,
                user_id,
                workspace_id,
                session_id,
                "Il Brain locale non e' raggiungibile. Avvia il runtime Gemma 4 locale e riprova."
                    .to_string(),
                None,
            );
        }
    };

    manager.append_event(ComputerEventCreate {
        session_id: session_id.to_string(),
        surface: SurfaceKind::Logs,
        kind: "brain_understanding_completed".to_string(),
        status: "done".to_string(),
        title: "Prompt compreso dal Brain".to_string(),
        subtitle: understanding.redacted_summary(),
        payload: serde_json::json!({
            "raw_prompt_stored": false,
            "route": understanding.route_name()
        }),
        artifact_refs: vec![],
        approval_required: false,
    })?;

    let mut plan = None;
    let assistant_text = match understanding {
        BrainUnderstanding::LocalCalculation {
            calculation_left,
            calculation_operator,
            calculation_right,
            ..
        } => {
            let calculation = SimpleCalculation {
                left: calculation_left,
                operator: normalize_brain_operator(&calculation_operator)?,
                right: calculation_right,
            };
            manager.append_event(ComputerEventCreate {
                session_id: session_id.to_string(),
                surface: SurfaceKind::Logs,
                kind: "local_calculation_completed".to_string(),
                status: "done".to_string(),
                title: "Calcolo locale completato".to_string(),
                subtitle: calculation.redacted_expression(),
                payload: serde_json::json!({
                    "raw_prompt_stored": false,
                    "operation": calculation.operator_label(),
                }),
                artifact_refs: vec![],
                approval_required: false,
            })?;
            format!(
                "{} {} {} fa {}.",
                calculation.left,
                calculation.operator,
                calculation.right,
                calculation.result()
            )
        }
        BrainUnderstanding::LocalTime { .. } => {
            manager.start_surface(session_id, SurfaceKind::Shell, "Terminale locale")?;
            manager.append_event(ComputerEventCreate {
                session_id: session_id.to_string(),
                surface: SurfaceKind::Shell,
                kind: "computer_action_started".to_string(),
                status: "running".to_string(),
                title: "Verificare ora locale".to_string(),
                subtitle: "Esecuzione read-only tramite comando date".to_string(),
                payload: serde_json::json!({ "command": "date" }),
                artifact_refs: vec![],
                approval_required: false,
            })?;
            let date_output = run_date_command()?;
            manager.append_terminal_output(
                session_id,
                user_id,
                workspace_id,
                &date_output.transcript,
            )?;
            manager.append_event(ComputerEventCreate {
                session_id: session_id.to_string(),
                surface: SurfaceKind::Shell,
                kind: "computer_action_completed".to_string(),
                status: "done".to_string(),
                title: "Ora locale verificata".to_string(),
                subtitle: "Risultato ottenuto localmente dalla shell".to_string(),
                payload: serde_json::json!({ "command": "date", "output": "redacted" }),
                artifact_refs: vec![],
                approval_required: false,
            })?;
            format!(
                "Ho verificato localmente dalla shell: {}.",
                date_output.value
            )
        }
        BrainUnderstanding::DirectAnswer { answer, .. }
        | BrainUnderstanding::Refuse { answer, .. } => answer,
        BrainUnderstanding::AskClarification { question, .. } => question,
        BrainUnderstanding::NeedsPlanning { summary, .. } => {
            let operational_plan = planner.plan(prompt, &summary)?;
            if operational_plan
                .steps
                .iter()
                .any(|step| step.surface == "browser")
            {
                manager.start_surface(session_id, SurfaceKind::Browser, "Browser locale")?;
            }
            manager.append_event(ComputerEventCreate {
                session_id: session_id.to_string(),
                surface: SurfaceKind::Logs,
                kind: "operational_plan_created".to_string(),
                status: "done".to_string(),
                title: "Piano operativo creato".to_string(),
                subtitle: format!(
                    "{} step, rischio {}",
                    operational_plan.steps.len(),
                    operational_plan.risk_level
                ),
                payload: serde_json::json!({
                    "raw_prompt_stored": false,
                    "plan_title": operational_plan.title,
                    "step_count": operational_plan.steps.len(),
                    "approval_steps": operational_plan.steps.iter().filter(|step| step.requires_user_approval).count()
                }),
                artifact_refs: vec![],
                approval_required: operational_plan
                    .steps
                    .iter()
                    .any(|step| step.requires_user_approval),
            })?;
            for step in &operational_plan.steps {
                manager.append_event(ComputerEventCreate {
                    session_id: session_id.to_string(),
                    surface: surface_from_plan_step(step),
                    kind: "operational_plan_step_ready".to_string(),
                    status: "waiting".to_string(),
                    title: step.title.clone(),
                    subtitle: step.detail.clone(),
                    payload: serde_json::json!({
                        "raw_prompt_stored": false,
                        "step_id": step.step_id,
                        "action_kind": step.action_kind,
                        "requires_user_approval": step.requires_user_approval
                    }),
                    artifact_refs: vec![],
                    approval_required: step.requires_user_approval,
                })?;
            }
            let step_count = operational_plan.steps.len();
            let title = operational_plan.title.clone();
            plan = Some(operational_plan);
            format!(
                "Ho creato un piano operativo: {title}. Ho preparato {step_count} step e blocchero' login, acquisto o pagamento finche' non dai conferma esplicita."
            )
        }
    };

    prompt_result(
        manager,
        user_id,
        workspace_id,
        session_id,
        assistant_text,
        plan,
    )
}

fn prompt_result(
    manager: &LocalComputerSessionManager,
    user_id: &str,
    workspace_id: &str,
    session_id: &str,
    assistant_text: String,
    plan: Option<PromptExecutionPlan>,
) -> Result<PromptSubmissionResult, String> {
    let computer_session = manager
        .read_model()
        .snapshot(session_id, user_id, workspace_id)?
        .ok_or_else(|| format!("session not found: {session_id}"))?;

    Ok(PromptSubmissionResult {
        user_message: PromptMessage {
            id: format!("user_{}", timestamp_nanos()),
            role: "user".to_string(),
            text: "[prompt redatto nel core locale]".to_string(),
            timestamp: "ora".to_string(),
            metadata: Some("Non salvato come payload raw".to_string()),
        },
        assistant_message: PromptMessage {
            id: format!("assistant_{}", timestamp_nanos()),
            role: "assistant".to_string(),
            text: assistant_text,
            timestamp: "ora".to_string(),
            metadata: Some("Tauri core locale".to_string()),
        },
        computer_session,
        plan,
    })
}

impl BrainUnderstanding {
    fn route_name(&self) -> &'static str {
        match self {
            BrainUnderstanding::DirectAnswer { .. } => "direct_answer",
            BrainUnderstanding::LocalTime { .. } => "local_time",
            BrainUnderstanding::LocalCalculation { .. } => "local_calculation",
            BrainUnderstanding::NeedsPlanning { .. } => "needs_planning",
            BrainUnderstanding::AskClarification { .. } => "ask_clarification",
            BrainUnderstanding::Refuse { .. } => "refuse",
        }
    }

    fn redacted_summary(&self) -> String {
        match self {
            BrainUnderstanding::DirectAnswer { .. } => "Risposta diretta".to_string(),
            BrainUnderstanding::LocalTime { .. } => "Richiesta ora/data locale".to_string(),
            BrainUnderstanding::LocalCalculation { .. } => "Calcolo locale".to_string(),
            BrainUnderstanding::NeedsPlanning { .. } => "Richiesta da pianificare".to_string(),
            BrainUnderstanding::AskClarification { .. } => "Serve chiarimento".to_string(),
            BrainUnderstanding::Refuse { .. } => "Richiesta rifiutata".to_string(),
        }
    }
}

fn brain_prompt(prompt: &str) -> String {
    format!(
        "You are the local-first assistant request understanding brain.\n\
         Classify the user's request language-agnostically. Do not execute tools.\n\
         Return only JSON matching the schema.\n\
         Use local_time for requests asking the current local time or date.\n\
         Use local_calculation for simple arithmetic even when written in words.\n\
         Use direct_answer only when no fresh system state or tool is needed.\n\
         Use needs_planning for browser, shell, connector, memory, automation, or multi-step work.\n\
         Always include calculation_left, calculation_operator and calculation_right. For non-calculation routes set them to null.\n\
         For local_calculation, calculation_left and calculation_right must be integers and calculation_operator must be one of +, -, *, /.\n\
         Never include the raw user prompt in the JSON.\n\
         User request: {prompt}"
    )
}

fn brain_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "required": ["route", "calculation_left", "calculation_operator", "calculation_right"],
        "properties": {
            "route": {
                "type": "string",
                "enum": [
                    "direct_answer",
                    "local_time",
                    "local_calculation",
                    "needs_planning",
                    "ask_clarification",
                    "refuse"
                ]
            },
            "answer": {"type": ["string", "null"]},
            "question": {"type": ["string", "null"]},
            "summary": {"type": ["string", "null"]},
            "reason": {"type": ["string", "null"]},
            "confidence": {"type": ["number", "null"]},
            "calculation_left": {"type": ["integer", "null"]},
            "calculation_operator": {
                "type": ["string", "null"],
                "enum": ["+", "-", "*", "/", "add", "subtract", "multiply", "divide", "plus", "minus", "times", "x", null]
            },
            "calculation_right": {"type": ["integer", "null"]}
        }
    })
}

fn planner_prompt(prompt: &str, summary: &str) -> String {
    format!(
        "You are the local-first assistant operational task planner.\n\
         Create a safe executable plan for the user's request. Do not perform the task.\n\
         Return only JSON matching the schema.\n\
         Use short UI-safe titles and details. Do not include secrets, payment data, credentials, raw forms, or raw prompt text.\n\
         For booking, purchasing, sending, posting, deleting, or changing external state, add a step with requires_user_approval=true before the risky action.\n\
         For browser research or form filling, use surface=browser. For shell checks, use surface=shell. For files/artifacts, use surface=files. Otherwise use surface=logs.\n\
         For browser steps, target_url may be an HTTPS start page or about:blank. Use a homepage/start URL only, never a search URL with query parameters or raw user text.\n\
         action_kind must be one of research, compare_options, draft, approval_gate, browser_action, shell_check, artifact, final_response.\n\
         User request summary: {summary}\n\
         User request: {prompt}"
    )
}

fn planner_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "required": ["title", "summary", "risk_level", "steps"],
        "properties": {
            "title": {"type": "string"},
            "summary": {"type": "string"},
            "risk_level": {"type": "string", "enum": ["low", "medium", "high"]},
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["step_id", "title", "detail", "surface", "action_kind", "requires_user_approval"],
                    "properties": {
                        "step_id": {"type": "string"},
                        "title": {"type": "string"},
                        "detail": {"type": "string"},
                        "surface": {"type": "string", "enum": ["browser", "shell", "files", "logs"]},
                        "action_kind": {"type": "string", "enum": ["research", "compare_options", "draft", "approval_gate", "browser_action", "shell_check", "artifact", "final_response"]},
                        "requires_user_approval": {"type": "boolean"},
                        "target_url": {"type": ["string", "null"]}
                    }
                }
            }
        }
    })
}

fn validate_prompt_plan(plan: &PromptExecutionPlan) -> Result<(), String> {
    if plan.title.trim().is_empty() {
        return Err("planner_plan_empty_title".to_string());
    }
    if plan.steps.is_empty() {
        return Err("planner_plan_empty_steps".to_string());
    }
    if plan.steps.len() > 12 {
        return Err(format!("planner_plan_too_many_steps:{}", plan.steps.len()));
    }
    for step in &plan.steps {
        if step.step_id.trim().is_empty() || step.title.trim().is_empty() {
            return Err("planner_plan_invalid_step".to_string());
        }
        if let Some(target_url) = &step.target_url {
            validate_browser_target_url(target_url)?;
        }
    }
    Ok(())
}

fn validate_browser_target_url(target_url: &str) -> Result<(), String> {
    let target_url = target_url.trim();
    if target_url == "about:blank" {
        return Ok(());
    }
    if target_url.len() > 300 {
        return Err("planner_plan_target_url_too_long".to_string());
    }
    if target_url.contains('?') || target_url.contains('#') {
        return Err("planner_plan_target_url_must_not_include_query".to_string());
    }
    if !(target_url.starts_with("https://") || target_url.starts_with("http://")) {
        return Err("planner_plan_target_url_unsupported_scheme".to_string());
    }
    Ok(())
}

fn surface_from_plan_step(step: &PromptPlanStep) -> SurfaceKind {
    match step.surface.as_str() {
        "browser" => SurfaceKind::Browser,
        "shell" => SurfaceKind::Shell,
        "files" => SurfaceKind::Files,
        _ => SurfaceKind::Logs,
    }
}

struct DateCommandOutput {
    value: String,
    transcript: String,
}

fn run_date_command() -> Result<DateCommandOutput, String> {
    let output = Command::new("date")
        .arg("+%Y-%m-%d %H:%M:%S %Z")
        .output()
        .map_err(|error| format!("date command failed: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(format!(
            "date command exited with {}: {stderr}",
            output.status
        ));
    }
    Ok(DateCommandOutput {
        value: stdout.clone(),
        transcript: format!("prompt % date '+%Y-%m-%d %H:%M:%S %Z'\n{stdout}"),
    })
}

struct SimpleCalculation {
    left: i64,
    operator: char,
    right: i64,
}

impl SimpleCalculation {
    fn result(&self) -> String {
        match self.operator {
            '+' => (self.left + self.right).to_string(),
            '-' => (self.left - self.right).to_string(),
            '*' => (self.left * self.right).to_string(),
            '/' if self.right == 0 => "undefined".to_string(),
            '/' if self.left % self.right == 0 => (self.left / self.right).to_string(),
            '/' => format!("{:.4}", self.left as f64 / self.right as f64),
            _ => "unsupported".to_string(),
        }
    }

    fn redacted_expression(&self) -> String {
        format!(
            "Espressione aritmetica locale: {} {} {}",
            self.left, self.operator, self.right
        )
    }

    fn operator_label(&self) -> &'static str {
        match self.operator {
            '+' => "add",
            '-' => "subtract",
            '*' => "multiply",
            '/' => "divide",
            _ => "unknown",
        }
    }
}

fn normalize_brain_operator(operator: &str) -> Result<char, String> {
    match operator.trim().to_lowercase().as_str() {
        "+" | "add" | "plus" => Ok('+'),
        "-" | "subtract" | "minus" => Ok('-'),
        "*" | "multiply" | "times" | "x" => Ok('*'),
        "/" | "divide" => Ok('/'),
        other => Err(format!("unsupported brain calculation operator: {other}")),
    }
}

fn timestamp_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use local_first_local_computer_session::{ComputerSessionCreate, LocalComputerSessionStore};

    struct StaticBrain {
        understanding: BrainUnderstanding,
    }

    struct StaticPlanner {
        plan: PromptExecutionPlan,
    }

    impl PromptBrain for StaticBrain {
        fn understand(&mut self, _prompt: &str) -> Result<BrainUnderstanding, String> {
            Ok(self.understanding.clone())
        }
    }

    impl PromptTaskPlanner for StaticPlanner {
        fn plan(&mut self, _prompt: &str, _summary: &str) -> Result<PromptExecutionPlan, String> {
            Ok(self.plan.clone())
        }
    }

    fn inert_planner() -> StaticPlanner {
        StaticPlanner {
            plan: PromptExecutionPlan {
                title: "Non usato".to_string(),
                summary: "Non usato".to_string(),
                risk_level: "low".to_string(),
                steps: vec![PromptPlanStep {
                    step_id: "noop".to_string(),
                    title: "Non usato".to_string(),
                    detail: "Non usato".to_string(),
                    surface: "logs".to_string(),
                    action_kind: "final_response".to_string(),
                    requires_user_approval: false,
                    target_url: None,
                }],
            },
        }
    }

    fn train_plan() -> PromptExecutionPlan {
        PromptExecutionPlan {
            title: "Prenotazione treno Napoli-Milano".to_string(),
            summary: "Cercare opzioni alta velocita e preparare conferma utente.".to_string(),
            risk_level: "medium".to_string(),
            steps: vec![
                PromptPlanStep {
                    step_id: "search_trains".to_string(),
                    title: "Cercare treni disponibili".to_string(),
                    detail: "Usare il browser locale per cercare tratte compatibili.".to_string(),
                    surface: "browser".to_string(),
                    action_kind: "research".to_string(),
                    requires_user_approval: false,
                    target_url: Some("https://www.trenitalia.com/".to_string()),
                },
                PromptPlanStep {
                    step_id: "compare_options".to_string(),
                    title: "Confrontare opzioni".to_string(),
                    detail: "Preparare una shortlist redatta con orari e vincoli.".to_string(),
                    surface: "browser".to_string(),
                    action_kind: "compare_options".to_string(),
                    requires_user_approval: false,
                    target_url: None,
                },
                PromptPlanStep {
                    step_id: "approval_before_payment".to_string(),
                    title: "Conferma prima del pagamento".to_string(),
                    detail: "Bloccare login, acquisto o pagamento senza conferma esplicita."
                        .to_string(),
                    surface: "logs".to_string(),
                    action_kind: "approval_gate".to_string(),
                    requires_user_approval: true,
                    target_url: None,
                },
            ],
        }
    }

    fn manager() -> LocalComputerSessionManager {
        let manager =
            LocalComputerSessionManager::new(LocalComputerSessionStore::open_in_memory().unwrap());
        manager
            .create_session(ComputerSessionCreate {
                session_id: "session_1".to_string(),
                task_id: "task_1".to_string(),
                workflow_id: None,
                user_id: "user_1".to_string(),
                workspace_id: "workspace_1".to_string(),
                title: "Computer locale".to_string(),
                subtitle: "Test".to_string(),
                risk_level: "low".to_string(),
                progress_total: 2,
            })
            .unwrap();
        manager
    }

    #[test]
    fn english_time_request_is_understood_by_brain_not_prompt_text_rules() {
        let manager = manager();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::LocalTime {
                reason: Some("The user asks for the current local time.".to_string()),
            },
        };
        let mut planner = inert_planner();

        let result = submit_user_prompt(
            &manager,
            &mut brain,
            &mut planner,
            "user_1",
            "workspace_1",
            "session_1",
            "what time is it?",
        )
        .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();

        assert!(result.assistant_message.text.contains("localmente"));
        assert!(!serialized.contains("what time is it?"));
        assert!(
            result
                .computer_session
                .timeline
                .iter()
                .any(|item| item.kind == "brain_understanding_completed")
        );
        assert!(
            result
                .computer_session
                .terminal_excerpt_redacted
                .iter()
                .any(|line| line.contains("prompt % date"))
        );
    }

    #[test]
    fn calculation_words_are_understood_from_brain_structured_output() {
        let manager = manager();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::LocalCalculation {
                calculation_left: 6,
                calculation_operator: "*".to_string(),
                calculation_right: 3,
                reason: Some("The user asks for arithmetic.".to_string()),
            },
        };
        let mut planner = inert_planner();

        let result = submit_user_prompt(
            &manager,
            &mut brain,
            &mut planner,
            "user_1",
            "workspace_1",
            "session_1",
            "what is six times three?",
        )
        .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();

        assert_eq!(result.assistant_message.text, "6 * 3 fa 18.");
        assert!(!serialized.contains("what is six times three?"));
        assert!(!serialized.contains("prompt_pending_brain"));
    }

    #[test]
    fn planning_request_creates_operational_plan_and_timeline_steps() {
        let manager = manager();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::NeedsPlanning {
                summary: "Prenotare un treno con conferma prima del pagamento".to_string(),
                reason: Some("Richiede browser e approval".to_string()),
            },
        };
        let mut planner = StaticPlanner { plan: train_plan() };

        let result = submit_user_prompt(
            &manager,
            &mut brain,
            &mut planner,
            "user_1",
            "workspace_1",
            "session_1",
            "prenota un treno",
        )
        .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();

        let plan = result.plan.unwrap();
        assert_eq!(plan.steps.len(), 3);
        assert_eq!(
            plan.steps[0].target_url.as_deref(),
            Some("https://www.trenitalia.com/")
        );
        assert!(plan.steps.iter().any(|step| step.requires_user_approval));
        assert!(
            result
                .computer_session
                .timeline
                .iter()
                .any(|item| item.kind == "operational_plan_created")
        );
        assert!(
            result
                .computer_session
                .timeline
                .iter()
                .any(|item| item.kind == "operational_plan_step_ready" && item.approval_required)
        );
        assert!(!serialized.contains("prompt_pending_brain"));
    }

    #[test]
    fn planner_target_url_rejects_query_parameters_to_avoid_raw_prompt_leakage() {
        let mut plan = train_plan();
        plan.steps[0].target_url =
            Some("https://www.google.com/search?q=prenota+un+treno".to_string());

        let error = validate_prompt_plan(&plan).unwrap_err();

        assert_eq!(error, "planner_plan_target_url_must_not_include_query");
    }
}
