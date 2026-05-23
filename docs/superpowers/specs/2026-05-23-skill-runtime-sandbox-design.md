# Skill Runtime Sandbox Design

## Goal

Execute local skill tools through a production-safe runtime boundary that validates manifests, declared permissions, filesystem scopes, network hosts and tool input before any skill runner is called.

## Scope

This block creates the runtime boundary and orchestration integration. It does not download plugins, install marketplace packages or run arbitrary unreviewed code directly from disk. External process, WASM or QuickJS adapters can be added behind the same `SkillRunner` trait once they provide real OS/runtime confinement.

## Architecture

Add a new crate `crates/skill-runtime` so sandbox execution depends on the Capability Layer, not the other way around. The existing `crates/capabilities` crate keeps registry and policy definitions. The new crate provides:

- `SkillRuntimeRequest`: manifest, tool name, arguments and optional declared access intent.
- `SkillRuntimeOutput`: JSON output plus an audit-safe execution trace.
- `SkillRuntimeLimits`: timeout and output-size budget carried through the boundary.
- `SkillSandboxPolicy`: validates tool existence, JSON schema basics, declared network hosts and filesystem paths.
- `SkillRunner`: trait for concrete execution adapters.
- `InMemorySkillRunner`: deterministic runner for tests and first-party local handlers.
- `SkillRuntime`: facade that validates pre-run intent, calls a runner and verifies post-run trace.
- `SkillRuntimeCapabilityProvider`: executable `CapabilityProvider` for skill manifests.

## Security Model

The runtime is deny-by-default:

- tool must exist in the manifest.
- arguments must satisfy the manifest input schema basics.
- requested network hosts must be declared by `SkillPermissions.network`.
- requested filesystem paths must stay inside declared filesystem roots.
- runner-reported network/filesystem trace is checked again after execution.
- output exceeding `max_output_bytes` is rejected.

The `SkillRunner` contract is explicit: adapters must enforce the same allowlists at the actual runtime boundary. The in-memory runner is safe because it does not touch the OS. Future process/WASM/QuickJS runners must pass the same test suite plus adapter-specific confinement tests before being used for untrusted plugins.

## Orchestration

`SkillRuntimeCapabilityProvider` exposes manifest tools as `CapabilityTool` values with provider kind `skill`. It can be registered in `CapabilityFacade`, so the existing policy, audit and `CapabilityTaskRuntimeBridge` continue to work. Skill tasks use the existing `background_maintenance` resource class.

## Non-Goals

- no marketplace.
- no remote install.
- no arbitrary process execution from plugin path.
- no cloud API.
- no bypass of `CapabilityFacade` or `Durable Task Runtime`.
