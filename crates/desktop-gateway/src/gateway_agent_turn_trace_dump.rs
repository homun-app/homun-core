//! Agent turn trace dump owner.
//!
//! Owns the gateway-side resolution of the optional trace-dump directory passed
//! into the engine loop. It does not own turn trace events, stream setup, loop
//! execution, browser execution, or subagents.

use super::*;

pub(crate) fn resolve_agent_turn_trace_dump_dir() -> Option<std::path::PathBuf> {
    local_first_engine::trace::dump_enabled()
        .then(gateway_logs_dir)
        .and_then(Result::ok)
}
