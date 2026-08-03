//! Plugin package and marketplace registry endpoints.
//!
//! `plugin_packages` owns deterministic archive verification and persistence.
//! This module owns the gateway HTTP wrapper: request DTOs, download limits,
//! registry/trusted-key/license endpoints, and local storage paths.

use crate::*;

const MAX_LOCAL_PLUGIN_PACKAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PLUGIN_REGISTRY_INDEX_BYTES: u64 = 1024 * 1024;

fn exceeds_local_plugin_package_limit(size: u64) -> bool {
    size > MAX_LOCAL_PLUGIN_PACKAGE_BYTES
}

fn exceeds_plugin_registry_index_limit(size: u64) -> bool {
    size > MAX_PLUGIN_REGISTRY_INDEX_BYTES
}

#[derive(Debug, Deserialize)]
pub(crate) struct InstallLocalPluginPackageRequest {
    registry_entry: PluginRegistryEntry,
    package_path: String,
    #[serde(default)]
    homun_version: Option<String>,
    #[serde(default)]
    beta_enabled: bool,
    #[serde(default)]
    trusted_public_keys: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CachePluginRegistryRequest {
    #[serde(default)]
    source_url: Option<String>,
    registry: PluginRegistryIndex,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FetchPluginRegistryRequest {
    source_url: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetTrustedPluginPublicKeysRequest {
    #[serde(default)]
    public_keys: Vec<String>,
    #[serde(default)]
    beta_enabled: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetPluginLicenseRequest {
    token: local_first_capabilities::PluginLicenseToken,
}

#[derive(Debug, Deserialize)]
pub(crate) struct InstallPluginPackageFromRegistryRequest {
    registry_entry: PluginRegistryEntry,
    #[serde(default)]
    homun_version: Option<String>,
    #[serde(default)]
    beta_enabled: bool,
    #[serde(default)]
    trusted_public_keys: Vec<String>,
}

/// POST /api/plugins/packages/install-local -- development/desktop install path
/// for a downloaded `.hplugin`.
pub(crate) async fn install_local_plugin_package(
    Json(request): Json<InstallLocalPluginPackageRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let package_path = PathBuf::from(request.package_path.trim());
    if !package_path.is_file() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_package_missing",
            message: "Plugin package path does not point to a file".to_string(),
        });
    }
    let size = fs::metadata(&package_path)
        .map_err(|e| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_package_metadata_failed",
            message: e.to_string(),
        })?
        .len();
    if exceeds_local_plugin_package_limit(size) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_package_too_large",
            message: "Plugin package is larger than the local install limit".to_string(),
        });
    }

    let archive = fs::read(&package_path).map_err(|e| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "plugin_package_read_failed",
        message: e.to_string(),
    })?;
    let homun_version = request
        .homun_version
        .as_deref()
        .unwrap_or(env!("CARGO_PKG_VERSION"));
    install_verified_plugin_archive(
        &request.registry_entry,
        &archive,
        homun_version,
        request.beta_enabled,
        &request.trusted_public_keys,
        false,
    )
}

pub(crate) async fn install_plugin_package_from_registry(
    State(state): State<AppState>,
    Json(request): Json<InstallPluginPackageFromRegistryRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let archive = download_plugin_package_archive(&state, &request.registry_entry).await?;
    let homun_version = request
        .homun_version
        .as_deref()
        .unwrap_or(env!("CARGO_PKG_VERSION"));
    install_verified_plugin_archive(
        &request.registry_entry,
        &archive,
        homun_version,
        request.beta_enabled,
        &request.trusted_public_keys,
        false,
    )
}

pub(crate) async fn update_plugin_package_from_registry(
    State(state): State<AppState>,
    Json(request): Json<InstallPluginPackageFromRegistryRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let installed = plugin_packages::load_installed_plugin_registry(
        &installed_plugin_registry_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_registry_path_unavailable",
            message: e.to_string(),
        })?,
    )
    .map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "plugin_registry_read_failed",
        message: e,
    })?;
    let Some(installed_plugin) = installed
        .plugins
        .iter()
        .find(|plugin| plugin.plugin_id == request.registry_entry.plugin_id)
    else {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_package_not_installed",
            message: "Plugin package is not installed".to_string(),
        });
    };
    if !request
        .registry_entry
        .is_newer_than(&installed_plugin.version)
    {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_package_update_not_newer",
            message: "Plugin package candidate is not newer than the installed version".to_string(),
        });
    }

    let archive = download_plugin_package_archive(&state, &request.registry_entry).await?;
    let homun_version = request
        .homun_version
        .as_deref()
        .unwrap_or(env!("CARGO_PKG_VERSION"));
    install_verified_plugin_archive(
        &request.registry_entry,
        &archive,
        homun_version,
        request.beta_enabled,
        &request.trusted_public_keys,
        true,
    )
}

