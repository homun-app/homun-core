use local_first_execution_protocol::{
    EffectClass, EffectReceiptRef, EffectReceiptStatus, ValidatedExecutionContract,
};
use local_first_task_runtime::{
    EffectReceiptClaim, ExecutionEffectReceipt, NewExecutionEffectReceipt, ProjectionClaim,
    TaskRecord, TaskStore,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EffectRequestKind {
    Capability,
    AdapterOutput,
}

#[derive(Clone, Debug)]
pub(crate) struct EffectRequest {
    operation: String,
    logical_call_id: String,
    effect_class: EffectClass,
    arguments: Value,
    kind: EffectRequestKind,
}

impl EffectRequest {
    pub(crate) fn capability(
        operation: impl Into<String>,
        logical_call_id: impl Into<String>,
        effect_class: EffectClass,
        arguments: Value,
    ) -> Self {
        Self {
            operation: operation.into(),
            logical_call_id: logical_call_id.into(),
            effect_class,
            arguments,
            kind: EffectRequestKind::Capability,
        }
    }

    pub(crate) fn adapter_output(
        operation: impl Into<String>,
        logical_call_id: impl Into<String>,
        effect_class: EffectClass,
        arguments: Value,
    ) -> Self {
        Self {
            operation: operation.into(),
            logical_call_id: logical_call_id.into(),
            effect_class,
            arguments,
            kind: EffectRequestKind::AdapterOutput,
        }
    }
}

pub(crate) struct EffectLease<'a> {
    receipt_ref: EffectReceiptRef,
    store: &'a Mutex<TaskStore>,
    settled: AtomicBool,
}

impl std::fmt::Debug for EffectLease<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EffectLease")
            .field("receipt_ref", &self.receipt_ref)
            .finish_non_exhaustive()
    }
}

impl EffectLease<'_> {
    pub(crate) fn receipt_ref(&self) -> &EffectReceiptRef {
        &self.receipt_ref
    }

    fn settle(&self) {
        self.settled.store(true, Ordering::Release);
    }
}

impl Drop for EffectLease<'_> {
    fn drop(&mut self) {
        if self.settled.swap(true, Ordering::AcqRel) {
            return;
        }
        let result = self
            .store
            .lock()
            .map_err(|_| "effect receipt drop store unavailable".to_string())
            .and_then(|store| {
                let receipt = store
                    .effect_receipt(&self.receipt_ref)
                    .map_err(|error| format!("effect receipt drop lookup failed: {error}"))?
                    .ok_or_else(|| "effect receipt disappeared before drop".to_string())?;
                if receipt.status != EffectReceiptStatus::Started {
                    return Ok(());
                }
                match store.mark_effect_receipt_uncertain(
                    &self.receipt_ref,
                    &serde_json::json!({
                        "code": "dispatch_interrupted_before_receipt_resolution"
                    }),
                ) {
                    Ok(_) => Ok(()),
                    Err(error) => {
                        // Completion or explicit resolution may win between the
                        // lookup and update. Any non-Started state is already safe.
                        match store.effect_receipt(&self.receipt_ref) {
                            Ok(Some(current)) if current.status != EffectReceiptStatus::Started => {
                                Ok(())
                            }
                            _ => Err(format!("effect receipt drop resolution failed: {error}")),
                        }
                    }
                }
            });
        if let Err(error) = result {
            tracing::error!(
                target: "execution::effect",
                receipt_ref = %self.receipt_ref.as_ref(),
                %error,
                "abandoned effect dispatch could not be marked uncertain"
            );
        }
    }
}

#[derive(Debug)]
pub(crate) enum EffectDecision<'a> {
    Execute(EffectLease<'a>),
    Replay(ExecutionEffectReceipt),
    Resolve(ExecutionEffectReceipt),
}

pub(crate) struct EffectHost<'a> {
    store: &'a Mutex<TaskStore>,
    contract: &'a ValidatedExecutionContract,
    run_id: Option<&'a str>,
    projection_claim: Option<&'a ProjectionClaim>,
}

