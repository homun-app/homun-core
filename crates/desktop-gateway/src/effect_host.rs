use local_first_execution_protocol::{EffectClass, EffectReceiptRef, ValidatedExecutionContract};
use local_first_task_runtime::{
    EffectReceiptClaim, ExecutionEffectReceipt, NewExecutionEffectReceipt, TaskRecord, TaskStore,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EffectLease {
    receipt_ref: EffectReceiptRef,
}

impl EffectLease {
    pub(crate) fn receipt_ref(&self) -> &EffectReceiptRef {
        &self.receipt_ref
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum EffectDecision {
    Execute(EffectLease),
    Replay(ExecutionEffectReceipt),
    Resolve(ExecutionEffectReceipt),
}

pub(crate) struct EffectHost<'a> {
    store: &'a Mutex<TaskStore>,
    contract: &'a ValidatedExecutionContract,
    run_id: Option<&'a str>,
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
        }
    }

    pub(crate) fn begin(&self, request: EffectRequest) -> Result<EffectDecision, String> {
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
            EffectRequestKind::AdapterOutput => store
                .prepare_and_claim_effect_receipt_for_execution(
                    &new_receipt,
                    contract.fencing_token,
                ),
        }
        .map_err(|error| format!("effect receipt claim failed: {error}"))?;
        match claim {
            EffectReceiptClaim::Execute(_) => {
                Ok(EffectDecision::Execute(EffectLease { receipt_ref }))
            }
            EffectReceiptClaim::Replay(receipt) => Ok(EffectDecision::Replay(receipt)),
            EffectReceiptClaim::Resolve(receipt) => Ok(EffectDecision::Resolve(receipt)),
        }
    }

    pub(crate) fn complete(
        &self,
        lease: &EffectLease,
        result: &Value,
        effects: &Value,
    ) -> Result<ExecutionEffectReceipt, String> {
        let result = crate::agent_journal::redact_json_value(result.clone());
        let effects = crate::agent_journal::redact_json_value(effects.clone());
        self.store
            .lock()
            .map_err(|_| "effect receipt completion store unavailable".to_string())?
            .complete_effect_receipt(lease.receipt_ref(), &result, &effects)
            .map_err(|error| format!("effect receipt completion failed: {error}"))
    }

    pub(crate) fn mark_uncertain(
        &self,
        lease: &EffectLease,
    ) -> Result<ExecutionEffectReceipt, String> {
        match self
            .store
            .lock()
            .map_err(|_| "effect receipt uncertainty store unavailable".to_string())?
            .claim_effect_receipt(lease.receipt_ref())
            .map_err(|error| format!("effect receipt uncertainty failed: {error}"))?
        {
            EffectReceiptClaim::Resolve(receipt) => Ok(receipt),
            EffectReceiptClaim::Replay(_) => Err("completed effect cannot become uncertain".into()),
            EffectReceiptClaim::Execute(_) => Err("effect receipt did not become uncertain".into()),
        }
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
        let channel_operation = matches!(
            request.operation.as_str(),
            "channel.telegram.reply" | "channel.whatsapp.reply"
        );
        let operation_channel = request
            .operation
            .strip_prefix("channel.")
            .and_then(|value| {
                value
                    .strip_suffix(".reply")
                    .filter(|value| !value.is_empty())
            });
        if contract.kind == "chat_turn"
            && task.kind == "chat_turn"
            && task.input_json.get("source").and_then(Value::as_str) == Some("channel")
            && task_thread == contract.scope.thread_id.as_deref()
            && requested_thread == contract.scope.thread_id.as_deref()
            && requested_channel == operation_channel
            && request.effect_class == EffectClass::ExternalWrite
            && channel_operation
        {
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
        ApprovalPolicy, EffectClass, EffectReceiptRef, ExecutionContract, ExecutionScope,
        ValidatedExecutionContract,
    };
    use local_first_task_runtime::{
        NewExecutionEffectReceipt, TaskRecord, TaskStatus, TaskStore, UserId, WorkspaceId,
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
        activate(&store, &channel);
        let channel_host = EffectHost::new(&store, &channel, None);
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
}
