# Mac Apps Beta Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the existing Host Computer Control implementation onto current `main` as an Apple Silicon-only, off-by-default Mac Apps beta with layered consent, isolated agent delegation, local-only screenshots, reactive UI, and release-grade verification.

**Architecture:** Keep the signed Swift helper as a primitive-only macOS boundary and the Rust gateway as the canonical owner of opt-in, grants, action policy, redaction, sessions, and audit. Expose only `use_computer(goal, app?)` to the manager when the persisted beta opt-in, effective TCC permissions, and at least one valid app grant all pass; granular tools remain confined to the existing host-only worker.

**Tech Stack:** Rust workspace (`axum`, `rusqlite`, `serde`), Swift/AppKit/Accessibility/ScreenCaptureKit, Electron, React/TypeScript, Node test runner, GitHub Actions, electron-builder, Apple code signing and notarization.

---

## File responsibility map

- `crates/host-computer/`: protocol, grants, redaction, policy, session coordinator, IPC client and artifacts; no UI or model orchestration.
- `runtimes/host-computer/macos/`: signed native helper and deterministic fixture; no grants, approvals, memory, or autonomous decisions.
- `crates/desktop-gateway/src/host_computer_gateway.rs`: beta runtime lifecycle, API handlers, worker boundary, session cancellation, snapshot registry, policy enforcement, and redacted journal projection.
- `crates/desktop-gateway/src/main.rs`: persisted runtime setting, HTTP routes, manager tool registration, `use_computer` dispatch, and isolated worker loop.
- `apps/desktop/src/lib/coreBridge.ts`: typed UI contract for beta state, settings, grants, and sessions.
- `apps/desktop/src/components/SettingsView.tsx`: opt-in, TCC status, per-app Observe/Control grants, revocation, and reactive refresh.
- `apps/desktop/src/components/ChatComputerPanel.tsx`: active Mac Apps status, approvals, takeover, pause, and stop.
- `apps/desktop/src/styles.css` and locale JSON files: flat responsive presentation and complete translations.
- `apps/desktop/electron/` plus `apps/desktop/scripts/`: helper discovery, factory reset, packaging, signing, and installed-bundle verification.
- `docs/testing/host-computer-macos-matrix.md`: canonical automated, visual, physical, and signed-artifact evidence.

### Task 1: Rebase the isolated implementation onto the current product baseline

**Files:**
- Review: every path in `git diff --name-only $(git merge-base main HEAD)..HEAD`
- Preserve from current `main`: adaptive-floor removal, provider usage, ODT ingestion, universal inspector, onboarding defaults, and launch-media documentation
- Verify: `Cargo.toml`, `Cargo.lock`, `crates/desktop-gateway/src/main.rs`, `apps/desktop/src/components/SettingsView.tsx`, `apps/desktop/src/styles.css`, `apps/desktop/package.json`

- [ ] **Step 1: Confirm both worktrees before rewriting history**

Run:

```bash
git -C /Users/fabio/Projects/Homun/app status --short --branch
git status --short --branch
git rev-list --left-right --count HEAD...main
```

Expected: the host-computer worktree is clean; unrelated deletions and `homun-tablet-full.png` remain only in the main checkout; divergence is recorded before rebase.

- [ ] **Step 2: Create a local recovery branch**

Run:

```bash
git branch -f fabio/host-computer-control-pre-integration HEAD
git show-ref --verify refs/heads/fabio/host-computer-control-pre-integration
```

Expected: the recovery ref resolves to commit `4f87a85a` or the current spec commit if the branch advanced legitimately.

- [ ] **Step 3: Rebase all feature commits onto current `main`**

Run:

```bash
BASE=$(git merge-base main HEAD)
git rebase --onto main "$BASE"
```

Conflict rules:

```text
Keep current main behavior for removed Adaptive scaffolding floor code.
Keep current main behavior for usage analytics, ODT ingestion, inspector, and onboarding.
Reapply only host-computer imports, routes, tool delegation, UI, helper packaging, and tests.
Never resolve by accepting an entire old main.rs, SettingsView.tsx, styles.css, package.json, or lockfile.
```

Expected: rebase completes with no merge commits and the main checkout remains untouched.

- [ ] **Step 4: Compare the rewritten series to the recovery branch**

Run:

```bash
git range-diff main...fabio/host-computer-control-pre-integration main...HEAD
git diff --check main...HEAD
```

Expected: every host-computer capability remains represented, changes from current `main` are not reverted, and no whitespace errors are reported.

- [ ] **Step 5: Run the existing host-computer baseline**

Run:

