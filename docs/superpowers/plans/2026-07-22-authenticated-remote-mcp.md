# Authenticated Remote MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect bearer-authenticated streamable-HTTP MCP servers such as Orion Moon while storing all HTTP headers in Homun's encrypted Secret Store instead of capability metadata.

**Architecture:** Keep the public `mcpConnect({ headers })` contract, but serialize remote headers into `SecretMaterial` under the connection's deterministic `SecretRef`. Change transport construction to consume a complete `CapabilityConnectionConfig`, resolve its secret on every discovery/tool call, and keep HTTP metadata limited to transport plus URL. Add a small pure frontend request builder so Bearer form behavior is covered by `node:test`.

**Tech Stack:** Rust 2024, Axum gateway, `local-first-secrets`, SQLite capability registry, React 19, TypeScript, Node test runner, i18next.

---

## File structure

- `crates/desktop-gateway/src/main.rs`: MCP connection serialization, Secret Store resolution, transport construction, connect/disconnect lifecycle, and Rust regression tests.
- `apps/desktop/src/lib/mcpConnection.mjs`: pure remote-MCP form validation and request construction shared by React and Node tests.
- `apps/desktop/src/lib/mcpConnection.ts`: typed wrapper for the `.mjs` implementation.
- `apps/desktop/src/lib/mcpConnection.test.mjs`: frontend request-contract tests.
- `apps/desktop/src/components/SettingsView.tsx`: authentication selector and password field.
- `apps/desktop/src/i18n/locales/{en,it,fr,de,es}.json`: translated form labels and help text.
- `docs/architecture/mcp.md`: secure persisted-connection contract.

### Task 1: Secret header serialization contract

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:38592-38606`
- Test: `crates/desktop-gateway/src/main.rs` test module near the existing MCP metadata tests

- [ ] **Step 1: Write failing metadata and secret round-trip tests**

Add tests that construct an `Authorization` header containing `orion-secret`, call the new desired helpers, and assert:

```rust
#[test]
fn mcp_http_metadata_never_contains_headers_or_bearer_token() {
    let metadata = mcp_http_config_to_metadata("https://example.com/mcp");
    let serialized = metadata.to_string();
    assert_eq!(metadata["transport"], "http");
    assert_eq!(metadata["url"], "https://example.com/mcp");
    assert!(metadata.get("headers").is_none());
    assert!(!serialized.contains("orion-secret"));
}

#[test]
fn mcp_http_headers_round_trip_as_secret_material() {
    let headers = std::collections::HashMap::from([
        ("Authorization".to_string(), "Bearer orion-secret".to_string()),
    ]);
    let material = mcp_http_headers_to_secret(&headers).expect("serialize headers");
    let restored = mcp_http_headers_from_secret(material).expect("decode headers");
    assert_eq!(restored, headers);
}

#[test]
fn mcp_http_headers_reject_malformed_secret_material() {
    let material = local_first_secrets::SecretMaterial::from_string("not-json");
    assert!(mcp_http_headers_from_secret(material).is_err());
}
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway mcp_http_
```

Expected: compilation fails because the new helper names/signatures do not exist and `mcp_http_config_to_metadata` still accepts headers.

- [ ] **Step 3: Implement minimal serialization helpers**

Change metadata to persist only URL and transport:

```rust
fn mcp_http_config_to_metadata(url: &str) -> Value {
    serde_json::json!({ "transport": "http", "url": url })
}
```

Add helpers that JSON-serialize a `HashMap<String, String>` to `SecretMaterial` and decode it back. Map UTF-8/JSON failures to non-secret-bearing error strings. Reject blank header names or values before serialization.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same `cargo test ... mcp_http_` command. Expected: all matching tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "test: define secure remote mcp metadata contract"
```

### Task 2: Resolve headers from Secret Store for discovery and execution

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:38400-38840`
- Test: `crates/desktop-gateway/src/main.rs` test module

- [ ] **Step 1: Write failing persisted-connection resolution tests**

Create an isolated encrypted test Secret Store, place the serialized header map at a deterministic `SecretRef`, construct a `CapabilityConnectionConfig` with HTTP metadata and that ref, then assert a new helper returns:

```rust
McpHttpConfig {
    url: "https://example.com/mcp".to_string(),
    headers: vec![("Authorization".to_string(), "Bearer orion-secret".to_string())],
}
```

Add sibling tests proving an unauthenticated HTTP connection resolves with empty headers and a missing referenced secret fails with `MCP credential not found` without containing the token.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway mcp_http_connection_
```

