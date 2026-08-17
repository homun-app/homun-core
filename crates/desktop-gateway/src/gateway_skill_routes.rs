//! Skill management, catalog, and registry HTTP routes.
//!
//! The scanner/catalog/security engines live in `skills*` modules. This owner
//! keeps route DTOs, local enablement state, origins, and GitHub/ClawHub
//! install orchestration out of the gateway root.

use std::{env, fs, path::PathBuf};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, GatewayError, gateway_paths::gateway_data_dir, homuncoder_skill_ids, skill_security,
    skills, skills_catalog, skills_dir,
};

fn skills_state_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("skills-state.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SkillsState {
    #[serde(default)]
    disabled: Vec<String>,
}

/// Loads the set of disabled skill ids (default: empty → everything enabled).
pub(crate) fn load_skills_disabled() -> std::collections::BTreeSet<String> {
    let Some(path) = skills_state_path() else {
        return std::collections::BTreeSet::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return std::collections::BTreeSet::new();
    };
    serde_json::from_str::<SkillsState>(&raw)
        .map(|s| s.disabled.into_iter().collect())
        .unwrap_or_default()
}

fn save_skills_disabled(disabled: &std::collections::BTreeSet<String>) -> Result<(), String> {
    let path = skills_state_path().ok_or_else(|| "data dir unavailable".to_string())?;
    let state = SkillsState {
        disabled: disabled.iter().cloned().collect(),
    };
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub(crate) struct SkillsResponse {
    skills: Vec<skills::SkillSummary>,
    /// Absolute path of the skills directory (shown in the UI empty state).
    dir: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetSkillEnabledRequest {
    enabled: bool,
}

fn skills_origins_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("skills-origins.json"))
}

/// Loads the id → source map (e.g. "github:anthropics/skills"). Skills not in
/// the map are treated as "local".
pub(crate) fn load_skills_origins() -> std::collections::BTreeMap<String, String> {
    let Some(path) = skills_origins_path() else {
        return std::collections::BTreeMap::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return std::collections::BTreeMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub(crate) fn save_skills_origins(
    origins: &std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    let path = skills_origins_path().ok_or_else(|| "data dir unavailable".to_string())?;
    let json = serde_json::to_string_pretty(origins).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn current_skills_response() -> SkillsResponse {
    let dir = skills_dir().ok();
    let disabled = load_skills_disabled();
    let origins = load_skills_origins();
    let mut skills = dir
        .as_deref()
        .map(|d| skills::scan_skills(d, &disabled, &origins))
        .unwrap_or_default();
    // Tag the methodology skills so Settings can group them under "HomunCoder".
    let homuncoder = homuncoder_skill_ids();
    for skill in &mut skills {
        if homuncoder.contains(&skill.id) {
            skill.source = "homuncoder".to_string();
        }
    }
    SkillsResponse {
        skills,
        dir: dir
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

pub(crate) async fn list_skills() -> Json<SkillsResponse> {
    Json(current_skills_response())
}

/// Skill detail + a static security scan of its files.
#[derive(Debug, Serialize)]
pub(crate) struct SkillDetailResponse {
    #[serde(flatten)]
    detail: skills::SkillDetail,
    security: skill_security::SecurityReport,
}

pub(crate) async fn skill_detail(
    Path(id): Path<String>,
) -> Result<Json<SkillDetailResponse>, GatewayError> {
    let dir = skills_dir().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skills_dir_unavailable",
        message: e.to_string(),
    })?;
    let disabled = load_skills_disabled();
    let origins = load_skills_origins();
    match skills::load_detail(&dir, &id, &disabled, &origins).map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skill_read_failed",
        message: e.to_string(),
    })? {
        Some(detail) => {
            let security = skill_security::scan_dir(&dir.join(&id));
            Ok(Json(SkillDetailResponse { detail, security }))
        }
        None => Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "skill_not_found",
            message: format!("skill {id} not found"),
        }),
    }
}

