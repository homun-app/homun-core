# ClawHub Publisher-Aware Skill Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrare tutte le skill ClawHub con lo stesso slug come voci publisher-distinte e mantenere `ownerHandle` fino ad anteprima, installazione e provenance locale.

**Architecture:** Il feed popolare cached resta il read model della pagina iniziale; le ricerche testuali passano all'endpoint ClawHub `/api/v1/search`, che espone publisher e duplicati. Il gateway mantiene l'ID locale basato sullo slug, mentre frontend e download usano l'identita' remota `ownerHandle + slug`; una funzione UI pura distingue installazione esatta, collisione e disponibilita'.

**Tech Stack:** Rust/Axum/Reqwest/Serde, Electron React 19/TypeScript, Node test runner, i18next.

---

## File structure

- Modify `crates/desktop-gateway/src/skills_catalog.rs`: wire types ClawHub, ricerca remota, download owner-aware ed errori bounded.
- Modify `crates/desktop-gateway/src/main.rs`: routing search-vs-cache, API owner-aware, validazione e provenance.
- Modify `apps/desktop/src/lib/coreBridge.ts`: tipi e payload catalogo.
- Create `apps/desktop/src/lib/skillCatalogState.{mjs,ts}`: identita' e collisione pure.
- Create `apps/desktop/src/lib/skillCatalogState.test.mjs`: regressioni UI-model.
- Modify `apps/desktop/src/components/{SettingsView,ChatView}.tsx`: card publisher-distinte e caller retrocompatibile.
- Modify `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json`: copy nuovi stati.
- Modify `docs/architecture/skills.md` and `docs/STATO.md`: verita' architetturale ed evidenza.

### Task 1: Preserve duplicate publishers in remote search

