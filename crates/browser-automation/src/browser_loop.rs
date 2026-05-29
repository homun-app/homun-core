use crate::{
    BrowserAutomationClient, BrowserAutomationError, BrowserMethod, BrowserResponse, BrowserResult,
    BrowserSidecarError, BrowserTransport,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

const MAX_NO_PROGRESS_ITERATIONS: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserLoopRequest {
    pub goal: String,
    pub target_id: String,
    pub initial_url: Option<String>,
    pub max_iterations: u32,
    /// Ordered checklist of concrete sub-goals for this task, e.g.
    /// `["Set departure = Napoli Centrale", "Pick the matching suggestion", ...]`.
    /// The loop renders this verbatim in the planner prompt; it stays agnostic
    /// about who produced it (gateway heuristic today, model-generated later).
    pub plan: Vec<String>,
}

impl BrowserLoopRequest {
    pub fn new(goal: impl Into<String>, target_id: impl Into<String>) -> Self {
        Self {
            goal: goal.into(),
            target_id: target_id.into(),
            initial_url: None,
            max_iterations: 12,
            plan: Vec::new(),
        }
    }

    pub fn with_initial_url(mut self, url: impl Into<String>) -> Self {
        self.initial_url = Some(url.into());
        self
    }

    pub fn with_plan(mut self, plan: Vec<String>) -> Self {
        self.plan = plan;
        self
    }

    pub fn with_max_iterations(mut self, max_iterations: u32) -> Self {
        self.max_iterations = max_iterations.max(1);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserObservation {
    pub target_id: String,
    pub url: String,
    pub snapshot: String,
    pub snapshot_hash: String,
    pub refs_mode: String,
    pub snapshot_format: String,
    pub refs_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserLoopIteration {
    pub iteration: u32,
    pub url_before: String,
    pub snapshot_hash_before: String,
    pub action: Value,
    pub expected_observation: Option<String>,
    pub url_after: String,
    pub snapshot_hash_after: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserLoopOutput {
    pub completed: bool,
    pub output: Value,
    pub final_observation: BrowserObservation,
    pub iterations: Vec<BrowserLoopIteration>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum BrowserLoopDecision {
    Act {
        action: Value,
        expected_observation: Option<String>,
    },
    Complete {
        output: Value,
    },
    Blocked {
        reason: String,
    },
}

pub trait BrowserLoopPlanner {
    fn decide_next(
        &mut self,
        request: &BrowserLoopRequest,
        observation: &BrowserObservation,
        iterations: &[BrowserLoopIteration],
    ) -> BrowserResult<BrowserLoopDecision>;
}

pub struct BrowserLoopRunner<T, P> {
    client: BrowserAutomationClient<T>,
    planner: P,
}

impl<T: BrowserTransport, P: BrowserLoopPlanner> BrowserLoopRunner<T, P> {
    pub fn new(transport: T, planner: P) -> Self {
        Self {
            client: BrowserAutomationClient::new(transport),
            planner,
        }
    }

    pub fn from_client(client: BrowserAutomationClient<T>, planner: P) -> Self {
        Self { client, planner }
    }

    pub fn into_client(self) -> BrowserAutomationClient<T> {
        self.client
    }

    pub fn run(&mut self, request: &BrowserLoopRequest) -> BrowserResult<BrowserLoopOutput> {
        self.run_with_iteration_observer(request, |_| Ok(()))
    }

    pub fn run_with_iteration_observer<F>(
        &mut self,
        request: &BrowserLoopRequest,
        mut on_iteration: F,
    ) -> BrowserResult<BrowserLoopOutput>
    where
        F: FnMut(&BrowserLoopIteration) -> BrowserResult<()>,
    {
        if let Some(url) = request.initial_url.as_ref() {
            self.client.call(
                BrowserMethod::Open,
                serde_json::json!({
                    "url": url,
                    "label": request.target_id,
                }),
            )?;
        }

        let mut observation = self.snapshot(&request.target_id)?;
        let mut iterations = Vec::new();
        let mut no_progress_iterations = 0u32;

        for iteration in 1..=request.max_iterations {
            let decision = match self.planner.decide_next(request, &observation, &iterations) {
                Ok(decision) => decision,
                Err(error) if recoverable_planner_validation_error(&error) => {
                    let next_observation = self.snapshot(&request.target_id)?;
                    let iteration_record = BrowserLoopIteration {
                        iteration,
                        url_before: observation.url.clone(),
                        snapshot_hash_before: observation.snapshot_hash.clone(),
                        action: serde_json::json!({
                            "kind": "planner_validation_error",
                            "error": error.to_string(),
                        }),
                        expected_observation: Some(
                            "planner must retry using only refs from the current snapshot"
                                .to_string(),
                        ),
                        url_after: next_observation.url.clone(),
                        snapshot_hash_after: next_observation.snapshot_hash.clone(),
                        status: "stale_ref_rejected".to_string(),
                    };
                    on_iteration(&iteration_record)?;
                    iterations.push(iteration_record);
                    observation = next_observation;
                    continue;
                }
                Err(error) => return Err(error),
            };

            match decision {
                BrowserLoopDecision::Complete { output } => {
                    return Ok(BrowserLoopOutput {
                        completed: true,
                        output,
                        final_observation: observation,
                        iterations,
                    });
                }
                BrowserLoopDecision::Blocked { reason } => {
                    return Ok(BrowserLoopOutput {
                        completed: false,
                        output: serde_json::json!({ "blocked_reason": reason }),
                        final_observation: observation,
                        iterations,
                    });
                }
                BrowserLoopDecision::Act {
                    action,
                    expected_observation,
                } => {
                    let url_before = observation.url.clone();
                    let snapshot_hash_before = observation.snapshot_hash.clone();
                    let action = normalized_action(action, &request.target_id)?;
                    let result = match self
                        .client
                        .call_response(BrowserMethod::Act, action.clone())?
                    {
                        BrowserResponse::Success {
                            ok: true, result, ..
                        } => result,
                        BrowserResponse::Error { error, .. }
                            if error.code == "BROWSER_STALE_REF" =>
                        {
                            let next_observation = self.snapshot(&request.target_id)?;
                            let iteration_record = BrowserLoopIteration {
                                iteration,
                                url_before,
                                snapshot_hash_before,
                                action,
                                expected_observation,
                                url_after: next_observation.url.clone(),
                                snapshot_hash_after: next_observation.snapshot_hash.clone(),
                                status: "stale_ref_recovered".to_string(),
                            };
                            on_iteration(&iteration_record)?;
                            iterations.push(iteration_record);
                            observation = next_observation;
                            continue;
                        }
                        BrowserResponse::Error { error, .. }
                            if recoverable_sidecar_action_error(&error) =>
                        {
                            let next_observation = self.snapshot(&request.target_id)?;
                            let made_progress = next_observation.url != url_before
                                || next_observation.snapshot_hash != snapshot_hash_before;
                            if made_progress {
                                no_progress_iterations = 0;
                            } else {
                                no_progress_iterations += 1;
                            }
                            let iteration_record = BrowserLoopIteration {
                                iteration,
                                url_before,
                                snapshot_hash_before,
                                action: serde_json::json!({
                                    "kind": "action_error",
                                    "error_code": error.code,
                                    "error": error.message,
                                    "failed_action": action,
                                }),
                                expected_observation,
                                url_after: next_observation.url.clone(),
                                snapshot_hash_after: next_observation.snapshot_hash.clone(),
                                status: "action_error_recovered".to_string(),
                            };
                            on_iteration(&iteration_record)?;
                            iterations.push(iteration_record);
                            observation = next_observation;
                            if no_progress_iterations >= MAX_NO_PROGRESS_ITERATIONS {
                                return Ok(BrowserLoopOutput {
                                    completed: false,
                                    output: serde_json::json!({
                                        "blocked_reason": "browser loop made no observable progress after repeated retryable action errors",
                                    }),
                                    final_observation: observation,
                                    iterations,
                                });
                            }
                            continue;
                        }
                        BrowserResponse::Error { error, .. } => {
                            return Err(BrowserAutomationError::Sidecar(format!(
                                "{}:{}",
                                error.code, error.message
                            )));
                        }
                        BrowserResponse::Success { .. } => {
                            return Err(BrowserAutomationError::InvalidResponse(
                                "browser act response has ok=false".to_string(),
                            ));
                        }
                    };
                    let next_observation =
                        if result.get("snapshot").and_then(Value::as_str).is_some() {
                            observation_from_value(result, &request.target_id)?
                        } else {
                            self.snapshot(&request.target_id)?
                        };
                    let made_progress = next_observation.url != url_before
                        || next_observation.snapshot_hash != snapshot_hash_before;
                    let status = if made_progress {
                        no_progress_iterations = 0;
                        "observed"
                    } else {
                        no_progress_iterations += 1;
                        "no_progress"
                    };

                    let iteration_record = BrowserLoopIteration {
                        iteration,
                        url_before,
                        snapshot_hash_before,
                        action,
                        expected_observation,
                        url_after: next_observation.url.clone(),
                        snapshot_hash_after: next_observation.snapshot_hash.clone(),
                        status: status.to_string(),
                    };
                    on_iteration(&iteration_record)?;
                    iterations.push(iteration_record);
                    observation = next_observation;
                    if no_progress_iterations >= MAX_NO_PROGRESS_ITERATIONS {
                        return Ok(BrowserLoopOutput {
                            completed: false,
                            output: serde_json::json!({
                                "blocked_reason": "browser loop made no observable progress after repeated actions",
                            }),
                            final_observation: observation,
                            iterations,
                        });
                    }
                }
            }
        }

        Ok(BrowserLoopOutput {
            completed: false,
            output: serde_json::json!({
                "blocked_reason": "max browser loop iterations reached",
            }),
            final_observation: observation,
            iterations,
        })
    }

    fn snapshot(&self, target_id: &str) -> BrowserResult<BrowserObservation> {
        let value = self.client.call(
            BrowserMethod::Snapshot,
            serde_json::json!({
                "target_id": target_id,
                "snapshot_format": "ai",
                "refs_mode": "aria",
                "mode": "efficient",
                "interactive": true,
                "compact": true,
                "depth": 10,
                "max_chars": 12_000,
                "urls": true,
            }),
        )?;
        observation_from_value(value, target_id)
    }
}

fn recoverable_sidecar_action_error(error: &BrowserSidecarError) -> bool {
    error.retryable
        && !error.manual_action_required
        && matches!(
            error.code.as_str(),
            "BROWSER_FORM_FILL_FAILED"
                | "BROWSER_ACTION_FAILED"
                | "BROWSER_ACTION_TIMEOUT"
                | "BROWSER_DIALOG_BLOCKED"
        )
}

fn recoverable_planner_validation_error(error: &BrowserAutomationError) -> bool {
    match error {
        BrowserAutomationError::InvalidResponse(message) => {
            message.contains("ref not present in current snapshot")
                || message.contains("uses selector but selectors are not available")
        }
        _ => false,
    }
}

fn normalized_action(action: Value, target_id: &str) -> BrowserResult<Value> {
    let mut object = match action {
        Value::Object(object) => object,
        _ => {
            return Err(BrowserAutomationError::InvalidResponse(
                "browser loop action must be a JSON object".to_string(),
            ));
        }
    };
    object.insert(
        "target_id".to_string(),
        Value::String(target_id.to_string()),
    );
    object
        .entry("snapshot_after".to_string())
        .or_insert(Value::Bool(true));
    Ok(Value::Object(object))
}

fn observation_from_value(
    value: Value,
    fallback_target_id: &str,
) -> BrowserResult<BrowserObservation> {
    let target_id = value
        .get("targetId")
        .or_else(|| value.get("target_id"))
        .and_then(Value::as_str)
        .unwrap_or(fallback_target_id)
        .to_string();
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let snapshot = value
        .get("snapshot")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            BrowserAutomationError::InvalidResponse(
                "browser observation is missing snapshot".to_string(),
            )
        })?
        .to_string();
    let refs_count = value
        .get("stats")
        .and_then(Value::as_object)
        .and_then(|stats| stats.get("refs"))
        .and_then(Value::as_u64)
        .or_else(|| {
            value
                .get("refs")
                .and_then(Value::as_array)
                .map(|refs| refs.len() as u64)
        })
        .unwrap_or(0);

    Ok(BrowserObservation {
        target_id,
        url,
        snapshot_hash: stable_hash(&snapshot),
        snapshot,
        refs_mode: string_field(&value, "refsMode")
            .or_else(|| string_field(&value, "refs_mode"))
            .unwrap_or_else(|| "unknown".to_string()),
        snapshot_format: string_field(&value, "snapshotFormat")
            .or_else(|| string_field(&value, "snapshot_format"))
            .unwrap_or_else(|| "unknown".to_string()),
        refs_count,
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn stable_hash(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

pub fn browser_loop_event_payload(iteration: &BrowserLoopIteration) -> Value {
    let mut payload = Map::new();
    payload.insert("iteration".to_string(), Value::from(iteration.iteration));
    payload.insert(
        "url_before".to_string(),
        Value::String(iteration.url_before.clone()),
    );
    payload.insert(
        "snapshot_hash_before".to_string(),
        Value::String(iteration.snapshot_hash_before.clone()),
    );
    payload.insert("action".to_string(), iteration.action.clone());
    if let Some(expected) = iteration.expected_observation.as_ref() {
        payload.insert(
            "expected_observation".to_string(),
            Value::String(expected.clone()),
        );
    }
    payload.insert(
        "url_after".to_string(),
        Value::String(iteration.url_after.clone()),
    );
    payload.insert(
        "snapshot_hash_after".to_string(),
        Value::String(iteration.snapshot_hash_after.clone()),
    );
    payload.insert(
        "status".to_string(),
        Value::String(iteration.status.clone()),
    );
    Value::Object(payload)
}
