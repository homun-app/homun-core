//! Structured data accumulation buffer.
//!
//! The `DataBuffer` collects structured records outside the LLM context window.
//! The model uses the `add_data` tool to save data, and the system injects a
//! compact summary into the context each turn. At task completion, the buffer
//! can be exported as CSV/JSON without involving the LLM.
//!
//! This solves the v1 problem where the model had to generate entire CSV files
//! in tool call arguments (causing truncation at ~6KB).

use std::collections::HashMap;

/// Structured data buffer for multi-step data collection tasks.
///
/// Records are stored as key-value maps with string values. The schema
/// defines the expected columns but is flexible — new columns discovered
/// during collection are added automatically.
#[derive(Debug, Clone)]
pub struct DataBuffer {
    /// Column names (order matters for CSV export).
    pub schema: Vec<String>,
    /// Collected records — each is a map of column_name → value.
    pub records: Vec<HashMap<String, String>>,
    /// Human-readable label for the task (e.g. "negozi Diesel Italia").
    pub label: Option<String>,
}

impl DataBuffer {
    /// Create a new buffer with the given schema columns and optional label.
    pub fn new(schema: Vec<String>, label: Option<String>) -> Self {
        Self {
            schema,
            records: Vec::new(),
            label,
        }
    }

    /// Add a record to the buffer.
    ///
    /// Any keys not in the schema are automatically added as new columns.
    /// Missing schema columns get empty string values.
    pub fn add_record(&mut self, record: HashMap<String, String>) -> usize {
        // Auto-extend schema with new keys
        for key in record.keys() {
            if !self.schema.contains(key) {
                self.schema.push(key.clone());
            }
        }
        self.records.push(record);
        self.records.len()
    }

    /// Number of records in the buffer.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Whether the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Generate a compact summary for injection into the LLM context.
    ///
    /// Keeps the summary under ~500 chars to avoid bloating the context.
    /// Shows the schema, record count, and the last 3 records as samples.
    pub fn summary(&self) -> String {
        if self.records.is_empty() {
            return String::new();
        }

        let label = self
            .label
            .as_deref()
            .unwrap_or("collected data");

        let mut s = format!(
            "[DATA BUFFER: {label} ({} records)]\nSchema: {}\n",
            self.records.len(),
            self.schema.join(", "),
        );

        // Show last 3 records as compact samples
        let start = self.records.len().saturating_sub(3);
        for record in &self.records[start..] {
            let values: Vec<&str> = self
                .schema
                .iter()
                .map(|col| record.get(col).map(|v| v.as_str()).unwrap_or(""))
                .collect();
            s.push_str(&format!("  {}\n", values.join(" | ")));
        }

        s.push_str("[END DATA BUFFER]");
        s
    }

    /// Export all records as CSV string.
    pub fn to_csv(&self) -> String {
        let mut csv = self.schema.join(",");
        csv.push('\n');
        for record in &self.records {
            let values: Vec<String> = self
                .schema
                .iter()
                .map(|col| {
                    let val = record.get(col).map(|v| v.as_str()).unwrap_or("");
                    // Escape CSV: quote if contains comma, quote, or newline
                    if val.contains(',') || val.contains('"') || val.contains('\n') {
                        format!("\"{}\"", val.replace('"', "\"\""))
                    } else {
                        val.to_string()
                    }
                })
                .collect();
            csv.push_str(&values.join(","));
            csv.push('\n');
        }
        csv
    }

    /// Export all records as JSON array string.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(&self.records).unwrap_or_else(|_| "[]".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_buffer_is_empty() {
        let buf = DataBuffer::new(vec!["name".into(), "city".into()], None);
        assert!(buf.is_empty());
        assert_eq!(buf.len(), 0);
        assert!(buf.summary().is_empty());
    }

    #[test]
    fn add_record_and_summary() {
        let mut buf = DataBuffer::new(
            vec!["name".into(), "city".into()],
            Some("test stores".into()),
        );

        let mut r = HashMap::new();
        r.insert("name".into(), "Store A".into());
        r.insert("city".into(), "Roma".into());
        buf.add_record(r);

        assert_eq!(buf.len(), 1);
        let summary = buf.summary();
        assert!(summary.contains("test stores"));
        assert!(summary.contains("1 records"));
        assert!(summary.contains("Store A"));
    }

    #[test]
    fn auto_extend_schema() {
        let mut buf = DataBuffer::new(vec!["name".into()], None);

        let mut r = HashMap::new();
        r.insert("name".into(), "Store A".into());
        r.insert("phone".into(), "+39123".into());
        buf.add_record(r);

        assert!(buf.schema.contains(&"phone".to_string()));
    }

    #[test]
    fn to_csv_basic() {
        let mut buf = DataBuffer::new(
            vec!["name".into(), "city".into()],
            None,
        );

        let mut r1 = HashMap::new();
        r1.insert("name".into(), "Store A".into());
        r1.insert("city".into(), "Roma".into());
        buf.add_record(r1);

        let mut r2 = HashMap::new();
        r2.insert("name".into(), "Store B".into());
        r2.insert("city".into(), "Milano".into());
        buf.add_record(r2);

        let csv = buf.to_csv();
        assert!(csv.starts_with("name,city\n"));
        assert!(csv.contains("Store A,Roma"));
        assert!(csv.contains("Store B,Milano"));
    }

    #[test]
    fn to_csv_escapes_commas() {
        let mut buf = DataBuffer::new(vec!["name".into(), "address".into()], None);

        let mut r = HashMap::new();
        r.insert("name".into(), "Store A".into());
        r.insert("address".into(), "Via Roma, 12".into());
        buf.add_record(r);

        let csv = buf.to_csv();
        assert!(csv.contains("\"Via Roma, 12\""));
    }

    #[test]
    fn summary_shows_last_3() {
        let mut buf = DataBuffer::new(vec!["id".into()], Some("items".into()));
        for i in 0..10 {
            let mut r = HashMap::new();
            r.insert("id".into(), format!("item_{i}"));
            buf.add_record(r);
        }

        let summary = buf.summary();
        assert!(summary.contains("10 records"));
        assert!(summary.contains("item_7"));
        assert!(summary.contains("item_8"));
        assert!(summary.contains("item_9"));
        assert!(!summary.contains("item_0"));
    }
}
