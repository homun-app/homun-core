use local_first_subagents::{
    AgentId, ExecutionGraph, TaskNode, TaskState,
};

#[test]
fn graph_exposes_only_tasks_whose_dependencies_succeeded() {
    let mut graph = ExecutionGraph::new();
    graph.add_node(TaskNode::new("plan", AgentId::Planner, vec![])).unwrap();
    graph
        .add_node(TaskNode::new("risk", AgentId::Risk, vec!["plan".to_string()]))
        .unwrap();
    graph
        .add_node(TaskNode::new("review", AgentId::Review, vec!["risk".to_string()]))
        .unwrap();

    assert_eq!(graph.ready_task_ids(), vec!["plan"]);

    graph.set_state("plan", TaskState::Succeeded).unwrap();
    assert_eq!(graph.ready_task_ids(), vec!["risk"]);

    graph.set_state("risk", TaskState::Succeeded).unwrap();
    assert_eq!(graph.ready_task_ids(), vec!["review"]);
}

#[test]
fn graph_blocks_dependents_when_dependency_failed() {
    let mut graph = ExecutionGraph::new();
    graph.add_node(TaskNode::new("plan", AgentId::Planner, vec![])).unwrap();
    graph
        .add_node(TaskNode::new("risk", AgentId::Risk, vec!["plan".to_string()]))
        .unwrap();

    graph.set_state("plan", TaskState::Failed).unwrap();

    assert!(graph.ready_task_ids().is_empty());
    assert_eq!(graph.blocked_task_ids(), vec!["risk"]);
}

#[test]
fn graph_rejects_missing_dependencies() {
    let mut graph = ExecutionGraph::new();

    let error = graph
        .add_node(TaskNode::new("risk", AgentId::Risk, vec!["plan".to_string()]))
        .unwrap_err();

    assert_eq!(error, "task risk depends on missing task plan");
}
