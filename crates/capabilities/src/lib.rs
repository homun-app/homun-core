mod audit;
mod channel;
mod error;
mod facade;
mod mcp;
mod policy;
mod provider;
mod types;

pub use audit::{CapabilityAuditEvent, InMemoryCapabilityAudit};
pub use channel::{
    ChannelCapabilities, ChannelMessage, ChannelProvider, FakeChannelProvider,
    OutboundChannelMessage,
};
pub use error::{CapabilityError, CapabilityResult};
pub use facade::{CapabilityFacade, ToolAccessPlan};
pub use mcp::{
    InMemoryMcpTransport, McpCapabilityProvider, McpStdioConfig, McpStdioTransport, McpToolPolicy,
    McpTransport,
};
pub use policy::{CapabilityPolicy, PolicyContext, ToolAccessDecision};
pub use provider::{CapabilityProvider, FakeCapabilityProvider};
pub use types::*;
