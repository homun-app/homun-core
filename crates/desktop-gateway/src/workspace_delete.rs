use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceDeleteError {
    Chat(String),
    Task(String),
    Memory(String),
    GraphCache(String),
    Registry(String),
}

impl fmt::Display for WorkspaceDeleteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Chat(error) => write!(formatter, "chat purge failed: {error}"),
            Self::Task(error) => write!(formatter, "task purge failed: {error}"),
            Self::Memory(error) => write!(formatter, "memory purge failed: {error}"),
            Self::GraphCache(error) => write!(formatter, "graph cache purge failed: {error}"),
            Self::Registry(error) => write!(formatter, "workspace registry write failed: {error}"),
        }
    }
}

impl std::error::Error for WorkspaceDeleteError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayWorkspacePurgeReport {
    pub chat_threads: usize,
    pub tasks: usize,
    pub memory_rows: usize,
    pub graph_cache_removed: bool,
}

pub fn coordinate_workspace_delete<Chat, Task, Memory, Graph, Registry>(
    purge_chat: Chat,
    purge_tasks: Task,
    purge_memory: Memory,
    purge_graph_cache: Graph,
    save_registry: Registry,
) -> Result<GatewayWorkspacePurgeReport, WorkspaceDeleteError>
where
    Chat: FnOnce() -> Result<usize, WorkspaceDeleteError>,
    Task: FnOnce() -> Result<usize, WorkspaceDeleteError>,
    Memory: FnOnce() -> Result<usize, WorkspaceDeleteError>,
    Graph: FnOnce() -> Result<bool, WorkspaceDeleteError>,
    Registry: FnOnce() -> Result<(), WorkspaceDeleteError>,
{
    let chat_threads = purge_chat()?;
    let tasks = purge_tasks()?;
    let memory_rows = purge_memory()?;
    let graph_cache_removed = purge_graph_cache()?;
    save_registry()?;
    Ok(GatewayWorkspacePurgeReport {
        chat_threads,
        tasks,
        memory_rows,
        graph_cache_removed,
    })
}
