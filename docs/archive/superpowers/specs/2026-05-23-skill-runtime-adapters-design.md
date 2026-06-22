# Skill Runtime Adapters Design

## Goal

Add a real local runner adapter behind `SkillRunner` so trusted local skills can execute through a hardened process boundary while preserving the sandbox policy, capability policy and Durable Task Runtime path.

## Scope

This block implements a process adapter for trusted/local handlers. It does not claim full untrusted-code isolation because portable Rust process spawning cannot prevent network access or arbitrary syscalls by itself. The runtime still verifies declared access intent and runner-reported trace. A future WASM or QuickJS adapter must provide stronger runtime confinement for untrusted plugins.

## Architecture

Add `ProcessSkillRunner` to `crates/skill-runtime`.

The adapter:

- launches a configured executable directly, never through a shell.
- requires executable and working directory to be inside configured local roots.
- clears inherited environment by default.
- passes only explicit env vars.
- writes `SkillRuntimeRequest` JSON to stdin.
- expects `SkillRuntimeOutput` JSON on stdout.
- captures stderr for audit-safe failure messages.
- kills the child on timeout.
- rejects stdout larger than the request `max_output_bytes`.

The existing `SkillRuntime` remains the security boundary coordinator: it validates request intent before the runner and validates output trace after the runner.

## Protocol

Input stdin:

```json
{
  "manifest": {},
  "tool_name": "calendar.search",
  "arguments": {},
  "declared_access": [],
  "limits": {}
}
```

Output stdout:

```json
{
  "output": {},
  "trace": {
    "accessed_network": [],
    "accessed_filesystem": []
  }
}
```

## Security Limits

The process runner is hardened but not a complete untrusted sandbox. It is suitable for:

- first-party local handlers.
- reviewed/trusted local skills.
- wrappers around already sandboxed runtimes.

It is not sufficient for arbitrary downloaded plugin code. That requires a WASM/QuickJS/process isolation adapter with OS/runtime-level network and filesystem confinement.

## Testing

Tests cover:

- config rejects executable and working directory outside allowed roots.
- runner sends request JSON to stdin and parses output JSON from stdout.
- inherited env is cleared and only explicit env vars survive.
- timeout kills long-running child.
- bad JSON and non-zero exit become runner failures.
- trace/output still pass through `SkillRuntime` post-run validation.