async fn download_plugin_package_archive(
    state: &AppState,
    registry_entry: &PluginRegistryEntry,
) -> Result<Bytes, GatewayError> {
    let package_url = registry_entry
        .package_url
        .trim()
        .parse::<reqwest::Url>()
        .map_err(|e| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_package_url_invalid",
            message: e.to_string(),
        })?;
    if package_url.scheme() != "https" {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_package_url_insecure",
            message: "Plugin package download requires an https URL".to_string(),
        });
    }

    let response = state
        .http
        .get(package_url)
        .send()
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "plugin_package_download_failed",
            message: e.to_string(),
        })?;
    if !response.status().is_success() {
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "plugin_package_download_status",
            message: format!("Plugin package returned HTTP {}", response.status()),
        });
    }
    if exceeds_local_plugin_package_limit(response.content_length().unwrap_or(0)) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_package_too_large",
            message: "Plugin package is larger than the local install limit".to_string(),
        });
    }
    let archive = response.bytes().await.map_err(|e| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "plugin_package_download_read_failed",
        message: e.to_string(),
    })?;
    if exceeds_local_plugin_package_limit(archive.len() as u64) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_package_too_large",
            message: "Plugin package is larger than the local install limit".to_string(),
        });
    }
    Ok(archive)
}

fn install_verified_plugin_archive(
    registry_entry: &PluginRegistryEntry,
    archive: &[u8],
    homun_version: &str,
    beta_enabled: bool,
    trusted_public_keys: &[String],
    replace_existing: bool,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let local_trusted_keys;
    let (trusted_public_keys, beta_enabled) = if trusted_public_keys.is_empty() {
        local_trusted_keys = plugin_packages::load_trusted_plugin_public_keys(
            &trusted_plugin_public_keys_path().map_err(|e| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "plugin_trusted_keys_path_unavailable",
                message: e.to_string(),
            })?,
        )
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_trusted_keys_read_failed",
            message: e,
        })?;
        (
            local_trusted_keys.public_keys.as_slice(),
            beta_enabled || local_trusted_keys.beta_enabled,
        )
    } else {
        (trusted_public_keys, beta_enabled)
    };
    let install_root = installed_plugin_packages_root().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "plugin_install_root_unavailable",
        message: e.to_string(),
    })?;
    let installed = plugin_packages::install_hplugin_package(
        registry_entry,
        archive,
        &install_root,
        plugin_packages::PluginInstallOptions {
            homun_version,
            beta_enabled,
            trusted_public_keys,
            replace_existing,
        },
    )
    .map_err(|e| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "plugin_package_install_failed",
        message: e,
    })?;
    let installed_registry = plugin_packages::upsert_installed_plugin_record(
        &installed_plugin_registry_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_registry_path_unavailable",
            message: e.to_string(),
        })?,
        plugin_packages::InstalledPluginRecord {
            plugin_id: installed.plugin_id.clone(),
            version: installed.version.clone(),
            install_dir: installed.install_dir.to_string_lossy().to_string(),
            package_sha256: registry_entry.package_sha256.clone(),
        },
    )
    .map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "plugin_registry_update_failed",
        message: e,
    })?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "plugin_id": installed.plugin_id,
        "version": installed.version,
        "install_dir": installed.install_dir,
        "files": installed.inspection.files,
        "security": installed.inspection.security,
        "installed_plugins": {
            "schema_version": installed_registry.schema_version,
            "plugins": installed_registry.plugins,
        },
    })))
}