```bash
cargo test -p local-first-host-computer
cargo test -p local-first-local-computer-session
cargo test -p local-first-desktop-gateway host_computer
swift test --package-path runtimes/host-computer/macos
cd apps/desktop && npm run test:host-computer-package && npm run test:host-computer-signing && npm run typecheck
```

Expected: all selected tests pass. Any baseline failure is fixed before Task 2 and recorded separately from new beta behavior.

### Task 2: Persist an off-by-default beta opt-in

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`RuntimeSettings`, default, merge tests, setting handler)
- Modify: `apps/desktop/src/lib/coreBridge.ts` (`RuntimeSettings`)
- Test: `crates/desktop-gateway/src/main.rs` test module

- [ ] **Step 1: Add failing Rust settings tests**

Add to the existing runtime-settings tests:

```rust
#[test]
fn mac_apps_beta_is_off_for_legacy_settings_and_survives_partial_patches() {
    let legacy: RuntimeSettings = serde_json::from_str("{}").unwrap();
    assert!(!legacy.mac_apps_beta_enabled);

    let enabled = merge_runtime_settings(
        &legacy,
        &serde_json::json!({ "mac_apps_beta_enabled": true }),
    );
    assert!(enabled.mac_apps_beta_enabled);

    let after_unrelated_patch = merge_runtime_settings(
        &enabled,
        &serde_json::json!({ "sandbox_mode": "read-only" }),
    );
    assert!(after_unrelated_patch.mac_apps_beta_enabled);
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway mac_apps_beta_is_off_for_legacy_settings_and_survives_partial_patches -- --exact
```

Expected: compile failure because `RuntimeSettings::mac_apps_beta_enabled` does not exist.

- [ ] **Step 3: Add the persisted field and accessor**

Add to `RuntimeSettings` and its `Default` implementation:

```rust
#[serde(default)]
mac_apps_beta_enabled: bool,
```

```rust
mac_apps_beta_enabled: false,
```

Add beside `load_runtime_settings`:

```rust
pub(crate) fn mac_apps_beta_enabled() -> bool {
    load_runtime_settings().mac_apps_beta_enabled
}
```

Add to the TypeScript interface:

```ts
/** Apple Silicon Mac Apps beta. Absent in legacy files means disabled. */
mac_apps_beta_enabled?: boolean;
```

- [ ] **Step 4: Run the focused test and gateway compile**

Run:

```bash
cargo test -p local-first-desktop-gateway mac_apps_beta_is_off_for_legacy_settings_and_survives_partial_patches -- --exact
cargo check -p local-first-desktop-gateway
cd apps/desktop && npm run typecheck
```

Expected: focused test passes; gateway and TypeScript compile. Pre-existing warnings are counted but not called warning-free.

- [ ] **Step 5: Commit the opt-in storage**

```bash
git add crates/desktop-gateway/src/main.rs apps/desktop/src/lib/coreBridge.ts
git commit -m "feat(computer): persist mac apps beta opt-in"
```

### Task 3: Make the backend state machine fail closed

**Files:**
- Modify: `crates/desktop-gateway/src/host_computer_gateway.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/host_computer_gateway.rs` unit tests or a focused test module in `main.rs`

- [ ] **Step 1: Add failing state and tool-gating tests**

Introduce a pure state resolver and test it before wiring runtime I/O:

```rust
#[test]
fn beta_state_is_disabled_before_permissions_and_never_ready_on_unsupported_hosts() {
    assert_eq!(resolve_beta_state(false, true, false, false, false, false), HostBetaState::Disabled);
    assert_eq!(resolve_beta_state(true, true, false, false, false, false), HostBetaState::Setup);
    assert_eq!(resolve_beta_state(true, true, true, true, false, false), HostBetaState::Ready);
    assert_eq!(resolve_beta_state(true, true, true, true, true, false), HostBetaState::Active);
    assert_eq!(resolve_beta_state(true, true, true, true, false, true), HostBetaState::Paused);
    assert_eq!(resolve_beta_state(true, false, true, true, false, false), HostBetaState::Unsupported);
}

#[test]
fn manager_tool_requires_opt_in_permissions_and_a_valid_grant() {
    assert!(!manager_should_register(false, true, true));
    assert!(!manager_should_register(true, false, true));
    assert!(!manager_should_register(true, true, false));
    assert!(manager_should_register(true, true, true));
}
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway beta_state_is_disabled_before_permissions_and_never_ready_on_unsupported_hosts -- --exact
cargo test -p local-first-desktop-gateway manager_tool_requires_opt_in_permissions_and_a_valid_grant -- --exact
```

Expected: failure because `HostBetaState`, `resolve_beta_state`, and `manager_should_register` do not exist.

