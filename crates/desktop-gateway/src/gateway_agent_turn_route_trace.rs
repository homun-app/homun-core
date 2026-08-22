//! Agent turn route trace owner.
//!
//! Owns the pre-loop trace entry that records the selected capability route in
//! `LoopState::tool_trace` and mirrors it as an activity delta. It does not own
//! route selection, tool perimeter pruning, the agent loop, browser execution or
//! subagents.

use super::*;

pub(crate) async fn publish_agent_turn_route_trace(
    loop_state: &mut local_first_engine::LoopState,
    tx: &StreamSink,
    route: &CapabilityRouteDecision,
) {
    if let Some(route_line) = capability_route_trace_line(route) {
        loop_state.tool_trace.push(route_line.clone());
        let _ = emit_stream_event(
            tx,
            GenerateStreamEvent::Delta {
                text: agent_turn_route_trace_activity_text(&route_line),
            },
        )
        .await;
    }
}

pub(crate) fn agent_turn_route_trace_activity_text(route_line: &str) -> String {
    format!("‹‹ACT››🧭 {route_line}‹‹/ACT››")
}

#[cfg(test)]
mod tests {
    use super::agent_turn_route_trace_activity_text;

    #[test]
    fn route_trace_activity_text_wraps_route_line_as_activity_delta() {
        assert_eq!(
            agent_turn_route_trace_activity_text("Using workflow route"),
            "‹‹ACT››🧭 Using workflow route‹‹/ACT››"
        );
    }
}
