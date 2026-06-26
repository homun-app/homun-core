# Project Access and Evented Automations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the project access foundation that lets Homun safely run evented automations from channels/connectors/addons without hidden project-memory or artifact leakage.

**Architecture:** Project access becomes the first policy surface before event rules. The runtime resolves `contact perimeter + project access + automation policy + capability policy + approval` before any project-scoped run, while all semantic evidence still converges to `MemoryFacade`. Evented automations then reuse the same visible turn lifecycle used by app chat, channels and scheduled tasks.

**Tech Stack:** Rust gateway (`crates/desktop-gateway`), existing workspace registry JSON, existing contact perimeter store, React desktop UI (`apps/desktop`), typed bridge (`apps/desktop/src/lib/coreBridge.ts`), existing eval/docs gates.

---

## File Map

- Modify `crates/desktop-gateway/src/main.rs`
  - Add project access DTOs and endpoints near the existing workspace routes.
  - Persist project access in a small operational JSON file under the gateway data dir.
  - Add an effective-policy resolver that composes existing contact perimeter with project grants.
  - Add focused Rust tests beside existing gateway tests.
- Modify `apps/desktop/src/lib/coreBridge.ts`
  - Add typed project access bridge methods.
- Modify `apps/desktop/src/components/Sidebar.tsx`
  - Add a project context action to open project access.
  - Keep project creation/chat creation behavior unchanged.
- Create or modify a focused project access UI component in `apps/desktop/src/components/`
  - Show authorized contacts, channel, and permission toggles.
  - Use existing island/modal styling and dark theme tokens.
- Modify `apps/desktop/src/components/AutomationsView.tsx`
  - After project access exists, restrict event-rule project selection to authorized contact/channel combinations.
- Modify docs:
  - `docs/DEVELOPMENT.md`
  - `docs/roadmap.md`
  - `docs/plans/2026-06-22-batch-1042-artifacts-memory.md`
  - `docs/superpowers/specs/2026-06-26-evented-automations-design.md`

---

## Milestone 1: Project Access Surface

This milestone must ship before event rules fire. It creates the project/contact/channel access contract and makes it visible to the user.

### Task 1: Backend Project Access Store

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Add failing tests for default-deny, upsert/list, and delete**

Add tests near the existing workspace tests in `crates/desktop-gateway/src/main.rs`:

```rust
#[test]
fn project_access_defaults_to_no_grants() {
    let temp = tempfile::tempdir().expect("tempdir");
    let _guard = TestGatewayDataDir::new(temp.path());

    let access = load_project_access_file();
    assert!(access.grants.is_empty());

    let grants = list_project_access("workspace_alpha");
    assert!(grants.is_empty());
}

#[test]
fn project_access_upsert_lists_and_removes_grants() {
    let temp = tempfile::tempdir().expect("tempdir");
    let _guard = TestGatewayDataDir::new(temp.path());

    upsert_project_access(ProjectAccessGrant {
        workspace_id: "workspace_alpha".to_string(),
        contact_reference: "contact_123".to_string(),
        contact_name: "Elena".to_string(),
        channel: "whatsapp".to_string(),
        can_trigger_automations: true,
        can_use_project_memory: true,
        can_receive_replies: true,
        can_receive_artifacts: false,
        capability_denies: vec!["browser".to_string()],
        updated_at: 100,
    })
    .expect("upsert grant");

    let grants = list_project_access("workspace_alpha");
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].contact_reference, "contact_123");
    assert_eq!(grants[0].channel, "whatsapp");
    assert!(grants[0].can_trigger_automations);
    assert!(grants[0].can_use_project_memory);
    assert!(grants[0].can_receive_replies);
    assert!(!grants[0].can_receive_artifacts);
    assert_eq!(grants[0].capability_denies, vec!["browser"]);

    remove_project_access("workspace_alpha", "contact_123", "whatsapp").expect("remove grant");
    assert!(list_project_access("workspace_alpha").is_empty());
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cargo test -p local-first-desktop-gateway project_access_ -- --nocapture
```

Expected: fail because `ProjectAccessGrant`, `load_project_access_file`, `list_project_access`, `upsert_project_access`, and `remove_project_access` do not exist yet.

- [ ] **Step 3: Implement the JSON-backed access store**