- [ ] **Step 3: Implement the state model**

Add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum HostBetaState {
    Unsupported,
    Disabled,
    Setup,
    Ready,
    Active,
    Paused,
    Error,
}

fn manager_should_register(enabled: bool, permissions_ready: bool, has_grant: bool) -> bool {
    enabled && permissions_ready && has_grant
}

fn resolve_beta_state(
    enabled: bool,
    supported: bool,
    accessibility: bool,
    screen_recording: bool,
    active: bool,
    paused: bool,
) -> HostBetaState {
    if !supported { return HostBetaState::Unsupported; }
    if !enabled { return HostBetaState::Disabled; }
    if !(accessibility && screen_recording) { return HostBetaState::Setup; }
    if paused { return HostBetaState::Paused; }
    if active { HostBetaState::Active } else { HostBetaState::Ready }
}
```

Use `cfg!(all(target_os = "macos", target_arch = "aarch64"))` as `supported`. Return `supported`, `enabled`, and `state` from `/api/host-computer/status`. When disabled, return status without starting the helper. If the opted-in helper or protocol fails, preserve the diagnostic detail and return `state: "error"`; never collapse that failure into `ready` or merely `available: false`. Restrict `runtime()` with:

```rust
if !super::mac_apps_beta_enabled() {
    return Err(api_error(StatusCode::SERVICE_UNAVAILABLE, "feature_disabled"));
}
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
return Err(api_error(StatusCode::SERVICE_UNAVAILABLE, "unsupported_platform"));
```

Make `manager_ready()` return `false` unless the persisted opt-in is enabled, and add the same check to `start_worker_session` so a stale or hallucinated `use_computer` call cannot bypass registration.

- [ ] **Step 4: Stop runtime state when the opt-in is turned off**

Add an async function with this contract:

```rust
pub async fn disable() {
    MANAGER_READY.store(false, Ordering::Release);
    if let Ok(mut coordinator) = sessions().lock() {
        if let Ok(Some(snapshot)) = coordinator.cancel_active(now_ms()) {
            drop(coordinator);
            publish_session("cancelled", &snapshot);
        }
    }
    if let Some(runtime) = RUNTIME.get() {
        let mut guard = runtime.lock().await;
        if let Some(current) = guard.as_ref() {
            if let Ok(mut snapshots) = current.snapshots.lock() {
                snapshots.clear();
            }
        }
        *guard = None;
    }
}
```

In `set_runtime_settings`, compare the previous and merged setting; after persisting, call `host_computer_gateway::disable().await` on a `true → false` transition.

- [ ] **Step 5: Defend the dispatch path**

Before executing the `use_computer` branch in `GatewayCapabilityExecutor`, return a structured disabled result when `manager_ready()` is false:

```rust
if name == "use_computer" && !host_computer_gateway::manager_ready() {
    return Ok(local_first_engine::ToolOutcome {
        result: serde_json::json!({
            "found": false,
            "error": "mac_apps_not_ready"
        }).to_string(),
        effects: Default::default(),
    });
}
```

- [ ] **Step 6: Run the state, gateway, and engine tests**

Run:

```bash
cargo test -p local-first-desktop-gateway beta_state_is_disabled_before_permissions_and_never_ready_on_unsupported_hosts -- --exact
cargo test -p local-first-desktop-gateway manager_tool_requires_opt_in_permissions_and_a_valid_grant -- --exact
cargo test -p local-first-desktop-gateway host_computer
cargo test -p local-first-engine
```

Expected: all selected tests pass and the disabled path never launches the helper or registers `use_computer`.

- [ ] **Step 7: Commit backend gating**

```bash
git add crates/desktop-gateway/src/host_computer_gateway.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(computer): gate mac apps behind explicit beta consent"
```

### Task 4: Add the reactive, flat Mac Apps beta settings UI

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/components/SettingsView.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/locales/{en,it,fr,de,es}.json`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Make the UI contract fail before implementation**

Add assertions:

```js
assertContains("src/components/SettingsView.tsx", "mac_apps_beta_enabled", "Mac Apps must have a persisted beta opt-in");
assertContains("src/components/SettingsView.tsx", 'window.addEventListener("focus"', "TCC state must refresh when returning from System Settings");
assertContains("src/components/SettingsView.tsx", 'document.addEventListener("visibilitychange"', "TCC state must refresh when the app becomes visible");
assertContains("src/i18n/locales/en.json", '"macAppsBeta"', "English must label Mac Apps as beta");
assertContains("src/i18n/locales/it.json", '"macAppsBeta"', "Italian must label Mac Apps as beta");
```

- [ ] **Step 2: Run UI contract and verify RED**

Run:

