use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::provider::ChatMessage;

const MAX_PLAN_ITEMS: usize = 6;

/// Iterations on a single step before forcing a checkpoint + potential rotation.
const MAX_ITERATIONS_PER_STEP: u32 = 8;

/// Interval between checkpoints (tool iterations since last checkpoint).
const CHECKPOINT_INTERVAL: u32 = 6;

/// Maximum strategy rotations per step before skipping it.
const MAX_STRATEGY_ROTATIONS: u8 = 2;

// ── Execution discipline ──────────────────────────────────────────

/// Action the agent loop must take after a tool result.
///
/// Returned by `ExecutionPlanState::note_iteration()`. The agent loop
/// reacts by compacting context, injecting prompts, or giving up.
#[derive(Debug, Clone)]
pub enum PlanAction {
    /// No action needed — continue normally.
    Continue,
    /// Force a checkpoint: compact context + inject progress summary.
    Checkpoint { summary: String },
    /// Force a strategy change: inject a "try different approach" prompt.
    StrategyRotation { prompt: String },
    /// All strategies exhausted — inject give-up report.
    GiveUp { report: String },
}

// ── Task checkpoint (persistence for crash recovery) ──────────────

/// Serializable checkpoint for persisting task state to DB.
///
/// Created at each execution checkpoint and on stop. Used to resume
/// interrupted tasks after crash/restart.
#[derive(Debug, Clone, Default)]
pub struct TaskCheckpoint {
    pub id: String,
    pub session_key: String,
    pub profile_id: Option<String>,
    pub channel: String,
    pub chat_id: String,
    pub user_prompt: String,
    /// Serialized ExecutionPlanSnapshot JSON.
    pub plan_json: String,
    /// File paths created by the agent during this task.
    pub files_created: Vec<String>,
    /// Completed step summaries (human-readable).
    pub completed_data: Vec<String>,
    /// "running" or "paused".
    pub status: String,
    /// Last iteration number.
    pub iteration: u32,
}

// ── Explicit plan types ────────────────────────────────────────────

/// Status of an explicit plan step.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
    /// Step was skipped after exhausting all strategy rotations.
    Skipped,
}

/// A single step in an explicit plan created by the LLM via `plan_task`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub description: String,
    pub status: StepStatus,
}

/// Serializable step for the web UI snapshot.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlanStepSnapshot {
    pub description: String,
    pub status: String, // "pending" | "in_progress" | "completed"
}

// ── Snapshot (streamed to web UI) ──────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExecutionPlanSnapshot {
    pub objective: String,
    pub constraints: Vec<String>,
    pub completed_steps: Vec<String>,
    pub active_blockers: Vec<String>,
    pub required_sources: Vec<String>,
    pub completed_sources: Vec<String>,
    pub current_source: Option<String>,
    /// Explicit plan steps — from cognition phase or LLM `plan_task` tool.
    /// Empty when using the default keyword-inferred mode (no cognition, no explicit plan).
    #[serde(default)]
    pub explicit_steps: Vec<PlanStepSnapshot>,
    /// Optional verification criterion supplied with the plan.
    #[serde(default)]
    pub verification: Option<String>,
    /// Intent classification from cognition (informational/transactional/navigational/creative).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_type: Option<String>,
    /// Orchestrator phase: "planning", "executing", "synthesizing".
    /// Empty when not using the task orchestrator.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub phase: String,
}

// ── Core state ─────────────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
pub struct ExecutionPlanState {
    objective: String,
    constraints: Vec<String>,
    completed_steps: Vec<String>,
    active_blockers: Vec<String>,
    seen_step_signatures: HashSet<String>,
    /// Explicit plan steps — seeded by the cognition phase (if active) or
    /// set by the LLM via the virtual `plan_task` tool at runtime.
    /// When non-empty, `runtime_message()` renders these instead of
    /// keyword-inferred constraints.
    explicit_steps: Vec<PlanStep>,
    /// Optional verification note for the final goal check.
    verification: Option<String>,
    /// Intent classification (informational/transactional/navigational/creative).
    intent_type: Option<String>,

    // ── Execution discipline (checkpoint/rotation/give-up) ────
    /// Tool iterations spent on the current step.
    iterations_on_step: u32,
    /// Total tool iterations tracked (for checkpoint interval).
    total_tool_iterations: u32,
    /// Strategy rotation count for the current step.
    strategy_rotations: u8,
    /// Iteration of the last checkpoint.
    last_checkpoint_iteration: u32,
    /// Failed approaches for the current step (for rotation prompt and report).
    failed_approaches: Vec<String>,
    /// Last status message (for progress streaming, dedup).
    last_status: Option<String>,
}

impl ExecutionPlanState {
    pub fn new(user_prompt: &str) -> Self {
        Self {
            objective: compact(user_prompt, 220),
            constraints: infer_constraints(user_prompt),
            completed_steps: Vec::new(),
            active_blockers: Vec::new(),
            seen_step_signatures: HashSet::new(),
            explicit_steps: Vec::new(),
            verification: None,
            intent_type: None,
            iterations_on_step: 0,
            total_tool_iterations: 0,
            strategy_rotations: 0,
            last_checkpoint_iteration: 0,
            failed_approaches: Vec::new(),
            last_status: None,
        }
    }

    pub fn note_tool_result(
        &mut self,
        tool_name: &str,
        arguments: &Value,
        output: &str,
        is_error: bool,
    ) {
        let signature = format!(
            "{}:{}",
            tool_name,
            serde_json::to_string(arguments).unwrap_or_else(|_| "{}".to_string())
        );

        if !is_error && self.seen_step_signatures.insert(signature) {
            let summary = summarize_step(tool_name, arguments, output);
            push_unique_limited(&mut self.completed_steps, summary, MAX_PLAN_ITEMS);
        }

        let blockers = infer_blockers(tool_name, output, is_error);
        if blockers.is_empty() {
            if !is_error {
                self.active_blockers.clear();
            }
        } else {
            self.active_blockers = blockers;
        }
    }