pub(crate) async fn set_skill_enabled(
    Path(id): Path<String>,
    Json(request): Json<SetSkillEnabledRequest>,
) -> Result<Json<SkillsResponse>, GatewayError> {
    let mut disabled = load_skills_disabled();
    if request.enabled {
        disabled.remove(&id);
    } else {
        disabled.insert(id);
    }
    save_skills_disabled(&disabled).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skills_state_write_failed",
        message,
    })?;
    Ok(Json(current_skills_response()))
}

// ------------------------------------------------------------- skills catalog

pub(crate) fn skills_catalog_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("clawhub-catalog.json"))
}

#[derive(Debug, Deserialize)]
pub(crate) struct CatalogQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct CategoryCount {
    name: String,
    count: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct CatalogResponse {
    skills: Vec<skills_catalog::CatalogEntry>,
    categories: Vec<CategoryCount>,
    /// Repo to install from (slug → `skills/<slug>` under this repo).
    repo: String,
    total: usize,
    fetched_at: u64,
    /// True when live publisher-aware search failed and cached slug-only
    /// results are being shown instead.
    search_degraded: bool,
}

fn catalog_response(cache: &skills_catalog::CatalogCache, query: &CatalogQuery) -> CatalogResponse {
    let limit = query.limit.unwrap_or(60).min(200);
    let skills = skills_catalog::search(
        cache,
        query.q.as_deref().unwrap_or(""),
        query.category.as_deref(),
        limit,
    );
    let mut categories: Vec<CategoryCount> = skills_catalog::category_counts(cache)
        .into_iter()
        .map(|(name, count)| CategoryCount { name, count })
        .collect();
    categories.sort_by_key(|category| std::cmp::Reverse(category.count));
    CatalogResponse {
        total: cache.entries.len(),
        skills,
        categories,
        repo: skills_catalog::CLAWHUB_REPO.to_string(),
        fetched_at: cache.fetched_at,
        search_degraded: false,
    }
}

/// Browse/search the skill catalog. On a cold or stale cache it refreshes from
/// ClawHub first (slow once, then cached ~6h).
pub(crate) async fn skill_catalog(
    State(state): State<AppState>,
    Query(query): Query<CatalogQuery>,
) -> Result<Json<CatalogResponse>, GatewayError> {
    let path = skills_catalog_path().ok_or_else(|| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "data_dir_unavailable",
        message: "data dir unavailable".to_string(),
    })?;
    let fresh =
        skills_catalog::load_cache(&path).is_some_and(|c| skills_catalog::cache_is_fresh(&c));
    if !fresh && let Err(error) = skills_catalog::refresh_cache(&state.http, &path).await {
        eprintln!("skill catalog refresh failed: {error}");
    }
    let cache = skills_catalog::load_cache(&path).unwrap_or(skills_catalog::CatalogCache {
        fetched_at: 0,
        entries: Vec::new(),
    });
    let text = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let limit = query.limit.unwrap_or(60).min(200);
    let (skills, search_degraded) = if let Some(text) = text {
        match skills_catalog::search_remote(&state.http, text, limit).await {
            Ok(entries) => (
                entries
                    .into_iter()
                    .filter(|entry| {
                        query
                            .category
                            .as_deref()
                            .is_none_or(|category| entry.category.eq_ignore_ascii_case(category))
                    })
                    .take(limit)
                    .collect(),
                false,
            ),
            Err(error) => {
                eprintln!("skill catalog search failed: {error}");
                (
                    skills_catalog::search(&cache, text, query.category.as_deref(), limit),
                    true,
                )
            }
        }
    } else {
        (
            skills_catalog::search(&cache, "", query.category.as_deref(), limit),
            false,
        )
    };
    let mut response = catalog_response(&cache, &query);
    response.skills = skills;
    response.search_degraded = search_degraded;
    Ok(Json(response))
}

