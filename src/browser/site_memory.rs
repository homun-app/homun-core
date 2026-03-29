//! Site memory — per-domain knowledge for browser automation.
//!
//! Stores navigation notes, form field schemas, and user preferences
//! in markdown files with YAML frontmatter (same format as SKILL.md).
//! Files live in `~/.homun/brain/sites/{domain}.md` (global) or
//! `~/.homun/brain/profiles/{profile}/sites/{domain}.md` (per-profile).
//!
//! Includes structural fingerprinting: a SHA-256 hash of the page's
//! interactive elements (roles + names, sorted). When the fingerprint
//! changes, navigation notes and form fields are invalidated while
//! user preferences are preserved.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A discovered form field with its role and inferred behavior.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormFieldInfo {
    pub name: String,
    /// ARIA role: `"textbox"`, `"combobox"`, `"checkbox"`, etc.
    pub role: String,
    /// Inferred behavior: `"autocomplete"`, `"datepicker"`, `"select"`, `"free_text"`.
    pub behavior: String,
}

/// Full site memory for a domain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteMemory {
    pub domain: String,
    /// SHA-256 of the page's interactive element structure.
    pub fingerprint: Option<String>,
    /// ISO 8601 timestamp of last fingerprint verification.
    pub last_verified: Option<String>,
    /// Discovered form fields with roles and behaviors.
    #[serde(default)]
    pub form_fields: Vec<FormFieldInfo>,
    /// Free-form navigation notes (markdown).
    #[serde(skip)]
    pub navigation_notes: String,
    /// Free-form user preferences (markdown).
    #[serde(skip)]
    pub user_preferences: String,
}

/// Result of comparing a stored fingerprint with the current page.
#[derive(Debug, PartialEq)]
pub enum FingerprintStatus {
    /// Structure unchanged — memory is valid.
    Match,
    /// Structure changed — invalidate navigation + form fields.
    Changed { old: String, new: String },
    /// No fingerprint stored — first visit, create one.
    NoFingerprint,
}

// ── File I/O ────────────────────────────────────────────────────

/// Resolve the site memory file path.
///
/// Checks profile-scoped path first, then global. Returns the first
/// existing path, or the profile path as default for new files.
pub fn resolve_site_memory_path(
    brain_dir: &Path,
    profile_brain_dir: Option<&Path>,
    domain: &str,
) -> PathBuf {
    let filename = format!("{domain}.md");

    // Profile-scoped path takes priority
    if let Some(profile_dir) = profile_brain_dir {
        let profile_path = profile_dir.join("sites").join(&filename);
        if profile_path.exists() {
            return profile_path;
        }
    }

    // Global path
    let global_path = brain_dir.join("sites").join(&filename);
    if global_path.exists() {
        return global_path;
    }

    // Default: profile if available, else global
    if let Some(profile_dir) = profile_brain_dir {
        profile_dir.join("sites").join(&filename)
    } else {
        global_path
    }
}

/// Load site memory from disk. Returns `None` if the file doesn't exist.
pub async fn load_site_memory(
    brain_dir: &Path,
    profile_brain_dir: Option<&Path>,
    domain: &str,
) -> Option<SiteMemory> {
    let path = resolve_site_memory_path(brain_dir, profile_brain_dir, domain);
    if !path.exists() {
        return None;
    }

    let content = tokio::fs::read_to_string(&path).await.ok()?;
    parse_site_memory(&content, domain)
}

/// Save site memory to disk (YAML frontmatter + markdown body).
pub async fn save_site_memory(
    brain_dir: &Path,
    profile_brain_dir: Option<&Path>,
    domain: &str,
    memory: &SiteMemory,
) -> Result<()> {
    let path = resolve_site_memory_path(brain_dir, profile_brain_dir, domain);

    // Ensure directory exists
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("Failed to create sites directory")?;
    }

    let content = serialize_site_memory(memory);
    tokio::fs::write(&path, content)
        .await
        .context("Failed to write site memory")?;

    tracing::info!(domain = %domain, path = %path.display(), "Saved site memory");
    Ok(())
}