    // ── Explicit plan methods ──────────────────────────────────────

    /// Create an explicit plan. Called when the LLM invokes `plan_task`.
    /// Replaces any prior explicit plan. Marks step[0] as InProgress.
    pub fn set_explicit_plan(&mut self, steps: Vec<String>, verification: Option<String>) {
        self.explicit_steps = steps
            .into_iter()
            .enumerate()
            .map(|(i, desc)| PlanStep {
                description: desc,
                status: if i == 0 {
                    StepStatus::InProgress
                } else {
                    StepStatus::Pending
                },
            })
            .collect();
        self.verification = verification;
    }

    /// Mark a plan step as completed and auto-advance the next pending
    /// step to InProgress. Called when the LLM invokes `complete_step`.
    pub fn complete_step(&mut self, step_index: usize) -> Result<String, String> {
        if self.explicit_steps.is_empty() {
            return Err("No plan exists. Call plan_task first.".to_string());
        }
        if step_index >= self.explicit_steps.len() {
            return Err(format!(
                "Step index {} is out of range (plan has {} steps).",
                step_index,
                self.explicit_steps.len()
            ));
        }

        self.explicit_steps[step_index].status = StepStatus::Completed;

        // Auto-advance: find the next pending step and mark it InProgress.
        for step in &mut self.explicit_steps {
            if step.status == StepStatus::Pending {
                step.status = StepStatus::InProgress;
                break;
            }
        }

        let desc = &self.explicit_steps[step_index].description;
        Ok(format!("Step {} completed: {}", step_index, desc))
    }

    /// Auto-advance explicit plan steps based on tool execution.
    ///
    /// When a tool completes, checks if any pending/in-progress step mentions
    /// the tool name in its description. If found, marks it completed and
    /// auto-advances the next pending step to in-progress.
    pub fn auto_advance_explicit_steps(&mut self, tool_name: &str) {
        if self.explicit_steps.is_empty() {
            return;
        }
        let tool_lower = tool_name.to_lowercase();
        let mut advanced = false;
        for step in &mut self.explicit_steps {
            if step.status == StepStatus::Completed {
                continue;
            }
            if step.description.to_lowercase().contains(&tool_lower) {
                step.status = StepStatus::Completed;
                advanced = true;
                break;
            }
        }
        // Auto-advance: ensure one step is InProgress
        if advanced
            && !self
                .explicit_steps
                .iter()
                .any(|s| s.status == StepStatus::InProgress)
        {
            for step in &mut self.explicit_steps {
                if step.status == StepStatus::Pending {
                    step.status = StepStatus::InProgress;
                    break;
                }
            }
        }
    }

    /// Mark all explicit steps as completed (called when run finishes).
    pub fn mark_all_completed(&mut self) {
        for step in &mut self.explicit_steps {
            step.status = StepStatus::Completed;
        }
    }

    /// Whether all explicit steps are done.
    pub fn all_steps_completed(&self) -> bool {
        !self.explicit_steps.is_empty()
            && self
                .explicit_steps
                .iter()
                .all(|s| s.status == StepStatus::Completed)
    }

    /// Whether an explicit plan is active.
    pub fn has_explicit_plan(&self) -> bool {
        !self.explicit_steps.is_empty()
    }

    /// Set the intent classification for the current plan.
    pub fn set_intent_type(&mut self, intent: Option<String>) {
        self.intent_type = intent;
    }

    // ── Execution discipline (checkpoint / rotation / give-up) ──

    /// Record a tool iteration and decide what action the agent loop should take.
    ///
    /// Call this after every tool result (not just browser). Returns a
    /// `PlanAction` that the agent loop must follow:
    /// - `Continue` — no action needed
    /// - `Checkpoint` — compact context + inject progress summary
    /// - `StrategyRotation` — inject "try different approach" prompt
    /// - `GiveUp` — inject give-up report
    pub fn note_iteration(&mut self, tool_name: &str, output: &str) -> PlanAction {
        if self.explicit_steps.is_empty() {
            return PlanAction::Continue;
        }

        self.total_tool_iterations += 1;
        self.iterations_on_step += 1;

        // Try to auto-advance the current step based on tool output
        self.try_semantic_advance(tool_name, output);

        // Check if all steps are resolved (completed or skipped)
        if self.all_steps_resolved() {
            return if self.has_skipped_steps() {
                PlanAction::GiveUp {
                    report: self.build_give_up_report(),
                }
            } else {
                PlanAction::Continue // All completed — success
            };
        }

        // Check if stuck on current step too long → strategy rotation
        if self.iterations_on_step >= MAX_ITERATIONS_PER_STEP {
            return self.handle_step_stall(tool_name);
        }

        // Check if checkpoint interval reached
        if self.total_tool_iterations > 0
            && self.total_tool_iterations - self.last_checkpoint_iteration >= CHECKPOINT_INTERVAL
        {
            return PlanAction::Checkpoint {
                summary: self.build_checkpoint_summary(),
            };
        }

        PlanAction::Continue
    }

    /// Build a structured progress summary for context injection at checkpoints.
    fn build_checkpoint_summary(&mut self) -> String {
        self.last_checkpoint_iteration = self.total_tool_iterations;

        let mut lines = vec!["## Task Progress".to_string()];

        lines.push(format!("Objective: {}", self.objective));
        lines.push(String::new());

        for (i, step) in self.explicit_steps.iter().enumerate() {
            let marker = match step.status {
                StepStatus::Completed => "[done]",
                StepStatus::InProgress => "[current]",
                StepStatus::Pending => "[todo]",
                StepStatus::Skipped => "[skipped]",
            };
            let extra = if step.status == StepStatus::InProgress {
                format!(
                    " ({} iterations, {} strategy changes)",
                    self.iterations_on_step, self.strategy_rotations
                )
            } else {
                String::new()
            };
            lines.push(format!("  {marker} Step {i}: {}{extra}", step.description));
        }

        if !self.failed_approaches.is_empty() {
            lines.push(String::new());
            lines.push("Failed approaches on current step:".to_string());
            for attempt in &self.failed_approaches {
                lines.push(format!("  - {attempt}"));
            }
        }

        lines.join("\n")
    }

