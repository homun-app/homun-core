# Host Computer Control (as-built)

Verificato 2026-07-31. Separate from the Docker Contained Computer.

- Helper: `runtimes/host-computer/macos` (Swift `HomunComputerService`).
- Rust client/policy: `crates/host-computer` + gateway `host_computer_gateway.rs`.
- Enablement: `HOMUN_HOST_COMPUTER=1` on macOS aarch64 (see
  [`runtime-flags.md`](runtime-flags.md)).

## Boundary

Contained Computer = browser/shell inside Docker. Host Computer Control crosses
onto the macOS host only through the signed helper, only for apps the user
granted, with Accessibility / Screen Recording owned by the OS.

Path (as wired today): UI → loopback gateway → host-computer worker turn →
Unix-domain socket + session secret → helper → macOS APIs.

Approvals, redaction, and physical takeover safety stay on the gateway/helper
boundary — do not invent a second permission path in the renderer.