impl<'a> EffectHost<'a> {
    pub(crate) fn new(
        store: &'a Mutex<TaskStore>,
        contract: &'a ValidatedExecutionContract,
        run_id: Option<&'a str>,
    ) -> Self {
        Self {
            store,
            contract,
            run_id,
            projection_claim: None,
        }
    }

    pub(crate) fn for_projection(
        store: &'a Mutex<TaskStore>,
        contract: &'a ValidatedExecutionContract,
        projection_claim: &'a ProjectionClaim,
    ) -> Self {
        Self {
            store,
            contract,
            run_id: None,
            projection_claim: Some(projection_claim),
        }
    }

    pub(crate) fn begin(&self, request: EffectRequest) -> Result<EffectDecision<'a>, String> {
        self.authorize_request(&request)?;
        let contract = self.contract.as_ref();
        let request_kind = request.kind;
        let arguments = canonical_json(request.arguments);
        let arguments_hash = hash_json(&arguments)?;
        let (mut idempotency_key, mut receipt_ref) = effect_receipt_identity(
            &contract.execution_id,
            &request.operation,
            &request.logical_call_id,
        )?;
        let store = self
            .store
            .lock()
            .map_err(|_| "effect receipt store unavailable".to_string())?;
        let legacy_idempotency_key = format!("{}:{arguments_hash}", request.operation);
        if let Some(legacy) = store
            .list_effect_receipts_for_execution(&contract.execution_id, contract.revision)
            .map_err(|error| format!("effect receipt migration lookup failed: {error}"))?
            .into_iter()
            .find(|receipt| {
                receipt.idempotency_key == legacy_idempotency_key
                    && receipt.operation == request.operation
                    && receipt.arguments_hash == arguments_hash
            })
        {
            idempotency_key = legacy.idempotency_key;
            receipt_ref = legacy.receipt_ref;
        }
        let new_receipt = NewExecutionEffectReceipt {
            receipt_ref: receipt_ref.clone(),
            execution_id: contract.execution_id.clone(),
            revision: contract.revision,
            idempotency_key,
            run_id: self.run_id.map(str::to_string),
            thread_id: contract.scope.thread_id.clone(),
            user_id: contract.scope.user_id.clone(),
            workspace_id: contract.scope.workspace_id.clone(),
            effect_class: request.effect_class,
            operation: request.operation,
            arguments_hash,
            compensation: None,
        };
        let claim = match request_kind {
            EffectRequestKind::Capability => {
                let task: TaskRecord = serde_json::from_value(contract.input.clone())
                    .map_err(|_| "capability effect requires canonical task input".to_string())?;
                let owner = task.lease_owner.as_deref().ok_or_else(|| {
                    "capability effect requires an acquired task owner".to_string()
                })?;
                store.prepare_and_claim_effect_receipt(&new_receipt, owner, contract.fencing_token)
            }
            EffectRequestKind::AdapterOutput => {
                let projection_claim = self.projection_claim.ok_or_else(|| {
                    "adapter output requires the current projection claim".to_string()
                })?;
                store.prepare_and_claim_effect_receipt_for_projection(
                    &new_receipt,
                    contract.fencing_token,
                    projection_claim,
                )
            }
        }
        .map_err(|error| format!("effect receipt claim failed: {error}"))?;
        match claim {
            EffectReceiptClaim::Execute(_) => Ok(EffectDecision::Execute(EffectLease {
                receipt_ref,
                store: self.store,
                settled: AtomicBool::new(false),
            })),
            EffectReceiptClaim::Replay(receipt) => Ok(EffectDecision::Replay(receipt)),
            EffectReceiptClaim::Resolve(receipt) => Ok(EffectDecision::Resolve(receipt)),
        }
    }

    pub(crate) fn complete(
        &self,
        lease: &EffectLease<'_>,
        result: &Value,
        effects: &Value,
    ) -> Result<ExecutionEffectReceipt, String> {
        let result = crate::agent_journal::redact_json_value(result.clone());
        let effects = crate::agent_journal::redact_json_value(effects.clone());
        let receipt = lease
            .store
            .lock()
            .map_err(|_| "effect receipt completion store unavailable".to_string())?
            .complete_effect_receipt(lease.receipt_ref(), &result, &effects)
            .map_err(|error| format!("effect receipt completion failed: {error}"))?;
        lease.settle();
        Ok(receipt)
    }

    pub(crate) fn mark_uncertain(
        &self,
        lease: &EffectLease<'_>,
    ) -> Result<ExecutionEffectReceipt, String> {
        let store = lease
            .store
            .lock()
            .map_err(|_| "effect receipt uncertainty store unavailable".to_string())?;
        let receipt = match store.mark_effect_receipt_uncertain(
            lease.receipt_ref(),
            &serde_json::json!({"code": "remote_outcome_unknown"}),
        ) {
            Ok(receipt) => receipt,
            Err(error) => match store.effect_receipt(lease.receipt_ref()) {
                Ok(Some(receipt)) if receipt.status == EffectReceiptStatus::Uncertain => receipt,
                _ => return Err(format!("effect receipt uncertainty failed: {error}")),
            },
        };
        lease.settle();
        Ok(receipt)
    }

    pub(crate) fn mark_uncertain_with_evidence(
        &self,
        lease: &EffectLease<'_>,
        evidence: &Value,
    ) -> Result<ExecutionEffectReceipt, String> {
        let evidence = crate::agent_journal::redact_json_value(evidence.clone());
        let receipt = lease
            .store
            .lock()
            .map_err(|_| "effect receipt uncertainty store unavailable".to_string())?
            .mark_effect_receipt_uncertain(lease.receipt_ref(), &evidence)
            .map_err(|error| format!("effect receipt uncertainty failed: {error}"))?;
        lease.settle();
        Ok(receipt)
    }

    pub(crate) fn release_not_applied(
        &self,
        lease: &EffectLease<'_>,
        code: &str,
        detail: &str,
    ) -> Result<ExecutionEffectReceipt, String> {
        let evidence = crate::agent_journal::redact_json_value(serde_json::json!({
            "code": code,
            "detail": detail,
        }));
        let receipt = lease
            .store
            .lock()
            .map_err(|_| "effect receipt release store unavailable".to_string())?
            .release_effect_receipt_not_applied(lease.receipt_ref(), &evidence)
            .map_err(|error| format!("effect receipt release failed: {error}"))?;
        lease.settle();
        Ok(receipt)
    }

    pub(crate) fn authorize_request(&self, request: &EffectRequest) -> Result<(), String> {
        if request.operation.trim().is_empty() || request.logical_call_id.trim().is_empty() {
            return Err("effect requires operation and logical call identity".into());
        }
        match request.kind {
            EffectRequestKind::Capability => {
                if self
                    .contract
                    .as_ref()
                    .policy
                    .allowed_effects
                    .contains(&request.effect_class)
                {
                    Ok(())
                } else {
                    Err(format!(
                        "execution contract denies {:?} for {}",
                        request.effect_class, request.operation
                    ))
                }
            }
            EffectRequestKind::AdapterOutput => self.authorize_adapter_output(request),
        }
    }

    fn authorize_adapter_output(&self, request: &EffectRequest) -> Result<(), String> {
        let contract = self.contract.as_ref();
        let task: TaskRecord = serde_json::from_value(contract.input.clone())
            .map_err(|_| "adapter output requires canonical task input".to_string())?;
        let task_thread = task.input_json.get("thread_id").and_then(Value::as_str);
        let requested_thread = request.arguments.get("thread_id").and_then(Value::as_str);
        let requested_channel = request.arguments.get("channel").and_then(Value::as_str);
        let channel_reply_operation = matches!(
            request.operation.as_str(),
            "channel.telegram.reply" | "channel.whatsapp.reply"
        );
        let channel_approval_operation = request.operation == "channel.remote_approval";
        let operation_channel = request
            .operation
            .strip_prefix("channel.")
            .and_then(|value| {
                value
                    .strip_suffix(".reply")
                    .or_else(|| value.strip_suffix(".approval"))
                    .filter(|value| !value.is_empty())
            });
        let projected_kind = matches!(contract.kind.as_str(), "chat_turn" | "proactive_prompt");
        let common_scope = projected_kind
            && task.kind == contract.kind
            && task_thread == contract.scope.thread_id.as_deref()
            && requested_thread == contract.scope.thread_id.as_deref()
            && request.effect_class == EffectClass::ExternalWrite;
        let reply_allowed = contract.kind == "chat_turn"
            && channel_reply_operation
            && requested_channel == operation_channel
            && task.input_json.get("source").and_then(Value::as_str) == Some("channel");
        let approval_allowed = channel_approval_operation
            && request
                .arguments
                .get("approval_id")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
        if common_scope && (reply_allowed || approval_allowed) {
            Ok(())
        } else {
            Err(format!(
                "execution contract denies adapter output {}",
                request.operation
            ))
        }
    }
}