```bash
cd apps/desktop && npm run test:ui-contract
```

Expected: failure on the missing beta opt-in and reactive listeners.

- [ ] **Step 3: Extend the typed status contract**

Use:

```ts
export type HostComputerBetaState =
  | "unsupported"
  | "disabled"
  | "setup"
  | "ready"
  | "active"
  | "paused"
  | "error";

export interface HostComputerStatus {
  supported: boolean;
  enabled: boolean;
  state: HostComputerBetaState;
  available: boolean;
  helper_version: string | null;
  accessibility: HostComputerPermissionState;
  screen_recording: HostComputerPermissionState;
  ready: boolean;
  reason?: string;
  host_session?: HostComputerWireEvent | null;
}
```

- [ ] **Step 4: Implement opt-in and reactive refresh**

In `MacAppsSettings`, load `coreBridge.runtimeSettings()` with the status, render the existing `Toggle`, and persist only:

```ts
await coreBridge.setRuntimeSettings({ mac_apps_beta_enabled: nextEnabled });
```

When disabled, show the beta explanation and hide TCC/grant controls. When unsupported, show Apple Silicon-only availability without an interactive toggle. Register these listeners inside the existing effect:

```ts
const refreshWhenVisible = () => {
  if (document.visibilityState === "visible") void refreshHostComputer().catch(() => {});
};
window.addEventListener("focus", refreshWhenVisible);
document.addEventListener("visibilitychange", refreshWhenVisible);
return () => {
  window.clearInterval(id);
  window.removeEventListener("focus", refreshWhenVisible);
  document.removeEventListener("visibilitychange", refreshWhenVisible);
};
```

Only fetch apps and grants when `status.enabled && status.available`. Clear selection immediately after disabling or revoking.

- [ ] **Step 5: Add complete locale copy**

Each locale receives the same keys. English source meaning:

```json
{
  "macAppsTitle": "Mac Apps",
  "macAppsBeta": "Beta",
  "macAppsOptIn": "Enable Mac Apps Beta",
  "macAppsOptInHint": "Off by default. Homun can use only apps you authorize individually.",
  "macAppsAppleSiliconOnly": "Available in beta on Apple Silicon Macs.",
  "macAppsDisabled": "Mac Apps is off",
  "macAppsLocalScreenshot": "Window captures stay on this Mac and are never sent to a model."
}
```

Italian source meaning:

```json
{
  "macAppsTitle": "App del Mac",
  "macAppsBeta": "Beta",
  "macAppsOptIn": "Attiva App del Mac Beta",
  "macAppsOptInHint": "Disattivata per impostazione predefinita. Homun può usare solo le app che autorizzi singolarmente.",
  "macAppsAppleSiliconOnly": "Disponibile in beta sui Mac Apple Silicon.",
  "macAppsDisabled": "App del Mac è disattivata",
  "macAppsLocalScreenshot": "Le acquisizioni delle finestre restano su questo Mac e non vengono mai inviate a un modello."
}
```

French:

```json
{
  "macAppsTitle": "Apps du Mac",
  "macAppsBeta": "Bêta",
  "macAppsOptIn": "Activer Apps du Mac Bêta",
  "macAppsOptInHint": "Désactivée par défaut. Homun ne peut utiliser que les apps que vous autorisez individuellement.",
  "macAppsAppleSiliconOnly": "Disponible en bêta sur les Mac Apple Silicon.",
  "macAppsDisabled": "Apps du Mac est désactivé",
  "macAppsLocalScreenshot": "Les captures de fenêtre restent sur ce Mac et ne sont jamais envoyées à un modèle."
}
```

German:

```json
{
  "macAppsTitle": "Mac-Apps",
  "macAppsBeta": "Beta",
  "macAppsOptIn": "Mac-Apps Beta aktivieren",
  "macAppsOptInHint": "Standardmäßig deaktiviert. Homun kann nur Apps verwenden, die du einzeln autorisierst.",
  "macAppsAppleSiliconOnly": "Als Beta auf Apple-Silicon-Macs verfügbar.",
  "macAppsDisabled": "Mac-Apps ist deaktiviert",
  "macAppsLocalScreenshot": "Fensteraufnahmen bleiben auf diesem Mac und werden niemals an ein Modell gesendet."
}
```

Spanish:

```json
{
  "macAppsTitle": "Apps del Mac",
  "macAppsBeta": "Beta",
  "macAppsOptIn": "Activar Apps del Mac Beta",
  "macAppsOptInHint": "Desactivada de forma predeterminada. Homun solo puede usar las apps que autorizas individualmente.",
  "macAppsAppleSiliconOnly": "Disponible en beta en Mac con Apple Silicon.",
  "macAppsDisabled": "Apps del Mac está desactivada",
  "macAppsLocalScreenshot": "Las capturas de ventanas permanecen en este Mac y nunca se envían a un modelo."
}
```

