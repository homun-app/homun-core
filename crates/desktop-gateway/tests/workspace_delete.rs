use local_first_desktop_gateway::workspace_delete::{
    WorkspaceDeleteError, coordinate_workspace_delete,
};
use std::cell::RefCell;

#[test]
fn workspace_delete_keeps_registry_when_any_purge_step_fails() {
    let operations = RefCell::new(Vec::new());
    let result = coordinate_workspace_delete(
        || {
            operations.borrow_mut().push("chat");
            Ok(1)
        },
        || {
            operations.borrow_mut().push("task");
            Ok(2)
        },
        || {
            operations.borrow_mut().push("memory");
            Err(WorkspaceDeleteError::Memory("forced".to_string()))
        },
        || {
            operations.borrow_mut().push("usage");
            Ok(4)
        },
        || {
            operations.borrow_mut().push("graph");
            Ok(true)
        },
        || {
            operations.borrow_mut().push("registry");
            Ok(())
        },
    );

    assert!(matches!(result, Err(WorkspaceDeleteError::Memory(_))));
    assert_eq!(*operations.borrow(), vec!["chat", "task", "memory"]);
}

#[test]
fn workspace_delete_removes_graph_cache_and_saves_registry_last() {
    let operations = RefCell::new(Vec::new());
    let report = coordinate_workspace_delete(
        || {
            operations.borrow_mut().push("chat");
            Ok(1)
        },
        || {
            operations.borrow_mut().push("task");
            Ok(2)
        },
        || {
            operations.borrow_mut().push("memory");
            Ok(3)
        },
        || {
            operations.borrow_mut().push("usage");
            Ok(4)
        },
        || {
            operations.borrow_mut().push("graph");
            Ok(true)
        },
        || {
            operations.borrow_mut().push("registry");
            Ok(())
        },
    )
    .unwrap();

    assert_eq!(report.chat_threads, 1);
    assert_eq!(report.tasks, 2);
    assert_eq!(report.memory_rows, 3);
    assert_eq!(report.usage_events, 4);
    assert!(report.graph_cache_removed);
    assert_eq!(operations.borrow().last(), Some(&"registry"));
}

#[test]
fn workspace_delete_does_not_save_registry_when_usage_purge_fails() {
    let operations = RefCell::new(Vec::new());
    let result = coordinate_workspace_delete(
        || Ok(1),
        || Ok(2),
        || Ok(3),
        || {
            operations.borrow_mut().push("usage");
            Err(WorkspaceDeleteError::Usage("forced".to_string()))
        },
        || {
            operations.borrow_mut().push("graph");
            Ok(true)
        },
        || {
            operations.borrow_mut().push("registry");
            Ok(())
        },
    );

    assert!(matches!(result, Err(WorkspaceDeleteError::Usage(_))));
    assert_eq!(*operations.borrow(), vec!["usage"]);
}