fn canonical_json(value: Value) -> Value {
    match value {
        Value::Object(values) => {
            let ordered = values
                .into_iter()
                .map(|(key, value)| (key, canonical_json(value)))
                .collect::<std::collections::BTreeMap<_, _>>();
            Value::Object(ordered.into_iter().collect())
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonical_json).collect()),
        other => other,
    }
}

fn hash_json(value: &Value) -> Result<String, String> {
    let encoded = serde_json::to_vec(value)
        .map_err(|error| format!("effect arguments serialization failed: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn effect_receipt_identity(
    execution_id: &str,
    operation: &str,
    logical_call_id: &str,
) -> Result<(String, EffectReceiptRef), String> {
    if execution_id.trim().is_empty()
        || operation.trim().is_empty()
        || logical_call_id.trim().is_empty()
    {
        return Err(
            "effect receipt requires execution, operation, and logical call identity".into(),
        );
    }
    let idempotency_key = format!("tool_call:{operation}:{logical_call_id}");
    let receipt_hash = format!(
        "{:x}",
        Sha256::digest(format!("{execution_id}:{idempotency_key}").as_bytes())
    );
    let receipt_ref = EffectReceiptRef::from_store_id(&receipt_hash[..32])
        .map_err(|error| format!("effect receipt reference failed: {error}"))?;
    Ok((idempotency_key, receipt_ref))
}

#[cfg(test)]
mod tests {
    use super::{EffectDecision, EffectHost, EffectRequest};
    use local_first_execution_protocol::{
        ApprovalPolicy, EffectClass, EffectReceiptRef, ExecutionContract, ExecutionOutcome,
        ExecutionScope, ValidatedExecutionContract, ValidatedExecutionOutcome,
    };
    use local_first_task_runtime::{
        NewExecutionEffectReceipt, ProjectionClaim, TaskRecord, TaskStatus, TaskStore, UserId,
        WorkspaceId,
    };
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::sync::Mutex;
    use time::{Duration, OffsetDateTime};

    fn contract(
        execution_id: &str,
        allowed_effects: Vec<EffectClass>,
    ) -> ValidatedExecutionContract {
        let now = OffsetDateTime::now_utc();
        let mut task = TaskRecord::new(
            execution_id,
            UserId::new("user-1"),
            WorkspaceId::new("workspace-1"),
            "chat_turn",
            "test",
            json!({"thread_id": "thread-1"}),
        );
        task.status = TaskStatus::Running;
        task.lease_owner = Some("worker-1".into());
        task.last_heartbeat_at = Some(now);
        task.lease_expires_at = Some(now + Duration::minutes(5));
        let mut raw = ExecutionContract::new(
            execution_id,
            "chat_turn",
            ExecutionScope {
                user_id: "user-1".into(),
                workspace_id: "workspace-1".into(),
                thread_id: Some("thread-1".into()),
            },
            serde_json::to_value(task).expect("task"),
        );
        raw.fencing_token = u64::try_from(now.unix_timestamp_nanos()).expect("fence");
        raw.policy.allowed_effects = allowed_effects;
        raw.policy.approval_policy = ApprovalPolicy::OnRequest;
        raw.try_into().expect("contract")
    }

    fn channel_contract(execution_id: &str) -> ValidatedExecutionContract {
        let now = OffsetDateTime::now_utc();
        let mut task = TaskRecord::new(
            execution_id,
            UserId::new("user-1"),
            WorkspaceId::new("workspace-1"),
            "chat_turn",
            "reply",
            json!({
                "thread_id": "thread-1",
                "source": "channel",
                "approval": "read_only",
            }),
        );
        task.status = TaskStatus::Running;
        task.lease_owner = Some("worker-1".into());
        task.last_heartbeat_at = Some(now);
        task.lease_expires_at = Some(now + Duration::minutes(5));
        let mut raw = ExecutionContract::new(
            execution_id,
            "chat_turn",
            ExecutionScope {
                user_id: "user-1".into(),
                workspace_id: "workspace-1".into(),
                thread_id: Some("thread-1".into()),
            },
            serde_json::to_value(task).expect("task"),
        );
        raw.fencing_token = u64::try_from(now.unix_timestamp_nanos()).expect("fence");
        raw.policy.allowed_effects = vec![EffectClass::Read];
        raw.try_into().expect("channel contract")
    }

    fn activate(store: &Mutex<TaskStore>, contract: &ValidatedExecutionContract) {
        let task: TaskRecord =
            serde_json::from_value(contract.as_ref().input.clone()).expect("task input");
        let store = store.lock().expect("store");
        store.insert_task(&task).expect("task");
        store.create_execution(contract).expect("execution");
        store
            .start_execution_attempt(
                &contract.as_ref().execution_id,
                contract.as_ref().revision,
                contract.as_ref().fencing_token,
                task.lease_owner.as_deref().expect("owner"),
            )
            .expect("attempt");
    }

    fn activate_projection(
        store: &Mutex<TaskStore>,
        contract: &ValidatedExecutionContract,
    ) -> ProjectionClaim {
        let task: TaskRecord =
            serde_json::from_value(contract.as_ref().input.clone()).expect("task input");
        let store = store.lock().expect("store");
        store.insert_task(&task).expect("task");
        store.create_execution(contract).expect("execution");
        let outcome = ValidatedExecutionOutcome::new(
            ExecutionOutcome::completed(json!({"answer": "done"})),
            contract,
        )
        .expect("outcome");
        store
            .commit_execution_outcome(&outcome)
            .expect("commit outcome");
        store
            .claim_projection("chat_lifecycle", "projector", 1, 1)
            .expect("claim projection")
            .expect("pending projection")
    }

    fn request(call_id: &str) -> EffectRequest {
        EffectRequest::capability(
            "connector.send",
            call_id,
            EffectClass::ExternalWrite,
            json!({"text": "same"}),
        )
    }

    #[test]
    fn distinct_logical_calls_with_equal_arguments_have_distinct_receipts() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract(
            "execution-1",
            vec![EffectClass::Read, EffectClass::ExternalWrite],
        );
        activate(&store, &contract);
        let host = EffectHost::new(&store, &contract, Some("run-1"));

        let first = host.begin(request("call-1")).expect("first claim");
        let second = host.begin(request("call-2")).expect("second claim");

        let EffectDecision::Execute(first) = first else {
            panic!("first call must execute");
        };
        let EffectDecision::Execute(second) = second else {
            panic!("second call must execute");
        };
        assert_ne!(first.receipt_ref(), second.receipt_ref());
    }

    #[test]
    fn completed_effect_replays_persisted_output() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract(
            "execution-2",
            vec![EffectClass::Read, EffectClass::ExternalWrite],
        );
        activate(&store, &contract);
        let host = EffectHost::new(&store, &contract, Some("run-2"));
        let EffectDecision::Execute(lease) = host.begin(request("call-1")).expect("claim") else {
            panic!("first call must execute");
        };
        host.complete(&lease, &json!("sent"), &json!({"delivered": true}))
            .expect("complete");

        let EffectDecision::Replay(receipt) = host.begin(request("call-1")).expect("replay") else {
            panic!("completed call must replay");
        };
        assert_eq!(receipt.result_json, Some(json!("sent")));
        assert_eq!(receipt.effects_json, Some(json!({"delivered": true})));
    }

    #[test]
    fn started_effect_becomes_resolve_and_is_never_claimed_again() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract(
            "execution-3",
            vec![EffectClass::Read, EffectClass::ExternalWrite],
        );
        activate(&store, &contract);
        let host = EffectHost::new(&store, &contract, Some("run-3"));
        assert!(matches!(
            host.begin(request("call-1")).expect("first claim"),
            EffectDecision::Execute(_)
        ));

        assert!(matches!(
            host.begin(request("call-1")).expect("uncertain claim"),
            EffectDecision::Resolve(_)
        ));
        assert!(matches!(
            host.begin(request("call-1")).expect("stable resolve"),
            EffectDecision::Resolve(_)
        ));
    }

    #[test]
    fn abandoned_dispatch_guard_becomes_uncertain_immediately() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract(
            "execution-abandoned-dispatch",
            vec![EffectClass::Read, EffectClass::ExternalWrite],
        );
        activate(&store, &contract);
        let host = EffectHost::new(&store, &contract, Some("run-abandoned"));
        let EffectDecision::Execute(lease) = host.begin(request("call-abandoned")).expect("claim")
        else {
            panic!("first call must execute");
        };

        let receipt_ref = lease.receipt_ref().clone();
        drop(lease);

        let receipt = store
            .lock()
            .expect("store")
            .list_effect_receipts_for_execution("execution-abandoned-dispatch", 1)
            .expect("load abandoned receipt")
            .into_iter()
            .find(|receipt| receipt.receipt_ref == receipt_ref)
            .expect("abandoned receipt exists");
        assert_eq!(
            receipt.status,
            local_first_execution_protocol::EffectReceiptStatus::Uncertain
        );

        let EffectDecision::Resolve(receipt) = host
            .begin(request("call-abandoned"))
            .expect("resolve abandoned dispatch")
        else {
            panic!("an abandoned dispatch must never execute again");
        };
        assert_eq!(
            receipt.status,
            local_first_execution_protocol::EffectReceiptStatus::Uncertain
        );
    }

    #[test]
    fn uncertain_effect_keeps_dispatch_evidence() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract(
            "execution-uncertain-evidence",
            vec![EffectClass::Read, EffectClass::ExternalWrite],
        );
        activate(&store, &contract);
        let host = EffectHost::new(&store, &contract, Some("run-evidence"));
        let EffectDecision::Execute(lease) = host.begin(request("call-evidence")).expect("claim")
        else {
            panic!("first call must execute");
        };
        let evidence = json!({
            "channel": "telegram",
            "recipient_fingerprint": "sha256:abc",
            "attempted": true
        });

        let receipt = host
            .mark_uncertain_with_evidence(&lease, &evidence)
            .expect("uncertain receipt");

        assert_eq!(receipt.effects_json, Some(evidence));
    }

    #[test]
    fn verified_not_applied_release_stays_retryable_after_lease_drop() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract(
            "execution-verified-not-applied",
            vec![EffectClass::Read, EffectClass::ExternalWrite],
        );
        activate(&store, &contract);
        let host = EffectHost::new(&store, &contract, Some("run-release"));
        let EffectDecision::Execute(lease) = host.begin(request("call-release")).expect("claim")
        else {
            panic!("first call must execute");
        };

        let released = host
            .release_not_applied(&lease, "connect_failed", "dispatch never reached remote")
            .expect("release receipt");
        assert_eq!(
            released.status,
            local_first_execution_protocol::EffectReceiptStatus::Prepared
        );
        drop(lease);

        assert!(matches!(
            host.begin(request("call-release")).expect("retry claim"),
            EffectDecision::Execute(_)
        ));
    }

    #[test]
    fn concurrent_verified_not_applied_resolution_cannot_become_uncertain() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract(
            "execution-concurrent-release",
            vec![EffectClass::Read, EffectClass::ExternalWrite],
        );
        activate(&store, &contract);
        let host = EffectHost::new(&store, &contract, Some("run-concurrent-release"));
        let EffectDecision::Execute(lease) = host
            .begin(request("call-concurrent-release"))
            .expect("claim")
        else {
            panic!("first call must execute");
        };
        let receipt_ref = lease.receipt_ref().clone();
        store
            .lock()
            .expect("store")
            .release_effect_receipt_not_applied(
                &receipt_ref,
                &json!({"code": "verified_not_dispatched"}),
            )
            .expect("concurrent release");

        assert!(host.mark_uncertain(&lease).is_err());
        drop(lease);

        let receipt = store
            .lock()
            .expect("store")
            .effect_receipt(&receipt_ref)
            .expect("load receipt")
            .expect("receipt exists");
        assert_eq!(
            receipt.status,
            local_first_execution_protocol::EffectReceiptStatus::Prepared
        );
        assert!(matches!(
            host.begin(request("call-concurrent-release"))
                .expect("retry claim"),
            EffectDecision::Execute(_)
        ));
    }

    #[test]
    fn denied_effect_fails_before_creating_a_receipt() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract("execution-4", vec![EffectClass::Read]);
        let host = EffectHost::new(&store, &contract, Some("run-4"));

        let error = host
            .begin(request("call-1"))
            .expect_err("external write must be denied");

        assert!(error.contains("execution contract denies"));
        assert!(
            store
                .lock()
                .expect("store")
                .list_effect_receipts_for_execution("execution-4", 1)
                .expect("receipts")
                .is_empty()
        );
    }

    #[test]
    fn legacy_argument_keyed_receipt_is_reused() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract(
            "execution-5",
            vec![EffectClass::Read, EffectClass::ExternalWrite],
        );
        activate(&store, &contract);
        let arguments = json!({"text": "same"});
        let arguments_hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&arguments).expect("arguments"))
        );
        let receipt_ref =
            EffectReceiptRef::from_store_id("55555555555555555555555555555555").expect("ref");
        store
            .lock()
            .expect("store")
            .prepare_effect_receipt(&NewExecutionEffectReceipt {
                receipt_ref: receipt_ref.clone(),
                execution_id: "execution-5".into(),
                revision: 1,
                run_id: Some("run-5".into()),
                thread_id: Some("thread-1".into()),
                user_id: "user-1".into(),
                workspace_id: "workspace-1".into(),
                effect_class: EffectClass::ExternalWrite,
                operation: "connector.send".into(),
                arguments_hash: arguments_hash.clone(),
                idempotency_key: format!("connector.send:{arguments_hash}"),
                compensation: None,
            })
            .expect("legacy receipt");
        let host = EffectHost::new(&store, &contract, Some("run-5"));

        let EffectDecision::Execute(lease) = host.begin(request("new-call")).expect("claim") else {
            panic!("legacy prepared receipt must execute");
        };
        assert_eq!(lease.receipt_ref(), &receipt_ref);
    }

    #[test]
    fn adapter_output_requires_a_matching_channel_chat_contract() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let channel = channel_contract("execution-6");
        let projection_claim = activate_projection(&store, &channel);
        let channel_host = EffectHost::for_projection(&store, &channel, &projection_claim);
        assert!(matches!(
            channel_host
                .begin(EffectRequest::adapter_output(
                    "channel.telegram.reply",
                    "projection_revision_1",
                    EffectClass::ExternalWrite,
                    json!({
                        "thread_id": "thread-1",
                        "channel": "telegram",
                        "recipient": "r1",
                        "answer": "ok",
                    }),
                ))
                .expect("channel output"),
            EffectDecision::Execute(_)
        ));

        let ordinary = contract("execution-7", vec![EffectClass::Read]);
        let ordinary_host = EffectHost::new(&store, &ordinary, None);
        assert!(
            ordinary_host
                .begin(EffectRequest::adapter_output(
                    "channel.telegram.reply",
                    "projection_revision_1",
                    EffectClass::ExternalWrite,
                    json!({
                        "thread_id": "thread-1",
                        "channel": "telegram",
                        "recipient": "r1",
                        "answer": "ok",
                    }),
                ))
                .is_err()
        );
    }

    #[test]
    fn channel_adapter_output_cannot_target_another_thread() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = channel_contract("execution-channel-scope");
        let host = EffectHost::new(&store, &contract, None);
        let request = EffectRequest::adapter_output(
            "channel.telegram.reply",
            "projection_revision_1",
            EffectClass::ExternalWrite,
            json!({
                "thread_id": "thread-2",
                "channel": "telegram",
                "recipient": "recipient-2",
                "answer": "hello",
            }),
        );

        let denied = host
            .authorize_request(&request)
            .expect_err("adapter output must stay inside the contract thread");

        assert!(denied.contains("denies adapter output"));
    }

    #[test]
    fn adapter_output_cannot_begin_without_a_projection_claim() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = channel_contract("execution-channel-no-claim");
        let host = EffectHost::new(&store, &contract, None);

        let error = host
            .begin(EffectRequest::adapter_output(
                "channel.telegram.reply",
                "projection_revision_1",
                EffectClass::ExternalWrite,
                json!({
                    "thread_id": "thread-1",
                    "channel": "telegram",
                    "recipient": "recipient-1",
                    "answer": "hello",
                }),
            ))
            .expect_err("adapter output requires projection ownership");

        assert!(error.contains("current projection claim"));
    }

    #[test]
    fn approval_adapter_output_requires_the_contract_thread() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract("execution-approval", vec![EffectClass::Read]);
        let host = EffectHost::new(&store, &contract, None);
        let request = |thread_id| {
            EffectRequest::adapter_output(
                "channel.remote_approval",
                "approval_123",
                EffectClass::ExternalWrite,
                json!({
                    "thread_id": thread_id,
                    "channel": "telegram",
                    "recipient": "recipient-1",
                    "approval_id": "approval_123",
                }),
            )
        };

        host.authorize_request(&request("thread-1"))
            .expect("approval output belongs to this execution thread");
        assert!(host.authorize_request(&request("thread-2")).is_err());
    }

    #[test]
    fn proactive_approval_adapter_output_uses_the_same_thread_contract() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let now = OffsetDateTime::now_utc();
        let mut task = TaskRecord::new(
            "proactive-approval",
            UserId::new("user-1"),
            WorkspaceId::new("workspace-1"),
            "proactive_prompt",
            "scheduled approval",
            json!({"thread_id": "thread-1"}),
        );
        task.status = TaskStatus::Running;
        task.lease_owner = Some("worker-1".into());
        let mut raw = ExecutionContract::new(
            "proactive-approval",
            "proactive_prompt",
            ExecutionScope {
                user_id: "user-1".into(),
                workspace_id: "workspace-1".into(),
                thread_id: Some("thread-1".into()),
            },
            serde_json::to_value(task).expect("task"),
        );
        raw.fencing_token = u64::try_from(now.unix_timestamp_nanos()).expect("fence");
        let contract: ValidatedExecutionContract = raw.try_into().expect("contract");
        let host = EffectHost::new(&store, &contract, None);

        host.authorize_request(&EffectRequest::adapter_output(
            "channel.remote_approval",
            "approval_proactive",
            EffectClass::ExternalWrite,
            json!({
                "thread_id": "thread-1",
                "channel": "telegram",
                "recipient": "recipient-1",
                "approval_id": "approval_proactive",
            }),
        ))
        .expect("proactive approval output");
    }

    #[test]
    fn completed_approval_adapter_output_replays_without_a_new_dispatch_lease() {
        let store = Mutex::new(TaskStore::open_in_memory().expect("store"));
        let contract = contract("execution-approval-replay", vec![EffectClass::Read]);
        let projection_claim = activate_projection(&store, &contract);
        let host = EffectHost::for_projection(&store, &contract, &projection_claim);
        let request = || {
            EffectRequest::adapter_output(
                "channel.remote_approval",
                "approval_456",
                EffectClass::ExternalWrite,
                json!({
                    "thread_id": "thread-1",
                    "channel": "telegram",
                    "recipient": "recipient-1",
                    "approval_id": "approval_456",
                }),
            )
        };
        let EffectDecision::Execute(lease) = host.begin(request()).expect("first dispatch lease")
        else {
            panic!("first approval dispatch must execute");
        };
        host.complete(
            &lease,
            &json!({"delivered": true}),
            &json!({"channel": "telegram"}),
        )
        .expect("complete dispatch");

        assert!(matches!(
            host.begin(request()).expect("replay dispatch"),
            EffectDecision::Replay(_)
        ));
    }
}
