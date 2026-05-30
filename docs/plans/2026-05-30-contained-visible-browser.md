# Contained, in-chat-visible browser (OpenClaw vs Manus → our plan)

Date: 2026-05-30

## Why

User feedback: the automated browser "opens and takes over the screen" — it
launches a real OS window that steals focus. Desired: the browser runs inside a
contained "computer" and is **visible as a window inside the chat**, like Manus.

## References

- **OpenClaw** (MIT, our browser-automation reference): a protocol-level browser
  CONTROL layer — CDP + Playwright, aria-ref snapshots, atomic actions,
  observe→act loop, three modes (managed / Chrome-extension relay / remote CDP).
  We already ported its *automation contract* (`browser_loop_controller.rs`,
  `runtimes/browser-automation`). It is the right reference for *how to drive* a
  browser, not for *where it runs or how it's shown*.
- **Manus**: each task gets an isolated cloud microVM (E2B/Firecracker) with a
  REAL Chromium (not headless) driven by Playwright inside it; the VM screen is
  **streamed into the web UI** ("Manus's Computer" panel). Contained + live-visible.

## Current state (evidence)

| Aspect | Before this work | Evidence |
|---|---|---|
| Default visibility | **Visible** → focus-stealing OS window | `main.rs` `browser_headless_env_value` → "0" |
| Browser/profile | Dedicated Chromium + dedicated temp profile (not the user's Chrome) | `profiles.ts`, `session_manager.ts` |
| Containment | Runs on the host; no sandbox/VM | — |
| In-chat visibility | Only sparse screenshot artifacts shown as a card; no live stream | `ChatView.tsx`, `local_computer_artifact_preview` |
| `local-computer-session` | Models surfaces (Browser/Shell/Files/Logs) + takeover + artifacts, but is a passive LOG, not a live surface | `crates/local-computer-session` |

Key realization: `local-computer-session` already models the right abstraction
(a Manus-style multi-surface computer). The work is to make it **live**, not to
invent new architecture.

## Gap

- vs OpenClaw: minor (missing extension/remote-CDP "drive my own browser" modes).
- vs Manus: (1) wrong default (focus-stealing window), (2) no live in-chat view
  (only screenshots), (3) no real containment (runs on host).

## Plan

### Phase 1 — local-first, no VM; fixes the complaint
1. **Headless by default** — DONE (this commit). No focus-stealing window;
   self-heal `restartAssistantVisible` still recovers hard sites (window only as
   last resort). `LOCAL_FIRST_BROWSER_HEADLESS=0` overrides.
2. **Per-iteration frame capture** — STAGED. Capture a screenshot artifact each
   loop iteration (best-effort, must not slow/destabilize the validated loop) so
   the EXISTING in-chat computer card updates live. Backend-only, but needs a
   running browser + unlocked screen to observe latency/stability.
3. **CDP screencast + input forwarding** — STAGED. Replace polled screenshots
   with `Page.startScreencast` frames pushed to the UI (SSE), and reinject
   click/scroll/type from the embedded panel via CDP for in-chat takeover. Needs
   a streaming channel from sidecar→gateway→UI and visual verification.

### Phase 2 — true "computer" (opt-in, later)
A contained local desktop (browser + shell + files in one streamed surface) via
a Linux microVM/container with Xvfb + window manager + VNC/noVNC embedded in the
UI. Heavier; needs virtualization (on macOS: Lima/container), in tension with the
no-Docker stance of ADR 0009 — so keep it opt-in, not default. This is the full
Manus-style "Computer" panel, on-device.

## Status

- Phase 1.1 (headless default): DONE, `cargo 76 bin / 24 lib` green.
- Phase 1.2 / 1.3 and Phase 2: staged; require a running browser and an unlocked
  screen for visual verification (the live view and any loop change to the
  signature browser feature must be observed, not changed blind).
