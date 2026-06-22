# Capability Layer, Channels And External Providers Design

## Goal

Define the production architecture for integrations, messaging channels, MCP tools, skills and optional managed integration providers.

The goal is to get broad connector coverage without hand-writing every provider, while preserving the project decisions already validated:

- local-first by default.
- Rust Core owns permissions, policy, audit and orchestration.
- cloud integration aggregators are optional and explicit.
- subagents never call external tools directly.
- user data only enters memory through policy-gated ingestion paths.

## Reference Model

OpenHuman is the architectural reference for this area, not code to copy. The useful patterns are:

- channels are separated from app integrations.
- integrations are exposed as typed tools.
- broad app coverage is delegated to an integration aggregator.
- each connection has auth state, tool schema discovery, execution and optional triggers.
- webviews and browser automation are fallback surfaces when APIs are weak or unavailable.
- long-running work is coordinated by a Durable Task Runtime, not by individual providers.

The parts we intentionally adapt differently:

- Composio or similar providers are not default-trusted infrastructure.
- the Rust Core keeps a provider-neutral contract instead of depending on one vendor.
- policy and audit live locally even when execution goes through a managed provider.
- secrets and connected-account metadata are stored locally with explicit privacy domains.

Primary references:

- OpenHuman: https://github.com/tinyhumansai/openhuman
- OpenHuman Skills: https://github.com/tinyhumansai/openhuman-skills
- Composio MCP: https://docs.composio.dev/mcp/introduction
- Composio Connect: https://docs.composio.dev/docs/composio-connect
- Zapier MCP: https://docs.zapier.com/powered-by-zapier/embedding-zapier-mcp/getting-started
- Pipedream MCP: https://pipedream.com/docs/connect/mcp/users/

## Scope

This design covers contracts and boundaries. Initial implementation should create a provider-neutral Rust crate with tests and fake providers before connecting live Composio, Zapier or Pipedream accounts.

In scope:

- capability provider contracts.
- tool discovery and execution contracts.
- connection lifecycle.
- trigger lifecycle.
- messaging channel abstraction.
- browser automation adapter boundary.
- skill package manifest model.
- policy enforcement before tool visibility and execution.
- audit events for every capability operation.
- local-first privacy labels for managed/cloud providers.
- resource declarations that let the Durable Task Runtime schedule expensive tools safely.

Out of scope for the first implementation:

- live OAuth with Composio/Zapier/Pipedream.
- full Tauri UI.
- complete provider catalog.
- hosted webhook receiver.
- copying OpenHuman code.
- durable scheduling, retry, queue management and checkpoint persistence.

## Component Model

### Capability Core

`crates/capabilities` should own provider-neutral contracts:

- `CapabilityProvider`
- `CapabilityTool`
- `CapabilityCall`
- `CapabilityResult`
- `CapabilityConnection`
- `CapabilityTrigger`
- `CapabilityAuditEvent`
- `CapabilityPolicy`

The crate exposes a facade, not provider internals:

```text
CapabilityFacade
  -> list_providers()
  -> list_connections(user, workspace)
  -> list_tools(request)
  -> authorize(request)
  -> call_tool(request)
  -> list_triggers(request)
  -> enable_trigger(request)
  -> disable_trigger(request)
  -> health()
```

All public methods require user/workspace identity and permission context.

### Providers

Provider categories:

- `native`: built into the app and local by default.
- `mcp`: local or remote MCP servers registered by the user.
- `managed`: Composio, Zapier MCP, Pipedream MCP or similar.
- `browser`: browser automation fallback.
- `skill`: local packages exposing tools through a sandbox.

Initial concrete providers:

- `NativeCapabilityProvider`: filesystem, git, local browser observer, memory-safe read models.
- `McpCapabilityProvider`: one generic provider for user-configured MCP servers.
- `ManagedCapabilityProvider`: interface only at first; Composio is the first intended adapter.
- `BrowserCapabilityProvider`: interface only at first; Playwright/webview implementation later.
- `SkillCapabilityProvider`: manifest and registry only at first.

Capability providers expose what can be done. They do not decide when work should run. Expensive or long-running calls declare resource needs so the Durable Task Runtime can queue, throttle or block them before execution.

### Channels

Channels are not generic app integrations. They are conversation transports:

- Telegram.
- Discord.
- Slack.
- iMessage.
- WhatsApp.
- Email.
- Web/desktop chat.

They share a separate `ChannelProvider` contract:

```text
ChannelProvider
  -> listen()
  -> send_message()
  -> send_draft()
  -> update_draft()
  -> send_reaction()
  -> start_typing()
  -> health()
```

Channels produce normalized inbound messages. The agent/subagent pipeline receives those messages through the Rust Core, not directly from provider code.

### Skills

Skills are local extension packages. They should use a manifest-based contract inspired by OpenHuman skills:

```json
{
  "id": "github-local",
  "version": "0.1.0",
  "description": "Local GitHub tools",
  "runtime": "quickjs",
  "tools": [],
  "permissions": {
    "network": ["api.github.com"],
    "filesystem": [],
    "privacy_domains": ["work"]
  }
}
```