/// GET /api/plugins/packages/installed -- read-only view of locally installed
/// package-backed plugins. Missing registry is a clean empty state.
pub(crate) async fn installed_plugin_packages() -> Result<Json<serde_json::Value>, GatewayError> {
    let registry = plugin_packages::load_installed_plugin_registry(
        &installed_plugin_registry_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_registry_path_unavailable",
            message: e.to_string(),
        })?,
    )
    .map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "plugin_registry_read_failed",
        message: e,
    })?;
    Ok(Json(serde_json::json!({
        "schema_version": registry.schema_version,
        "plugins": registry.plugins,
    })))
}

/// GET /api/plugins/packages/updates -- deterministic read-only comparison
/// between the cached marketplace registry and locally installed packages.
pub(crate) async fn plugin_package_updates() -> Result<Json<serde_json::Value>, GatewayError> {
    let installed = plugin_packages::load_installed_plugin_registry(
        &installed_plugin_registry_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_registry_path_unavailable",
            message: e.to_string(),
        })?,
    )
    .map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "plugin_registry_read_failed",
        message: e,
    })?;
    let cached = plugin_packages::load_cached_plugin_registry(
        &cached_plugin_registry_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_registry_cache_path_unavailable",
            message: e.to_string(),
        })?,
    )
    .map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "plugin_registry_cache_read_failed",
        message: e,
    })?;
    let mut updates = Vec::new();
    if let Some(cached) = cached {
        for installed_plugin in &installed.plugins {
            if let Some(candidate) = cached.registry.plugins.iter().find(|entry| {
                entry.plugin_id == installed_plugin.plugin_id
                    && entry.is_newer_than(&installed_plugin.version)
            }) {
                updates.push(serde_json::json!({
                    "plugin_id": installed_plugin.plugin_id,
                    "installed_version": installed_plugin.version,
                    "candidate": candidate,
                }));
            }
        }
    }
    Ok(Json(serde_json::json!({
        "updates": updates,
    })))
}

/// GET/PUT /api/plugins/trusted-keys -- local allowlist of Ed25519 public keys
/// that are allowed to sign marketplace packages.
pub(crate) async fn trusted_plugin_public_keys() -> Result<Json<serde_json::Value>, GatewayError> {
    let trusted = plugin_packages::load_trusted_plugin_public_keys(
        &trusted_plugin_public_keys_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_trusted_keys_path_unavailable",
            message: e.to_string(),
        })?,
    )
    .map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "plugin_trusted_keys_read_failed",
        message: e,
    })?;
    Ok(Json(serde_json::json!({
        "schema_version": trusted.schema_version,
        "beta_enabled": trusted.beta_enabled,
        "public_keys": trusted.public_keys,
    })))
}

pub(crate) async fn set_trusted_plugin_public_keys(
    Json(request): Json<SetTrustedPluginPublicKeysRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let trusted = plugin_packages::save_trusted_plugin_public_keys(
        &trusted_plugin_public_keys_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_trusted_keys_path_unavailable",
            message: e.to_string(),
        })?,
        request.public_keys,
        request.beta_enabled,
    )
    .map_err(|e| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "plugin_trusted_keys_invalid",
        message: e,
    })?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "schema_version": trusted.schema_version,
        "beta_enabled": trusted.beta_enabled,
        "public_keys": trusted.public_keys,
    })))
}

/// GET/PUT /api/plugins/licenses -- local offline license token store. Tokens are
/// accepted only after deterministic signature/plugin/expiry verification.
pub(crate) async fn plugin_licenses()
-> Result<Json<plugin_packages::PluginLicenseStore>, GatewayError> {
    let store =
        plugin_packages::load_plugin_license_store(&plugin_license_store_path().map_err(|e| {
            GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "plugin_license_store_path_unavailable",
                message: e.to_string(),
            }
        })?)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_license_store_read_failed",
            message: e,
        })?;
    Ok(Json(store))
}

pub(crate) async fn set_plugin_license(
    Json(request): Json<SetPluginLicenseRequest>,
) -> Result<Json<plugin_packages::PluginLicenseStore>, GatewayError> {
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "clock_unavailable",
            message: e.to_string(),
        })?
        .as_secs() as i64;
    let store = plugin_packages::upsert_verified_plugin_license(
        &plugin_license_store_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_license_store_path_unavailable",
            message: e.to_string(),
        })?,
        request.token,
        now_unix,
    )
    .map_err(|e| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "plugin_license_rejected",
        message: e,
    })?;
    Ok(Json(store))
}

