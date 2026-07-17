mod audit;
mod cached_provider;
mod channel;
mod error;
mod facade;
mod mcp;
mod policy;
mod provider;
mod registry;
pub mod search;
mod skill_plugin;
mod task_runtime_bridge;
mod types;
mod workflow_routing;

pub use audit::{CapabilityAuditEvent, InMemoryCapabilityAudit};
// browser_provider module retired (F1.d cleanup): the dot-named `BrowserCapabilityProvider`
// was a dormant typed twin, never instantiated. The live durable browser executor drives the
// shared sidecar directly (`execute_capability_browser_task` + `browser_method_for_capability_tool`
// in desktop-gateway), and the planner sees the real underscore-named chat tools via
// `browser_registry_cached_tools()`. See docs/architecture/browser.md divergence #6.
pub use cached_provider::CachedToolProvider;
pub use channel::{
    ChannelCapabilities, ChannelMessage, ChannelProvider, FakeChannelProvider,
    OutboundChannelMessage,
};
// composio module retired (F1.c): the pre-v3 `ComposioCapabilityProvider` was a dead
// second execution path; the live v3 path lives entirely in the desktop-gateway. See
// docs/architecture/connectors-composio.md.
pub use error::{CapabilityError, CapabilityResult};
pub use facade::{CapabilityFacade, ToolAccessPlan};
pub use mcp::{
    InMemoryMcpTransport, McpCapabilityProvider, McpStdioConfig, McpStdioTransport, McpToolPolicy,
    McpTransport, name_is_read_only,
};
pub use policy::{CapabilityPolicy, PolicyContext, ToolAccessDecision};
pub use provider::{CapabilityProvider, FakeCapabilityProvider};
pub use registry::*;
pub use skill_plugin::*;
pub use task_runtime_bridge::*;
pub use types::*;
pub use workflow_routing::{Forcing, WorkflowRouting, WorkflowRoutingRegistry, tool_matches_deny};