    /// Handle a step that has stalled (too many iterations).
    /// Returns StrategyRotation if rotations remain, or advances/skips the step.
    fn handle_step_stall(&mut self, _tool_name: &str) -> PlanAction {
        if self.strategy_rotations < MAX_STRATEGY_ROTATIONS {
            self.strategy_rotations += 1;

            // Record the failed approach
            let step_desc = self.current_step_description();
            self.failed_approaches.push(format!(
                "Attempt {}: {} iterations on '{}'",
                self.strategy_rotations, self.iterations_on_step, step_desc
            ));

            // Reset iteration counter for the new strategy
            self.iterations_on_step = 0;
            // Also reset checkpoint to avoid immediate re-trigger
            self.last_checkpoint_iteration = self.total_tool_iterations;

            let prompt = format!(
                "The current approach for step '{}' is not working after {} iterations.\n\
                 Previous attempts: {}\n\n\
                 You MUST try a DIFFERENT approach:\n\
                 - If a web search isn't finding results, try different search terms\n\
                 - If a website doesn't respond, try an alternative source\n\
                 - If a file write fails, verify the path and retry\n\
                 - If a command fails, try a different approach\n\
                 - If nothing works, explain to the user what you found and what blocked you",
                step_desc,
                MAX_ITERATIONS_PER_STEP,
                self.failed_approaches.join("; "),
            );

            PlanAction::StrategyRotation { prompt }
        } else {
            // All rotations exhausted → skip this step
            self.skip_current_step();

            if self.all_steps_resolved() {
                PlanAction::GiveUp {
                    report: self.build_give_up_report(),
                }
            } else {
                // More steps remain — checkpoint and continue
                PlanAction::Checkpoint {
                    summary: self.build_checkpoint_summary(),
                }
            }
        }
    }

    /// Build a report explaining what was accomplished and what failed.
    fn build_give_up_report(&self) -> String {
        let all_completed = self
            .explicit_steps
            .iter()
            .all(|s| s.status == StepStatus::Completed);
        if all_completed {
            return String::new();
        }

        let mut lines = vec![
            "I was unable to complete all the required steps. Here's what happened:".to_string(),
            String::new(),
        ];

        for step in &self.explicit_steps {
            let marker = match step.status {
                StepStatus::Completed => "[done]",
                StepStatus::Skipped => "[FAILED]",
                StepStatus::Pending => "[not attempted]",
                StepStatus::InProgress => "[incomplete]",
            };
            lines.push(format!("  {marker} {}", step.description));
        }

        if !self.failed_approaches.is_empty() {
            lines.push(String::new());
            lines.push("Approaches tried:".to_string());
            for attempt in &self.failed_approaches {
                lines.push(format!("  - {attempt}"));
            }
        }

        lines.push(String::new());
        lines.push(
            "Please inform the user about what you found and what blocked you.".to_string(),
        );

        lines.join("\n")
    }

    /// Generate a user-facing progress status for streaming.
    ///
    /// Returns `Some(status)` when the status changed since last call,
    /// `None` if unchanged (for dedup).
    pub fn progress_status(&mut self) -> Option<String> {
        if self.explicit_steps.is_empty() {
            return None;
        }

        let total = self.explicit_steps.len();
        let done = self
            .explicit_steps
            .iter()
            .filter(|s| s.status == StepStatus::Completed)
            .count();
        let current = self.current_step_description();

        let status = if done == total {
            format!("All {total} steps completed")
        } else {
            format!("Step {}/{total}: {current}", done + 1)
        };

        if self.last_status.as_deref() == Some(status.as_str()) {
            return None; // Dedup
        }
        self.last_status = Some(status.clone());
        Some(status)
    }

    /// Description of the current in-progress step.
    fn current_step_description(&self) -> String {
        self.explicit_steps
            .iter()
            .find(|s| s.status == StepStatus::InProgress)
            .map(|s| s.description.clone())
            .unwrap_or_else(|| compact(&self.objective, 120))
    }

    /// Whether all steps are resolved (completed or skipped).
    fn all_steps_resolved(&self) -> bool {
        !self.explicit_steps.is_empty()
            && self
                .explicit_steps
                .iter()
                .all(|s| s.status == StepStatus::Completed || s.status == StepStatus::Skipped)
    }

    /// Whether any step was skipped (partial failure).
    fn has_skipped_steps(&self) -> bool {
        self.explicit_steps.iter().any(|s| s.status == StepStatus::Skipped)
    }

    /// Skip the current in-progress step. Does NOT clear failed_approaches
    /// (preserved for the give-up report).
    fn skip_current_step(&mut self) {
        if let Some(step) = self
            .explicit_steps
            .iter_mut()
            .find(|s| s.status == StepStatus::InProgress)
        {
            tracing::warn!(
                step = %step.description,
                rotations = self.strategy_rotations,
                "Plan step skipped after exhausting strategy rotations"
            );
            step.status = StepStatus::Skipped;
        }

        // Auto-advance: find next pending step
        for step in &mut self.explicit_steps {
            if step.status == StepStatus::Pending {
                step.status = StepStatus::InProgress;
                break;
            }
        }

        // Reset per-step counters (keep failed_approaches for report)
        self.iterations_on_step = 0;
        self.strategy_rotations = 0;
    }