/// GET/POST /api/plugins/registry/cache -- local marketplace registry cache.
pub(crate) async fn cached_plugin_registry() -> Result<Json<serde_json::Value>, GatewayError> {
    let cached = plugin_packages::load_cached_plugin_registry(
        &cached_plugin_registry_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_registry_cache_path_unavailable",
            message: e.to_string(),
        })?,
    )
    .map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "plugin_registry_cache_read_failed",
        message: e,
    })?;
    Ok(Json(serde_json::json!({
        "cached": cached,
    })))
}

pub(crate) async fn cache_plugin_registry(
    Json(request): Json<CachePluginRegistryRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let cached = plugin_packages::save_cached_plugin_registry(
        &cached_plugin_registry_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_registry_cache_path_unavailable",
            message: e.to_string(),
        })?,
        request.source_url,
        request.registry,
    )
    .map_err(|e| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "plugin_registry_cache_invalid",
        message: e,
    })?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "cached": cached,
    })))
}

pub(crate) async fn fetch_plugin_registry(
    State(state): State<AppState>,
    Json(request): Json<FetchPluginRegistryRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let source_url = request.source_url.trim();
    let parsed_url = source_url
        .parse::<reqwest::Url>()
        .map_err(|e| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_registry_url_invalid",
            message: e.to_string(),
        })?;
    if parsed_url.scheme() != "https" {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_registry_url_insecure",
            message: "Plugin registry fetch requires an https URL".to_string(),
        });
    }

    let response = state
        .http
        .get(parsed_url.clone())
        .send()
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "plugin_registry_fetch_failed",
            message: e.to_string(),
        })?;
    if !response.status().is_success() {
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "plugin_registry_fetch_status",
            message: format!("Plugin registry returned HTTP {}", response.status()),
        });
    }
    if exceeds_plugin_registry_index_limit(response.content_length().unwrap_or(0)) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_registry_too_large",
            message: "Plugin registry response is larger than the local cache limit".to_string(),
        });
    }
    let bytes = response.bytes().await.map_err(|e| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "plugin_registry_read_failed",
        message: e.to_string(),
    })?;
    if exceeds_plugin_registry_index_limit(bytes.len() as u64) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "plugin_registry_too_large",
            message: "Plugin registry response is larger than the local cache limit".to_string(),
        });
    }
    let registry: PluginRegistryIndex =
        serde_json::from_slice(&bytes).map_err(|e| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "plugin_registry_parse_failed",
            message: e.to_string(),
        })?;
    let cached = plugin_packages::save_cached_plugin_registry(
        &cached_plugin_registry_path().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "plugin_registry_cache_path_unavailable",
            message: e.to_string(),
        })?,
        Some(parsed_url.to_string()),
        registry,
    )
    .map_err(|e| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "plugin_registry_cache_invalid",
        message: e,
    })?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "cached": cached,
    })))
}

fn installed_plugin_packages_root() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?.join("plugins").join("installed"))
}

fn installed_plugin_registry_path() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?.join("plugins").join("installed.json"))
}

fn cached_plugin_registry_path() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?
        .join("plugins")
        .join("registry-cache.json"))
}

fn trusted_plugin_public_keys_path() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?
        .join("plugins")
        .join("trusted-keys.json"))
}

fn plugin_license_store_path() -> Result<PathBuf, std::io::Error> {
    Ok(gateway_data_dir()?.join("plugins").join("licenses.json"))
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_LOCAL_PLUGIN_PACKAGE_BYTES, MAX_PLUGIN_REGISTRY_INDEX_BYTES,
        exceeds_local_plugin_package_limit, exceeds_plugin_registry_index_limit,
    };

    #[test]
    fn gateway_plugin_packages_enforces_strict_size_limits() {
        assert!(!exceeds_local_plugin_package_limit(
            MAX_LOCAL_PLUGIN_PACKAGE_BYTES
        ));
        assert!(exceeds_local_plugin_package_limit(
            MAX_LOCAL_PLUGIN_PACKAGE_BYTES + 1
        ));
        assert!(!exceeds_plugin_registry_index_limit(
            MAX_PLUGIN_REGISTRY_INDEX_BYTES
        ));
        assert!(exceeds_plugin_registry_index_limit(
            MAX_PLUGIN_REGISTRY_INDEX_BYTES + 1
        ));
    }
}