// ── Parsing / Serialization ─────────────────────────────────────

/// Parse a site memory file (YAML frontmatter + markdown body).
///
/// Uses gray_matter for frontmatter extraction, then converts the Pod
/// to serde_json::Value (same pattern as `skills/loader.rs`).
fn parse_site_memory(content: &str, domain: &str) -> Option<SiteMemory> {
    let matter = gray_matter::Matter::<gray_matter::engine::YAML>::new();
    let parsed = matter.parse(content);

    let mut memory = if let Some(data) = parsed.data {
        let json: serde_json::Value = data.into();
        if json.is_null() {
            SiteMemory::new(domain)
        } else {
            let fingerprint = json.get("fingerprint").and_then(|v| v.as_str()).map(String::from);
            let last_verified = json.get("last_verified").and_then(|v| v.as_str()).map(String::from);
            let form_fields = json
                .get("form_fields")
                .and_then(|v| v.as_array())
                .map(|arr| parse_form_fields_from_json(arr))
                .unwrap_or_default();

            SiteMemory {
                domain: domain.to_string(),
                fingerprint,
                last_verified,
                form_fields,
                navigation_notes: String::new(),
                user_preferences: String::new(),
            }
        }
    } else {
        SiteMemory::new(domain)
    };

    // Extract markdown sections from body
    let body = parsed.content;
    memory.navigation_notes = extract_section(&body, "Navigation");
    memory.user_preferences = extract_section(&body, "User Preferences");

    Some(memory)
}