**Files:**
- Modify: `crates/desktop-gateway/src/skills_catalog.rs`
- Test: `crates/desktop-gateway/src/skills_catalog.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Write the failing normalization test**

```rust
#[test]
fn remote_search_keeps_same_slug_from_distinct_publishers() {
    let body: SearchApiResponse = serde_json::from_value(serde_json::json!({
        "results": [
            {"slug":"weather","displayName":"Weather","summary":"Forecasts","downloads":164739,"ownerHandle":"steipete","owner":{"displayName":"Peter Steinberger"}},
            {"slug":"weather","displayName":"Weather","summary":"Forecasts","downloads":21,"ownerHandle":"legionspace-hackathon","owner":{"displayName":"LegionSpace-Hackathon"}},
            {"slug":"weather","displayName":"Weather China","summary":"China forecasts","downloads":9,"ownerHandle":"lfengwa2","owner":{"displayName":"lfengwa2"}}
        ]
    })).unwrap();
    let entries = catalog_entries_from_search(body);
    assert_eq!(entries.len(), 3);
    assert_eq!(
        entries.iter().filter_map(|entry| entry.owner_handle.as_deref()).collect::<Vec<_>>(),
        vec!["steipete", "legionspace-hackathon", "lfengwa2"]
    );
    assert!(entries.iter().all(|entry| entry.slug == "weather"));
}
```

- [ ] **Step 2: Run it and verify RED**

```bash
cargo test -p local-first-desktop-gateway remote_search_keeps_same_slug_from_distinct_publishers -- --nocapture
```

Expected: compile failure because the search wire types, normalizer and publisher fields do not exist.

- [ ] **Step 3: Add the minimal model and normalizer**

Add serde-defaulted fields to `CatalogEntry` and initialize them to `None` in cached-feed constructors:

```rust
#[serde(default)]
pub owner_handle: Option<String>,
#[serde(default)]
pub owner_name: Option<String>,
```

Add:

```rust
#[derive(Debug, Deserialize)]
struct SearchApiResponse { #[serde(default)] results: Vec<SearchApiSkill> }

#[derive(Debug, Deserialize)]
struct SearchApiSkill {
    slug: String,
    #[serde(rename = "displayName", default)] display_name: String,
    #[serde(default)] summary: String,
    #[serde(default)] downloads: u64,
    #[serde(rename = "ownerHandle", default)] owner_handle: Option<String>,
    #[serde(default)] owner: Option<SearchApiOwner>,
}

#[derive(Debug, Deserialize)]
struct SearchApiOwner { #[serde(rename = "displayName", default)] display_name: String }

fn catalog_entries_from_search(response: SearchApiResponse) -> Vec<CatalogEntry> {
    response.results.into_iter().map(|skill| {
        let name = if skill.display_name.trim().is_empty() { skill.slug.clone() } else { skill.display_name };
        let owner_name = skill.owner.map(|owner| owner.display_name).filter(|value| !value.trim().is_empty());
        CatalogEntry {
            category: derive_category(&name, &skill.summary),
            slug: skill.slug,
            owner_handle: skill.owner_handle,
            owner_name,
            name,
            description: skill.summary,
            downloads: skill.downloads,
            stars: 0,
        }
    }).collect()
}
```

Add the async boundary, preserving ClawHub ranking:

```rust
pub async fn search_remote(http: &reqwest::Client, query: &str, limit: usize) -> Result<Vec<CatalogEntry>, String> {
    let mut url = reqwest::Url::parse(&format!("{CLAWHUB_API_BASE}/search")).map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("q", query).append_pair("limit", &limit.clamp(1, 200).to_string());
    let response = http.get(url).header(reqwest::header::USER_AGENT, "homun").send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err(format!("search: HTTP {}", response.status())); }
    Ok(catalog_entries_from_search(response.json::<SearchApiResponse>().await.map_err(|error| error.to_string())?))
}
```

- [ ] **Step 4: Run module tests GREEN**

```bash
cargo test -p local-first-desktop-gateway skills_catalog::tests:: -- --nocapture
```

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/skills_catalog.rs
git commit -m "feat: preserve skill publishers in ClawHub search"
```

### Task 2: Make downloads owner-aware and retain upstream detail

**Files:**
- Modify: `crates/desktop-gateway/src/skills_catalog.rs`
- Modify: `crates/desktop-gateway/src/main.rs` (temporary `None` callers)
- Test: `crates/desktop-gateway/src/skills_catalog.rs`

- [ ] **Step 1: Write failing URL/error tests**

```rust
#[test]
fn download_url_includes_owner_handle_when_known() {
    assert_eq!(download_url("weather", Some("steipete")), "https://clawhub.ai/api/v1/download?slug=weather&ownerHandle=steipete");
    assert_eq!(download_url("weather", None), "https://clawhub.ai/api/v1/download?slug=weather");
}

#[test]
fn download_error_keeps_bounded_upstream_explanation() {
    let message = download_error_message(reqwest::StatusCode::CONFLICT, "Ambiguous skill slug. Retry with ownerHandle.");
    assert!(message.contains("HTTP 409 Conflict"));
    assert!(message.contains("Retry with ownerHandle"));
    assert!(download_error_message(reqwest::StatusCode::BAD_GATEWAY, &"x".repeat(5000)).len() < 1300);
}
```

- [ ] **Step 2: Run each test and verify RED**

```bash
cargo test -p local-first-desktop-gateway download_url_includes_owner_handle_when_known -- --nocapture
cargo test -p local-first-desktop-gateway download_error_keeps_bounded_upstream_explanation -- --nocapture
```

- [ ] **Step 3: Implement helpers and update `download_zip`**

```rust
fn download_url(slug: &str, owner_handle: Option<&str>) -> String {
    let mut url = reqwest::Url::parse(DOWNLOAD_BASE).expect("static ClawHub download URL");
    let mut pairs = url.query_pairs_mut();
    pairs.append_pair("slug", slug);
    if let Some(owner) = owner_handle.filter(|value| !value.is_empty()) { pairs.append_pair("ownerHandle", owner); }
    drop(pairs);
    url.to_string()
}

fn download_error_message(status: reqwest::StatusCode, body: &str) -> String {
    let detail: String = body.trim().chars().take(1024).collect();
    if detail.is_empty() { format!("download: HTTP {status}") } else { format!("download: HTTP {status}: {detail}") }
}
```

Change the signature to:

```rust
pub async fn download_zip(http: &reqwest::Client, slug: &str, owner_handle: Option<&str>) -> Result<Vec<u8>, String>
```

Build the request with `download_url`. For a non-success response, save `status`, read `.text()` with an empty fallback, and return `download_error_message`. Retain success byte limits. Pass `None` at both gateway call sites until Task 3.

- [ ] **Step 4: Verify GREEN and compile**

```bash
cargo test -p local-first-desktop-gateway skills_catalog::tests:: -- --nocapture
cargo check -p local-first-desktop-gateway
```

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/skills_catalog.rs crates/desktop-gateway/src/main.rs
git commit -m "fix: target ClawHub downloads by publisher"
```

### Task 3: Wire publisher through gateway APIs, search and provenance

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/main.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Write failing pure contract tests**

```rust
#[test]
fn clawhub_origin_is_publisher_specific_and_legacy_compatible() {
    assert_eq!(clawhub_origin("weather", Some("steipete")), "clawhub:@steipete/weather");
    assert_eq!(clawhub_origin("weather", None), "clawhub:weather");
}

#[test]
fn catalog_owner_validation_rejects_path_or_query_injection() {
    assert!(valid_catalog_owner("legionspace-hackathon"));
    assert!(!valid_catalog_owner("../weather"));
    assert!(!valid_catalog_owner("owner&slug=other"));
}
```

- [ ] **Step 2: Run tests and verify RED**

```bash
cargo test -p local-first-desktop-gateway clawhub_origin_is_publisher_specific_and_legacy_compatible -- --nocapture
cargo test -p local-first-desktop-gateway catalog_owner_validation_rejects_path_or_query_injection -- --nocapture
```

- [ ] **Step 3: Extend requests, validation and provenance**

Add `#[serde(default)] owner_handle: Option<String>` to `CatalogInstallRequest` and `CatalogPreviewQuery`, plus `owner_handle: Option<String>` to `CatalogPreview`. Add:

```rust
fn valid_catalog_owner(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100 && value.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

fn validated_catalog_owner(value: Option<String>) -> Result<Option<String>, GatewayError> {
    let value = value.map(|owner| owner.trim().to_string()).filter(|owner| !owner.is_empty());
    if value.as_deref().is_some_and(|owner| !valid_catalog_owner(owner)) {
        return Err(GatewayError { status: StatusCode::BAD_REQUEST, code: "invalid_owner_handle", message: "invalid ClawHub owner handle".to_string() });
    }
    Ok(value)
}

fn clawhub_origin(slug: &str, owner_handle: Option<&str>) -> String {
    owner_handle.map(|owner| format!("clawhub:@{owner}/{slug}")).unwrap_or_else(|| format!("clawhub:{slug}"))
}
```

Validate owner before network calls, pass it to both `download_zip` calls, and save `clawhub_origin` only after successful extraction.

- [ ] **Step 4: Route text queries to remote search with cache fallback**

Add `search_degraded: bool` to `CatalogResponse`. After loading the cache, select skills with:

```rust
let text = query.q.as_deref().map(str::trim).filter(|value| !value.is_empty());
let limit = query.limit.unwrap_or(60).min(200);
let (skills, search_degraded) = if let Some(text) = text {
    match skills_catalog::search_remote(&state.http, text, limit).await {
        Ok(entries) => (
            entries.into_iter()
                .filter(|entry| query.category.as_deref().is_none_or(|category| entry.category.eq_ignore_ascii_case(category)))
                .take(limit)
                .collect(),
            false,
        ),
        Err(error) => {
            eprintln!("skill catalog search failed: {error}");
            (skills_catalog::search(&cache, text, query.category.as_deref(), limit), true)
        }
    }
} else {
    (skills_catalog::search(&cache, "", query.category.as_deref(), limit), false)
};
```

Build category counts, `total`, `repo`, and `fetched_at` from the cache as today. Use the selected `skills` and flag in the response; do not deduplicate by slug.

- [ ] **Step 5: Verify gateway GREEN**

```bash
cargo test -p local-first-desktop-gateway clawhub_origin_is_publisher_specific_and_legacy_compatible -- --nocapture
cargo test -p local-first-desktop-gateway catalog_owner_validation_rejects_path_or_query_injection -- --nocapture
cargo test -p local-first-desktop-gateway skills_catalog::tests:: -- --nocapture
```

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat: expose publisher-aware skill catalog APIs"
```

### Task 4: Add a pure frontend identity/collision model

**Files:**
- Create: `apps/desktop/src/lib/skillCatalogState.mjs`
- Create: `apps/desktop/src/lib/skillCatalogState.ts`
- Create: `apps/desktop/src/lib/skillCatalogState.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { catalogIdentity, catalogInstallState } from "./skillCatalogState.mjs";

const weather = (owner_handle) => ({ slug: "weather", owner_handle });

test("publisher plus slug is the remote identity", () => {
  assert.equal(catalogIdentity(weather("steipete")), "steipete/weather");
  assert.equal(catalogIdentity(weather("lfengwa2")), "lfengwa2/weather");
  assert.equal(catalogIdentity(weather(null)), "weather");
});

test("installed requires exact provenance", () => {
  const installed = [{ id: "weather", source: "clawhub:@steipete/weather" }];
  assert.equal(catalogInstallState(weather("steipete"), installed), "installed");
  assert.equal(catalogInstallState(weather("lfengwa2"), installed), "occupied");
  assert.equal(catalogInstallState({ slug: "forecast", owner_handle: "x" }, installed), "available");
  assert.equal(catalogInstallState(weather(null), [{ id: "weather", source: "clawhub:weather" }]), "installed");
});
```

- [ ] **Step 2: Verify RED**

```bash
cd apps/desktop && node --test src/lib/skillCatalogState.test.mjs
```

Expected: module-not-found.

- [ ] **Step 3: Implement the model and typed wrapper**

`skillCatalogState.mjs`:

```javascript
export function catalogIdentity(skill) {
  return skill.owner_handle ? `${skill.owner_handle}/${skill.slug}` : skill.slug;
}
export function catalogInstallState(skill, installedSkills) {
  const installed = installedSkills.find((candidate) => candidate.id === skill.slug);
  if (!installed) return "available";
  const expected = skill.owner_handle ? `clawhub:@${skill.owner_handle}/${skill.slug}` : `clawhub:${skill.slug}`;
  return installed.source === expected ? "installed" : "occupied";
}
```

`skillCatalogState.ts`:

```typescript
import * as implementation from "./skillCatalogState.mjs";
export interface CatalogIdentityInput { slug: string; owner_handle?: string | null; }
export interface InstalledSkillIdentity { id: string; source: string; }
export type CatalogInstallState = "available" | "installed" | "occupied";
export const catalogIdentity: (skill: CatalogIdentityInput) => string = implementation.catalogIdentity;
export const catalogInstallState: (skill: CatalogIdentityInput, installed: InstalledSkillIdentity[]) => CatalogInstallState = implementation.catalogInstallState;
```

- [ ] **Step 4: Verify GREEN**

```bash
cd apps/desktop
node --test src/lib/skillCatalogState.test.mjs
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/skillCatalogState.mjs apps/desktop/src/lib/skillCatalogState.ts apps/desktop/src/lib/skillCatalogState.test.mjs
git commit -m "test: define skill catalog publisher identity"
```

### Task 5: Render publisher-distinct cards and exact targets

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/components/SettingsView.tsx`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json`

- [ ] **Step 1: Change the frontend contract first**

In `coreBridge.ts`:

```typescript
export interface CatalogTarget { slug: string; owner_handle?: string | null; }
export interface CatalogSkills extends CatalogTarget {
  owner_name?: string | null;
  name: string; description: string; downloads: number; stars: number; category: string;
}
```

Add `search_degraded: boolean` to `SkillsCatalogResponse` and `owner_handle?: string | null` to `CatalogPreview`. Replace bridge calls with:

```typescript
async function electronCatalogPreview(target: CatalogTarget): Promise<CatalogPreview> {
  const params = new URLSearchParams({ slug: target.slug });
  if (target.owner_handle) params.set("owner_handle", target.owner_handle);
  return gatewayGetJson<CatalogPreview>(`/api/skills/catalog/preview?${params.toString()}`);
}
async function electronCatalogInstall(target: CatalogTarget): Promise<SkillssResponse> {
  return gatewayPostJson<SkillssResponse>("/api/skills/catalog/install", { slug: target.slug, owner_handle: target.owner_handle ?? null });
}
```

- [ ] **Step 2: Run typecheck and verify RED at old string callers**

```bash
cd apps/desktop && npm run typecheck
```

- [ ] **Step 3: Update Settings behavior**

Pass full `skills` summaries into `MarketplaceView`. Use `CatalogSkills` for `previewTarget`, `catalogIdentity(skill)` for React key/busy state, and `catalogInstallState(skill, installedSkills)` for the badge/action. The install function must call `coreBridge.catalogInstall(skill)` and close only that preview. Card copy shows `@owner_handle` and `owner_name`; preview remains openable for `occupied`, while Install renders only for `available`.

Use this state shape:

```typescript
const [busy, setBusy] = useState<string | null>(null);
const [previewTarget, setPreviewTarget] = useState<CatalogSkills | null>(null);
const identity = catalogIdentity(skill);
const installState = catalogInstallState(skill, installedSkills);
```

`CatalogPreviewModal` receives the full target, calls `coreBridge.catalogPreview(target)`, and forwards the same target to install. Render the non-blocking fallback note when `data.search_degraded` is true.

- [ ] **Step 4: Keep ChatView retrocompatible**

```typescript
await coreBridge.catalogInstall({ slug: item.slug });
```

Ambiguous chat cards now show the bounded upstream explanation and never pick a publisher silently.

- [ ] **Step 5: Add locale-parity copy**

Add under `settings` in all five catalogs:

```json
"skillPublisher": "Publisher: @{{owner}}",
"skillSlugOccupied": "Another publisher already occupies this skill ID",
"skillSearchDegraded": "Live publisher search is unavailable; showing cached matches."
```

Use these exact localized values, keeping identical keys so `i18n-parity.test.mjs` passes:

- `it`: `Publisher: @{{owner}}`; `Un altro publisher occupa gia' questo ID skill`; `La ricerca live dei publisher non e' disponibile; mostro i risultati in cache.`
- `es`: `Editor: @{{owner}}`; `Otro editor ya ocupa este ID de skill`; `La busqueda en vivo de editores no esta disponible; se muestran resultados en cache.`
- `fr`: `Editeur : @{{owner}}`; `Un autre editeur occupe deja cet identifiant de skill`; `La recherche en direct des editeurs est indisponible ; affichage des resultats en cache.`
- `de`: `Herausgeber: @{{owner}}`; `Ein anderer Herausgeber belegt bereits diese Skill-ID`; `Die Live-Herausgebersuche ist nicht verfugbar; zwischengespeicherte Treffer werden angezeigt.`

- [ ] **Step 6: Verify frontend GREEN**

```bash
cd apps/desktop
node --test src/lib/skillCatalogState.test.mjs
node --test tests/i18n-parity.test.mjs
npm run typecheck
npm run test:ui-contract
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/coreBridge.ts apps/desktop/src/components/SettingsView.tsx apps/desktop/src/components/ChatView.tsx apps/desktop/src/i18n/locales
git commit -m "feat: show publisher variants in skill search"
```

### Task 6: Document and verify the slice

**Files:**
- Modify: `docs/architecture/skills.md`
- Modify: `docs/STATO.md`

- [ ] **Step 1: Update architecture truth and Mermaid**

Document that blank browsing uses cached `/skills`, text search uses publisher-aware `/search`, preview/download propagate `ownerHandle`, local ID remains slug, and provenance `clawhub:@owner/slug` distinguishes exact install from occupied ID. Rename the Mermaid catalog node to `ClawHub browse cache + publisher search`; keep one canonical install path.

- [ ] **Step 2: Run deterministic gates**

```bash
cargo test -p local-first-desktop-gateway
cd apps/desktop
node --test src/lib/skillCatalogState.test.mjs
npm run test:electron
npm run test:ui-contract
npm run build
cd ../..
git diff --check
```

Expected: zero failures; do not describe an excluded/hung suite as green.

- [ ] **Step 3: Run live ClawHub contract smoke**

```bash
curl -sS -A homun 'https://clawhub.ai/api/v1/search?q=weather&limit=20' | jq '[.results[] | select(.slug == "weather") | .ownerHandle]'
curl -sS -A homun -o /dev/null -w '%{http_code}\n' 'https://clawhub.ai/api/v1/download?slug=weather&ownerHandle=steipete'
```

Expected: first output contains `steipete`, `legionspace-hackathon`, `lfengwa2`; second output is `200`.

- [ ] **Step 4: Record an honest STATO checkpoint**

Record root cause, behavior, exact gate counts/output, and visual validation as `non eseguita` unless Fabio checks the rebuilt app on screen. Do not infer rendered correctness from typecheck or contract tests.

- [ ] **Step 5: Commit docs**

```bash
git add docs/architecture/skills.md docs/STATO.md
git commit -m "docs: record publisher-aware skill catalog"
```

- [ ] **Step 6: Audit scope**

```bash
git status --short --branch
git log -6 --oneline
```

Expected: only the user's pre-existing unrelated deletions/image remain uncommitted; no unrelated path was staged.