The first implementation should validate manifests and register tools, but not execute untrusted skill code yet. Execution sandbox choice is a separate decision.

## Data Flow

### Tool Discovery

```text
User/Agent request
  -> CapabilityFacade
  -> CapabilityPolicy filters providers by identity, domain, autonomy and risk
  -> provider.list_tools()
  -> ToolAccessPolicy splits model-visible tools from executable tools
  -> audit visibility decision
  -> return tool schemas
```

The model may see a tool schema for planning while execution stays blocked unless the task envelope permits it.

### Tool Execution

```text
ToolAgent proposes call
  -> Rust Core validates schema
  -> CapabilityPolicy checks provider, tool, action, privacy domain, autonomy level and risk
  -> RiskAgent/ReviewAgent when required
  -> CapabilityProvider.call_tool()
  -> output redaction and anti-exfiltration scan
  -> MemoryFacade ingestion only when explicitly requested and policy-approved
  -> audit event
```

Subagents never hold provider clients. They emit proposed calls or structured requests; the core executes only approved calls.

### Long-Running Tool Work

Operations that may run for minutes, hours or days must be wrapped in a durable task before provider execution. Examples:

- browser booking or form workflows.
- repeated availability checks.
- connector sync jobs.
- Graphify indexing.
- large filesystem scans.
- managed-provider triggers that fan out into multiple actions.

The Capability Layer remains the provider-neutral execution boundary. The Durable Task Runtime owns queueing, priority, resource governance, checkpointing, retry/backoff, pause/resume/cancel and user-approval waits.

```text
Durable Task Runtime
  -> CapabilityFacade
  -> CapabilityProvider.call_tool()
  -> redaction / audit
  -> checkpoint result
```

Provider calls should be small and resumable where possible. If a provider has to perform a large operation, it must return enough structured state for the task runtime to explain progress and recover safely.

### Managed Provider Boundary

Managed providers are allowed only when the user enables them. Every managed provider must declare:

- cloud execution.
- provider name.
- data categories that may leave the device.
- auth mode.
- tool scopes.
- trigger behavior.
- retention/audit caveats if known.

The UI must show this as a privacy boundary, not as an invisible implementation detail.

## Storage

`crates/capabilities` should use SQLite and local encryption for:

- providers.
- connections.
- tool catalog cache.
- trigger configs.
- user/workspace policy grants.
- audit events.
- OAuth/API-key references.

Scheduling state is intentionally excluded from the capability store. Task state, queues, leases, resource budgets and checkpoints belong to `crates/task-runtime`.

Secrets should not be embedded in plain JSON payloads. Initial implementation can mirror the memory crate's application-level encryption pattern.

## Error Handling

Errors should be typed:

- `ProviderUnavailable`
- `ProviderNotEnabled`
- `ConnectionRequired`
- `AuthorizationRequired`
- `PermissionDenied`
- `PolicyDenied`
- `SchemaValidationFailed`
- `ToolExecutionFailed`
- `TriggerFailed`
- `SecretUnavailable`
- `ManagedProviderBoundary`

Managed provider failures should preserve provider status and retryability without leaking secrets.

## Security Rules

- deny by default.
- provider enablement is per user/workspace.
- every tool has action class: `read`, `draft`, `write_with_confirmation`, `approved_automation`.
- every tool has privacy domains and sensitivity bounds.
- trigger payloads are treated as untrusted input.
- prompt injection checks run before exposing retrieved tool output to subagents.
- browser automation is always high risk unless scoped to an approved domain and action.
- managed providers cannot bypass local audit.

## Testing Strategy

Initial tests should use fake providers:

- provider registry lists enabled and disabled providers.
- policy hides tools from unauthorized users.
- model-visible tools can differ from executable tools.
- managed provider calls require explicit cloud permission.
- tool call schema validation rejects malformed arguments.
- trigger setup records audit and policy.
- channel messages normalize sender, target, thread and content.
- secret fields are redacted from audit.
- multiuser isolation prevents cross-user connection access.

Live provider tests should be opt-in only and excluded from `make test`.

## Production Readiness Criteria

The Capability Layer is production-ready when:

- it has provider-neutral contracts.
- fake providers cover discovery, auth, call, triggers and failures.
- policy is enforced before visibility and before execution.
- all calls are audited.
- multiuser and workspace isolation are tested.
- managed/cloud providers are explicitly marked and gated.
- memory ingestion goes through `MemoryFacade`.
- subagents can use capability tools only through core-mediated calls.
- `make test` passes without live external accounts.

## First Implementation Slice

Implement the local contracts before live integrations:

1. Create `crates/capabilities`.
2. Add contracts and typed errors.
3. Add in-memory or SQLite registry.
4. Add fake native provider.
5. Add policy-gated `CapabilityFacade`.
6. Add audit events.
7. Add channel contracts and normalized message structs.
8. Add managed provider metadata/gating, without live Composio yet.
9. Add tests for all boundary rules.

After this is stable, implement `McpCapabilityProvider`, then Composio as the first managed provider adapter.