/// Force a catalog refresh from ClawHub.
pub(crate) async fn skill_catalog_refresh(
    State(state): State<AppState>,
) -> Result<Json<CatalogResponse>, GatewayError> {
    let path = skills_catalog_path().ok_or_else(|| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "data_dir_unavailable",
        message: "data dir unavailable".to_string(),
    })?;
    skills_catalog::refresh_cache(&state.http, &path)
        .await
        .map_err(|message| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "catalog_refresh_failed",
            message,
        })?;
    let cache = skills_catalog::load_cache(&path).unwrap_or(skills_catalog::CatalogCache {
        fetched_at: 0,
        entries: Vec::new(),
    });
    Ok(Json(catalog_response(
        &cache,
        &CatalogQuery {
            q: None,
            category: None,
            limit: None,
        },
    )))
}

#[derive(Debug, Deserialize)]
pub(crate) struct CatalogInstallRequest {
    slug: String,
    #[serde(default)]
    owner_handle: Option<String>,
}

pub(crate) fn valid_catalog_owner(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn validated_catalog_owner(value: Option<String>) -> Result<Option<String>, GatewayError> {
    let value = value
        .map(|owner| owner.trim().to_string())
        .filter(|owner| !owner.is_empty());
    if value
        .as_deref()
        .is_some_and(|owner| !valid_catalog_owner(owner))
    {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_owner_handle",
            message: "invalid ClawHub owner handle".to_string(),
        });
    }
    Ok(value)
}

pub(crate) fn clawhub_origin(slug: &str, owner_handle: Option<&str>) -> String {
    owner_handle
        .map(|owner| format!("clawhub:@{owner}/{slug}"))
        .unwrap_or_else(|| format!("clawhub:{slug}"))
}

/// Installs a catalog skill: download its ClawHub ZIP, extract into the skills
/// dir (the local scanner then picks it up), record origin. Returns the refreshed
/// local skill list.
pub(crate) async fn install_catalog_skill(
    State(state): State<AppState>,
    Json(request): Json<CatalogInstallRequest>,
) -> Result<Json<SkillsResponse>, GatewayError> {
    let slug = request.slug.trim().to_string();
    let owner_handle = validated_catalog_owner(request.owner_handle)?;
    if !skills::is_safe_id(&slug) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_slug",
            message: format!("invalid slug: «{slug}»"),
        });
    }
    let root = skills_dir().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skills_dir_unavailable",
        message: e.to_string(),
    })?;
    let dest = root.join(&slug);
    if dest.exists() {
        return Err(GatewayError {
            status: StatusCode::CONFLICT,
            code: "skill_exists",
            message: format!("skill «{slug}» already installed"),
        });
    }
    let zip = skills_catalog::download_zip(&state.http, &slug, owner_handle.as_deref())
        .await
        .map_err(|message| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "catalog_download_failed",
            message,
        })?;
    let dest_for_extract = dest.clone();
    tokio::task::spawn_blocking(move || skills_catalog::extract_zip(&zip, &dest_for_extract))
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "catalog_extract_join",
            message: e.to_string(),
        })?
        .map_err(|message| {
            let _ = std::fs::remove_dir_all(&dest);
            GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "catalog_extract_failed",
                message,
            }
        })?;
    let mut origins = load_skills_origins();
    origins.insert(slug.clone(), clawhub_origin(&slug, owner_handle.as_deref()));
    let _ = save_skills_origins(&origins);
    Ok(Json(current_skills_response()))
}