Add near the workspace persistence helpers:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ProjectAccessGrant {
    workspace_id: String,
    contact_reference: String,
    #[serde(default)]
    contact_name: String,
    channel: String,
    #[serde(default)]
    can_trigger_automations: bool,
    #[serde(default)]
    can_use_project_memory: bool,
    #[serde(default)]
    can_receive_replies: bool,
    #[serde(default)]
    can_receive_artifacts: bool,
    #[serde(default)]
    capability_denies: Vec<String>,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ProjectAccessFile {
    #[serde(default)]
    grants: Vec<ProjectAccessGrant>,
}

fn gateway_project_access_path() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?.join("project-access.json"))
}

fn normalize_project_access_grant(mut grant: ProjectAccessGrant) -> ProjectAccessGrant {
    grant.workspace_id = grant.workspace_id.trim().to_string();
    grant.contact_reference = grant.contact_reference.trim().to_string();
    grant.contact_name = grant.contact_name.trim().to_string();
    grant.channel = grant.channel.trim().to_lowercase();
    grant.capability_denies = grant
        .capability_denies
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    grant.capability_denies.sort();
    grant.capability_denies.dedup();
    grant
}

fn load_project_access_file() -> ProjectAccessFile {
    gateway_project_access_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<ProjectAccessFile>(&raw).ok())
        .unwrap_or_default()
}

fn save_project_access_file(file: &ProjectAccessFile) -> Result<(), std::io::Error> {
    let path = gateway_project_access_path()?;
    let body = serde_json::to_string_pretty(file).unwrap_or_else(|_| "{\"grants\":[]}".to_string());
    fs::write(path, body)
}

fn list_project_access(workspace_id: &str) -> Vec<ProjectAccessGrant> {
    let workspace_id = workspace_id.trim();
    load_project_access_file()
        .grants
        .into_iter()
        .filter(|grant| grant.workspace_id == workspace_id)
        .collect()
}

fn upsert_project_access(grant: ProjectAccessGrant) -> Result<(), std::io::Error> {
    let grant = normalize_project_access_grant(grant);
    let mut file = load_project_access_file();
    file.grants.retain(|existing| {
        !(existing.workspace_id == grant.workspace_id
            && existing.contact_reference == grant.contact_reference
            && existing.channel == grant.channel)
    });
    file.grants.push(grant);
    file.grants.sort_by(|a, b| {
        a.workspace_id
            .cmp(&b.workspace_id)
            .then(a.contact_name.cmp(&b.contact_name))
            .then(a.channel.cmp(&b.channel))
    });
    save_project_access_file(&file)
}

fn remove_project_access(
    workspace_id: &str,
    contact_reference: &str,
    channel: &str,
) -> Result<(), std::io::Error> {
    let channel = channel.trim().to_lowercase();
    let mut file = load_project_access_file();
    file.grants.retain(|existing| {
        !(existing.workspace_id == workspace_id.trim()
            && existing.contact_reference == contact_reference.trim()
            && existing.channel == channel)
    });
    save_project_access_file(&file)
}
```

- [ ] **Step 4: Run the tests**

Run:

```bash
cargo test -p local-first-desktop-gateway project_access_ -- --nocapture
```

Expected: both `project_access_...` tests pass.

### Task 2: Project Access API Contract

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/lib/coreBridge.ts`

- [ ] **Step 1: Add gateway endpoints**

Register routes next to `/api/workspaces/{workspace_id}/delete`:

```rust
.route(
    "/api/workspaces/{workspace_id}/access",
    get(project_access_list),
)
.route(
    "/api/workspaces/{workspace_id}/access/upsert",
    post(project_access_upsert),
)
.route(
    "/api/workspaces/{workspace_id}/access/remove",
    post(project_access_remove),
)
```

Add request/response handlers:

```rust
#[derive(Debug, Deserialize)]
struct ProjectAccessUpsertRequest {
    contact_reference: String,
    #[serde(default)]
    contact_name: String,
    channel: String,
    #[serde(default)]
    can_trigger_automations: bool,
    #[serde(default)]
    can_use_project_memory: bool,
    #[serde(default)]
    can_receive_replies: bool,
    #[serde(default)]
    can_receive_artifacts: bool,
    #[serde(default)]
    capability_denies: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ProjectAccessRemoveRequest {
    contact_reference: String,
    channel: String,
}

async fn project_access_list(
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<ProjectAccessGrant>>, GatewayError> {
    Ok(Json(list_project_access(&workspace_id)))
}

async fn project_access_upsert(
    Path(workspace_id): Path<String>,
    Json(request): Json<ProjectAccessUpsertRequest>,
) -> Result<Json<Vec<ProjectAccessGrant>>, GatewayError> {
    if request.contact_reference.trim().is_empty() || request.channel.trim().is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "project_access_invalid",
            message: "contact_reference and channel are required".to_string(),
        });
    }
    upsert_project_access(ProjectAccessGrant {
        workspace_id: workspace_id.clone(),
        contact_reference: request.contact_reference,
        contact_name: request.contact_name,
        channel: request.channel,
        can_trigger_automations: request.can_trigger_automations,
        can_use_project_memory: request.can_use_project_memory,
        can_receive_replies: request.can_receive_replies,
        can_receive_artifacts: request.can_receive_artifacts,
        capability_denies: request.capability_denies,
        updated_at: now_epoch_seconds(),
    })
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "project_access_write_failed",
        message: error.to_string(),
    })?;
    Ok(Json(list_project_access(&workspace_id)))
}

async fn project_access_remove(
    Path(workspace_id): Path<String>,
    Json(request): Json<ProjectAccessRemoveRequest>,
) -> Result<Json<Vec<ProjectAccessGrant>>, GatewayError> {
    remove_project_access(&workspace_id, &request.contact_reference, &request.channel).map_err(
        |error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "project_access_write_failed",
            message: error.to_string(),
        },
    )?;
    Ok(Json(list_project_access(&workspace_id)))
}
```

- [ ] **Step 2: Add bridge types and methods**

In `apps/desktop/src/lib/coreBridge.ts`:

```ts
export type ProjectAccessGrant = {
  workspace_id: string;
  contact_reference: string;
  contact_name: string;
  channel: string;
  can_trigger_automations: boolean;
  can_use_project_memory: boolean;
  can_receive_replies: boolean;
  can_receive_artifacts: boolean;
  capability_denies: string[];
  updated_at: number;
};

export type ProjectAccessInput = Omit<ProjectAccessGrant, "workspace_id" | "updated_at">;

async function electronProjectAccess(workspaceId: string): Promise<ProjectAccessGrant[]> {
  return gatewayGetJson<ProjectAccessGrant[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/access`,
  );
}

async function electronUpsertProjectAccess(
  workspaceId: string,
  input: ProjectAccessInput,
): Promise<ProjectAccessGrant[]> {
  return gatewayPostJson<ProjectAccessGrant[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/access/upsert`,
    input,
  );
}

async function electronRemoveProjectAccess(
  workspaceId: string,
  contactReference: string,
  channel: string,
): Promise<ProjectAccessGrant[]> {
  return gatewayPostJson<ProjectAccessGrant[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/access/remove`,
    { contact_reference: contactReference, channel },
  );
}
```

Expose these in the `coreBridge` object:

```ts
projectAccess: (workspaceId: string) => electronProjectAccess(workspaceId),
upsertProjectAccess: (workspaceId: string, input: ProjectAccessInput) =>
  electronUpsertProjectAccess(workspaceId, input),
removeProjectAccess: (workspaceId: string, contactReference: string, channel: string) =>
  electronRemoveProjectAccess(workspaceId, contactReference, channel),
```

- [ ] **Step 3: Verify backend and frontend compile**

Run:

```bash
cargo test -p local-first-desktop-gateway project_access_ -- --nocapture
npm run build
```

Expected: gateway tests pass and desktop build succeeds.

### Task 3: Effective Project Policy Resolver

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Add tests for deny-win resolution**

Add:

```rust
#[test]
fn project_policy_denies_when_contact_not_authorized() {
    let temp = tempfile::tempdir().expect("tempdir");
    let _guard = TestGatewayDataDir::new(temp.path());

    let resolved = resolve_project_contact_policy(
        "workspace_alpha",
        "contact_missing",
        "whatsapp",
        &chat_store::StoredPerimeter::default(),
    );

    assert!(!resolved.authorized);
    assert!(!resolved.can_trigger_automations);
    assert!(!resolved.can_use_project_memory);
    assert!(resolved.denied_reason.contains("not authorized"));
}

