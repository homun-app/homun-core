//! Tool for structured data accumulation.
//!
//! The `add_data` tool lets the LLM save structured records into a
//! `DataBuffer` that lives outside the context window. This solves the
//! problem where the model had to generate entire CSV files in tool call
//! arguments (causing truncation).
//!
//! The tool is only available when the cognition phase identifies a
//! `data_schema` — meaning the task involves collecting structured data.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::agent::data_buffer::DataBuffer;
use crate::tools::{Tool, ToolContext, ToolResult};

/// Tool that saves structured data records to an external buffer.
///
/// Created dynamically when a task has a `data_schema`. Shares an
/// `Arc<Mutex<DataBuffer>>` with the agent loop so both can access
/// the accumulated data.
pub struct AddDataTool {
    buffer: Arc<Mutex<DataBuffer>>,
}

impl AddDataTool {
    /// Create a new `add_data` tool backed by the given buffer.
    pub fn new(buffer: Arc<Mutex<DataBuffer>>) -> Self {
        Self { buffer }
    }

    /// Build the JSON Schema for this tool's parameters.
    ///
    /// The schema is dynamic — it includes the column names from the
    /// DataBuffer's schema so the model knows what fields to provide.
    pub fn parameters_for_schema(schema: &[String]) -> Value {
        let mut properties = serde_json::Map::new();
        for col in schema {
            properties.insert(
                col.clone(),
                serde_json::json!({ "type": "string", "description": col }),
            );
        }

        serde_json::json!({
            "type": "object",
            "properties": {
                "records": {
                    "type": "array",
                    "description": format!(
                        "Array of data records to save. Each record should have fields: {}",
                        schema.join(", ")
                    ),
                    "items": {
                        "type": "object",
                        "properties": properties
                    }
                }
            },
            "required": ["records"]
        })
    }
}

#[async_trait]
impl Tool for AddDataTool {
    fn name(&self) -> &str {
        "add_data"
    }

    fn description(&self) -> &str {
        "Save structured data records to the collection buffer. \
         Call this every time you find relevant data during research. \
         Records are accumulated across tool calls and exported at the end."
    }

    fn parameters(&self) -> Value {
        // Fallback schema when we can't access the buffer synchronously
        serde_json::json!({
            "type": "object",
            "properties": {
                "records": {
                    "type": "array",
                    "description": "Array of data records to save",
                    "items": {
                        "type": "object",
                        "additionalProperties": { "type": "string" }
                    }
                }
            },
            "required": ["records"]
        })
    }

    async fn execute(&self, args: Value, _ctx: &ToolContext) -> Result<ToolResult> {
        let records_val = args
            .get("records")
            .ok_or_else(|| anyhow::anyhow!("Missing 'records' parameter"))?;

        let records_arr = records_val
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("'records' must be an array"))?;

        if records_arr.is_empty() {
            return Ok(ToolResult::success("No records provided."));
        }

        let mut buffer = self.buffer.lock().await;
        let mut added = 0u32;

        for record_val in records_arr {
            let obj = match record_val.as_object() {
                Some(o) => o,
                None => continue, // skip non-object entries
            };

            let mut record: HashMap<String, String> = HashMap::new();
            for (key, value) in obj {
                // Convert any JSON value to string
                let str_val = match value {
                    Value::String(s) => s.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                };
                if !str_val.is_empty() {
                    record.insert(key.clone(), str_val);
                }
            }

            if !record.is_empty() {
                buffer.add_record(record);
                added += 1;
            }
        }

        let total = buffer.len();
        Ok(ToolResult::success(format!(
            "Added {added} record(s) to buffer. Total: {total} record(s)."
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ctx() -> ToolContext {
        ToolContext {
            workspace: "/tmp".to_string(),
            channel: "cli".to_string(),
            chat_id: "test".to_string(),
            message_tx: None,
            approval_manager: None,
            skill_env: None,
            user_id: None,
            profile_id: None,
            profile_brain_dir: None,
            profile_slug: None,
            allowed_namespaces: None,
            contact_id: None,
            channel_defaults: None,
        }
    }

    #[tokio::test]
    async fn add_data_basic() {
        let buffer = Arc::new(Mutex::new(DataBuffer::new(
            vec!["name".into(), "city".into()],
            None,
        )));
        let tool = AddDataTool::new(buffer.clone());

        let args = serde_json::json!({
            "records": [
                { "name": "Store A", "city": "Roma" },
                { "name": "Store B", "city": "Milano" }
            ]
        });

        let result = tool.execute(args, &test_ctx()).await.unwrap();
        assert!(!result.is_error);
        assert!(result.output.contains("Added 2"));
        assert!(result.output.contains("Total: 2"));

        let buf = buffer.lock().await;
        assert_eq!(buf.len(), 2);
    }

    #[tokio::test]
    async fn add_data_empty_records() {
        let buffer = Arc::new(Mutex::new(DataBuffer::new(vec![], None)));
        let tool = AddDataTool::new(buffer);

        let args = serde_json::json!({ "records": [] });
        let result = tool.execute(args, &test_ctx()).await.unwrap();
        assert!(result.output.contains("No records"));
    }

    #[tokio::test]
    async fn add_data_extends_schema() {
        let buffer = Arc::new(Mutex::new(DataBuffer::new(
            vec!["name".into()],
            None,
        )));
        let tool = AddDataTool::new(buffer.clone());

        let args = serde_json::json!({
            "records": [{ "name": "Store A", "phone": "+39123" }]
        });

        tool.execute(args, &test_ctx()).await.unwrap();

        let buf = buffer.lock().await;
        assert!(buf.schema.contains(&"phone".to_string()));
    }
}
