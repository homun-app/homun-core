-- Cognition phase metrics for reliability monitoring.
-- Tracks success/failure per model to identify patterns
-- and measure the impact of reliability improvements.
CREATE TABLE IF NOT EXISTS cognition_metrics (
    id        INTEGER PRIMARY KEY,
    model     TEXT    NOT NULL,
    success   BOOLEAN NOT NULL DEFAULT 0,
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    failure_reason TEXT,
    tool_count INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cognition_metrics_model ON cognition_metrics(model);
CREATE INDEX IF NOT EXISTS idx_cognition_metrics_timestamp ON cognition_metrics(timestamp);
