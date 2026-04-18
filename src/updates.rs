//! Update checker (Sprint 9 UPD-1).
//!
//! Polls the GitHub Releases API once per day to discover if a newer
//! version of Homun is available. The result is cached in `AppState` so
//! the topbar chip and the `/v1/updates/status` endpoint read it without
//! hitting GitHub on every refresh.
//!
//! # Design notes
//!
//! - **Notifier only, never auto-updater.** This subsystem points the user
//!   at the right download mechanism (apt / dnf / brew / WSL) but does
//!   NOT self-update the binary. Auto-update is a post-v1.0 feature
//!   (tracked as UPD-2 in UNIFIED-ROADMAP) because it requires signed
//!   update manifests, atomic replace, and a security audit.
//!
//! - **Respects each installer's native update path.** The platform hint
//!   returned by `detect_platform_hint` suggests the command matching
//!   the installer the user most likely used — `apt upgrade homun` on
//!   Debian/Ubuntu (including Windows-via-WSL), `dnf upgrade homun` on
//!   Fedora/RHEL, `brew upgrade homun` on macOS. Homun never downloads
//!   a .deb / .rpm / .dmg behind the user's back.
//!
//! - **Opt-out gated on config.** `[updates] check_enabled = false`
//!   disables the background task entirely. The endpoint then returns
//!   `{ check_enabled: false }` and the UI hides the chip.
//!
//! - **Single poll per day**. The GitHub API has a 60-req/hour
//!   unauthenticated rate limit per IP. One request per day per Homun
//!   instance is nowhere near the limit even with 1000+ concurrent users.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Default polling interval: once every 24 hours.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Initial delay after gateway boot before the first check (60 seconds).
///
/// Gives the gateway time to settle (channels connected, DB migrations
/// applied, health checks green) before we hit an external API. Also
/// avoids a thundering herd on GitHub if many users restart
/// simultaneously — each Homun instance staggers by its own boot time.
pub const INITIAL_DELAY: Duration = Duration::from_secs(60);

/// Structured result returned by [`check_for_update`] and cached in AppState.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    /// The installed version (from `CARGO_PKG_VERSION`).
    pub current: String,
    /// The latest release tag on GitHub, normalized (leading `v` stripped).
    pub latest: String,
    /// Whether `latest` is strictly greater than `current` (semver).
    pub available: bool,
    /// HTML URL of the latest release on GitHub.
    pub release_url: String,
    /// RFC-3339 timestamp when the release was published on GitHub.
    pub published_at: String,
    /// Platform-aware hint: the command the user should run to upgrade,
    /// inferred from `std::env::consts::{OS, ARCH}`.
    pub platform_hint: String,
    /// RFC-3339 timestamp when we last polled GitHub successfully.
    pub checked_at: String,
}