- [ ] **Step 6: Keep the layout flat and responsive**

Use one section with divider rows. Add no nested card background. The only new CSS should cover the opt-in row and compact unsupported state:

```css
.host-computer-opt-in {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
}

.host-computer-opt-in > div { min-width: 0; }
.host-computer-beta-copy { max-width: 72ch; }

@media (max-width: 760px) {
  .host-computer-opt-in { align-items: flex-start; }
}
```

- [ ] **Step 7: Run UI tests and commit**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run typecheck
node --test tests/i18n-parity.test.mjs
```

Expected: all commands pass.

```bash
git add apps/desktop/src/lib/coreBridge.ts apps/desktop/src/components/SettingsView.tsx apps/desktop/src/styles.css apps/desktop/src/i18n/locales apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(computer): add reactive mac apps beta settings"
```

### Task 5: Enforce local-only screenshots for the beta

**Files:**
- Modify: `crates/host-computer/src/redaction.rs`
- Modify: `crates/host-computer/tests/redaction_contract.rs`
- Modify: `crates/desktop-gateway/src/host_computer_gateway.rs`
- Test: `crates/host-computer/tests/redaction_contract.rs`

- [ ] **Step 1: Add a failing all-provider screenshot test**

Extend the existing `local_first_host_computer` import with `protocol::ArtifactRef`, then add:

```rust
#[test]
fn beta_projection_strips_screenshot_refs_for_every_provider() {
    let mut input = snapshot(Some("safe text"), false);
    input.screenshot_ref = Some(ArtifactRef {
        artifact_ref: "host-computer:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        mime_type: "image/png".into(),
        size_bytes: 42,
        sha256: "a".repeat(64),
    });
    for provider in [ProviderDisclosure::Local, ProviderDisclosure::Remote, ProviderDisclosure::Unknown] {
        let projected = project_snapshot(&input, provider, DisclosurePolicy::MAC_APPS_BETA);
        assert!(projected.screenshot_ref.is_none());
    }
}
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cargo test -p local-first-host-computer beta_projection_strips_screenshot_refs_for_every_provider -- --exact
```

Expected: failure because `DisclosurePolicy::MAC_APPS_BETA` does not exist and local projection retains the reference.

- [ ] **Step 3: Add an explicit beta disclosure policy**

```rust
impl DisclosurePolicy {
    pub const MAC_APPS_BETA: Self = Self {
        disclose_screenshot_reference: false,
    };
}
```

Rename the field to `disclose_screenshot_reference` and apply it independently of provider:

```rust
if !policy.disclose_screenshot_reference {
    projected.screenshot_ref = None;
}
```

Use `DisclosurePolicy::MAC_APPS_BETA` in `worker_get_state`. The artifact remains available to the local UI/session layer; the worker result sent to the model contains no resolvable path or screenshot reference.

- [ ] **Step 4: Run redaction and gateway tests**

Run:

```bash
cargo test -p local-first-host-computer redaction_contract
cargo test -p local-first-desktop-gateway host_computer
```

Expected: all selected tests pass; local, remote, and unknown model projections lack `screenshot_ref`.

- [ ] **Step 5: Commit privacy hardening**

```bash
git add crates/host-computer/src/redaction.rs crates/host-computer/tests/redaction_contract.rs crates/desktop-gateway/src/host_computer_gateway.rs
git commit -m "fix(computer): keep beta screenshots outside model context"
```

### Task 6: Harden action classification and approval summaries

**Files:**
- Modify: `crates/host-computer/src/policy.rs`
- Modify: `crates/host-computer/tests/policy_matrix.rs`
- Modify: `crates/desktop-gateway/src/host_computer_gateway.rs`
- Test: `crates/host-computer/tests/policy_matrix.rs`
- Test: focused gateway tests in `crates/desktop-gateway/src/host_computer_gateway.rs`

- [ ] **Step 1: Add failing policy tests for generic UI effects and Terminal**

```rust
#[test]
fn generic_interactions_need_control_and_single_use_approval() {
    let request = PolicyRequest {
        category: ActionCategory::Interaction,
        protected_target: false,
        low_risk_typing_enabled: false,
        approval_matches: false,
    };
    assert_eq!(
        HostActionPolicy.decide(Some(GrantLevel::Observe), &request),
        PolicyDecision::GrantRequired(GrantLevel::Control),
    );
    assert_eq!(
        HostActionPolicy.decide(Some(GrantLevel::Control), &request),
        PolicyDecision::ApprovalRequired(ActionCategory::Interaction),
    );
}
```

Add a gateway classifier test:

```rust
#[test]
fn terminal_actions_are_hard_denied_and_press_is_not_assumed_reversible() {
    assert_eq!(classify_action("com.apple.Terminal", SemanticAction::ScrollDown), ActionCategory::TerminalInput);
    assert_eq!(classify_action("com.apple.Notes", SemanticAction::Press), ActionCategory::Interaction);
    assert_eq!(classify_action("com.apple.Notes", SemanticAction::SetValue), ActionCategory::TextEntry);
    assert_eq!(classify_action("com.apple.Notes", SemanticAction::ScrollDown), ActionCategory::Reversible);
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cargo test -p local-first-host-computer generic_interactions_need_control_and_single_use_approval -- --exact
cargo test -p local-first-desktop-gateway terminal_actions_are_hard_denied_and_press_is_not_assumed_reversible -- --exact
```

Expected: failure because `Interaction` and `classify_action` do not exist.

- [ ] **Step 3: Implement conservative beta classification**

Add `Interaction` to `ActionCategory` and require approval for it. Classify actions in the gateway:

```rust
fn classify_action(bundle_id: &str, action: SemanticAction) -> ActionCategory {
    if is_terminal_bundle_id(bundle_id) {
        return ActionCategory::TerminalInput;
    }
    match action {
        SemanticAction::SetValue => ActionCategory::TextEntry,
        SemanticAction::Press
        | SemanticAction::Confirm
        | SemanticAction::Increment
        | SemanticAction::Decrement => ActionCategory::Interaction,
        SemanticAction::ShowMenu
        | SemanticAction::Cancel
        | SemanticAction::Raise
        | SemanticAction::ScrollUp
        | SemanticAction::ScrollDown => ActionCategory::Reversible,
    }
}
```

Use this function before the policy decision. Do not infer safety from model text or allow the request to supply its own category.

- [ ] **Step 4: Make approval summaries concrete and bounded**

Replace role-only summaries with app, action, role, and a redacted label capped at 120 characters:

```rust
fn action_summary(
    category: ActionCategory,
    app: &str,
    action: SemanticAction,
    role: &str,
    label: Option<&str>,
) -> String {
    let target = label
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.chars().take(120).collect::<String>())
        .unwrap_or_else(|| role.to_string());
    format!("{action:?} ‘{target}’ in {app} ({category:?})")
}
```

Never include the `SetValue` payload in the approval summary or journal.

- [ ] **Step 5: Run policy, protected-target, and gateway tests**

Run:

```bash
cargo test -p local-first-host-computer policy_matrix
cargo test -p local-first-host-computer protected_target_contract
cargo test -p local-first-desktop-gateway host_computer
```

Expected: Observe cannot mutate; Terminal input is denied before approval; generic button effects require a one-use approval with a concrete target summary.

- [ ] **Step 6: Commit safety classification**

```bash
git add crates/host-computer/src/policy.rs crates/host-computer/tests/policy_matrix.rs crates/desktop-gateway/src/host_computer_gateway.rs
git commit -m "fix(computer): classify host actions conservatively"
```

### Task 7: Verify revocation, disable, takeover, logout, and factory-reset cleanup

**Files:**
- Modify: `crates/desktop-gateway/src/host_computer_gateway.rs`
- Modify: `apps/desktop/electron/lib/factory-reset.cjs`
- Modify: `apps/desktop/tests/host-computer-reset.test.mjs`
- Test: `crates/host-computer/tests/takeover_contract.rs`
- Test: `crates/host-computer/tests/policy_matrix.rs`

- [ ] **Step 1: Add regression tests for zero residual state**

Extend the reset test to assert removal of `runtime-settings.json`, because it contains the beta opt-in:

```js
assert.ok(
  hostComputerStatePaths(root).some((entry) => entry.endsWith("runtime-settings.json")),
  "factory reset must remove the persisted Mac Apps opt-in",
);
```

Add a gateway test that starts a session, disables the feature, and asserts no active session and no snapshot registry entries remain. Add a revoke test that proves a revoked grant cancels the active session before another action can execute.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd apps/desktop && node --test tests/host-computer-reset.test.mjs
cargo test -p local-first-desktop-gateway host_computer_disable_clears_runtime_state -- --exact
cargo test -p local-first-desktop-gateway host_computer_revoke_cancels_active_session -- --exact
```

