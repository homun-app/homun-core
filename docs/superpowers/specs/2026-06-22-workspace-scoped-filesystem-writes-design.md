# Workspace-scoped filesystem writes (Path B)

## Problem

Every MCP write currently produces a confirmation card. This serializes ordinary
multi-file deliverables even when the user has explicitly associated the thread
with a project folder. The existing per-server “always allow” setting is too
broad: it authorizes all writes from a server, regardless of path or thread.

## Goal

Allow routine `mcp:filesystem` writes without confirmation only inside the
explicit project folder of the originating thread. Keep confirmation for every
other path, workspace-less/personal thread, MCP provider, and external action.

## Scope and non-scope

In scope: `mcp:filesystem` `create`, `insert`, and `str_replace`, which expose
one absolute `path` in their cached, trusted MCP contract.

Out of scope: a generic allowlist for arbitrary MCP servers, Composio writes,
channel sends, shell commands, filesystem reads, and changing the user-visible
approval UI. Those retain their existing policy.

## Design

The gateway defines a static `WorkspaceScopedMcpManifest` for provider
`mcp:filesystem`. It lists the exact write tool names and the JSON-pointer path
argument they declare (`/path`). This is a capability contract, not inference
from tool name, prose, or argument keys.

For each candidate write, `workspace_scoped_mcp_write` resolves the origin
thread’s workspace through `project_root_for_thread`. It returns eligible only
when the manifest matches and all declared paths pass an absolute, symlink-safe
jail under that root. The jail accepts a target that does not yet exist by
canonicalizing its deepest existing ancestor; it rejects `..`, root escapes, and
symlinks that resolve outside the project.

The chat loop skips the confirm card only when this policy returns eligible.
`run_mcp_chat_tool` receives an execution authority: `WorkspaceScoped` must
pass the root jail, while `Confirmed` and `RemoteConfirmed` require an explicit
approval proof. The local `mcp_execute` endpoint verifies that its originating
persisted MCP-confirm marker exactly matches the tool and arguments before it
can use `Confirmed`; Telegram holds a live pending code before it may use
`RemoteConfirmed`. An out-of-scope call without one of these proofs returns a
policy error before invoking the MCP transport.

Filesystem MCP is connected once at the stable user capability scope, never
again per project. At turn construction, when both a linked project root and
the live Filesystem MCP catalog are present, the gateway injects that absolute
root into the model context. The model resolves a relative request against it;
it must not ask the user where to write or claim that the already-connected MCP
is unavailable. This is guidance only: the manifest+jail remains the actual
authorization enforcement.

## Security properties

- A configured workspace folder is the explicit user grant; personal and
  workspace-less conversations have no automatic write grant.
- The provider id, tool name, and JSON-pointer path location come from a static
  trusted manifest. No keyword or regex heuristic decides authorization.
- The guard runs before the MCP process receives the call on every execution
  path. The server may receive only validated path arguments for Path B calls.
- A bearer token to the local endpoint is not an approval proof: outside the
  workspace scope the endpoint must bind execution to its persisted confirm
  card, and remote execution to its pending approval code.
- Existing confirm paths remain the fallback for any non-eligible write.

## Acceptance criteria

1. `create`, `insert`, and `str_replace` under a project root execute without
   an MCP confirm card.
2. The same tools outside the root, through a symlink escape, or without a
   project root remain confirmation-gated and cannot execute via the direct MCP
   endpoint without explicit approval.
3. A non-filesystem MCP write remains confirmation-gated.
4. Existing approved MCP writes and Telegram approval-resume continue to work.
5. Tests prove all decisions from manifest + path evidence, with no model or
   textual heuristic involved.

## Verification

Unit tests cover manifest matching, nested allowed paths, missing targets,
`..`, symlink escape, missing project root, non-filesystem provider, and direct
execution denial. The in-app Gemma gate creates `note.md` and `riepilogo.md`
under a configured project workspace without a confirmation card; an equivalent
write outside the root still surfaces one.
