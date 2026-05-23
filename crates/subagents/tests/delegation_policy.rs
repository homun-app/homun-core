use local_first_subagents::{
    decide_delegation, DelegationDecision, DelegationInput, TaskComplexity,
};

#[test]
fn delegation_policy_answers_directly_when_no_tool_or_specialist_is_needed() {
    let decision = decide_delegation(&DelegationInput {
        needs_tool: false,
        needs_specialist: false,
        complexity: TaskComplexity::Simple,
        estimated_turns: 1,
        large_transcript: false,
    });

    assert_eq!(decision, DelegationDecision::ReplyDirectly);
}

#[test]
fn delegation_policy_prefers_direct_tool_before_subagent() {
    let decision = decide_delegation(&DelegationInput {
        needs_tool: true,
        needs_specialist: false,
        complexity: TaskComplexity::Simple,
        estimated_turns: 1,
        large_transcript: false,
    });

    assert_eq!(decision, DelegationDecision::UseDirectTool);
}

#[test]
fn delegation_policy_uses_inline_subagent_for_specialist_work() {
    let decision = decide_delegation(&DelegationInput {
        needs_tool: true,
        needs_specialist: true,
        complexity: TaskComplexity::Moderate,
        estimated_turns: 3,
        large_transcript: false,
    });

    assert_eq!(decision, DelegationDecision::SpawnInlineSubagent);
}

#[test]
fn delegation_policy_uses_worker_thread_for_long_or_large_work() {
    let decision = decide_delegation(&DelegationInput {
        needs_tool: true,
        needs_specialist: true,
        complexity: TaskComplexity::Complex,
        estimated_turns: 8,
        large_transcript: true,
    });

    assert_eq!(decision, DelegationDecision::SpawnWorkerThread);
}