Expected: at least the runtime-settings path assertion fails before cleanup is updated.

- [ ] **Step 3: Implement cleanup without manipulating TCC**

Add `runtime-settings.json` to the owned paths removed by factory reset. Keep macOS TCC records outside the wipe and explain them in UI copy. Make disable and revoke use the same internal `cancel_active_and_clear_snapshots(reason)` helper so both paths publish one terminal event and leave no resumable generation.

- [ ] **Step 4: Run reset, takeover, and session tests**

Run:

```bash
cd apps/desktop && node --test tests/host-computer-reset.test.mjs
cargo test -p local-first-host-computer takeover_contract
cargo test -p local-first-host-computer policy_matrix
cargo test -p local-first-desktop-gateway host_computer
```

Expected: all tests pass; stale resume generations are rejected after disable, revoke, user input, or reset.

- [ ] **Step 5: Commit lifecycle cleanup**

```bash
git add crates/desktop-gateway/src/host_computer_gateway.rs apps/desktop/electron/lib/factory-reset.cjs apps/desktop/tests/host-computer-reset.test.mjs
git commit -m "fix(computer): clear mac apps state on every shutdown boundary"
```

### Task 8: Verify Apple Silicon packaging and unsupported-platform behavior

**Files:**
- Modify: `apps/desktop/electron/main.cjs`
- Modify: `apps/desktop/tests/host-computer-package.test.mjs`
- Modify: `apps/desktop/scripts/verify-host-computer-package.mjs`
- Modify: `.github/workflows/build.yml`
- Verify: `apps/desktop/package.json`

