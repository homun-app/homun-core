# Remove Adaptive Scaffolding Floor

## Decision

Remove the user-facing and runtime adaptive-scaffolding experiment. Homun keeps one canonical agent-loop behavior for every model. The permanent harness floor—memory, context, tool envelope, plan precedence, stop conditions, approval, and safety—does not change.

## Scope

- Remove the Settings toggle and its translations.
- Remove `adaptive_floor` from the desktop bridge and runtime-settings contract.
- Remove the `off`/`shadow`/`on` resolver, telemetry, tier-derived scaffold profile, workflow relaxation, and tier-dependent verification branch.
- Keep capability-tier model selection because it is independently used by role routing.
- Keep deterministic capability and plugin routing unchanged.
- Update current architecture/status documentation to describe the single canonical loop. Preserve ADR 0018 and archived plans as historical records, marking the ADR superseded rather than rewriting history.

## Canonical behavior after removal

- Heuristic workflow matches continue to use their declared workflow route.
- Deterministic plugin bindings continue to force their declared route.
- Step completion continues to use the existing evidence-based verification gate uniformly.
- The runtime settings endpoint remains backward-compatible with old JSON files: the removed key is ignored during deserialization and omitted on the next write.

## Verification

- A UI contract test proves the adaptive-floor control and labels are absent.
- Gateway tests prove runtime settings no longer expose or preserve the removed key.
- Existing workflow routing and step verification tests remain green.
- Desktop typecheck/build and targeted gateway tests pass.

