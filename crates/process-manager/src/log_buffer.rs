use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub stream: LogStream,
    pub line: String,
}

pub struct LogBuffer {
    capacity: usize,
    entries: VecDeque<LogEntry>,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: VecDeque::new(),
        }
    }

    pub fn push(&mut self, stream: LogStream, line: impl Into<String>) {
        if self.capacity == 0 {
            return;
        }
        while self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(LogEntry {
            stream,
            line: line.into(),
        });
    }

    pub fn entries(&self) -> Vec<LogEntry> {
        self.entries.iter().cloned().collect()
    }
}
