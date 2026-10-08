# Owned terminal execution: H09/H10

Homun currently has material tools and supervised MCP, but no native terminal
backend. Docker daemon 29.4.3 is available locally; cached images exist. Implement
an owned execution port, starting with Docker. Do not expose it to agents before
application approval/state/API/UI integration is complete.

Alternatives: local Popen is simpler but process ownership/reconnection and host
access need a different contract; a custom MCP terminal reuses current approval
UI but substitutes integration for the missing owned capability. Docker gives
separate daemon-owned lifetimes and inspectable pinned containers. Local, SSH,
PTY/stdin and other Hermes backends remain requirements, not exclusions.

Backend spec: exact image SHA256, workspace/run/call identity, command, dedicated
workspace under an engine-owned root. No host home/socket mount, host environment
forwarding, implicit image pull or network in this initial policy. CPU/memory/PID
limits, dropped capabilities, no-new-privileges, init. Host-shell-free Docker argv;
only /bin/sh inside the approved image interprets command text.

Deterministic names and owner/contract labels permit reconnect. Durable exclusive
intent marker precedes Docker IO. Repeated start never starts an existing or
removed container. A crash/timeout with missing container is uncertain, never an
automatic fresh execution. Removal retains intent. Ownership mismatch prevents
inspect/log/stop/remove. Stop addresses exactly one owned container.

The backend stores no command output in markers, bounds CLI memory/log previews
and reports clipped logs/exit/OOM states truthfully. Final resource deletion only
explicitly targets fixture-owned containers; no global prune. Tests must include
same-call concurrency/reconnect/no redispatch, contract changes, symlink rejection,
real stdout/nonzero exit/stop and persistence of workspace files.

Following tranche: application-approved job proposals and durable runtime state,
agent tool registration and native result routing, background deadline/watchdog,
UI consent/status, file tools and artifact import, PTY and stdin. Backend alone
is not operational H09 parity and must not be advertised as an agent tool.
