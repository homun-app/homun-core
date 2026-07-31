# Contained Computer And noVNC Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrare Homun Computer come pronto soltanto quando container, CDP e noVNC sono realmente utilizzabili e connessi.

**Architecture:** Il gateway pubblica una readiness machine verificata; il viewer noVNC comunica `connecting|connected|disconnected|failed` al parent. Il desktop distingue disponibilità, attività e connessione invece di dedurle da `novnc_url`.

**Tech Stack:** Rust, Docker, noVNC/RFB, Electron iframe, React 19, Node test runner.

---

## File structure

- Preserve and extend current dirty changes in `runtimes/contained-computer/{novnc-view.html,novnc-view.js,Dockerfile,up.sh}`.
- Modify `crates/desktop-gateway/src/{sandbox.rs,main.rs,novnc_proxy.rs}`: health/readiness.
- Modify `apps/desktop/src/lib/coreBridge.ts` and `components/{ChatComputerPanel,ContainedComputerView}.tsx`.
- Modify `apps/desktop/tests/contained-computer-package.test.mjs` and UI contracts.

### Task 1: Integrare senza perdere il fix CSP già presente

**Files:**
- Modify: `runtimes/contained-computer/novnc-view.html`
- Modify: `runtimes/contained-computer/novnc-view.js`
- Modify: `runtimes/contained-computer/Dockerfile`
- Modify: `runtimes/contained-computer/up.sh`
- Modify: `crates/desktop-gateway/src/sandbox.rs`
- Modify: `apps/desktop/tests/contained-computer-package.test.mjs`

- [ ] **Step 1: Record the existing diff before editing**

Run: `git diff -- runtimes/contained-computer apps/desktop/tests/contained-computer-package.test.mjs crates/desktop-gateway/src/sandbox.rs`

Expected: external `lfpa-view.js`, Docker COPY, hash inputs and CSP test are present. If absent, restore those exact changes from commit/diff evidence before continuing.

- [ ] **Step 2: Run the current package test**

Run: `cd apps/desktop && npm run test:contained-computer-package`

Expected: PASS for the external viewer module; any failure is fixed before readiness work.

- [ ] **Step 3: Commit only the existing CSP slice if still uncommitted**

```bash
git add runtimes/contained-computer/novnc-view.html runtimes/contained-computer/novnc-view.js runtimes/contained-computer/Dockerfile runtimes/contained-computer/up.sh crates/desktop-gateway/src/sandbox.rs apps/desktop/tests/contained-computer-package.test.mjs apps/desktop/scripts/check-ui-contract.mjs apps/desktop/src/components/ChatComputerPanel.tsx
git commit -m "fix(computer): load the embedded noVNC viewer under CSP"
```

### Task 2: Pubblicare readiness verificata

**Files:**
- Modify: `crates/desktop-gateway/src/sandbox.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/novnc_proxy.rs`
- Modify: `apps/desktop/src/lib/coreBridge.ts`

- [ ] **Step 1: Write RED state tests**

```rust
#[test]
fn readiness_requires_container_cdp_and_novnc() {
    assert_eq!(computer_readiness(true, true, true, None).phase, "ready");
    assert_eq!(computer_readiness(true, false, true, None).phase, "starting");
    assert_eq!(computer_readiness(true, true, false, Some("novnc_unreachable")).phase, "failed");
}
```

- [ ] **Step 2: Run RED**

Run: `cargo test -p local-first-desktop-gateway readiness_requires_container -- --nocapture`

- [ ] **Step 3: Implement the read model**

```rust
#[derive(Debug, Serialize, PartialEq, Eq)]
struct ComputerReadiness { phase: &'static str, container_ok: bool, cdp_ok: bool, novnc_ok: bool, error_code: Option<String> }
fn computer_readiness(container_ok: bool, cdp_ok: bool, novnc_ok: bool, error: Option<&str>) -> ComputerReadiness {
    let phase = if error.is_some() { "failed" } else if container_ok && cdp_ok && novnc_ok { "ready" } else if container_ok { "starting" } else { "off" };
    ComputerReadiness { phase, container_ok, cdp_ok, novnc_ok, error_code: error.map(str::to_string) }
}
```

Probe noVNC with bounded GET `/lfpa-view.html`, CDP with the existing resolver, and container state without touching the idle timer. Add these fields to `ContainedComputerLiveResponse` and `ContainedComputerLive`.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p local-first-desktop-gateway readiness_ -- --nocapture
cargo test -p local-first-desktop-gateway novnc_ -- --nocapture
git add crates/desktop-gateway/src/sandbox.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/novnc_proxy.rs apps/desktop/src/lib/coreBridge.ts
git commit -m "feat(computer): expose verified container readiness"
```

### Task 3: Confermare la connessione RFB nel desktop

**Files:**
- Modify: `runtimes/contained-computer/novnc-view.js`
- Modify: `apps/desktop/src/components/ChatComputerPanel.tsx`
- Modify: `apps/desktop/src/components/ContainedComputerView.tsx`
- Modify: `apps/desktop/tests/contained-computer-package.test.mjs`

- [ ] **Step 1: Add failing viewer contract assertions**

```js
assert.match(viewerModule, /parent\.postMessage\(\{ type: "homun-novnc-state", state: "connected" \}/);
assert.match(chatPanel, /homun-novnc-state/);
assert.match(chatPanel, /computerConnectionState === "connected"/);
```

Run: `cd apps/desktop && npm run test:contained-computer-package`

- [ ] **Step 2: Emit and consume connection states**

```js
function publish(state, detail = null) {
  parent.postMessage({ type: "homun-novnc-state", state, detail }, location.origin);
}
rfb.addEventListener("connect", () => publish("connected"));
rfb.addEventListener("disconnect", (event) => publish(event.detail?.clean ? "disconnected" : "failed"));
publish("connecting");
```

The React components accept messages only when `event.origin` matches the iframe URL and `event.source === iframeRef.current?.contentWindow`. Display LIVE only for `connected`; show connecting/retry otherwise.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/desktop
npm run test:contained-computer-package
npm run test:ui-contract
npm run build
git add ../../runtimes/contained-computer/novnc-view.js src/components/ChatComputerPanel.tsx src/components/ContainedComputerView.tsx tests/contained-computer-package.test.mjs
git commit -m "fix(computer): report the real noVNC connection state"
```

### Task 4: Live gate

- [ ] **Step 1: Rebuild and start**

Run: `runtimes/contained-computer/up.sh`

Expected: `homun-cc` is running; CDP and noVNC probes are ready.

- [ ] **Step 2: Verify the rendered app**

Open the installed/dev Electron app, start a browser task, and verify the sequence `starting → ready → connected`; stop the container and verify `failed` plus Retry without a blank panel. Record `artifacts/qa/novnc-readiness.png` and the corresponding gateway log timestamps.