Expected: failure because persisted-connection secret resolution is absent.

- [ ] **Step 3: Implement connection-aware transport construction**

Add `mcp_http_config_from_connection(state, connection)` and change:

```rust
fn build_mcp_transport(
    state: &AppState,
    connection: &CapabilityConnectionConfig,
) -> Result<McpAnyTransport, String>
```

For HTTP, read URL from `connection.metadata`; if `connection.secret_ref` starts with `secret://`, parse it as `SecretRef`, load secret material, decode the map, and supply headers to `McpHttpTransport`. For stdio, continue parsing `connection.metadata` unchanged. Update all call sites in generic capability execution, discovery, refresh, and chat tool execution.

- [ ] **Step 4: Run focused and existing MCP tests**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway mcp_
```

Expected: new resolution tests and the existing 9 MCP tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat: resolve remote mcp headers from secret store"
```

### Task 3: Persist and delete remote MCP header secrets

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:38687-38865`
- Modify: `crates/desktop-gateway/src/main.rs:42490-42555`
- Test: `crates/desktop-gateway/src/main.rs` test module

- [ ] **Step 1: Write failing lifecycle tests**

Extract blocking lifecycle functions with testable inputs. Add a connect test using an in-memory capability registry and isolated encrypted Secret Store. Submit one `Authorization` header and assert the persisted connection:

```rust
assert_eq!(connection.metadata, serde_json::json!({
    "transport": "http",
    "url": "https://example.com/mcp"
}));
assert!(connection.secret_ref.starts_with("secret://"));
assert!(!serde_json::to_string(&connection).unwrap().contains("orion-secret"));
assert!(state.secret_store.get(&connection.secret_ref.parse().unwrap()).unwrap().is_some());
```

Add a disconnect test proving the same `SecretRef` returns no material after provider removal.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway mcp_secret_lifecycle_
```

Expected: tests fail because connect persists headers in metadata and disconnect does not delete secret material.

- [ ] **Step 3: Implement secure connect persistence**

For remote connections with non-empty headers, create:

```rust
SecretRef::new(user.as_str(), workspace.as_str(), provider_id.as_str(), connection_id.as_str())
```

Store `mcp_http_headers_to_secret(&request.headers)` before persisting the connection, put only `secret_ref.as_str()` in `CapabilityConnectionConfig`, and call `mcp_http_config_to_metadata(url)`. For no-header HTTP and stdio, preserve current behavior. If registry persistence fails after a new secret write, call `secret_store.delete(&secret_ref)` before returning the original error.

- [ ] **Step 4: Implement secret-aware disconnect**

Move disconnect body into `mcp_disconnect_blocking`. Read the target connection and parse its `secret_ref` before removing the provider. After registry removal, delete the secret and surface `mcp_secret_delete_failed` if deletion fails.

- [ ] **Step 5: Run focused tests and MCP regression suite**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway mcp_secret_lifecycle_
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway mcp_
```

Expected: all matching tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat: secure remote mcp credential lifecycle"
```

### Task 4: Bearer-authenticated manual MCP form

**Files:**
- Create: `apps/desktop/src/lib/mcpConnection.mjs`
- Create: `apps/desktop/src/lib/mcpConnection.ts`
- Create: `apps/desktop/src/lib/mcpConnection.test.mjs`
- Modify: `apps/desktop/src/components/SettingsView.tsx:4092-4220`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write failing frontend request tests**

Create Node tests for this desired API:

```js
import { buildRemoteMcpConnectInput, remoteMcpReady } from "./mcpConnection.mjs";

test("bearer auth becomes an Authorization header", () => {
  assert.deepEqual(
    buildRemoteMcpConnectInput({
      name: "Orion Moon",
      url: "https://orion-moon.pinkfloyd.competitoor.com/mcp",
      authMode: "bearer",
      bearerToken: "secret-token",
    }),
    {
      name: "Orion Moon",
      url: "https://orion-moon.pinkfloyd.competitoor.com/mcp",
      headers: { Authorization: "Bearer secret-token" },
    },
  );
});

test("bearer mode requires a non-empty token", () => {
  assert.equal(remoteMcpReady({ name: "Orion Moon", url: "https://example.com/mcp", authMode: "bearer", bearerToken: "" }), false);
});

test("no-auth mode sends no credential header", () => {
  assert.deepEqual(buildRemoteMcpConnectInput({ name: "Public", url: "https://example.com/mcp", authMode: "none", bearerToken: "" }), {
    name: "Public",
    url: "https://example.com/mcp",
    headers: {},
  });
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
node --test src/lib/mcpConnection.test.mjs
```

Expected: module-not-found failure because the pure implementation is absent.

- [ ] **Step 3: Implement pure helper and typed wrapper**

Implement trimming, readiness, and request construction in `.mjs`. Export typed `McpRemoteAuthMode`, `McpRemoteForm`, `remoteMcpReady`, and `buildRemoteMcpConnectInput` from the `.ts` wrapper using the established sibling-module pattern.

- [ ] **Step 4: Run test and verify GREEN**

Run the same Node command. Expected: 3 tests pass.

- [ ] **Step 5: Wire the Settings form**

In `McpAddDetail`, add `authMode` and `bearerToken` state. URL mode renders a select with `None` and `Bearer token`; Bearer mode renders a password input with `autoComplete="off"`. Use `remoteMcpReady` for button state and `buildRemoteMcpConnectInput` for the request. Clear `bearerToken` in `finally` so success and failure do not leave the secret in React state.

- [ ] **Step 6: Add npm test script and verify typecheck**

Add `"test:mcp-connection": "node --test src/lib/mcpConnection.test.mjs"`, then run:

```bash
npm run test:mcp-connection
npm run typecheck
```

Expected: 3 tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/mcpConnection.mjs apps/desktop/src/lib/mcpConnection.ts apps/desktop/src/lib/mcpConnection.test.mjs apps/desktop/src/components/SettingsView.tsx apps/desktop/package.json
git commit -m "feat: add bearer auth to remote mcp settings"
```

### Task 5: Localization, documentation, and rendered verification

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `docs/architecture/mcp.md:220-230`

- [ ] **Step 1: Add localized labels**

Add settings keys for authentication, no authentication, Bearer token, token label, token placeholder, and the note that credentials are stored securely on the device. Correct the existing mixed-language Italian MCP copy while touching the same block.

- [ ] **Step 2: Update architecture contract**

Replace the HTTP metadata example containing headers with:

```json
{ "transport": "http", "url": "https://example.com/mcp" }
```

Document that `CapabilityConnectionConfig.secret_ref` points to the encrypted JSON header map and that transport construction resolves it per call.

- [ ] **Step 3: Run static verification**

Run:

```bash
npm run test:mcp-connection
npm run typecheck
npm run build
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway mcp_
cargo fmt --all -- --check
git diff --check
```

Expected: all commands exit 0; the Rust run may emit only pre-existing warnings.

- [ ] **Step 4: Render and inspect Settings**

Start the Vite app, open Settings -> Connectors -> MCP -> Add manual server at a representative desktop width, and verify visually:

- URL mode shows the authentication selector.
- Bearer selection shows a masked token field without nested-card clutter.
- The form remains readable and the connect button state changes with the token.
- No token appears in visible notices, developer output, or the resulting connection details.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/i18n/locales docs/architecture/mcp.md
git commit -m "docs: explain secure authenticated mcp connections"
```

### Task 6: Final regression proof

**Files:**
- Verify only

- [ ] **Step 1: Run gateway MCP and secret-store suites**

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway mcp_
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-secrets
```

- [ ] **Step 2: Run desktop checks**

```bash
cd apps/desktop
npm run test:mcp-connection
npm run typecheck
npm run build
```

- [ ] **Step 3: Inspect persisted-data invariants**

Run the focused Rust test that serializes the stored connection and assert the sentinel `orion-secret` is absent. Inspect `git diff` for accidental token values and confirm only intended files changed.

- [ ] **Step 4: Report exact evidence**

Report each command's pass count/exit status, rendered UI verification, any excluded broader suites, and whether a live Orion Moon smoke test was performed. Never claim live authentication unless a user-supplied token was tested without exposing it.
