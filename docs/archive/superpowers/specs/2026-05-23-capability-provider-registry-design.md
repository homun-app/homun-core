# Capability Provider Registry Design

## Goal

Persist provider configuration and user/workspace grants so the Capability Layer can be reconstructed after restart and durable tasks can execute without relying on in-memory test setup.

## Scope

The registry belongs to `crates/capabilities`. It stores provider metadata, enablement, grants, connection metadata, tool cache and resource hints. It does not store raw secrets and does not instantiate live providers by itself.

In scope:

- SQLite-backed registry store.
- Provider config per provider id.
- User/workspace grants.
- Managed-cloud opt-in per user/workspace/provider.
- Privacy domains and action grants.
- Connection metadata with `secret_ref`, never raw secret.
- Tool catalog cache.
- Resource hints for TaskRuntime scheduling.
- Derive `PolicyContext` from persisted grants.

Out of scope:

- Keychain/secret storage implementation.
- OAuth flows.
- Live provider process management.
- UI screens.
- Hosted webhook receivers.

## Data Model

Provider config:

- `provider_id`
- `provider_kind`
- `display_name`
- `enabled_by_default`
- `managed_metadata`
- `resource_class`
- `rate_limit_per_minute`
- `created_at`
- `updated_at`

Provider grant:

- `provider_id`
- `user_id`
- `workspace_id`
- `enabled`
- `allow_managed_cloud`
- `privacy_domains`
- `allowed_actions`
- `max_autonomy_level`
- `created_at`
- `updated_at`

Connection config:

- `connection_id`
- `provider_id`
- `user_id`
- `workspace_id`
- `status`
- `display_name`
- `privacy_domains`
- `secret_ref`
- `metadata`

Tool cache:

- provider id.
- tool name.
- action class.
- privacy domains.
- sensitivity.
- input schema.
- cached at.

## Policy Context

The registry derives `PolicyContext` for a user/workspace by combining enabled grants:

- `enabled_providers`: all enabled providers for that scope.
- `privacy_domains`: union of granted domains.
- `allowed_actions`: union of granted actions.
- `max_autonomy_level`: maximum granted autonomy level.
- `allow_managed_cloud`: true only if at least one enabled managed grant opts in.

Provider-specific managed-cloud denial still remains enforced by `CapabilityPolicy`.

## Security Rules

- No raw OAuth token, API key, password or session secret is stored.
- `secret_ref` points to future secure storage/keychain entries.
- Managed providers are disabled unless explicitly granted for user/workspace.
- Tool cache is metadata only.
- Registry reads are scoped by user/workspace.

## Testing

Tests must cover:

- idempotent schema creation.
- provider config roundtrip.
- grants derive correct `PolicyContext`.
- disabled grants are excluded.
- managed cloud opt-in is explicit.
- connection metadata stores secret refs, not raw secret values.
- tool cache roundtrips tool schemas.
- resource hints are retained for task runtime scheduling.

