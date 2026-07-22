//! Skill catalog browser — ported/adapted from the Homun project
//! (`src/skills/clawhub.rs` + `search.rs`).
//!
//! Fetches the OpenClaw/ClawHub skill registry, caches it locally for instant
//! search, and derives a topical category per skill (ClawHub itself has no
//! topical taxonomy — only per-source counts — so we classify by keywords into
//! the same buckets officialskills.sh uses). Installing a catalog entry reuses
//! the existing GitHub install path against `openclaw/skills`.

use std::path::Path;

use serde::{Deserialize, Serialize};

const CLAWHUB_API_BASE: &str = "https://clawhub.ai/api/v1";
const CACHE_MAX_AGE_SECS: u64 = 6 * 3600;
/// Pages (×200) pulled on a refresh. ClawHub sorts by downloads, so the first
/// pages are the most popular skills; bounded to keep cold-start latency sane.
const MAX_PAGES: usize = 10;
/// GitHub repo backing ClawHub skills — install pulls `skills/<slug>` from here.
pub const CLAWHUB_REPO: &str = "openclaw/skills";

/// One catalog entry (cached, searchable).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogEntry {
    /// ClawHub slug (also the folder name under `skills/` in the repo).
    pub slug: String,
    /// Publisher identity is present on search results but absent from the
    /// popular-feed cache. Keeping it optional preserves old cache files.
    #[serde(default)]
    pub owner_handle: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub stars: u64,
    /// Derived topical category (see [`derive_category`]).
    pub category: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CatalogCache {
    pub fetched_at: u64,
    pub entries: Vec<CatalogEntry>,
}

// ---- ClawHub API wire types -------------------------------------------------

#[derive(Debug, Deserialize)]
struct ApiResponse {
    #[serde(default)]
    items: Vec<ApiSkill>,
    #[serde(rename = "nextCursor", default)]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiSkill {
    slug: String,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    stats: ApiStats,
}

#[derive(Debug, Deserialize)]
struct SearchApiResponse {
    #[serde(default)]
    results: Vec<SearchApiSkill>,
}

#[derive(Debug, Deserialize)]
struct SearchApiSkill {
    slug: String,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    downloads: u64,
    #[serde(rename = "ownerHandle", default)]
    owner_handle: Option<String>,
    #[serde(default)]
    owner: Option<SearchApiOwner>,
}

#[derive(Debug, Deserialize)]
struct SearchApiOwner {
    #[serde(rename = "displayName", default)]
    display_name: String,
}

#[derive(Debug, Default, Deserialize)]
struct ApiStats {
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    stars: u64,
}

// ---- category classifier ----------------------------------------------------

/// Classifies a skill into a topical category by keywords over name+description.
/// Buckets mirror officialskills.sh (Development, Infrastructure, AI Tools, Data,
/// Security, Workflows, Design, Docs, Testing).
/// Falls back to "Workflows" (the broadest bucket) when nothing matches.
pub fn derive_category(name: &str, description: &str) -> String {
    let hay = format!("{name} {description}").to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| hay.contains(n));
    if has(&[
        "unit test",
        "test suite",
        "e2e",
        "coverage",
        "pytest",
        "jest",
        "linter",
    ]) {
        "Testing"
    } else if has(&[
        "security",
        "secret",
        "vuln",
        "auth",
        "encrypt",
        "audit",
        "compliance",
        "owasp",
    ]) {
        "Security"
    } else if has(&[
        "deploy",
        "docker",
        "kubernetes",
        "k8s",
        "terraform",
        "infra",
        "ci/cd",
        "devops",
        "cloud",
        "aws",
        "gcp",
        "azure",
    ]) {
        "Infrastructure"
    } else if has(&[
        "data",
        "sql",
        "etl",
        "pandas",
        "dataframe",
        "analytics",
        "database",
        "warehouse",
        "csv",
        "scrap",
    ]) {
        "Data"
    } else if has(&[
        "design", "figma", "css", "tailwind", "brand", "layout", "icon", "image", "canvas",
        "frontend",
    ]) {
        "Design"
    } else if has(&[
        "doc", "readme", "markdown", "writing", "pdf", "docx", "report", "slide", "pptx",
    ]) {
        "Docs"
    } else if has(&[
        "llm",
        "agent",
        "prompt",
        "rag",
        "embedding",
        "model",
        "ai ",
        "ml ",
        "openai",
        "anthropic",
    ]) {
        "AI Tools"
    } else if has(&[
        "code",
        "refactor",
        "git",
        "review",
        "debug",
        "compile",
        "typescript",
        "rust",
        "python",
        "api",
        "sdk",
    ]) {
        "Development"
    } else {
        "Workflows"
    }
    .to_string()
}

