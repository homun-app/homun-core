use local_first_subagents::{AgentId, routine_startup_workflow};

#[test]
fn routine_startup_workflow_matches_project_mvp_shape() {
    let workflow = routine_startup_workflow(serde_json::json!({
        "events": [
            "08:58 open_app Zed",
            "09:01 terminal git pull",
            "09:03 browser trello.com board Acme"
        ]
    }));

    let ids: Vec<&str> = workflow
        .iter()
        .map(|spec| spec.task.task_id.as_str())
        .collect();
    assert_eq!(
        ids,
        vec![
            "routine.plan",
            "routine.risk",
            "routine.memory",
            "routine.tool",
            "routine.review"
        ]
    );

    assert_eq!(workflow[0].task.agent_id, AgentId::Planner);
    assert_eq!(workflow[1].task.agent_id, AgentId::Risk);
    assert_eq!(workflow[2].task.agent_id, AgentId::Memory);
    assert_eq!(workflow[3].task.agent_id, AgentId::Tool);
    assert_eq!(workflow[4].task.agent_id, AgentId::Review);

    assert_eq!(workflow[1].depends_on, vec!["routine.plan"]);
    assert_eq!(workflow[2].depends_on, vec!["routine.risk"]);
    assert_eq!(workflow[3].depends_on, vec!["routine.risk"]);
    assert_eq!(
        workflow[4].depends_on,
        vec!["routine.memory", "routine.tool"]
    );

    let review_schema = &workflow[4].task.input["schema"];
    assert_eq!(review_schema["properties"]["findings"]["type"], "array");
    assert_eq!(
        review_schema["properties"]["findings"]["items"]["required"],
        serde_json::json!(["severity", "message"])
    );
}