- [ ] **Step 1: Add a failing architecture contract**

In the package test, assert the helper is only activated on Darwin arm64:

```js
assert.match(mainSource, /process\.platform === "darwin"/);
assert.match(mainSource, /process\.arch === "arm64"/);
assert.match(mainSource, /HOMUN_HOST_COMPUTER_HELPER_PATH/);
```

- [ ] **Step 2: Run the package test and verify RED**

Run:

```bash
cd apps/desktop && node --test tests/host-computer-package.test.mjs
```

Expected: failure because Electron currently checks Darwin but not `process.arch`.

- [ ] **Step 3: Gate helper discovery by architecture**

Use:

```js
if (
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  env.HOMUN_HOST_COMPUTER !== "0"
) {
  // existing helper discovery
}
```

Keep the helper included in the normal arm64 DMG/ZIP and absent as an active capability on Windows, Linux, and Intel macOS.

- [ ] **Step 4: Make the signed-package verifier assert arm64**

Add `lipo -archs` to the verifier command plan for both the nested helper executable and gateway. Expected architecture is exactly `arm64` for the first beta; a universal claim is forbidden.

- [ ] **Step 5: Run package and signing tests**

Run:

```bash
cd apps/desktop
npm run test:host-computer-package
npm run test:host-computer-signing
npm run package:prepare
```

Expected: helper builds, launches, and completes the authenticated socket handshake; package preparation produces the nested helper under `.package/resources/host-computer/`.

- [ ] **Step 6: Commit packaging constraints**

```bash
git add apps/desktop/electron/main.cjs apps/desktop/tests/host-computer-package.test.mjs apps/desktop/scripts/verify-host-computer-package.mjs .github/workflows/build.yml
git commit -m "build(computer): constrain mac apps beta to apple silicon"
```

### Task 9: Run the complete automated release gate

**Files:**
- Update evidence only after fresh runs: `docs/testing/host-computer-macos-matrix.md`

- [ ] **Step 1: Run host-specific suites**

```bash
cargo test -p local-first-host-computer
cargo test -p local-first-local-computer-session
cargo test -p local-first-desktop-gateway host_computer
swift test --package-path runtimes/host-computer/macos
cd apps/desktop
npm run test:electron
npm run test:ui-contract
npm run typecheck
npm run build
```

Expected: zero failures. Record exact test counts and any explicit skips.

- [ ] **Step 2: Run regression and repository gates**

From the repository root:

```bash
cargo test -p local-first-engine
cargo check -p local-first-desktop-gateway
python3 scripts/pre_release_gate.py
git diff --check main...HEAD
```

Expected: all invoked commands exit 0. If a suite hangs, is excluded, or cannot run, record it as not verified rather than green.

- [ ] **Step 3: Update the acceptance matrix with fresh evidence**

Replace only the `Local engineering evidence` counts and date with observed outputs. Keep every unexecuted physical or signing row under `Not claimed`.

- [ ] **Step 4: Commit evidence**

```bash
git add docs/testing/host-computer-macos-matrix.md
git commit -m "docs(computer): refresh mac apps beta acceptance evidence"
```

### Task 10: Verify the rendered desktop app and real macOS boundaries

**Files:**
- Evidence: `docs/testing/host-computer-macos-matrix.md`
- Test workspace: disposable Homun data root, not the user's active workspace