    /// Semantic auto-advance: check if a tool result indicates the current
    /// step is complete, based on keyword matching between step description
    /// and tool name/output.
    fn try_semantic_advance(&mut self, tool_name: &str, output: &str) {
        let current = match self
            .explicit_steps
            .iter()
            .position(|s| s.status == StepStatus::InProgress)
        {
            Some(idx) => idx,
            None => return,
        };

        let step_lower = self.explicit_steps[current].description.to_lowercase();
        let output_lower = output.to_ascii_lowercase();

        let should_advance = match tool_name {
            "browser" => {
                // Navigate completed → step about navigation
                if output_lower.contains("page url:")
                    && (step_lower.contains("naviga")
                        || step_lower.contains("vai")
                        || step_lower.contains("go to")
                        || step_lower.contains("open")
                        || step_lower.contains("apri"))
                {
                    true
                // Results visible → step about searching
                } else {
                    (step_lower.contains("cerca")
                        || step_lower.contains("search")
                        || step_lower.contains("find"))
                        && (output_lower.contains("results")
                            || output_lower.contains("risultat")
                            || output_lower.contains("product")
                            || output_lower.contains("listing"))
                }
            }
            "web_search" => {
                // Web search completed → step about searching/finding
                step_lower.contains("cerca")
                    || step_lower.contains("search")
                    || step_lower.contains("find")
                    || step_lower.contains("ricerca")
            }
            "web_fetch" => {
                // Web fetch completed → step about extracting/reading
                step_lower.contains("estrai")
                    || step_lower.contains("extract")
                    || step_lower.contains("leggi")
                    || step_lower.contains("read")
                    || step_lower.contains("scarica")
                    || step_lower.contains("download")
            }
            "write_file" => {
                // File written → step about saving/creating/generating
                !output_lower.contains("error")
                    && (step_lower.contains("salva")
                        || step_lower.contains("save")
                        || step_lower.contains("crea")
                        || step_lower.contains("create")
                        || step_lower.contains("genera")
                        || step_lower.contains("generate")
                        || step_lower.contains("csv")
                        || step_lower.contains("file"))
            }
            "shell" => {
                // Shell completed → step about executing/running
                !output_lower.contains("error")
                    && (step_lower.contains("esegui")
                        || step_lower.contains("execute")
                        || step_lower.contains("run")
                        || step_lower.contains("lancia")
                        || step_lower.contains("command"))
            }
            _ => false,
        };

        if should_advance {
            self.explicit_steps[current].status = StepStatus::Completed;
            // Auto-advance next pending step
            for step in &mut self.explicit_steps {
                if step.status == StepStatus::Pending {
                    step.status = StepStatus::InProgress;
                    break;
                }
            }
            // Reset per-step counters
            self.iterations_on_step = 0;
            self.strategy_rotations = 0;
            self.failed_approaches.clear();
        }
    }

    // ── Task persistence (checkpoint / resume) ──────────────────

    /// Build a TaskCheckpoint from current state for DB persistence.
    #[allow(clippy::too_many_arguments)]
    pub fn to_checkpoint(
        &self,
        id: &str,
        session_key: &str,
        profile_id: Option<&str>,
        channel: &str,
        chat_id: &str,
        user_prompt: &str,
        files_created: &[String],
        status: &str,
    ) -> TaskCheckpoint {
        let plan_json =
            serde_json::to_string(&self.snapshot()).unwrap_or_else(|_| "{}".to_string());

        TaskCheckpoint {
            id: id.to_string(),
            session_key: session_key.to_string(),
            profile_id: profile_id.map(|s| s.to_string()),
            channel: channel.to_string(),
            chat_id: chat_id.to_string(),
            user_prompt: user_prompt.to_string(),
            plan_json,
            files_created: files_created.to_vec(),
            completed_data: self.completed_steps.clone(),
            status: status.to_string(),
            iteration: self.total_tool_iterations,
        }
    }

    /// Build a resume prompt from a saved checkpoint.
    ///
    /// This prompt gives the LLM enough context to continue from where
    /// the task was interrupted, without needing the original conversation.
    pub fn build_resume_prompt(checkpoint: &TaskCheckpoint) -> String {
        let mut lines = vec![
            format!(
                "The user's original request was:\n\"{}\"",
                checkpoint.user_prompt
            ),
            String::new(),
        ];

        // Parse plan snapshot and show step status
        if let Ok(snap) =
            serde_json::from_str::<ExecutionPlanSnapshot>(&checkpoint.plan_json)
        {
            if !snap.explicit_steps.is_empty() {
                lines.push("Progress before interruption:".to_string());
                for step in &snap.explicit_steps {
                    let marker = match step.status.as_str() {
                        "completed" => "[done]",
                        "in_progress" => "[interrupted]",
                        "skipped" => "[skipped]",
                        _ => "[todo]",
                    };
                    lines.push(format!("  {marker} {}", step.description));
                }
                lines.push(String::new());
            }
        }

        if !checkpoint.files_created.is_empty() {
            lines.push("Files already created:".to_string());
            for file in &checkpoint.files_created {
                lines.push(format!("  - {file}"));
            }
            lines.push(String::new());
        }

        if !checkpoint.completed_data.is_empty() {
            lines.push("Work completed so far:".to_string());
            for data in &checkpoint.completed_data {
                lines.push(format!("  - {data}"));
            }
            lines.push(String::new());
        }

        lines.push(
            "IMPORTANT: Resume from where you left off. Do NOT redo completed steps.\n\
             Read any existing files to verify their content before continuing."
                .to_string(),
        );

        lines.join("\n")
    }

    // ── Runtime message (injected each iteration) ───────────────