#[test]
fn project_policy_composes_grant_with_contact_perimeter_denies() {
    let temp = tempfile::tempdir().expect("tempdir");
    let _guard = TestGatewayDataDir::new(temp.path());

    upsert_project_access(ProjectAccessGrant {
        workspace_id: "workspace_alpha".to_string(),
        contact_reference: "contact_123".to_string(),
        contact_name: "Elena".to_string(),
        channel: "whatsapp".to_string(),
        can_trigger_automations: true,
        can_use_project_memory: true,
        can_receive_replies: true,
        can_receive_artifacts: true,
        capability_denies: vec!["browser".to_string()],
        updated_at: 100,
    })
    .expect("upsert grant");

    let perimeter = chat_store::StoredPerimeter {
        memory_scope: "contact_only".to_string(),
        knowledge_folders: Vec::new(),
        tools_allowed: Vec::new(),
        tools_denied: vec!["filesystem".to_string()],
        can_see_contacts: false,
        can_see_calendar: false,
    };

    let resolved = resolve_project_contact_policy(
        "workspace_alpha",
        "contact_123",
        "whatsapp",
        &perimeter,
    );

    assert!(resolved.authorized);
    assert!(resolved.can_trigger_automations);
    assert!(resolved.can_use_project_memory);
    assert_eq!(resolved.tools_denied, vec!["browser", "filesystem"]);
}
```

- [ ] **Step 2: Implement resolver DTO**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
struct EffectiveProjectContactPolicy {
    authorized: bool,
    can_trigger_automations: bool,
    can_use_project_memory: bool,
    can_receive_replies: bool,
    can_receive_artifacts: bool,
    tools_denied: Vec<String>,
    denied_reason: String,
}

fn resolve_project_contact_policy(
    workspace_id: &str,
    contact_reference: &str,
    channel: &str,
    perimeter: &chat_store::StoredPerimeter,
) -> EffectiveProjectContactPolicy {
    let normalized_channel = channel.trim().to_lowercase();
    let grant = list_project_access(workspace_id).into_iter().find(|grant| {
        grant.contact_reference == contact_reference.trim() && grant.channel == normalized_channel
    });
    let Some(grant) = grant else {
        return EffectiveProjectContactPolicy {
            authorized: false,
            can_trigger_automations: false,
            can_use_project_memory: false,
            can_receive_replies: false,
            can_receive_artifacts: false,
            tools_denied: perimeter.tools_denied.clone(),
            denied_reason: "contact/channel is not authorized for this project".to_string(),
        };
    };

    let mut tools_denied = perimeter.tools_denied.clone();
    tools_denied.extend(grant.capability_denies.clone());
    tools_denied.sort();
    tools_denied.dedup();

    EffectiveProjectContactPolicy {
        authorized: true,
        can_trigger_automations: grant.can_trigger_automations,
        can_use_project_memory: grant.can_use_project_memory,
        can_receive_replies: grant.can_receive_replies,
        can_receive_artifacts: grant.can_receive_artifacts,
        tools_denied,
        denied_reason: String::new(),
    }
}
```

- [ ] **Step 3: Run resolver tests**

Run:

```bash
cargo test -p local-first-desktop-gateway project_policy_ -- --nocapture
```

Expected: pass.

### Task 4: Project Access UI

**Files:**
- Create: `apps/desktop/src/components/ProjectAccessDialog.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/components/styles.css`

- [ ] **Step 1: Add dialog component**

Create `ProjectAccessDialog.tsx` with:

```tsx
import { Shield, Trash2, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  coreBridge,
  type CoreContact,
  type ProjectAccessGrant,
  type WorkspaceRecord,
} from "../lib/coreBridge";

type Props = {
  workspace: WorkspaceRecord | null;
  onClose: () => void;
};

const CHANNELS = ["whatsapp", "telegram", "email"];

export function ProjectAccessDialog({ workspace, onClose }: Props) {
  const [contacts, setContacts] = useState<CoreContact[]>([]);
  const [grants, setGrants] = useState<ProjectAccessGrant[]>([]);
  const [contactReference, setContactReference] = useState("");
  const [channel, setChannel] = useState("whatsapp");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    void Promise.all([coreBridge.contacts(), coreBridge.projectAccess(workspace.id)]).then(
      ([nextContacts, nextGrants]) => {
        setContacts(nextContacts);
        setGrants(nextGrants);
        setContactReference(nextContacts[0]?.reference ?? "");
      },
    );
  }, [workspace]);

  const selectedContact = useMemo(
    () => contacts.find((contact) => contact.reference === contactReference),
    [contacts, contactReference],
  );

  if (!workspace) return null;

  async function addGrant() {
    if (!workspace || !selectedContact) return;
    setSaving(true);
    try {
      const next = await coreBridge.upsertProjectAccess(workspace.id, {
        contact_reference: selectedContact.reference,
        contact_name: selectedContact.name,
        channel,
        can_trigger_automations: true,
        can_use_project_memory: true,
        can_receive_replies: true,
        can_receive_artifacts: false,
        capability_denies: [],
      });
      setGrants(next);
    } finally {
      setSaving(false);
    }
  }

  async function removeGrant(grant: ProjectAccessGrant) {
    if (!workspace) return;
    const next = await coreBridge.removeProjectAccess(
      workspace.id,
      grant.contact_reference,
      grant.channel,
    );
    setGrants(next);
  }

  return (
    <div className="project-access-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="project-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Project access for ${workspace.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="project-access-header">
          <div>
            <p className="eyebrow">Project access</p>
            <h2>{workspace.name}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            x
          </button>
        </header>

        <div className="project-access-add">
          <select value={contactReference} onChange={(e) => setContactReference(e.target.value)}>
            {contacts.map((contact) => (
              <option key={contact.reference} value={contact.reference}>
                {contact.name}
              </option>
            ))}
          </select>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button className="primary-button" type="button" disabled={!selectedContact || saving} onClick={addGrant}>
            <UserPlus size={15} /> Authorize
          </button>
        </div>

        <div className="project-access-list">
          {grants.length === 0 ? (
            <p className="muted">No contacts are authorized for this project yet.</p>
          ) : (
            grants.map((grant) => (
              <article className="project-access-row" key={`${grant.contact_reference}:${grant.channel}`}>
                <Shield size={16} />
                <div>
                  <strong>{grant.contact_name || grant.contact_reference}</strong>
                  <span>{grant.channel}</span>
                </div>
                <div className="project-access-flags">
                  {grant.can_trigger_automations ? <span>Automations</span> : null}
                  {grant.can_use_project_memory ? <span>Project memory</span> : null}
                  {grant.can_receive_replies ? <span>Replies</span> : null}
                  {grant.can_receive_artifacts ? <span>Artifacts</span> : null}
                </div>
                <button className="icon-button" type="button" onClick={() => removeGrant(grant)} aria-label="Remove access">
                  <Trash2 size={15} />
                </button>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Wire from project context menu**

In `Sidebar.tsx`, add local state:

```tsx
const [accessProject, setAccessProject] = useState<WorkspaceRecord | null>(null);
```

Add a project context menu item:

```tsx
<button type="button" onClick={() => setAccessProject(project)}>
  <Shield size={14} /> Manage access
</button>
```

Render the dialog near other modals:

```tsx
<ProjectAccessDialog workspace={accessProject} onClose={() => setAccessProject(null)} />
```

- [ ] **Step 3: Add CSS using existing island tokens**

Use rounded island/card styles consistent with sidebar/settings:

```css
.project-access-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--bg) 52%, transparent);
}

.project-access-dialog {
  width: min(720px, calc(100vw - 48px));
  max-height: min(720px, calc(100vh - 48px));
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  padding: 18px;
}

.project-access-header,
.project-access-add,
.project-access-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.project-access-header {
  justify-content: space-between;
  margin-bottom: 16px;
}

.project-access-add {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-subtle);
}

.project-access-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.project-access-row {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px;
}

.project-access-row > div:nth-child(2) {
  min-width: 150px;
  display: grid;
  gap: 2px;
}

.project-access-row span,
.project-access-flags span {
  color: var(--muted);
  font-size: 12px;
}