/// GitHub Releases API response subset — we only parse the fields we need.
#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    published_at: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// Check GitHub Releases for a newer version.
///
/// - `repo`: the `owner/name` pair of the public repo that hosts releases
///   (typically `homun-app/homun` per Sprint 9 config default).
/// - `current`: the running binary version — usually `env!("CARGO_PKG_VERSION")`.
///
/// Returns `Ok(UpdateInfo)` on success (with `available` indicating whether
/// an upgrade is actually needed), `Err` on network/parse/semver failures
/// so the caller can log + retry next cycle without corrupting state.
pub async fn check_for_update(
    client: &reqwest::Client,
    repo: &str,
    current: &str,
) -> Result<UpdateInfo> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let response = client
        .get(&url)
        .header(
            reqwest::header::USER_AGENT,
            format!("homun/{} update-checker", current),
        )
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .with_context(|| format!("GitHub Releases API request failed for {}", repo))?;

    let status = response.status();
    if !status.is_success() {
        // 404 is normal when the repo hasn't had any release yet (e.g. freshly
        // created homun-app/homun pre-v1.0). We surface it as an Err so the
        // caller logs at debug level, not as a benign "no update".
        anyhow::bail!("GitHub Releases API returned HTTP {}", status);
    }

    let release: GitHubRelease = response
        .json()
        .await
        .context("Failed to parse GitHub Releases response")?;

    // Drafts and prereleases should never be surfaced to users as "new version" —
    // the maintainer might still be testing and doesn't want early-adopter bug
    // reports from the production channel.
    if release.draft || release.prerelease {
        anyhow::bail!("latest release is draft or prerelease — ignoring");
    }

    let latest = release.tag_name.trim_start_matches('v').to_string();
    let available = is_newer(&latest, current)?;

    Ok(UpdateInfo {
        current: current.to_string(),
        latest,
        available,
        release_url: release.html_url,
        published_at: release.published_at,
        platform_hint: detect_platform_hint(),
        checked_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Compare two semver strings and return true if `remote > local`.
///
/// Both inputs are expected to be in semver format (major.minor.patch with
/// optional prerelease + build metadata). Anything that fails to parse is
/// reported as an error so we don't silently compare invalid versions.
pub fn is_newer(remote: &str, local: &str) -> Result<bool> {
    let remote_v = semver::Version::parse(remote)
        .with_context(|| format!("invalid remote version: {}", remote))?;
    let local_v = semver::Version::parse(local)
        .with_context(|| format!("invalid local version: {}", local))?;
    Ok(remote_v > local_v)
}

/// Detect the platform and return the command the user should run to upgrade.
///
/// The hint is advisory — it suggests the most likely upgrade path based on
/// the binary's build target, not on runtime inspection of the user's
/// system. Windows WSL is indistinguishable from native Linux at this
/// layer, so Windows users see the Linux hint and the docs explain that
/// they should run it inside their WSL shell.
pub fn detect_platform_hint() -> String {
    match std::env::consts::OS {
        "linux" => {
            // Inspect /etc/os-release to distinguish Debian-family (apt)
            // from Red Hat-family (dnf/yum). Falls back to a generic hint
            // if the file is missing or unrecognized.
            match detect_linux_family() {
                LinuxFamily::Debian => "sudo apt update && sudo apt upgrade homun".to_string(),
                LinuxFamily::RedHat => "sudo dnf upgrade homun".to_string(),
                LinuxFamily::Unknown => {
                    "Download the .deb or .rpm from GitHub Releases and reinstall.".to_string()
                }
            }
        }
        "macos" => "brew upgrade homun".to_string(),
        "windows" => {
            // Windows is WSL-first in Sprint 8 — a user running homun.exe
            // on native Windows isn't in our supported surface area.
            "Open your WSL terminal and run: sudo apt upgrade homun".to_string()
        }
        other => format!(
            "Download the latest binary from GitHub Releases for {}",
            other
        ),
    }
}

enum LinuxFamily {
    Debian,
    RedHat,
    Unknown,
}

fn detect_linux_family() -> LinuxFamily {
    let content = match std::fs::read_to_string("/etc/os-release") {
        Ok(c) => c,
        Err(_) => return LinuxFamily::Unknown,
    };
    // /etc/os-release keys are shell-style: `ID=ubuntu`, `ID_LIKE="debian"`.
    // We scan for any line starting with ID or ID_LIKE and classify.
    for line in content.lines() {
        let line = line.trim();
        if let Some(val) = line
            .strip_prefix("ID=")
            .or_else(|| line.strip_prefix("ID_LIKE="))
        {
            let val = val.trim_matches('"').to_lowercase();
            if val.contains("debian") || val.contains("ubuntu") {
                return LinuxFamily::Debian;
            }
            if val.contains("rhel")
                || val.contains("fedora")
                || val.contains("centos")
                || val.contains("rocky")
                || val.contains("alma")
            {
                return LinuxFamily::RedHat;
            }
        }
    }
    LinuxFamily::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_newer_strict_ordering() {
        assert!(is_newer("0.2.0", "0.1.0").unwrap());
        assert!(is_newer("1.0.0", "0.9.9").unwrap());
        assert!(is_newer("0.1.1", "0.1.0").unwrap());
        assert!(!is_newer("0.1.0", "0.1.0").unwrap()); // equal = not newer
        assert!(!is_newer("0.1.0", "0.2.0").unwrap()); // older = not newer
    }

    #[test]
    fn is_newer_handles_prerelease_semver() {
        // Per semver spec, a stable release is always greater than any prerelease
        // of the same version: 1.0.0 > 1.0.0-rc1
        assert!(is_newer("1.0.0", "1.0.0-rc1").unwrap());
        assert!(!is_newer("1.0.0-rc1", "1.0.0").unwrap());
        // Prereleases compare lexically: rc2 > rc1
        assert!(is_newer("1.0.0-rc2", "1.0.0-rc1").unwrap());
    }

    #[test]
    fn is_newer_rejects_invalid() {
        assert!(is_newer("not-a-version", "1.0.0").is_err());
        assert!(is_newer("1.0.0", "bad").is_err());
    }

    #[test]
    fn platform_hint_is_non_empty_on_all_targets() {
        let hint = detect_platform_hint();
        assert!(!hint.is_empty());
        // Must contain a runnable command or a download instruction
        let has_command = hint.contains("apt")
            || hint.contains("dnf")
            || hint.contains("brew")
            || hint.contains("Download");
        assert!(
            has_command,
            "platform hint should contain an actionable command, got: {}",
            hint
        );
    }

    #[test]
    fn update_info_roundtrip_serde() {
        let info = UpdateInfo {
            current: "0.1.0".to_string(),
            latest: "0.2.0".to_string(),
            available: true,
            release_url: "https://github.com/homun-app/homun/releases/tag/v0.2.0".to_string(),
            published_at: "2026-05-01T10:00:00Z".to_string(),
            platform_hint: "brew upgrade homun".to_string(),
            checked_at: "2026-05-02T08:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&info).unwrap();
        let parsed: UpdateInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.current, "0.1.0");
        assert_eq!(parsed.latest, "0.2.0");
        assert!(parsed.available);
    }
}