- [ ] **Step 1: Build and launch a local candidate**

Run:

```bash
cd apps/desktop
npm run package:prepare
npm run electron:dev
```

Expected: normal Homun app launches; Mac Apps is visible but off; no TCC prompt appears automatically.

- [ ] **Step 2: Inspect the real UI at all required viewports**

Inspect `Settings → Computer` and the Chat Computer card at 1280×800, 1440×900, and 1728×1117 for unsupported, disabled, setup, ready, Observe, Control, active, paused, and error states.

Expected: no horizontal scroll, overlaps, nested-card clutter, stale state, or manual refresh requirement.

- [ ] **Step 3: Perform real TCC and app tests**

On Apple Silicon, deliberately grant and revoke Accessibility and Screen Recording. Test one AppKit app, one SwiftUI app, a browser, and an editor. Execute only reversible fixture actions. Verify mouse and trackpad takeover, grant revocation during a session, app/window closure, helper restart, logout, beta disable, and factory reset.

Expected: all rows in `Physical macOS acceptance` have recorded macOS/app versions, before/after permission state, sanitized outcome, and pass/fail evidence.

- [ ] **Step 4: Prove hard denials**

Attempt to target a password manager, macOS authentication UI, a secure field, and Terminal input.

Expected: each attempt is denied before native action dispatch; no screenshot bytes, secure values, or typed payloads appear in model context, chat, journal, or memory.

- [ ] **Step 5: Record only observed results**

Update the matrix. Do not mark signed/notarized RC rows green from a development build.

```bash
git add docs/testing/host-computer-macos-matrix.md
git commit -m "test(computer): record physical mac apps beta acceptance"
```

### Task 11: Produce and audit the signed release candidate

**Files:**
- Verify: `.github/workflows/build.yml`
- Verify: `apps/desktop/scripts/verify-host-computer-package.mjs`
- Release notes source: GitHub release body

- [ ] **Step 1: Prepare exact release notes**

Use this body, replacing only the automatically selected version number:

```markdown
## Highlights
- Mac Apps Beta lets Homun observe or control only the Mac applications you authorize individually.
- Included in the normal macOS app, off by default, and available first on Apple Silicon.

## Security
- Separate Observe and Control grants, action-time approvals, immediate physical-input takeover, and a global stop.
- Password managers, authentication UI, secure fields, and Terminal input remain blocked.
- Window captures remain local and are never sent to a model in this beta.

## Requirements
- macOS on Apple Silicon.
- Accessibility and Screen Recording permissions granted explicitly in System Settings.

Roadmap: connected-actions, local-computer
```

- [ ] **Step 2: Push the reviewed integration branch and open the normal review path**

```bash
git status --short
git push -u origin fabio/host-computer-control
```

Expected: clean branch is available remotely; no tag exists yet.

- [ ] **Step 3: Merge only after review and green CI**

Expected: the merge preserves unrelated `main` work and the resulting `main` commit contains the complete beta plus fresh acceptance evidence.

- [ ] **Step 4: Create the next annotated version tag from verified `main`**

Derive the version from the latest published tag:

```bash
git fetch origin --tags
LATEST=$(git tag -l 'v0.1.*' --sort=-v:refname | head -1)
PATCH=${LATEST##*.}
VERSION="v0.1.$((PATCH + 1))"
git tag -a "$VERSION" -m "Mac Apps Beta for Apple Silicon"
git push origin "$VERSION"
```

Expected: the tag points exactly at the reviewed `main` commit.

- [ ] **Step 5: Wait for and audit the actual installers**

Required evidence:

```text
Linux and Windows builds remain green and do not expose Mac Apps.
macOS arm64 DMG and ZIP are signed and notarized.
Nested helper and gateway are arm64, share the expected Team ID, and pass Gatekeeper.
Updater metadata references the same version and artifacts.
No unsigned Windows fallback or missing expected asset is accepted.
```

Run the package verifier against the downloaded `.app` before publishing the release. Keep the release draft until every required asset, digest, updater file, signature, notarization ticket, and installed-app smoke check passes.

### Task 12: Hand off the verified release identity to the website plan

**Files:**
- Read: published GitHub release URL and version
- Next plan: `docs/superpowers/plans/2026-07-21-mac-apps-beta-website.md`

- [ ] **Step 1: Record the immutable release coordinates**

Capture:

```text
tag
main commit SHA
published GitHub release URL
macOS arm64 asset names
publication timestamp
```

- [ ] **Step 2: Start the website plan only after release publication**

Expected: public homepage and changelog never claim a downloadable beta before the corresponding release exists.
