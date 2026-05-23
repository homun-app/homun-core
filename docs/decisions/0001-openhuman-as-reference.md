# 0001 - OpenHuman as Reference, Not Blueprint

Date: 2026-05-23

## Status

Accepted.

## Context

OpenHuman (`tinyhumansai/openhuman`, inspected at commit `934546b2b3ae20271c2cd82b95e8221efb199568`) was already considered during project planning. It is useful because it is a working personal-agent harness with desktop UI, memory, integrations, tools, subagents, delegation policy and prompt-injection protections.

The project must not become an OpenHuman copy or fork. Our validated decisions remain:

- local-first by default.
- Tauri UI.
- Rust Core.
- Python/MLX/Gemma 4 runtime on Mac.
- subagents coordinated by our Rust Core.
- deny-by-default permissions.
- explicit audit trail.

## Decision

We use OpenHuman as a source of implementation patterns to study and adapt, not as a codebase to import.

Ideas from OpenHuman must pass this filter before entering our roadmap:

1. What problem does the pattern solve?
2. Does it fit our local-first constraints?
3. What do we adapt to Rust Core + MLX/Gemma?
4. What do we explicitly not import?
5. How do we test the adapted behavior?

## Patterns To Adopt

| OpenHuman pattern | What we adapt | Why |
| --- | --- | --- |
| Data-driven agent definitions | `AgentDefinition` registry in Rust with id, display name, `when_to_use`, tier, tool scope and runtime limits | Avoid hardcoding every subagent in orchestration logic |
| Direct-first delegation policy | `DelegationPolicy` before spawning subagents | Prevent wasteful subagent calls for simple/direct-tool tasks |
| Visible tools vs executable tools | separate model-visible tool contracts from runtime-executable capabilities | The model should see only what it can choose; the core may hold broader execution capability |
| Typed subagent runner | keep subagent execution isolated from the parent session | Subagents produce compact, audit-ready outputs instead of becoming nested chat sessions |
| Memory facade | expose memory through a small client API | Prevent modules from bypassing memory policy and storage rules |
| Prompt-injection guard before inference/tools | guard user/tool text before model calls and tool loops | Tool execution must not begin from untrusted prompt coercion |
| Token/result compression | summarize large tool outputs before feeding them back | Prevent context flooding and reduce latency/cost |

## Patterns Not Adopted Directly

| OpenHuman pattern | Why not direct |
| --- | --- |
| Managed model routing backend | We default to local MLX/Gemma. Cloud routing is not a default primitive. |
| Composio-managed OAuth as default | Connectors may use MCP/Composio where useful, but secrets and data flow must be explicit and local-first. |
| Ollama local AI path | The validated Mac runtime is Python + MLX + `mlx-vlm`, not Ollama. |
| Full OpenHuman agent/session harness | Our core is smaller and contract-first; subagents are Rust-orchestrated tasks with JSON outputs. |

## Near-Term Implementation Impact

1. Add a data-driven `AgentDefinition` registry to `crates/subagents`.
2. Add a `DelegationPolicy` type that encodes direct-first routing.
3. Split tool visibility from executable permissions in subagent contracts.
4. Add prompt-injection guard contracts before runtime calls.
5. Add memory facade before implementing Memory Core internals.

## Source Notes

Relevant OpenHuman files inspected:

- `docs/agent-subagent-tool-flow.md`
- `docs/DELEGATION_POLICY.md`
- `docs/memory-sync-functions.md`
- `docs/PROMPT_INJECTION_GUARD.md`
- `src/openhuman/agent/harness/definition.rs`
- `src/openhuman/agent/harness/tool_filter.rs`
- `src/openhuman/tools/orchestrator_tools.rs`
- built-in `agent.toml` examples under `src/openhuman/agent/agents/`
