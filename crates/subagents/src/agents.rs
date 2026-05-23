use crate::{
    AgentDefinition, AgentId, AgentTier, DelegationDecision, DelegationInput, TaskComplexity,
    ToolScope,
};
use std::collections::BTreeMap;

pub fn default_registry() -> Vec<AgentId> {
    vec![
        AgentId::Planner,
        AgentId::Memory,
        AgentId::Tool,
        AgentId::Vision,
        AgentId::Risk,
        AgentId::Automation,
        AgentId::Review,
    ]
}

pub fn default_agent_definitions() -> BTreeMap<String, AgentDefinition> {
    [
        AgentDefinition {
            id: "PlannerAgent".to_string(),
            display_name: "Planner".to_string(),
            when_to_use: "Infer routines and build structured plans from local events".to_string(),
            tier: AgentTier::Reasoning,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 4,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "RiskAgent".to_string(),
            display_name: "Risk".to_string(),
            when_to_use: "Assess risk, reversibility and approval needs".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 2,
            max_result_chars: Some(2000),
            timeout_seconds: Some(20),
        },
        AgentDefinition {
            id: "MemoryAgent".to_string(),
            display_name: "Memory".to_string(),
            when_to_use: "Extract durable memory candidates and evidence".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 3,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "ToolAgent".to_string(),
            display_name: "Tool".to_string(),
            when_to_use: "Prepare typed tool plans without executing actions".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::DraftOnly,
            subagents: vec![],
            max_iterations: 3,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "VisionAgent".to_string(),
            display_name: "Vision".to_string(),
            when_to_use: "Analyze local screenshots and images".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 2,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "AutomationAgent".to_string(),
            display_name: "Automation".to_string(),
            when_to_use: "Propose routine automations from reviewed plans".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::DraftOnly,
            subagents: vec![],
            max_iterations: 3,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "ReviewAgent".to_string(),
            display_name: "Review".to_string(),
            when_to_use: "Review subagent outputs for policy, risk and schema consistency"
                .to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 2,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
    ]
    .into_iter()
    .map(|definition| (definition.id.clone(), definition))
    .collect()
}

pub fn validate_agent_definitions(definitions: &[AgentDefinition]) -> Vec<String> {
    let by_id: BTreeMap<&str, &AgentDefinition> = definitions
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect();
    let mut errors = Vec::new();

    for definition in definitions {
        if definition.id.trim().is_empty() {
            errors.push("agent id must not be empty".to_string());
        }
        if definition.when_to_use.trim().is_empty() {
            errors.push(format!("agent {} must describe when_to_use", definition.id));
        }
        if definition.max_iterations == 0 {
            errors.push(format!(
                "agent {} max_iterations must be > 0",
                definition.id
            ));
        }
        if definition.tier == AgentTier::Worker && !definition.subagents.is_empty() {
            errors.push(format!(
                "worker agent {} must not list subagents",
                definition.id
            ));
            continue;
        }

        for subagent_id in &definition.subagents {
            let Some(target) = by_id.get(subagent_id.as_str()) else {
                errors.push(format!(
                    "agent {} references missing subagent {}",
                    definition.id, subagent_id
                ));
                continue;
            };
            if definition.tier == AgentTier::Chat && target.tier == AgentTier::Chat {
                errors.push(format!(
                    "chat agent {} must not delegate to chat agent {}",
                    definition.id, target.id
                ));
            }
            if definition.tier == AgentTier::Reasoning && target.tier == AgentTier::Reasoning {
                errors.push(format!(
                    "reasoning agent {} must not delegate to reasoning agent {}",
                    definition.id, target.id
                ));
            }
        }
    }

    errors
}

pub fn decide_delegation(input: &DelegationInput) -> DelegationDecision {
    if !input.needs_tool && !input.needs_specialist {
        return DelegationDecision::ReplyDirectly;
    }
    if input.needs_tool && !input.needs_specialist {
        return DelegationDecision::UseDirectTool;
    }
    if input.large_transcript
        || input.estimated_turns > 5
        || input.complexity == TaskComplexity::Complex
    {
        return DelegationDecision::SpawnWorkerThread;
    }
    DelegationDecision::SpawnInlineSubagent
}
