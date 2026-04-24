pub mod add_data;
pub mod approval;
pub mod automation;
pub mod bootstrap;
#[cfg(feature = "browser")]
pub mod browser;
pub mod contacts;
#[cfg(feature = "channel-email")]
pub mod email_inbox;
pub mod file;
#[cfg(feature = "mcp")]
pub mod mcp;
#[cfg(feature = "mcp")]
pub mod mcp_token_refresh;
pub mod message;
pub mod registry;
pub mod response_blocks;
pub mod sandbox;
pub mod send_file;
pub mod shell;
pub mod skill_create;
pub mod spawn;
pub mod vault;
pub mod view_file;
pub mod web;
pub mod workflow;

#[cfg(feature = "embeddings")]
pub mod knowledge;
#[cfg(feature = "embeddings")]
pub mod remember;

pub use approval::{
    global_approval_manager, init_approval_manager, ApprovalDecision, ApprovalId, ApprovalLogEntry,
    ApprovalManager, ApprovalResponse, PendingApproval,
};
pub use automation::AutomationTool;
#[cfg(feature = "browser")]
pub use browser::{BrowserSession, BrowserTool};
pub use contacts::ContactsTool;
#[cfg(feature = "channel-email")]
pub use email_inbox::ReadEmailInboxTool;
pub use file::{EditFileTool, ListDirTool, ReadFileTool, WriteFileTool};
#[cfg(feature = "mcp")]
pub use mcp::{McpManager, McpPeer, McpServerInfo};
pub use message::MessageTool;
pub use registry::{Tool, ToolContext, ToolRegistry, ToolResult};
pub use response_blocks::{extract_blocks, BlockOption, BlockResponse, ChoiceBlock, ResponseBlock};
pub use shell::ShellTool;
pub use skill_create::CreateSkillTool;
pub use spawn::SpawnTool;
pub use vault::VaultTool;
pub use web::{WebFetchTool, WebSearchTool};
pub use workflow::WorkflowTool;

#[cfg(feature = "embeddings")]
pub use knowledge::KnowledgeTool;
#[cfg(feature = "embeddings")]
pub use remember::RememberTool;