#[derive(Debug, Deserialize)]
pub(crate) struct CatalogPreviewQuery {
    slug: String,
    #[serde(default)]
    owner_handle: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CatalogPreview {
    slug: String,
    owner_handle: Option<String>,
    name: String,
    description: String,
    /// SKILL.md body (frontmatter stripped) for rendering.
    body: String,
    files: Vec<String>,
    security: skill_security::SecurityReport,
}

/// Previews a catalog skill WITHOUT installing: downloads the ZIP, extracts the
/// SKILL.md + file list in memory, and runs the security scan.
pub(crate) async fn preview_catalog_skill(
    State(state): State<AppState>,
    Query(query): Query<CatalogPreviewQuery>,
) -> Result<Json<CatalogPreview>, GatewayError> {
    let slug = query.slug.trim().to_string();
    let owner_handle = validated_catalog_owner(query.owner_handle)?;
    let zip = skills_catalog::download_zip(&state.http, &slug, owner_handle.as_deref())
        .await
        .map_err(|message| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "catalog_download_failed",
            message,
        })?;
    let files = skills_catalog::read_zip_text_files(&zip).map_err(|message| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "catalog_zip_invalid",
        message,
    })?;
    let manifest = files
        .iter()
        .find(|(p, _)| p == "SKILL.md" || p.ends_with("/SKILL.md"))
        .map(|(_, c)| c.clone())
        .unwrap_or_default();
    let (frontmatter, body) = skills::split_frontmatter(&manifest);
    let security = skill_security::scan_blobs(&files);
    Ok(Json(CatalogPreview {
        name: frontmatter.name.unwrap_or_else(|| slug.clone()),
        description: frontmatter.description.unwrap_or_default(),
        body,
        files: files.iter().map(|(p, _)| p.clone()).collect(),
        security,
        slug,
        owner_handle,
    }))
}

// ---------------------------------------------------------- skills marketplace

/// Curated, directly-installable skill collections (GitHub repos whose folders
/// each contain a `SKILL.md`). Shown as suggestions; the user can also enter any
/// `owner/repo`.
const CURATED_SKILL_REPOS: &[&str] = &["anthropics/skills"];

