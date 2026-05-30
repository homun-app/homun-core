# Decision 0009: Capability execution containment (workspace = sandbox root)

Date: 2026-05-30

## Status

Accepted. Target model for P4 connectors (MCP, skills, Composio); reached
incrementally. The destructive-action approval gate and "prefer remote/WASM"
posture apply immediately; the per-workspace OS filesystem sandbox is the
hardening step landed alongside local stdio MCP.

## Context

P4 lets the user CONNECT third-party tools — MCP servers, skills, Composio.
These EXECUTE on the user's machine, which raises a containment question the
existing model does not answer:

- **Workspace isolation (P4.1) is DATA scoping, not security.** `active_workspace_id()`
  re-scopes which tasks/memory/capabilities a project sees; it does not contain
  what a spawned process can do.
- **The capability policy is at the CALL boundary.** `CapabilityFacade` enforces
  grants/autonomy/allowed_actions on the tool-CALLS the assistant *chooses*. It
  does **not** constrain a process once spawned: `McpStdioTransport::spawn(command)`
  launches an arbitrary process with the user's full privileges. A buggy or
  malicious MCP server could delete files regardless of the call policy.
- There is **no Docker/container/sandbox-exec/seccomp** anywhere in the codebase.
- The skill runtime already has a **real** sandbox: WASM via wasmtime (fuel-
  limited, no host imports → cannot touch the OS). Process skills run as the user.

So "prevent connectors from deleting important data" requires **filesystem
confinement**, not more call-boundary policy.

## Decision

A **tiered containment model**, using the workspace as the security boundary —
not a single mechanism, and not Docker-by-default:

1. **Remote connectors are safe by construction.** Composio and remote/HTTP MCP
   run off-device and cannot touch local files. Contain them with the existing
   approval gate + (future) network policy. **Prefer them.**
2. **Skills default to WASM** (existing wasmtime sandbox). Process execution only
   for skills the user explicitly marks trusted.
3. **Local stdio MCP (arbitrary process) is filesystem-confined to the active
   workspace directory.** The connector may write only inside that project's
   workspace dir; the rest of the disk is read-only/hidden. Implemented per-OS:
   macOS `sandbox-exec` (seatbelt) first, Linux `bubblewrap` next, Windows later.
   Where no OS sandbox is available, fall back to trust + approval and surface
   the reduced guarantee explicitly.
4. **Destructive actions always require explicit approval** (delete/overwrite/
   move/purchase/login/payment), across every surface (shell, browser, tools) —
   defense in depth, independent of the sandbox.

**The workspace is both the data scope (P4.1) and the filesystem sandbox root.**
A connector in "Project B" cannot read or write "Project A" or the user's
documents — isolation becomes a real boundary, not just a data filter.

## Consequences

- **Pro**: real containment where it matters (local MCP), zero overhead where it
  doesn't (cloud/WASM); no mandatory Docker install; builds on P4.1 with no new
  architecture (the workspace dir already exists as the boundary).
- **Con / work**: per-OS sandbox wrappers are platform-specific effort; macOS
  ships first. Until a platform's wrapper lands, local process connectors there
  rely on trust + approval (must be stated in the connect UI).
- **Immediate**: destructive-action approval + "prefer remote/WASM" posture are
  in effect now. Composio (P4.3 first) needs no local sandbox — it is remote.
- The connect UI must show each connector's containment level (remote / WASM /
  sandboxed-process / trusted-process) so the user grants with eyes open.

## Addendum — Composio distribution model: DIRECT / BYO key (local-first)

The product is distributed (downloadable, single-user-per-install). OpenHuman
(our reference) offers two Composio modes: a **backend tenant** (OpenHuman's
server holds their Composio key, pays billing, custodies all users' OAuth tokens,
gets webhooks) and a **direct** mode (the user supplies their own Composio key,
sovereign, poll-based, no webhooks). The frictionless "no key" experience is the
backend mode — it requires operating a cloud service.

Decision: **we use DIRECT / BYO key only.** No backend tenant. Each user creates
their own (free) Composio account and pastes their own API key once (stored
encrypted, per-workspace); per-service connection uses Composio's **hosted auth
`link()`** flow (NOT the deprecated `initiate()`, sunset 2026-05-08 for new orgs)
— click → `connectUrl` → browser OAuth → poll status → connected. Consequences:
no server to run, no Composio cost or token custody for the maintainer, true
local-first; trade-off is the one-time Composio signup and poll-based sync (no
real-time trigger webhooks). The args-aware gate (list/connect free, execute
behind approval) carries over from OpenHuman.
