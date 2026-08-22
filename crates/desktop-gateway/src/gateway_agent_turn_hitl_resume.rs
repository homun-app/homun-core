//! Agent turn HITL resume projection owner.
//!
//! Owns the gateway-to-engine mapping for a durable HITL resume that has
//! already been selected for this turn. HITL stash lookup, prompt harness text,
//! browser liveness, and the agent loop stay in their existing owners.

use super::*;

pub(crate) fn resolved_hitl_guard_for_turn(
    resume: Option<&HitlResumeTurnContext>,
) -> Option<local_first_engine::hitl::ResolvedHitlGuard> {
    resume.map(|ctx| local_first_engine::hitl::ResolvedHitlGuard {
        envelope: local_first_engine::hitl::HitlEnvelope {
            kind: match ctx.wait.kind {
                hitl_resume::HitlWaitKind::Choice => local_first_engine::hitl::HitlKind::Choice,
                hitl_resume::HitlWaitKind::Clarify => local_first_engine::hitl::HitlKind::Clarify,
            },
            hold_policy: local_first_engine::hitl::HoldPolicy::Free,
            payload: ctx.wait.payload.clone(),
            source_marker: "durable_resume".to_string(),
        },
        resolution: ctx.resolution.clone(),
    })
}