// ---- cache I/O + fetch ------------------------------------------------------

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Loads the cache from disk if present (regardless of age).
pub fn load_cache(path: &Path) -> Option<CatalogCache> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn cache_is_fresh(cache: &CatalogCache) -> bool {
    now_secs().saturating_sub(cache.fetched_at) <= CACHE_MAX_AGE_SECS
}

/// Paginates the entire ClawHub registry and rewrites the local cache. Slow
/// (~tens of seconds) but only runs on a cold/stale cache or explicit refresh.
pub async fn refresh_cache(http: &reqwest::Client, path: &Path) -> Result<usize, String> {
    let mut entries: Vec<CatalogEntry> = Vec::new();
    let mut cursor: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let mut url = format!("{CLAWHUB_API_BASE}/skills?sort=downloads&limit=200");
        if let Some(c) = &cursor {
            url.push_str(&format!("&cursor={c}"));
        }
        let resp = http
            .get(&url)
            .header(reqwest::header::USER_AGENT, "homun")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            break;
        }
        let body: ApiResponse = resp.json().await.map_err(|e| e.to_string())?;
        if body.items.is_empty() {
            break;
        }
        for skill in &body.items {
            let name = if skill.display_name.is_empty() {
                skill.slug.clone()
            } else {
                skill.display_name.clone()
            };
            let category = derive_category(&name, &skill.summary);
            entries.push(CatalogEntry {
                slug: skill.slug.clone(),
                owner_handle: None,
                owner_name: None,
                name,
                description: skill.summary.clone(),
                downloads: skill.stats.downloads,
                stars: skill.stats.stars,
                category,
            });
        }
        if body.next_cursor.is_none() {
            break;
        }
        cursor = body.next_cursor;
    }

    let cache = CatalogCache {
        fetched_at: now_secs(),
        entries,
    };
    let count = cache.entries.len();
    let json = serde_json::to_string(&cache).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(count)
}

/// Searches ClawHub's publisher-aware endpoint. Unlike the popular feed, this
/// endpoint intentionally returns every owner/slug match, so callers must not
/// deduplicate entries by slug.
pub async fn search_remote(
    http: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<CatalogEntry>, String> {
    let mut url = reqwest::Url::parse(&format!("{CLAWHUB_API_BASE}/search"))
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("limit", &limit.clamp(1, 200).to_string());
    let response = http
        .get(url)
        .header(reqwest::header::USER_AGENT, "homun")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("search: HTTP {}", response.status()));
    }
    let body = response
        .json::<SearchApiResponse>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(catalog_entries_from_search(body))
}

fn catalog_entries_from_search(response: SearchApiResponse) -> Vec<CatalogEntry> {
    response
        .results
        .into_iter()
        .map(|skill| {
            let name = if skill.display_name.trim().is_empty() {
                skill.slug.clone()
            } else {
                skill.display_name
            };
            let owner_name = skill
                .owner
                .map(|owner| owner.display_name)
                .filter(|value| !value.trim().is_empty());
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
        })
        .collect()
}

// ---- search -----------------------------------------------------------------