const SKILL_REGISTRY_MAX: usize = 80;
const SKILL_INSTALL_MAX_FILES: usize = 150;
const SKILL_INSTALL_MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
struct RegistrySkill {
    /// Folder leaf — the id it would get once installed.
    id: String,
    /// Folder path within the repo (e.g. "skills/pdf"), "" if at the root.
    path: String,
    name: String,
    description: String,
    /// True if a skill with this id already exists locally.
    installed: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct RegistryResponse {
    repo: String,
    skills: Vec<RegistrySkill>,
    suggested: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RegistryQuery {
    repo: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct InstallSkillRequest {
    repo: String,
    path: String,
}

/// Validates an `owner/repo` slug. Strict on purpose: the value is interpolated
/// into api.github.com / raw.githubusercontent.com URLs, so rejecting anything
/// unusual prevents being redirected to another host.
pub(crate) fn valid_github_repo(repo: &str) -> bool {
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 {
        return false;
    }
    let ok = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s != "."
            && s != ".."
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    ok(parts[0]) && ok(parts[1])
}

/// Optional GitHub token, which raises the 60 req/hour anonymous limit. Read
/// from env first, then a 0600 file under the data dir. Never logged.
fn github_token() -> Option<String> {
    if let Ok(token) = env::var("HOMUN_GITHUB_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Some(token);
        }
    }
    let path = gateway_data_dir().ok()?.join("github-token");
    let token = fs::read_to_string(path).ok()?.trim().to_string();
    (!token.is_empty()).then_some(token)
}

fn github_get(http: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    let mut builder = http.get(url).header(reqwest::header::USER_AGENT, "homun");
    if let Some(token) = github_token() {
        builder = builder.bearer_auth(token);
    }
    builder
}

fn github_err(code: &'static str, message: impl Into<String>) -> GatewayError {
    GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code,
        message: message.into(),
    }
}

async fn github_default_branch(http: &reqwest::Client, repo: &str) -> Result<String, GatewayError> {
    let url = format!("https://api.github.com/repos/{repo}");
    let resp = github_get(http, &url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| github_err("github_unreachable", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(github_err(
            "github_repo_error",
            format!("repo {repo}: HTTP {}", resp.status()),
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| github_err("github_bad_json", e.to_string()))?;
    Ok(body
        .get("default_branch")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("main")
        .to_string())
}

/// Recursive git tree as (path, is_blob) pairs.
async fn github_tree(
    http: &reqwest::Client,
    repo: &str,
    branch: &str,
) -> Result<Vec<(String, bool)>, GatewayError> {
    let url = format!("https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1");
    let resp = github_get(http, &url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| github_err("github_unreachable", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(github_err(
            "github_tree_error",
            format!("tree {repo}@{branch}: HTTP {}", resp.status()),
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| github_err("github_bad_json", e.to_string()))?;
    let tree = body
        .get("tree")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| github_err("github_no_tree", "repo tree missing"))?;
    Ok(tree
        .iter()
        .filter_map(|node| {
            let path = node
                .get("path")
                .and_then(serde_json::Value::as_str)?
                .to_string();
            let is_blob = node.get("type").and_then(serde_json::Value::as_str) == Some("blob");
            Some((path, is_blob))
        })
        .collect())
}

async fn github_raw_bytes(
    http: &reqwest::Client,
    repo: &str,
    branch: &str,
    path: &str,
) -> Result<Vec<u8>, GatewayError> {
    let url = format!("https://raw.githubusercontent.com/{repo}/{branch}/{path}");
    let resp = github_get(http, &url)
        .send()
        .await
        .map_err(|e| github_err("github_unreachable", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(github_err(
            "github_raw_error",
            format!("{path}: HTTP {}", resp.status()),
        ));
    }
    Ok(resp
        .bytes()
        .await
        .map_err(|e| github_err("github_read_error", e.to_string()))?
        .to_vec())
}

/// Derives the install id (folder leaf) from a skill folder path within a repo.
/// A root-level skill (empty folder) uses the repo name.
fn skill_id_for(repo: &str, folder: &str) -> String {
    if folder.is_empty() {
        repo.split('/').nth(1).unwrap_or("skill").to_string()
    } else {
        folder.rsplit('/').next().unwrap_or("skill").to_string()
    }
}

/// Lists installable skills (folders containing a `SKILL.md`) in a GitHub repo.
/// One GitHub API call for the branch + one for the tree; `SKILL.md` previews
/// are fetched from raw.githubusercontent.com, which is not API-rate-limited.
pub(crate) async fn registry_skills(
    State(state): State<AppState>,
    Query(query): Query<RegistryQuery>,
) -> Result<Json<RegistryResponse>, GatewayError> {
    let repo = query
        .repo
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| CURATED_SKILL_REPOS[0].to_string());
    if !valid_github_repo(&repo) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_repo",
            message: format!("invalid repo: «{repo}» (expected owner/name)"),
        });
    }
    let branch = github_default_branch(&state.http, &repo).await?;
    let tree = github_tree(&state.http, &repo, &branch).await?;
    let installed: std::collections::BTreeSet<String> = current_skills_response()
        .skills
        .into_iter()
        .map(|s| s.id)
        .collect();

    let mut skills = Vec::new();
    for (path, is_blob) in &tree {
        if !is_blob {
            continue;
        }
        if path != "SKILL.md" && !path.ends_with("/SKILL.md") {
            continue;
        }
        if skills.len() >= SKILL_REGISTRY_MAX {
            break;
        }
        let folder = path
            .strip_suffix("SKILL.md")
            .unwrap_or("")
            .trim_end_matches('/')
            .to_string();
        let id = skill_id_for(&repo, &folder);
        if !skills::is_safe_id(&id) {
            continue;
        }
        let (name, description) = match github_raw_bytes(&state.http, &repo, &branch, path).await {
            Ok(bytes) => {
                let (fm, _) = skills::split_frontmatter(&String::from_utf8_lossy(&bytes));
                (
                    fm.name.unwrap_or_else(|| id.clone()),
                    fm.description.unwrap_or_default(),
                )
            }
            Err(_) => (id.clone(), String::new()),
        };
        let installed = installed.contains(&id);
        skills.push(RegistrySkill {
            id,
            path: folder,
            name,
            description,
            installed,
        });
    }

    Ok(Json(RegistryResponse {
        repo,
        skills,
        suggested: CURATED_SKILL_REPOS.iter().map(|s| s.to_string()).collect(),
    }))
}

/// Downloads one skill folder from a GitHub repo into the local skills dir.
/// Staged to a temp directory and atomically renamed so a failed download never
/// leaves a half-written skill. Refuses to overwrite an existing skill.
pub(crate) async fn install_registry_skill(
    State(state): State<AppState>,
    Json(request): Json<InstallSkillRequest>,
) -> Result<Json<SkillsResponse>, GatewayError> {
    if !valid_github_repo(&request.repo) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_repo",
            message: format!("invalid repo: «{}»", request.repo),
        });
    }
    if request.path.contains("..") {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_path",
            message: "invalid skill path".to_string(),
        });
    }
    let folder = request.path.trim_matches('/').to_string();
    let id = skill_id_for(&request.repo, &folder);
    if !skills::is_safe_id(&id) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_skill_id",
            message: format!("invalid skill id: «{id}»"),
        });
    }

    let root = skills_dir().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skills_dir_unavailable",
        message: e.to_string(),
    })?;
    let dest = root.join(&id);
    if dest.exists() {
        return Err(GatewayError {
            status: StatusCode::CONFLICT,
            code: "skill_exists",
            message: format!("skill «{id}» already present — remove it before reinstalling"),
        });
    }

    let branch = github_default_branch(&state.http, &request.repo).await?;
    let tree = github_tree(&state.http, &request.repo, &branch).await?;
    let prefix = if folder.is_empty() {
        String::new()
    } else {
        format!("{folder}/")
    };
    let blobs: Vec<String> = tree
        .iter()
        .filter(|(path, is_blob)| *is_blob && (prefix.is_empty() || path.starts_with(&prefix)))
        .map(|(path, _)| path.clone())
        .collect();

    let manifest = format!("{prefix}SKILL.md");
    if !blobs.contains(&manifest) {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "skill_manifest_missing",
            message: "no SKILL.md at the indicated path".to_string(),
        });
    }
    if blobs.len() > SKILL_INSTALL_MAX_FILES {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "skill_too_many_files",
            message: format!(
                "the skill has {} files (max {SKILL_INSTALL_MAX_FILES})",
                blobs.len()
            ),
        });
    }

    // Stage to a sibling temp dir, then atomically rename into place.
    let staging = root.join(format!(".staging-{id}"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skill_stage_failed",
        message: e.to_string(),
    })?;

    let mut total = 0usize;
    for path in &blobs {
        let rel = path.strip_prefix(&prefix).unwrap_or(path);
        if rel.is_empty() || rel.split('/').any(|c| c == ".." || c.is_empty()) {
            continue;
        }
        let bytes = match github_raw_bytes(&state.http, &request.repo, &branch, path).await {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
        };
        total += bytes.len();
        if total > SKILL_INSTALL_MAX_BYTES {
            let _ = fs::remove_dir_all(&staging);
            return Err(GatewayError {
                status: StatusCode::BAD_REQUEST,
                code: "skill_too_large",
                message: "skill too large".to_string(),
            });
        }
        let out = staging.join(rel);
        if let Some(parent) = out.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(error) = fs::write(&out, &bytes) {
            let _ = fs::remove_dir_all(&staging);
            return Err(GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "skill_write_failed",
                message: error.to_string(),
            });
        }
    }

    if let Err(error) = fs::rename(&staging, &dest) {
        let _ = fs::remove_dir_all(&staging);
        return Err(GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "skill_install_failed",
            message: error.to_string(),
        });
    }

    let mut origins = load_skills_origins();
    origins.insert(id, format!("github:{}", request.repo));
    let _ = save_skills_origins(&origins);

    Ok(Json(current_skills_response()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_skill_routes_owner_validates_catalog_owner_handles() {
        assert!(valid_catalog_owner("fabio.dev_1"));
        assert!(!valid_catalog_owner(""));
        assert!(!valid_catalog_owner("fabio/dev"));
    }

    #[test]
    fn gateway_skill_routes_owner_validates_github_repositories() {
        assert!(valid_github_repo("owner/repo"));
        assert!(!valid_github_repo("owner/repo/extra"));
        assert!(!valid_github_repo("../repo"));
    }
}
