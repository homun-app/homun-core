use local_first_subagents::{
    AgentDefinition, AgentTier, ToolScope, default_agent_definitions, validate_agent_definitions,
};

#[test]
fn default_agent_definitions_include_routing_metadata() {
    let registry = default_agent_definitions();
    let planner = registry.get("PlannerAgent").unwrap();

    assert_eq!(planner.display_name, "Planner");
    assert_eq!(planner.tier, AgentTier::Reasoning);
    assert!(planner.when_to_use.contains("routine"));
    assert_eq!(planner.tool_scope, ToolScope::ReadOnly);
    assert_eq!(planner.max_iterations, 4);
}

#[test]
fn worker_agents_cannot_delegate_to_subagents() {
    let definitions = vec![AgentDefinition {
        id: "ToolAgent".to_string(),
        display_name: "Tool".to_string(),
        when_to_use: "Prepare tool calls".to_string(),
        tier: AgentTier::Worker,
        tool_scope: ToolScope::DraftOnly,
        subagents: vec!["ReviewAgent".to_string()],
        max_iterations: 3,
        max_result_chars: Some(4000),
        timeout_seconds: Some(30),
    }];

    let errors = validate_agent_definitions(&definitions);

    assert_eq!(
        errors,
        vec!["worker agent ToolAgent must not list subagents"]
    );
}

#[test]
fn reasoning_agents_cannot_delegate_to_reasoning_agents() {
    let definitions = vec![
        AgentDefinition {
            id: "PlannerAgent".to_string(),
            display_name: "Planner".to_string(),
            when_to_use: "Plan".to_string(),
            tier: AgentTier::Reasoning,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec!["RiskAgent".to_string()],
            max_iterations: 4,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "RiskAgent".to_string(),
            display_name: "Risk".to_string(),
            when_to_use: "Assess risk".to_string(),
            tier: AgentTier::Reasoning,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 4,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
    ];

    let errors = validate_agent_definitions(&definitions);

    assert_eq!(
        errors,
        vec!["reasoning agent PlannerAgent must not delegate to reasoning agent RiskAgent"]
    );
}
