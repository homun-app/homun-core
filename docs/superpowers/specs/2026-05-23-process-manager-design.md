# Process Manager Design

## Goal

Add a Rust Process Manager that supervises local sidecars and user-configured helper processes without owning scheduling, permissions or agent planning.

## Scope

The Process Manager is a base component for the Rust Core. It starts, stops, restarts and checks health for local processes such as:

- Python/MLX Gemma runtime.
- Node/TypeScript browser sidecar.
- MCP stdio servers.
- Future local skill/plugin helper processes.

It does not decide when an assistant task should run. Durable Task Runtime owns task scheduling, resources, retry and checkpoint semantics. Capability providers own tool contracts. The Process Manager only owns process lifecycle and observability.

## Architecture

Create `crates/process-manager` as a focused crate.

Main units:

- `types.rs`: process ids, kinds, specs, status, health checks, restart policy and UI snapshot contracts.
- `store.rs`: SQLite registry for configured process specs and latest lifecycle snapshots.
- `log_buffer.rs`: bounded in-memory log ring for stdout/stderr lines.
- `health.rs`: health evaluator for process-alive and HTTP GET checks.
- `supervisor.rs`: real local process supervisor using `std::process::Command`.
- `manager.rs`: orchestration facade that registers specs, starts/stops/restarts processes, polls health and exposes UI-safe status.

## Process Contract

Each process has:

- stable `ProcessId`.
- `ProcessKind`: `llm_runtime`, `browser_sidecar`, `mcp_server`, `skill_runner`, `plugin_host`, `other`.
- command, args, env and optional cwd.
- `HealthCheck`: `none`, `process_alive`, `http_get`.
- `RestartPolicy`: disabled or bounded restart count with backoff milliseconds.
- bounded log capacity.

Status values:

```text
configured
starting
running
healthy
unhealthy
exited
failed
stopped
restarting
```

## Persistence

The store persists specs and latest snapshots in SQLite. Secrets must not be embedded in specs; environment values are configuration only and future secret refs should be resolved outside this crate.

## Error Handling

Errors are typed under `ProcessManagerError`. Starting an already running process is idempotent. Stopping an unknown process returns `NotFound`. Health failures produce `unhealthy` snapshots instead of panicking.

## Testing

Tests must cover:

- contract serialization.
- SQLite migrations and round trips.
- bounded log buffer.
- fake supervisor lifecycle through `ProcessManager`.
- real local process spawn/health/log capture with a short-lived fixture command.
- HTTP health check using a local test server or injected fake probe.

## Non-Goals

- No planner/router.
- No task scheduling.
- No keychain implementation.
- No Tauri UI.
- No implicit cloud process management.