    pub fn runtime_message(&self) -> Option<ChatMessage> {
        if self.objective.is_empty()
            && self.constraints.is_empty()
            && self.completed_steps.is_empty()
            && self.active_blockers.is_empty()
            && self.explicit_steps.is_empty()
        {
            return None;
        }

        let mut lines = Vec::new();
        if !self.objective.is_empty() {
            lines.push(format!("Execution objective: {}", self.objective));
        }

        // Intent-aware guidance injected each iteration
        if let Some(ref intent) = self.intent_type {
            match intent.as_str() {
                "informational" => lines.push(
                    "Intent: INFORMATIONAL — extract and present data to the user. Do not complete transactions.".to_string()
                ),
                "transactional" => lines.push(
                    "Intent: TRANSACTIONAL — complete the requested action. Proceed through forms/checkout.".to_string()
                ),
                _ => {}
            }
        }

        if !self.explicit_steps.is_empty() {
            // ── Explicit plan mode ──────────────────────────────
            lines.push("Execution plan:".to_string());
            for (i, step) in self.explicit_steps.iter().enumerate() {
                let tag = match step.status {
                    StepStatus::Completed => "[DONE]",
                    StepStatus::InProgress => "[CURRENT]",
                    StepStatus::Pending => "[TODO]",
                    StepStatus::Skipped => "[SKIPPED]",
                };
                lines.push(format!("  {} Step {}: {}", tag, i, step.description));
            }
            if let Some(ref v) = self.verification {
                lines.push(format!("Verification: {}", v));
            }
            if self.all_steps_completed() {
                let note = self
                    .verification
                    .as_deref()
                    .unwrap_or("Verify the results match the original request");
                lines.push(format!(
                    "All planned steps completed. {}. Review the results before giving your final response.",
                    note
                ));
            }
        } else {
            // ── Inferred mode (existing behavior) ──────────────
            if !self.constraints.is_empty() {
                lines.push("Constraints to satisfy before finishing:".to_string());
                for item in &self.constraints {
                    lines.push(format!("- {}", item));
                }
            }
        }

        // Completed tool results and blockers always apply.
        if !self.completed_steps.is_empty() {
            lines.push("Completed so far:".to_string());
            for item in &self.completed_steps {
                lines.push(format!("- {}", item));
            }
        }
        if !self.active_blockers.is_empty() {
            lines.push("Active blockers to resolve next:".to_string());
            for item in &self.active_blockers {
                lines.push(format!("- {}", item));
            }
        }
        lines.push(
            "Plan rule: continue from the remaining blockers/constraints instead of restarting; only finalize once the requested outcome is actually achieved or clearly impossible."
                .to_string(),
        );

        Some(ChatMessage::user(&lines.join("\n")))
    }

    // ── Snapshot (for web UI streaming) ─────────────────────────

    pub fn snapshot(&self) -> ExecutionPlanSnapshot {
        ExecutionPlanSnapshot {
            objective: self.objective.clone(),
            constraints: self.constraints.clone(),
            completed_steps: self.completed_steps.clone(),
            active_blockers: self.active_blockers.clone(),
            required_sources: Vec::new(),
            completed_sources: Vec::new(),
            current_source: None,
            explicit_steps: self
                .explicit_steps
                .iter()
                .map(|s| PlanStepSnapshot {
                    description: s.description.clone(),
                    status: match s.status {
                        StepStatus::Pending => "pending".to_string(),
                        StepStatus::InProgress => "in_progress".to_string(),
                        StepStatus::Completed => "completed".to_string(),
                        StepStatus::Skipped => "skipped".to_string(),
                    },
                })
                .collect(),
            verification: self.verification.clone(),
            intent_type: self.intent_type.clone(),
            phase: String::new(),
        }
    }
}

fn infer_constraints(user_prompt: &str) -> Vec<String> {
    let text = user_prompt.to_ascii_lowercase();
    let mut constraints = Vec::new();
    let requested_sources = infer_named_sources(&text);

    if contains_any(
        &text,
        &[
            "compare",
            "confronta",
            "versus",
            " vs ",
            "both ",
            "entrambi",
            "sia ",
            "che ",
        ],
    ) {
        constraints.push(
            "Cover every requested option/source and compare them before finalizing.".to_string(),
        );
    }

    if contains_any(
        &text,
        &[
            "today",
            "oggi",
            "tomorrow",
            "domani",
            "latest",
            "current",
            "adesso",
            "stasera",
            "tonight",
            "this week",
            "questa settimana",
        ],
    ) {
        constraints.push(
            "Treat date/time-sensitive details as current and verify them from fresh evidence."
                .to_string(),
        );
    }

    if contains_any(
        &text,
        &[
            "after ",
            "before ",
            "dopo ",
            "prima delle",
            "entro ",
            "under ",
            "below ",
            "meno di",
            "fino a",
            "at least",
            "almeno",
            "between ",
            "tra ",
        ],
    ) || text.contains(':')
        || text.chars().any(|ch| ch.is_ascii_digit())
    {
        constraints.push(
            "Respect explicit numeric, date, price, time, and threshold constraints from the request."
                .to_string(),
        );
    }

    if contains_any(
        &text,
        &[
            "book",
            "booking",
            "reserve",
            "reservation",
            "ticket",
            "biglietto",
            "prenota",
            "checkout",
            "order",
            "buy",
            "purchase",
            "search form",
            "form",
        ],
    ) {
        constraints.push(
            "For multi-step forms, confirm each required field/widget before submitting."
                .to_string(),
        );
    }

    if contains_any(
        &text,
        &[
            "and ", " e ", " then ", " poi ", " also ", " anche ", "oltre ", "plus ",
        ],
    ) {
        constraints
            .push("Complete all distinct sub-requests in the prompt before stopping.".to_string());
    }

    if !requested_sources.is_empty() {
        constraints.push(format!(
            "Required sources to cover: {}.",
            requested_sources.join(", ")
        ));
    }

    constraints.truncate(MAX_PLAN_ITEMS);
    constraints
}

