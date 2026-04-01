-- Task checkpoints: persist execution state for crash recovery and resume.
-- One row per active task. Updated at each checkpoint (every ~6 tool iterations).
-- Deleted on successful completion (cleanup).

CREATE TABLE IF NOT EXISTS task_checkpoints (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    profile_id TEXT,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    user_prompt TEXT NOT NULL,
    plan_json TEXT NOT NULL DEFAULT '{}',
    files_created TEXT NOT NULL DEFAULT '[]',
    completed_data TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'paused', 'completed', 'cancelled')),
    iteration INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_status
    ON task_checkpoints(status);
CREATE INDEX IF NOT EXISTS idx_task_checkpoints_session
    ON task_checkpoints(session_key);