/// Parse form_fields from a JSON array (converted from gray_matter Pod).
fn parse_form_fields_from_json(items: &[serde_json::Value]) -> Vec<FormFieldInfo> {
    let mut fields = Vec::new();
    for item in items {
        let name = match item.get("name").and_then(|v| v.as_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let role = item
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("textbox")
            .to_string();
        let behavior = item
            .get("behavior")
            .and_then(|v| v.as_str())
            .unwrap_or("free_text")
            .to_string();
        fields.push(FormFieldInfo {
            name,
            role,
            behavior,
        });
    }
    fields
}

/// Serialize site memory to YAML frontmatter + markdown.
fn serialize_site_memory(memory: &SiteMemory) -> String {
    let mut out = String::with_capacity(512);
    out.push_str("---\n");
    out.push_str(&format!("domain: \"{}\"\n", memory.domain));
    if let Some(fp) = &memory.fingerprint {
        out.push_str(&format!("fingerprint: \"{fp}\"\n"));
    }
    if let Some(lv) = &memory.last_verified {
        out.push_str(&format!("last_verified: \"{lv}\"\n"));
    }
    if !memory.form_fields.is_empty() {
        out.push_str("form_fields:\n");
        for f in &memory.form_fields {
            out.push_str(&format!(
                "  - name: \"{}\"\n    role: \"{}\"\n    behavior: \"{}\"\n",
                f.name, f.role, f.behavior
            ));
        }
    }
    out.push_str("---\n\n");

    if !memory.navigation_notes.is_empty() {
        out.push_str("## Navigation\n");
        out.push_str(&memory.navigation_notes);
        if !memory.navigation_notes.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }

    if !memory.user_preferences.is_empty() {
        out.push_str("## User Preferences\n");
        out.push_str(&memory.user_preferences);
        if !memory.user_preferences.ends_with('\n') {
            out.push('\n');
        }
    }

    out
}

/// Extract content of a `## SectionName` from markdown body.
fn extract_section(body: &str, section_name: &str) -> String {
    let header = format!("## {section_name}");
    let mut capturing = false;
    let mut lines = Vec::new();

    for line in body.lines() {
        if line.trim() == header {
            capturing = true;
            continue;
        }
        if capturing && line.starts_with("## ") {
            break; // Next section
        }
        if capturing {
            lines.push(line);
        }
    }

    // Trim leading/trailing blank lines
    let text = lines.join("\n");
    text.trim().to_string()
}

// ── Fingerprinting ──────────────────────────────────────────────

/// Interactive ARIA roles used for structural fingerprinting.
const INTERACTIVE_ROLES: &[&str] = &[
    "button",
    "checkbox",
    "combobox",
    "link",
    "listbox",
    "menuitem",
    "option",
    "radio",
    "searchbox",
    "select",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
];

/// Compute a structural fingerprint from a browser snapshot.
///
/// Extracts lines with interactive roles (button, textbox, combobox, etc.),
/// normalizes them (role + name only), sorts them, and returns a truncated
/// SHA-256 hex digest. Insensitive to content changes (prices, times) —
/// only structural changes (new/renamed fields) alter the fingerprint.
pub fn compute_structural_fingerprint(snapshot_text: &str) -> String {
    let mut elements = BTreeSet::new();

    for line in snapshot_text.lines() {
        let trimmed = line.trim().trim_start_matches("- ");
        // Match lines like: `button "Submit" [ref=e5]` or `textbox "Email"`
        for role in INTERACTIVE_ROLES {
            if trimmed.starts_with(role) {
                // Extract role + quoted name: `button "Submit"`
                let element_sig = extract_role_and_name(trimmed);
                elements.insert(element_sig);
                break;
            }
        }
    }

    // Sort (BTreeSet is already sorted) and hash
    let combined: String = elements.into_iter().collect::<Vec<_>>().join("\n");
    let hash = Sha256::digest(combined.as_bytes());
    // Truncate to 16 hex chars (64 bits) — sufficient for change detection
    hash[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Extract `"role \"name\""` from a snapshot line, stripping ref and other metadata.
fn extract_role_and_name(line: &str) -> String {
    // Find the role (first word)
    let role_end = line.find(' ').unwrap_or(line.len());
    let role = &line[..role_end];

    // Find quoted name if present
    if let Some(quote_start) = line.find('"') {
        if let Some(quote_end) = line[quote_start + 1..].find('"') {
            let name = &line[quote_start + 1..quote_start + 1 + quote_end];
            return format!("{role} \"{name}\"");
        }
    }

    role.to_string()
}

// ── Form field discovery ────────────────────────────────────────

/// Extract form fields from a browser snapshot (no LLM call needed).
///
/// Parses the snapshot text for interactive form elements and infers
/// their behavior from role and name patterns.
pub fn extract_form_fields(snapshot_text: &str) -> Vec<FormFieldInfo> {
    let form_roles = ["textbox", "combobox", "checkbox", "radio", "slider", "spinbutton", "searchbox"];
    let mut fields = Vec::new();

    for line in snapshot_text.lines() {
        let trimmed = line.trim().trim_start_matches("- ");
        for &role in &form_roles {
            if trimmed.starts_with(role) {
                let name = extract_quoted_name(trimmed).unwrap_or_default();
                if name.is_empty() {
                    continue; // Skip unnamed fields
                }
                let behavior = infer_behavior(role, &name);
                fields.push(FormFieldInfo {
                    name,
                    role: role.to_string(),
                    behavior,
                });
                break;
            }
        }
    }

    fields
}

/// Extract the quoted name from a snapshot line.
fn extract_quoted_name(line: &str) -> Option<String> {
    let start = line.find('"')?;
    let end = line[start + 1..].find('"')?;
    Some(line[start + 1..start + 1 + end].to_string())
}

/// Infer form field behavior from role and name.
fn infer_behavior(role: &str, name: &str) -> String {
    let lower = name.to_lowercase();

    match role {
        "combobox" => {
            if lower.contains("dat") || lower.contains("date") || lower.contains("when") {
                "datepicker".to_string()
            } else {
                "autocomplete".to_string()
            }
        }
        "checkbox" | "radio" | "switch" => "toggle".to_string(),
        "slider" | "spinbutton" => "numeric".to_string(),
        "searchbox" => "autocomplete".to_string(),
        _ => "free_text".to_string(), // textbox default
    }
}

// ── Fingerprint comparison ──────────────────────────────────────

/// Compare stored fingerprint with the current page's structure.
pub fn check_fingerprint(memory: &SiteMemory, current_snapshot: &str) -> FingerprintStatus {
    let current_fp = compute_structural_fingerprint(current_snapshot);

    match &memory.fingerprint {
        None => FingerprintStatus::NoFingerprint,
        Some(stored) if *stored == current_fp => FingerprintStatus::Match,
        Some(stored) => FingerprintStatus::Changed {
            old: stored.clone(),
            new: current_fp,
        },
    }
}

/// Invalidate stale sections after a fingerprint change.
///
/// Clears navigation notes and form fields but preserves user preferences.
pub fn invalidate_stale_sections(memory: &mut SiteMemory, new_fingerprint: &str) {
    tracing::info!(
        domain = %memory.domain,
        old_fp = ?memory.fingerprint,
        new_fp = %new_fingerprint,
        "Site structure changed — invalidating navigation notes and form fields"
    );
    memory.navigation_notes.clear();
    memory.form_fields.clear();
    memory.fingerprint = Some(new_fingerprint.to_string());
    memory.last_verified = Some(chrono::Utc::now().to_rfc3339());
}

/// Format site memory as context for injection into the agent prompt.
///
/// Returns a compact summary suitable for the system prompt or tool result.
pub fn format_memory_for_context(memory: &SiteMemory) -> String {
    let mut parts = Vec::new();

    if !memory.form_fields.is_empty() {
        let fields: Vec<String> = memory
            .form_fields
            .iter()
            .map(|f| format!("  - {} ({}): {}", f.name, f.role, f.behavior))
            .collect();
        parts.push(format!("Form fields:\n{}", fields.join("\n")));
    }

    if !memory.navigation_notes.is_empty() {
        parts.push(format!("Navigation notes:\n{}", memory.navigation_notes));
    }

    if !memory.user_preferences.is_empty() {
        parts.push(format!("User preferences:\n{}", memory.user_preferences));
    }

    if parts.is_empty() {
        return String::new();
    }

    format!(
        "Site knowledge for {}:\n{}",
        memory.domain,
        parts.join("\n\n")
    )
}

impl SiteMemory {
    /// Create an empty site memory for a new domain.
    pub fn new(domain: &str) -> Self {
        Self {
            domain: domain.to_string(),
            fingerprint: None,
            last_verified: None,
            form_fields: Vec::new(),
            navigation_notes: String::new(),
            user_preferences: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_stability() {
        let snapshot = r#"
- navigation
  - link "Home" [ref=e1]
  - link "Search" [ref=e2]
- main
  - textbox "Departure" [ref=e3]
  - combobox "Arrival" [ref=e4]
  - button "Search" [ref=e5]
  - text "Price: €45.00"
"#;
        let fp1 = compute_structural_fingerprint(snapshot);

        // Same structure, different content
        let snapshot2 = r#"
- navigation
  - link "Home" [ref=e1]
  - link "Search" [ref=e2]
- main
  - textbox "Departure" [ref=e3]
  - combobox "Arrival" [ref=e4]
  - button "Search" [ref=e5]
  - text "Price: €89.00"
"#;
        let fp2 = compute_structural_fingerprint(snapshot2);

        // Fingerprints should match (content changed, structure didn't)
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn fingerprint_detects_structural_change() {
        let snapshot1 = r#"
- textbox "Departure" [ref=e3]
- combobox "Arrival" [ref=e4]
- button "Search" [ref=e5]
"#;
        let snapshot2 = r#"
- textbox "Departure" [ref=e3]
- combobox "Arrival" [ref=e4]
- textbox "Promo Code" [ref=e6]
- button "Search" [ref=e5]
"#;
        let fp1 = compute_structural_fingerprint(snapshot1);
        let fp2 = compute_structural_fingerprint(snapshot2);

        assert_ne!(fp1, fp2, "New field should change fingerprint");
    }

    #[test]
    fn extract_form_fields_basic() {
        let snapshot = r#"
- textbox "Email" [ref=e1]
- combobox "Country" [ref=e2]
- combobox "Date of travel" [ref=e3]
- checkbox "Accept terms" [ref=e4]
- button "Submit" [ref=e5]
"#;
        let fields = extract_form_fields(snapshot);
        assert_eq!(fields.len(), 4); // button is not a form field
        assert_eq!(fields[0].name, "Email");
        assert_eq!(fields[0].behavior, "free_text");
        assert_eq!(fields[1].name, "Country");
        assert_eq!(fields[1].behavior, "autocomplete");
        assert_eq!(fields[2].name, "Date of travel");
        assert_eq!(fields[2].behavior, "datepicker");
        assert_eq!(fields[3].name, "Accept terms");
        assert_eq!(fields[3].behavior, "toggle");
    }

    #[test]
    fn check_fingerprint_match() {
        let snapshot = "- button \"OK\" [ref=e1]\n- textbox \"Name\" [ref=e2]";
        let fp = compute_structural_fingerprint(snapshot);
        let memory = SiteMemory {
            domain: "test.com".to_string(),
            fingerprint: Some(fp),
            last_verified: None,
            form_fields: Vec::new(),
            navigation_notes: String::new(),
            user_preferences: String::new(),
        };

        assert_eq!(check_fingerprint(&memory, snapshot), FingerprintStatus::Match);
    }

    #[test]
    fn check_fingerprint_no_stored() {
        let memory = SiteMemory::new("test.com");
        assert_eq!(
            check_fingerprint(&memory, "- button \"OK\""),
            FingerprintStatus::NoFingerprint
        );
    }

    #[test]
    fn invalidation_preserves_preferences() {
        let mut memory = SiteMemory {
            domain: "test.com".to_string(),
            fingerprint: Some("old".to_string()),
            last_verified: None,
            form_fields: vec![FormFieldInfo {
                name: "Email".to_string(),
                role: "textbox".to_string(),
                behavior: "free_text".to_string(),
            }],
            navigation_notes: "Click here to login".to_string(),
            user_preferences: "Prefers dark mode".to_string(),
        };

        invalidate_stale_sections(&mut memory, "new_fp");

        assert!(memory.navigation_notes.is_empty());
        assert!(memory.form_fields.is_empty());
        assert_eq!(memory.user_preferences, "Prefers dark mode");
        assert_eq!(memory.fingerprint, Some("new_fp".to_string()));
    }

    #[test]
    fn roundtrip_serialize_parse() {
        let memory = SiteMemory {
            domain: "example.com".to_string(),
            fingerprint: Some("abc123".to_string()),
            last_verified: Some("2026-03-28T14:00:00Z".to_string()),
            form_fields: vec![FormFieldInfo {
                name: "Search".to_string(),
                role: "textbox".to_string(),
                behavior: "free_text".to_string(),
            }],
            navigation_notes: "Use the search bar at the top".to_string(),
            user_preferences: "Language: Italian".to_string(),
        };

        let serialized = serialize_site_memory(&memory);
        let parsed = parse_site_memory(&serialized, "example.com").unwrap();

        assert_eq!(parsed.domain, "example.com");
        assert_eq!(parsed.fingerprint, Some("abc123".to_string()));
        assert_eq!(parsed.form_fields.len(), 1);
        assert_eq!(parsed.form_fields[0].name, "Search");
        assert_eq!(parsed.navigation_notes, "Use the search bar at the top");
        assert_eq!(parsed.user_preferences, "Language: Italian");
    }

    #[test]
    fn format_context_empty() {
        let memory = SiteMemory::new("test.com");
        assert!(format_memory_for_context(&memory).is_empty());
    }

    #[test]
    fn format_context_with_data() {
        let memory = SiteMemory {
            domain: "test.com".to_string(),
            fingerprint: None,
            last_verified: None,
            form_fields: vec![FormFieldInfo {
                name: "Email".to_string(),
                role: "textbox".to_string(),
                behavior: "free_text".to_string(),
            }],
            navigation_notes: "Click login button".to_string(),
            user_preferences: String::new(),
        };

        let ctx = format_memory_for_context(&memory);
        assert!(ctx.contains("Site knowledge for test.com"));
        assert!(ctx.contains("Email (textbox): free_text"));
        assert!(ctx.contains("Click login button"));
    }
}
