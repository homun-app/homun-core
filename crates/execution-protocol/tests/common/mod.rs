#![allow(dead_code)]

use local_first_execution_protocol::*;
use serde_json::{Value, json};

pub const DURABLE_STORE_ID: &str = "0123456789abcdef0123456789abcdef";
pub const SECRET_STORE_ID: &str = "abcdef0123456789abcdef0123456789";

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

pub fn durable_ref() -> DurableDataRef {
    DurableDataRef::from_store_id(DURABLE_STORE_ID).unwrap()
}

pub fn secret_ref() -> SecretRef {
    SecretRef::from_store_id(SECRET_STORE_ID).unwrap()
}

pub fn checkpoint_with(data_ref: CheckpointDataRef) -> CheckpointEnvelope {
    CheckpointEnvelope::new("exec-1", 1, "chat_turn", 1, data_ref)
}

pub fn checkpoint_for(
    execution_id: &str,
    revision: u64,
    producer_kind: &str,
) -> CheckpointEnvelope {
    CheckpointEnvelope::new(
        execution_id,
        revision,
        producer_kind,
        1,
        CheckpointDataRef::Public {
            record_ref: durable_ref(),
        },
    )
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
