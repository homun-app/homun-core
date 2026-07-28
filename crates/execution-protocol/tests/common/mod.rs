#![allow(dead_code)]

use local_first_execution_protocol::*;
use serde_json::{Value, json};

pub fn scope() -> ExecutionScope {
    ExecutionScope {
        user_id: "user-1".into(),
        workspace_id: "workspace-1".into(),
        thread_id: Some("thread-1".into()),
    }
}

pub fn valid_contract() -> ExecutionContract {
    ExecutionContract::new("exec-1", "chat_turn", scope(), json!({"prompt": "hello"}))
}

pub fn assert_invalid(contract: ExecutionContract, expected: ProtocolValidationError) {
    assert_eq!(contract.validate(), Err(expected));
}

pub fn assert_golden_round_trip<T>(value: &T, golden: &str)
where
    T: serde::Serialize + serde::de::DeserializeOwned + std::fmt::Debug + Eq,
{
    assert_eq!(serde_json::to_string(value).unwrap(), golden);
    let decoded = serde_json::from_str::<T>(golden).unwrap();
    assert_eq!(&decoded, value);
    assert_eq!(serde_json::to_string(&decoded).unwrap(), golden);
}

pub fn durable_ref(value: &str) -> DurableDataRef {
    DurableDataRef::new(value).unwrap()
}

pub fn secret_ref(value: &str) -> SecretRef {
    SecretRef::new(value).unwrap()
}

pub fn checkpoint_with(data_ref: CheckpointDataRef) -> CheckpointEnvelope {
    CheckpointEnvelope {
        checkpoint_id: "exec-1:1".into(),
        execution_id: "exec-1".into(),
        revision: 1,
        producer_kind: "chat_turn".into(),
        schema_version: 1,
        data_ref,
    }
}

pub fn signal() -> WakeCondition {
    WakeCondition::Signal {
        kind: "connector.message".into(),
        correlation_id: "msg-1".into(),
    }
}

pub fn opaque_payload() -> Value {
    json!({"opaque": true})
}
