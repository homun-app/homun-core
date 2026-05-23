# Skill Plugin Registry Design

## Goal

Make local skills and plugins first-class capability records that can be installed, versioned, permission-reviewed and surfaced to the orchestrator without coupling the assistant to a specific plugin runtime.

## Scope

This block implements the local registry and provider boundary only. It does not execute arbitrary plugin code. Execution remains a later sandbox/runtime concern. The registry must be enough for UI, policy, subagents and task runtime to know what is installed, what tools are exposed, what permissions are requested and whether a user/workspace enabled them.

## Architecture

The Capability Layer owns skill/plugin discovery state because skill tools must be filtered by the same provider, privacy-domain, action and autonomy policy used for MCP, native connectors, managed providers and browser automation.

The implementation adds focused contracts:

- `SkillManifest`: static local skill manifest with id, version, runtime, tools and requested permissions.
- `SkillToolManifest`: one tool declaration inside a skill manifest.
- `PluginManifest`: plugin package manifest with plugin metadata and bundled skills.
- `SkillInstallRecord`: user/workspace install state, source path, enabled flag, trust level and timestamps.
- `PluginInstallRecord`: user/workspace plugin install state, source path, enabled flag, trust level and timestamps.
- `SkillPluginRegistryStore`: SQLite persistence for manifests and install records.
- `SkillCapabilityProvider`: read-only provider adapter that exposes enabled skill tools as `CapabilityTool` values.

## Data Model

Manifest records are global and immutable-by-id-version from the user's perspective. Install records are scoped by `user_id` and `workspace_id`, because two users or workspaces may trust different skills or enable different plugin bundles.

The registry stores manifest JSON and normalized columns used for filtering:

- skill id and version.
- plugin id and version.
- runtime.
- enabled status.
- trust level.
- source path.
- privacy domains and actions from each tool declaration.

The registry never stores executable code blobs. Paths point at local files under project/user-controlled plugin roots; path confinement for installation will be handled by the later installer block.

## Policy

Skill tools are provider kind `skill`, provider id `skill:<skill_id>`, and resource class `background_maintenance`. They are invisible unless the install record is enabled for the current user/workspace and the resulting provider is enabled in `PolicyContext`.

Permissions are deny-by-default:

- network hosts and filesystem scopes are declared in `SkillPermissions`.
- privacy domains are declared both globally on permissions and per tool.
- actions are explicit per tool.
- `SkillCapabilityProvider` exposes tools only from enabled install records.
- `CapabilityPolicy` decides model visibility and executable access.

## Orchestration

The provider adapter does not execute tools. If called directly it returns a clear execution-unavailable error. The later executor block will route skill calls through a sandboxed skill runtime and Durable Task Runtime. This keeps the current block production-safe: skill declarations can be reviewed, shown and policy-filtered without enabling unsafe arbitrary execution.

## UI Readiness

The registry exposes install records and manifests without raw executable code. UI can render:

- installed skills/plugins by user/workspace.
- enabled/disabled status.
- trust level.
- requested network/filesystem/privacy permissions.
- visible and executable tools after policy filtering.

## Testing

Tests must cover:

- manifest serialization and multilingual descriptions.
- install records scoped by user/workspace.
- disabled installs excluded from provider tools.
- plugin manifests registering bundled skills.
- policy filtering through `CapabilityFacade`.
- schema migrations idempotent.

## Non-Goals

- no marketplace.
- no remote plugin download.
- no sandboxed execution.
- no automatic install from arbitrary paths.
- no cloud dependency.
