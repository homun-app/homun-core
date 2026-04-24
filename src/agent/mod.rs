mod agent_loop;
pub mod approval_gate;
mod attachment_router;
pub mod auth;
pub mod bootstrap_watcher;
mod browser_context;
mod browser_task_plan;
pub mod cognition;
mod context;
mod context_compactor;
pub mod data_buffer;
pub mod debounce;
pub mod definition;
pub mod email_approval;
mod execution_plan;
pub mod gateway;
pub mod heartbeat;
mod iteration_budget;
mod llm_caller;
mod loop_control;
pub mod memory;
mod memory_db;
pub mod orchestrator;
pub(crate) mod profile_resolver;
pub mod prompt; // New modular prompt system
pub mod registry;
pub mod request_trace;
mod skill_activator;
pub mod stop;
pub mod subagent; // Make public so spawn.rs can access it
mod tool_builder;
mod tool_veto;
mod verifier;

#[cfg(feature = "embeddings")]
pub mod embeddings;

#[cfg(feature = "embeddings")]
pub mod index_meta;

#[cfg(feature = "embeddings")]
pub mod memory_search;

pub use crate::utils::watcher::WatcherHandle as BootstrapWatcherHandle;
pub use agent_loop::AgentLoop;
pub use bootstrap_watcher::{BootstrapContent, BootstrapFiles, BootstrapWatcher};
pub use browser_task_plan::BrowserTaskPlanState;
pub use context::ContextBuilder;
pub use definition::AgentDefinition;
pub use execution_plan::{ExecutionPlanSnapshot, ExecutionPlanState, TaskCheckpoint};
pub use gateway::Gateway;
pub use heartbeat::HeartbeatService;
pub use memory::MemoryConsolidator;
pub use prompt::{PromptContext, PromptMode, PromptSection, SystemPromptBuilder, ToolInfo};
pub use registry::AgentRegistry;
pub use subagent::SubagentManager;

#[cfg(feature = "embeddings")]
pub use embeddings::{create_embedding_provider, EmbeddingEngine};

#[cfg(feature = "embeddings")]
pub use index_meta::IndexMeta;

#[cfg(feature = "embeddings")]
pub use memory_search::MemorySearcher;