.project-access-flags {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
```

- [ ] **Step 4: Build and smoke**

Run:

```bash
npm run build
```

Manual smoke:

1. Open Electron.
2. Hover a project.
3. Open project menu.
4. Click `Manage access`.
5. Add Fabio/WhatsApp.
6. Close and reopen the dialog.
7. Verify the grant persisted and the UI matches dark/light themes.

### Task 5: Runtime Guardrail Before Event Automations

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Introduce a single helper for channel-originated project scope**

Add:

```rust
fn channel_project_access_or_personal(
    maybe_workspace_id: Option<&str>,
    contact_reference: &str,
    channel: &str,
    perimeter: &chat_store::StoredPerimeter,
) -> EffectiveProjectContactPolicy {
    let Some(workspace_id) = maybe_workspace_id.filter(|value| !value.trim().is_empty()) else {
        return EffectiveProjectContactPolicy {
            authorized: true,
            can_trigger_automations: false,
            can_use_project_memory: false,
            can_receive_replies: true,
            can_receive_artifacts: false,
            tools_denied: perimeter.tools_denied.clone(),
            denied_reason: String::new(),
        };
    };
    resolve_project_contact_policy(workspace_id, contact_reference, channel, perimeter)
}
```

- [ ] **Step 2: Apply the helper only where a channel turn requests a project**

Do not change ordinary app chat. In the channel-turn context path, before using project memory/folders/artifacts, resolve the policy. If `can_use_project_memory=false`, use personal/channel scope and add a trace line:

```rust
tool_trace.push(format!(
    "project access denied for {channel}:{contact_reference} on {workspace_id}: {}",
    policy.denied_reason
));
```

- [ ] **Step 3: Add test**

Add a gateway unit test that asserts unauthorized channel project access does not enable project memory. Use the smallest local helper-level test if the full channel harness is too broad.

Run:

```bash
cargo test -p local-first-desktop-gateway project_policy_ -- --nocapture
```

Expected: pass.

---

## Milestone 2: Event Source Contract

Only start after Milestone 1 is green.

### Task 6: Normalize Event Envelope

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] Add `NormalizedAutomationEvent` with stable `event_id`, `source_kind`, `provider_id`, `event_type`, `actor`, `payload`, `dedup_key`, `visibility`, and optional `workspace_id`.
- [ ] Add tests for serde round-trip and stable dedup key.
- [ ] Run `cargo test -p local-first-task-runtime automation_event -- --nocapture`.

### Task 7: Event Source Discovery

**Files:**
- Modify: `crates/skill-runtime/src/provider.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/components/AutomationsView.tsx`

- [ ] Surface channels, scheduler, connector polling, MCP polling and addon triggers as typed event sources.
- [ ] Keep UI read-only for event sources whose provider is disconnected.
- [ ] Run gateway and desktop build.

---

## Milestone 3: Channel Event Rules

### Task 8: Match WhatsApp/Telegram Inbound Events

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] Convert inbound channel messages into `NormalizedAutomationEvent`.
- [ ] Resolve project/contact policy before matching rules.
- [ ] Create visible user placeholder immediately in the owning thread.
- [ ] Emit `thread.turn_started` so Workspace Island/Computer appear at once.
- [ ] Reuse the same turn lifecycle used by app chat.
- [ ] Add tests for visible placeholder, unauthorized-project denial, and no hidden run.

### Task 9: Send-Back Continuity

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] Preserve existing channel-recipient continuity.
- [ ] Gate channel send-back by `can_receive_replies` and rule policy.
- [ ] Gate artifact send-back by `can_receive_artifacts` and approval.
- [ ] Add tests where app-side reply in a channel-owned thread mirrors back to the channel only when allowed.

---

## Milestone 4: Polling and Addon Actions

### Task 10: Connector/MCP Polling

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/task-runtime/src/types.rs`

- [ ] Implement polling cursor state on automation `state`.
- [ ] Dedup by provider stable id.
- [ ] Show events as logical triggers, not as generic schedules.
- [ ] Add Gmail unread smoke once connector credentials are available.

### Task 11: Capability/Addons as Actions

**Files:**
- Modify: capability registry and automation execution path discovered during implementation.

- [ ] Route action prompt through the unified capability registry.
- [ ] Allow Presentations/Documents/PDF only through policy-approved capability execution.
- [ ] Keep generated artifacts in managed artifact storage and MemoryFacade provenance.
- [ ] Require approval before external send/publish unless explicitly authorized.

---

## Milestone 5: UI Builder and Evals

### Task 12: IFTTT Builder

**Files:**
- Modify: `apps/desktop/src/components/AutomationsView.tsx`

- [ ] Replace event builder with IF / FILTER / THEN zones.
- [ ] Keep schedules.
- [ ] Show polling as "checked every N minutes" only when the provider lacks push.
- [ ] Disable invalid project/contact combinations.

### Task 13: Eval and Release Gate

**Files:**
- Modify: `scripts/eval_suite.py`
- Modify: `scripts/pre_release_gate.py`
- Modify docs.

- [ ] Eval: unauthorized contact cannot access project memory.
- [ ] Eval: authorized WhatsApp contact can trigger a visible rule.
- [ ] Eval: Presentations addon can be selected but cannot auto-send without policy.
- [ ] Eval: new chat can recall why a rule fired via memory/provenance.
- [ ] Gate: `cargo test -p local-first-desktop-gateway -- --nocapture`.
- [ ] Gate: `npm run test:ui-contract`.
- [ ] Gate: `npm run build`.
- [ ] Gate: `git diff --check`.

---

## Execution Notes

- Do not create a separate semantic automation memory store.
- Do not infer project access from message text.
- Do not let project access widen contact perimeter silently.
- Do not run evented automations hidden in the background.
- Do not let subagents bypass project access; subagents inherit the resolved effective policy for the parent run.
- Keep commits per milestone or smaller if a task is independently green.