fn infer_blockers(tool_name: &str, output: &str, is_error: bool) -> Vec<String> {
    let lower = output.to_ascii_lowercase();
    let mut blockers = Vec::new();

    if lower.contains("blocked click on element [") && lower.contains("form still looks incomplete")
    {
        blockers.push(
            "The form still appears incomplete; resolve missing/unfinished widgets before trying to submit again."
                .to_string(),
        );
    }
    if lower.contains("visible suggestions:") || lower.contains("autocomplete") {
        blockers.push(
            "A typed field still needs an explicit autocomplete/combobox selection.".to_string(),
        );
    }
    if lower.contains("date picker appears to be open") {
        blockers.push("A date picker is open and still needs an explicit selection.".to_string());
    }
    if lower.contains("time options appear to be open") {
        blockers.push("Time options are open and still need an explicit selection.".to_string());
    }
    if lower.contains("tool vetoed:") {
        blockers.push(compact(output, 220));
    }
    if lower.contains("this appears to be an error page") {
        blockers.push(
            "Navigation hit an error page. Try the site's homepage or an alternative URL."
                .to_string(),
        );
    }
    if is_error && blockers.is_empty() {
        if lower.contains("missing required parameter") || lower.contains("missing parameter") {
            blockers.push(format!(
                "Latest {} call failed due to a missing parameter. Read the error message, add the missing parameter, and retry the SAME tool call immediately.",
                tool_name
            ));
        } else {
            blockers.push(format!(
                "Latest {} step failed; inspect the last tool result and adjust the next action instead of repeating blindly.",
                tool_name
            ));
        }
    }

    blockers.truncate(MAX_PLAN_ITEMS);
    blockers
}

fn summarize_step(tool_name: &str, arguments: &Value, output: &str) -> String {
    match tool_name {
        "web_search" => format!(
            "Searched the web for {}.",
            arguments
                .get("query")
                .and_then(|v| v.as_str())
                .map(|v| compact(v, 80))
                .unwrap_or_else(|| "the request".to_string())
        ),
        "web_fetch" => format!(
            "Read {}.",
            arguments
                .get("url")
                .and_then(|v| v.as_str())
                .map(|v| compact(v, 96))
                .unwrap_or_else(|| "a source".to_string())
        ),
        "shell" => "Ran a shell step.".to_string(),
        _ if crate::browser::is_browser_tool(tool_name) => {
            let action = arguments
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("action");
            if let Some(source) = infer_source_from_browser_output(output) {
                if output.contains("Extracted results:") {
                    format!("Extracted browser results from {}.", source)
                } else {
                    format!(
                        "Browser step completed on {}: {}.",
                        source,
                        compact(action, 40)
                    )
                }
            } else {
                format!("Browser step completed: {}.", compact(action, 40))
            }
        }
        _ => {
            let summary = compact(output, 96);
            if summary.is_empty() {
                format!("Completed {}.", tool_name)
            } else {
                format!("{}: {}", tool_name, summary)
            }
        }
    }
}