/// Filters by optional category + query, ranks by a Homun-style score
/// (substring match + popularity), returns up to `limit` entries.
pub fn search(
    cache: &CatalogCache,
    query: &str,
    category: Option<&str>,
    limit: usize,
) -> Vec<CatalogEntry> {
    let q = query.trim().to_lowercase();
    let terms: Vec<String> = q.split_whitespace().map(str::to_string).collect();

    let mut scored: Vec<(i64, &CatalogEntry)> = cache
        .entries
        .iter()
        .filter(|e| category.map_or(true, |c| e.category.eq_ignore_ascii_case(c)))
        .filter_map(|e| {
            let hay = format!("{} {} {}", e.slug, e.name, e.description).to_lowercase();
            if !terms.is_empty() && !terms.iter().all(|t| hay.contains(t.as_str())) {
                return None;
            }
            let mut score = 0i64;
            if !q.is_empty() && hay.contains(&q) {
                score += 80;
            }
            score += terms.iter().filter(|t| hay.contains(t.as_str())).count() as i64 * 18;
            score += (e.stars.min(5000) / 50) as i64;
            score += (e.downloads.min(500_000) / 5_000) as i64;
            Some((score, e))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, e)| e.clone())
        .collect()
}

// ---- download + install (public ClawHub ZIP) -------------------------------

const DOWNLOAD_BASE: &str = "https://clawhub.ai/api/v1/download";
const MAX_ZIP_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024;

/// Downloads a skill's package ZIP from ClawHub's public download endpoint
/// (`/api/v1/download?slug=`). No scraping, no auth — the same URL the website's
/// "Download" button uses.
pub async fn download_zip(
    http: &reqwest::Client,
    slug: &str,
    owner_handle: Option<&str>,
) -> Result<Vec<u8>, String> {
    let url = download_url(slug, owner_handle);
    let resp = http
        .get(&url)
        .header(reqwest::header::USER_AGENT, "homun")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(download_error_message(status, &body));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_ZIP_BYTES {
        return Err("package too large".to_string());
    }
    Ok(bytes.to_vec())
}

fn download_url(slug: &str, owner_handle: Option<&str>) -> String {
    let mut url = reqwest::Url::parse(DOWNLOAD_BASE).expect("static ClawHub download URL");
    let mut pairs = url.query_pairs_mut();
    pairs.append_pair("slug", slug);
    if let Some(owner) = owner_handle.filter(|value| !value.is_empty()) {
        pairs.append_pair("ownerHandle", owner);
    }
    drop(pairs);
    url.to_string()
}

fn download_error_message(status: reqwest::StatusCode, body: &str) -> String {
    let detail: String = body.trim().chars().take(1024).collect();
    if detail.is_empty() {
        format!("download: HTTP {status}")
    } else {
        format!("download: HTTP {status}: {detail}")
    }
}

/// Returns the text files (relative path, content) inside a skill ZIP — for
/// preview rendering + security preflight without installing.
pub fn read_zip_text_files(zip_bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if !entry.is_file() || entry.size() > MAX_ENTRY_BYTES {
            continue;
        }
        let name = entry.name().to_string();
        let mut buf = String::new();
        use std::io::Read;
        if entry.read_to_string(&mut buf).is_ok() {
            files.push((name, buf));
        }
    }
    Ok(files)
}

/// Extracts a skill ZIP into `dest_dir`, guarding against path traversal and
/// oversized entries. Creates `dest_dir`; caller ensures it doesn't already exist.
pub fn extract_zip(zip_bytes: &[u8], dest_dir: &std::path::Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else {
            continue; // skips entries with `..`/absolute paths
        };
        let out = dest_dir.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if entry.size() > MAX_ENTRY_BYTES {
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Count of entries per category (for the filter chips).
pub fn category_counts(cache: &CatalogCache) -> std::collections::BTreeMap<String, usize> {
    let mut counts = std::collections::BTreeMap::new();
    for entry in &cache.entries {
        *counts.entry(entry.category.clone()).or_insert(0) += 1;
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_classifier_buckets() {
        assert_eq!(
            derive_category("pdf-extractor", "Extract text from PDF documents"),
            "Docs"
        );
        assert_eq!(
            derive_category("k8s-deployer", "Deploy to kubernetes clusters"),
            "Infrastructure"
        );
        assert_eq!(
            derive_category("rag-helper", "Build a RAG pipeline with embeddings"),
            "AI Tools"
        );
        assert_eq!(
            derive_category("pentest", "Scan for security vulnerabilities"),
            "Security"
        );
        assert_eq!(
            derive_category("coverage-bot", "Generate a test suite with coverage"),
            "Testing"
        );
        assert_eq!(
            derive_category("mystery", "helps with miscellaneous chores"),
            "Workflows"
        );
    }

    #[test]
    fn search_filters_and_ranks() {
        let cache = CatalogCache {
            fetched_at: now_secs(),
            entries: vec![
                CatalogEntry {
                    slug: "a".into(),
                    owner_handle: None,
                    owner_name: None,
                    name: "PDF Tools".into(),
                    description: "read pdf".into(),
                    downloads: 1000,
                    stars: 10,
                    category: "Docs".into(),
                },
                CatalogEntry {
                    slug: "b".into(),
                    owner_handle: None,
                    owner_name: None,
                    name: "K8s".into(),
                    description: "deploy".into(),
                    downloads: 5,
                    stars: 0,
                    category: "Infrastructure".into(),
                },
            ],
        };
        let hits = search(&cache, "pdf", None, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].slug, "a");
        // category filter
        assert_eq!(search(&cache, "", Some("Infrastructure"), 10).len(), 1);
        assert_eq!(search(&cache, "", Some("Docs"), 10)[0].slug, "a");
    }

    #[test]
    fn remote_search_keeps_same_slug_from_distinct_publishers() {
        let body: SearchApiResponse = serde_json::from_value(serde_json::json!({
            "results": [
                {
                    "slug": "weather",
                    "displayName": "Weather",
                    "summary": "Forecasts",
                    "downloads": 164739,
                    "ownerHandle": "steipete",
                    "owner": { "displayName": "Peter Steinberger" }
                },
                {
                    "slug": "weather",
                    "displayName": "Weather",
                    "summary": "Forecasts",
                    "downloads": 21,
                    "ownerHandle": "legionspace-hackathon",
                    "owner": { "displayName": "LegionSpace-Hackathon" }
                },
                {
                    "slug": "weather",
                    "displayName": "Weather China",
                    "summary": "China forecasts",
                    "downloads": 9,
                    "ownerHandle": "lfengwa2",
                    "owner": { "displayName": "lfengwa2" }
                }
            ]
        }))
        .unwrap();

        let entries = catalog_entries_from_search(body);

        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries
                .iter()
                .filter_map(|entry| entry.owner_handle.as_deref())
                .collect::<Vec<_>>(),
            vec!["steipete", "legionspace-hackathon", "lfengwa2"]
        );
        assert!(entries.iter().all(|entry| entry.slug == "weather"));
    }

    #[test]
    fn download_url_includes_owner_handle_when_known() {
        assert_eq!(
            download_url("weather", Some("steipete")),
            "https://clawhub.ai/api/v1/download?slug=weather&ownerHandle=steipete"
        );
        assert_eq!(
            download_url("weather", None),
            "https://clawhub.ai/api/v1/download?slug=weather"
        );
    }

    #[test]
    fn download_error_keeps_bounded_upstream_explanation() {
        let message = download_error_message(
            reqwest::StatusCode::CONFLICT,
            "Ambiguous skill slug. Retry with ownerHandle.",
        );
        assert!(message.contains("HTTP 409 Conflict"));
        assert!(message.contains("Retry with ownerHandle"));
        assert!(
            download_error_message(reqwest::StatusCode::BAD_GATEWAY, &"x".repeat(5000)).len()
                < 1300
        );
    }
}