fn push_unique_limited(items: &mut Vec<String>, item: String, limit: usize) {
    if item.trim().is_empty() || items.iter().any(|existing| existing == &item) {
        return;
    }
    items.push(item);
    if items.len() > limit {
        let overflow = items.len() - limit;
        items.drain(0..overflow);
    }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn compact(value: &str, max_len: usize) -> String {
    let joined = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.len() <= max_len {
        return joined;
    }
    let mut chars = joined.chars();
    let truncated: String = chars.by_ref().take(max_len.saturating_sub(1)).collect();
    if truncated.is_empty() {
        String::new()
    } else {
        format!("{}…", truncated)
    }
}

fn infer_named_sources(text: &str) -> Vec<String> {
    let mut sources = Vec::new();

    // Tier 1: well-known sites (exact match)
    for (source, needles) in [
        ("trenitalia", &["trenitalia"][..]),
        ("italo", &["italo", "italotreno"][..]),
        ("amazon", &["amazon"][..]),
        ("ebay", &["ebay"][..]),
        ("booking", &["booking"][..]),
        ("trainline", &["trainline"][..]),
        ("omio", &["omio"][..]),
    ] {
        if needles.iter().any(|needle| text.contains(needle)) && !sources.contains(&source) {
            sources.push(source);
        }
    }

    let mut result: Vec<String> = sources.into_iter().map(|s| s.to_string()).collect();

    // Tier 2: generic brand detection from "X o Y" / "X or Y" patterns
    if result.is_empty() {
        for s in extract_brand_pair(text) {
            if !result.contains(&s) {
                result.push(s);
            }
        }
    }

    result
}

/// Extract brand pair from "X o Y" / "X or Y" / "X e Y" patterns.
///
/// Skips filler words (articles, prepositions) to handle "di Prada o di Gucci".
fn extract_brand_pair(lower: &str) -> Vec<String> {
    let connectors = [" o ", " or ", " e ", " and "];
    let filler: &[&str] = &[
        "di", "da", "le", "il", "la", "lo", "un", "una", "del", "al", "per", "con", "su", "the",
        "a", "an", "in", "on", "for", "to", "from", "my", "me", "this", "that", "più", "piu",
        "meno", "anche", "poi", "tipo", "come", "quale",
    ];
    let is_brand = |word: &str| -> bool {
        word.len() >= 3
            && word.chars().all(|c| c.is_alphanumeric() || c == '-')
            && !filler.contains(&word)
    };

    let words: Vec<&str> = lower.split_whitespace().collect();
    let mut brands = Vec::new();

    for conn in &connectors {
        let conn_word = conn.trim();
        for (i, &w) in words.iter().enumerate() {
            if w != conn_word {
                continue;
            }
            let before = (0..i).rev().map(|j| words[j]).find(|w| is_brand(w));
            let after = ((i + 1)..words.len())
                .map(|j| words[j])
                .take(3)
                .find(|w| is_brand(w));
            if let (Some(b), Some(a)) = (before, after) {
                if !brands.contains(&b.to_string()) {
                    brands.push(b.to_string());
                }
                if !brands.contains(&a.to_string()) {
                    brands.push(a.to_string());
                }
            }
        }
    }
    brands
}

fn infer_source_from_browser_output(output: &str) -> Option<String> {
    let url = output
        .lines()
        .find_map(|line| line.trim().strip_prefix("Page URL: "))?;
    let host = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.")
        .split('/')
        .next()?;
    let source = host
        .split('.')
        .find(|part| !matches!(*part, "com" | "it" | "org" | "net" | "co"))?;
    if source.is_empty() {
        None
    } else {
        Some(source.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{ExecutionPlanState, StepStatus};

    // ── Existing tests ─────────────────────────────────────────

    #[test]
    fn infers_generic_constraints_from_prompt() {
        let state = ExecutionPlanState::new(
            "find me a train tomorrow after 16:00 and compare both Trenitalia and Italo",
        );
        let message = state.runtime_message().expect("plan message");
        let content = message.content.expect("content");
        assert!(content.contains("compare them before finalizing"));
        assert!(content.contains("date/time-sensitive"));
        assert!(content.contains("Respect explicit numeric"));
        assert!(content.contains("Required sources to cover: trenitalia, italo"));
    }

    #[test]
    fn records_blockers_from_browser_form_hints() {
        let mut state = ExecutionPlanState::new("book a train ticket");
        state.note_tool_result(
            "playwright__browser_type",
            &serde_json::json!({"ref":"e1","text":"napoli"}),
            "Visible suggestions: Napoli Centrale | Napoli Afragola. This field likely requires selecting an explicit suggestion before continuing.",
            false,
        );
        let content = state
            .runtime_message()
            .and_then(|msg| msg.content)
            .expect("content");
        assert!(content.contains("autocomplete/combobox selection"));
    }

    // ── Explicit plan tests ────────────────────────────────────

    #[test]
    fn explicit_plan_creation_marks_first_step_in_progress() {
        let mut state = ExecutionPlanState::new("build a website");
        state.set_explicit_plan(
            vec!["Design mockup".into(), "Write HTML".into(), "Deploy".into()],
            Some("Check site is live".into()),
        );

        assert!(state.has_explicit_plan());
        assert_eq!(state.explicit_steps[0].status, StepStatus::InProgress);
        assert_eq!(state.explicit_steps[1].status, StepStatus::Pending);
        assert_eq!(state.explicit_steps[2].status, StepStatus::Pending);
        assert!(!state.all_steps_completed());
    }

    #[test]
    fn complete_step_advances_to_next() {
        let mut state = ExecutionPlanState::new("multi-step task");
        state.set_explicit_plan(
            vec!["Step A".into(), "Step B".into(), "Step C".into()],
            None,
        );

        // Complete step 0 → step 1 becomes InProgress
        let msg = state.complete_step(0).unwrap();
        assert!(msg.contains("Step A"));
        assert_eq!(state.explicit_steps[0].status, StepStatus::Completed);
        assert_eq!(state.explicit_steps[1].status, StepStatus::InProgress);
        assert_eq!(state.explicit_steps[2].status, StepStatus::Pending);

        // Complete step 1 → step 2 becomes InProgress
        state.complete_step(1).unwrap();
        assert_eq!(state.explicit_steps[2].status, StepStatus::InProgress);

        // Complete step 2 → all done
        state.complete_step(2).unwrap();
        assert!(state.all_steps_completed());
    }

    #[test]
    fn complete_step_out_of_range_returns_error() {
        let mut state = ExecutionPlanState::new("test");
        state.set_explicit_plan(vec!["Only step".into()], None);
        assert!(state.complete_step(5).is_err());
    }

    #[test]
    fn complete_step_without_plan_returns_error() {
        let mut state = ExecutionPlanState::new("test");
        assert!(state.complete_step(0).is_err());
    }

    #[test]
    fn runtime_message_renders_explicit_plan_not_constraints() {
        let mut state = ExecutionPlanState::new("do X and Y");
        // Would normally infer "Complete all sub-requests" constraint
        state.set_explicit_plan(vec!["Do X".into(), "Do Y".into()], Some("Both done".into()));
        let content = state
            .runtime_message()
            .and_then(|msg| msg.content)
            .expect("content");

        // Should use explicit plan format
        assert!(content.contains("[CURRENT] Step 0: Do X"));
        assert!(content.contains("[TODO] Step 1: Do Y"));
        assert!(content.contains("Verification: Both done"));

        // Should NOT show inferred constraints
        assert!(!content.contains("Constraints to satisfy"));
    }

    #[test]
    fn runtime_message_nudges_verification_when_all_completed() {
        let mut state = ExecutionPlanState::new("quick task");
        state.set_explicit_plan(vec!["Do it".into()], Some("Confirm done".into()));
        state.complete_step(0).unwrap();

        let content = state
            .runtime_message()
            .and_then(|msg| msg.content)
            .expect("content");
        assert!(content.contains("All planned steps completed"));
        assert!(content.contains("Confirm done"));
    }

    #[test]
    fn snapshot_includes_explicit_steps() {
        let mut state = ExecutionPlanState::new("test");
        state.set_explicit_plan(vec!["A".into(), "B".into()], None);
        let snap = state.snapshot();
        assert_eq!(snap.explicit_steps.len(), 2);
        assert_eq!(snap.explicit_steps[0].status, "in_progress");
        assert_eq!(snap.explicit_steps[1].status, "pending");
    }

    #[test]
    fn backward_compat_no_explicit_plan_uses_constraints() {
        let state = ExecutionPlanState::new("compare Trenitalia and Italo");
        let content = state
            .runtime_message()
            .and_then(|msg| msg.content)
            .expect("content");
        assert!(content.contains("Constraints to satisfy"));

        let snap = state.snapshot();
        assert!(snap.explicit_steps.is_empty());
        assert!(snap.verification.is_none());
    }

    #[test]
    fn infer_brand_sources_from_prompt() {
        let state =
            ExecutionPlanState::new("mi trovi delle scarpe di pelle marrone di prada o di gucci");
        let content = state
            .runtime_message()
            .and_then(|msg| msg.content)
            .expect("content");
        assert!(content.contains("prada"));
        assert!(content.contains("gucci"));
    }

    #[test]
    fn error_page_creates_blocker() {
        use super::infer_blockers;
        let blockers = infer_blockers(
            "browser",
            "⚠ This appears to be an error page (404).\nTry the homepage.",
            false,
        );
        assert!(blockers.iter().any(|b| b.contains("error page")));
    }

    // ── Execution discipline tests ────────────────────────────

    #[test]
    fn note_iteration_returns_continue_without_plan() {
        let mut state = ExecutionPlanState::new("simple question");
        let action = state.note_iteration("web_search", "results");
        assert!(matches!(action, super::PlanAction::Continue));
    }

    #[test]
    fn checkpoint_triggers_after_interval() {
        let mut state = ExecutionPlanState::new("task");
        state.set_explicit_plan(vec!["Do something complex".into()], None);

        for i in 0..5 {
            let action = state.note_iteration("web_search", &format!("result {i}"));
            assert!(
                matches!(action, super::PlanAction::Continue),
                "Iteration {i} should be Continue"
            );
        }
        // 6th iteration triggers checkpoint (CHECKPOINT_INTERVAL = 6)
        let action = state.note_iteration("web_search", "result 5");
        assert!(
            matches!(action, super::PlanAction::Checkpoint { .. }),
            "6th iteration should trigger checkpoint"
        );
    }

    #[test]
    fn strategy_rotation_after_stall() {
        let mut state = ExecutionPlanState::new("task");
        state.set_explicit_plan(vec!["Click the filter".into()], None);

        for i in 0..super::MAX_ITERATIONS_PER_STEP {
            state.note_iteration("browser", &format!("click result {i}"));
        }
        // Next iteration should trigger rotation (iterations_on_step >= MAX)
        // But we already triggered it at iteration 8 inside the loop above
        // Let's check the state after the loop
        assert_eq!(state.strategy_rotations, 1);
        assert_eq!(state.failed_approaches.len(), 1);
    }

    #[test]
    fn give_up_after_max_rotations() {
        let mut state = ExecutionPlanState::new("task");
        state.set_explicit_plan(vec!["Click the filter".into()], None);

        // Exhaust all rotations
        for rotation in 0..=super::MAX_STRATEGY_ROTATIONS {
            for _ in 0..super::MAX_ITERATIONS_PER_STEP {
                let action = state.note_iteration("browser", "same result");
                if matches!(action, super::PlanAction::GiveUp { .. }) {
                    // Verify we got here
                    assert_eq!(rotation, super::MAX_STRATEGY_ROTATIONS);
                    return;
                }
            }
        }

        // Should have triggered GiveUp by now
        panic!("Should have given up after exhausting rotations");
    }

    #[test]
    fn semantic_advance_web_search() {
        let mut state = ExecutionPlanState::new("task");
        state.set_explicit_plan(
            vec![
                "Cerca negozi Diesel".into(),
                "Estrai i dettagli".into(),
            ],
            None,
        );

        // web_search should advance "Cerca" step
        state.note_iteration("web_search", "Results for Diesel stores");
        assert_eq!(state.explicit_steps[0].status, StepStatus::Completed);
        assert_eq!(state.explicit_steps[1].status, StepStatus::InProgress);
    }

    #[test]
    fn semantic_advance_write_file() {
        let mut state = ExecutionPlanState::new("task");
        state.set_explicit_plan(
            vec![
                "Raccogli dati".into(),
                "Salva il file CSV".into(),
            ],
            None,
        );

        // Skip to step 1
        state.explicit_steps[0].status = StepStatus::Completed;
        state.explicit_steps[1].status = StepStatus::InProgress;

        // write_file should advance "Salva" step
        state.note_iteration("write_file", "Wrote 1234 bytes to file.csv");
        assert_eq!(state.explicit_steps[1].status, StepStatus::Completed);
    }

    #[test]
    fn progress_status_updates_on_change() {
        let mut state = ExecutionPlanState::new("task");
        state.set_explicit_plan(
            vec!["Step A".into(), "Step B".into()],
            None,
        );

        let s1 = state.progress_status();
        assert!(s1.is_some());
        assert!(s1.as_ref().unwrap().contains("Step 1/2"));

        // Same status → dedup
        let s2 = state.progress_status();
        assert!(s2.is_none(), "Same status should be deduped");

        // Advance step → new status
        state.explicit_steps[0].status = StepStatus::Completed;
        state.explicit_steps[1].status = StepStatus::InProgress;
        state.last_status = None; // Reset for test
        let s3 = state.progress_status();
        assert!(s3.is_some());
        assert!(s3.as_ref().unwrap().contains("Step 2/2"));
    }

    #[test]
    fn checkpoint_summary_has_structure() {
        let mut state = ExecutionPlanState::new("Find Diesel stores");
        state.set_explicit_plan(
            vec!["Search web".into(), "Extract data".into()],
            None,
        );

        state.note_iteration("web_search", "found results");
        // Step 0 advances, now on step 1
        let summary = state.build_checkpoint_summary();
        assert!(summary.contains("Task Progress"));
        assert!(summary.contains("Find Diesel stores"));
    }

    #[test]
    fn give_up_report_includes_attempts() {
        let mut state = ExecutionPlanState::new("task");
        state.set_explicit_plan(vec!["Difficult step".into()], None);

        // Exhaust everything
        for _ in 0..(super::MAX_ITERATIONS_PER_STEP * (super::MAX_STRATEGY_ROTATIONS as u32 + 1))
        {
            let action = state.note_iteration("browser", "same result");
            if let super::PlanAction::GiveUp { report } = action {
                assert!(report.contains("[FAILED]"), "Report should show failed step");
                assert!(report.contains("Attempt"), "Report should include attempts");
                return;
            }
        }
        panic!("Should have given up");
    }

    #[test]
    fn skipped_status_in_snapshot() {
        let mut state = ExecutionPlanState::new("task");
        state.set_explicit_plan(vec!["A".into(), "B".into()], None);
        state.explicit_steps[0].status = StepStatus::Skipped;
        let snap = state.snapshot();
        assert_eq!(snap.explicit_steps[0].status, "skipped");
    }
}
