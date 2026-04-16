/// Remember tool — save personal information to USER.md.
///
/// Uses a flexible "Semantic Markdown" format that is:
/// - Language-agnostic (works in any language)
/// - LLM-friendly (easy to parse and understand)
/// - Human-readable (clean markdown structure)
///
/// Format:
/// ```markdown
/// # User Profile
/// > Last updated: YYYY-MM-DD HH:MM
///
/// ## SectionName
/// <!-- Optional semantic comment for LLM context -->
/// - key: value
/// - another_key: value
/// ```
///
/// Sections can be created dynamically by the LLM.
/// Default sections: Identity, Family, Preferences, Contacts, Context
use std::path::PathBuf;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;

use super::registry::{get_string_param, Tool, ToolContext, ToolResult};
use crate::config::Config;

/// Default sections with their semantic comments
const DEFAULT_SECTIONS: &[(&str, &str)] = &[
    (
        "Identity",
        "Basic facts: name, birth, residence, profession, health",
    ),
    ("Family", "Family relationships and loved ones"),
    ("Preferences", "Tastes, hobbies, interests, style"),
    ("Contacts", "Contact information: email, phone, addresses"),
    ("Context", "Life context, frequent places, current projects"),
];

/// Remember tool for saving personal information.
pub struct RememberTool {
    data_dir: PathBuf,
}

impl RememberTool {
    pub fn new() -> Self {
        Self {
            data_dir: Config::data_dir(),
        }
    }
}

#[async_trait]
impl Tool for RememberTool {
    fn name(&self) -> &str {
        "remember"
    }

    fn description(&self) -> &str {
        "Save personal information to the user profile or site-specific memory. \
         Use this when the user wants you to remember something about them \
         (preferences, contacts, personal details). The 'category' parameter \
         determines which section the info goes into. \
         When 'site' is provided, saves to site-specific memory instead of USER.md. \
         Use site memory for navigation tips and per-site preferences. \
         Examples: 'remember my dog is named Max', 'save that I like pizza', \
         'ricorda che la mia compagna la chiamo Felix'."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": "A short identifier for this information (e.g., 'dog_name', 'favorite_food', 'partner_nickname', 'email'). Use underscores for multi-word keys."
                },
                "value": {
                    "type": "string",
                    "description": "The information to remember. For secrets/passwords, use 'vault://key_name' format."
                },
                "category": {
                    "type": "string",
                    "description": "Section to store this in. Use existing sections (Identity, Family, Preferences, Contacts, Context) or create a new one. For site memory, use 'Navigation' or 'User Preferences'. Default: Identity",
                    "default": "Identity"
                },
                "site": {
                    "type": "string",
                    "description": "If provided, save to site-specific memory instead of USER.md. Use the bare domain (e.g., 'trenitalia.com'). Site memory stores navigation tips, form field info, and per-site user preferences."
                }
            },
            "required": ["key", "value"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let key = get_string_param(&args, "key")?;
        let value = get_string_param(&args, "value")?;
        let category =
            get_string_param(&args, "category").unwrap_or_else(|_| "Identity".to_string());
        let site = get_string_param(&args, "site").ok();

        // Validate key
        if key.is_empty() || key.len() > 64 {
            return Ok(ToolResult::error("Key must be 1-64 characters"));
        }

        // Normalize key: replace spaces with underscores, lowercase
        let normalized_key = key.replace(' ', "_").to_lowercase();

        // Use profile-scoped brain dir if available, else global
        let brain_dir = ctx
            .profile_brain_dir
            .clone()
            .unwrap_or_else(|| self.data_dir.join("brain"));

        // Site-specific memory: write to sites/{domain}.md instead of USER.md.
        // Uses the profile-scoped brain dir so each profile has its own site memory.
        if let Some(ref domain) = site {
            let global_brain = self.data_dir.join("brain");
            let profile_dir = ctx.profile_brain_dir.as_deref();
            return self
                .remember_for_site(
                    &global_brain,
                    profile_dir,
                    domain,
                    &category,
                    &normalized_key,
                    &value,
                )
                .await;
        }

        let user_file = brain_dir.join("USER.md");

        // Ensure brain directory exists
        tokio::fs::create_dir_all(&brain_dir).await.ok();

        // Read current content
        let current_content = if user_file.exists() {
            tokio::fs::read_to_string(&user_file)
                .await
                .unwrap_or_default()
        } else {
            String::new()
        };

        // Build the new content
        let new_content = update_user_content(&current_content, &category, &normalized_key, &value);

        // Write back
        tokio::fs::write(&user_file, &new_content).await?;

        tracing::info!(
            key = %normalized_key,
            value = %value,
            category = %category,
            "Remembered personal information"
        );

        Ok(ToolResult::success(format!(
            "✓ Remembered: {} = {} (in section '{}')",
            normalized_key, value, category
        )))
    }
}

impl RememberTool {
    /// Save information to site-specific memory (sites/{domain}.md).
    ///
    /// Uses the `SiteMemory` format: YAML frontmatter + markdown sections.
    /// Maps `category` to markdown sections (e.g., "Navigation", "User Preferences").
    /// Writes to the profile-scoped path if available, else global.
    async fn remember_for_site(
        &self,
        global_brain_dir: &std::path::Path,
        profile_brain_dir: Option<&std::path::Path>,
        domain: &str,
        category: &str,
        key: &str,
        value: &str,
    ) -> Result<ToolResult> {
        use crate::browser::site_memory;

        // Security: reject domains with path traversal components (#18).
        // A domain like "../../etc/cron.d/evil" would escape the sites/ directory
        // because PathBuf::join traverses with ".." components. No valid domain
        // contains "/" or "\\" or "..", so this has zero false positives.
        if domain.contains('/')
            || domain.contains('\\')
            || domain.contains("..")
            || domain.is_empty()
        {
            return Ok(ToolResult::error(format!(
                "Invalid site domain: '{domain}'. Must be a bare hostname (e.g., 'trenitalia.com')."
            )));
        }

        // Load existing site memory (checks profile first, then global)
        let mut memory = site_memory::load_site_memory(global_brain_dir, profile_brain_dir, domain)
            .await
            .unwrap_or_else(|| site_memory::SiteMemory::new(domain));

        // Map category to the appropriate section
        let line = format!("- {key}: {value}\n");
        let lower = category.to_lowercase();
        if lower.contains("nav") {
            if !memory.navigation_notes.is_empty() && !memory.navigation_notes.ends_with('\n') {
                memory.navigation_notes.push('\n');
            }
            memory.navigation_notes.push_str(&line);
        } else {
            // Default: user preferences
            if !memory.user_preferences.is_empty() && !memory.user_preferences.ends_with('\n') {
                memory.user_preferences.push('\n');
            }
            memory.user_preferences.push_str(&line);
        }

        // Save to profile-scoped path (or global if no profile)
        site_memory::save_site_memory(global_brain_dir, profile_brain_dir, domain, &memory).await?;

        tracing::info!(
            domain = %domain,
            key = %key,
            value = %value,
            category = %category,
            "Remembered site-specific information"
        );

        Ok(ToolResult::success(format!(
            "✓ Remembered for {domain}: {key} = {value} (in section '{category}')"
        )))
    }
}

/// Update the USER.md content with a new key-value pair.
/// Uses Semantic Markdown format with flexible sections.
fn update_user_content(content: &str, category: &str, key: &str, value: &str) -> String {
    let section_header = format!("## {}", category);

    if content.is_empty() {
        // Create new file with standard structure
        create_new_user_file(category, key, value)
    } else if content.contains(&section_header) {
        // Section exists - update or add key
        update_section(content, &section_header, key, value)
    } else {
        // Add new section at end (before any "Last updated" line if present)
        add_new_section(content, category, key, value)
    }
}

/// Create a new USER.md file with the standard structure.
fn create_new_user_file(category: &str, key: &str, value: &str) -> String {
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
    let mut result = String::new();

    result.push_str("# User Profile\n\n");

    // Add header with timestamp
    result.push_str(&format!("> Last updated: {}\n\n", timestamp));

    // Add all default sections, but put the first entry in the right section
    let mut found_target = false;
    for (section_name, section_comment) in DEFAULT_SECTIONS {
        if section_name == &category {
            // This is the target section - add the key-value
            result.push_str(&format!("## {}\n", section_name));
            result.push_str(&format!("<!-- {} -->\n", section_comment));
            result.push_str(&format!("- {}: {}\n\n", key, value));
            found_target = true;
        } else if found_target {
            // Already added target section, add this empty
            result.push_str(&format!("## {}\n", section_name));
            result.push_str(&format!("<!-- {} -->\n\n", section_comment));
        } else {
            // Before target section, add empty
            result.push_str(&format!("## {}\n", section_name));
            result.push_str(&format!("<!-- {} -->\n\n", section_comment));
        }
    }

    // If category is not a default section, add it
    if !DEFAULT_SECTIONS.iter().any(|(name, _)| name == &category) {
        result.push_str(&format!("## {}\n", category));
        result.push_str(&format!("- {}: {}\n\n", key, value));
    }

    result
}

/// Add a new section to an existing file.
fn add_new_section(content: &str, category: &str, key: &str, value: &str) -> String {
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M");

    // Find where to insert (before "Last updated" or at end)
    let lines: Vec<&str> = content.lines().collect();
    let mut result = String::new();
    let mut inserted = false;

    for line in &lines {
        // If we hit a "Last updated" line and haven't inserted yet, insert before it
        if line.starts_with("> Last updated:") && !inserted {
            result.push_str(&format!("## {}\n", category));
            result.push_str(&format!("- {}: {}\n\n", key, value));
            inserted = true;
        }
        result.push_str(line);
        result.push('\n');
    }

    // If no "Last updated" line found, append at end
    if !inserted {
        result = content.trim_end().to_string();
        result.push_str(&format!("\n\n## {}\n", category));
        result.push_str(&format!("- {}: {}\n", key, value));
    }

    // Update timestamp
    result = update_timestamp(&result, &timestamp.to_string());

    result
}

/// Update a specific section, adding or replacing the key.
fn update_section(content: &str, section_header: &str, key: &str, value: &str) -> String {
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
    let lines: Vec<&str> = content.lines().collect();
    let mut result = Vec::new();
    let mut in_target_section = false;
    let mut key_updated = false;
    let key_prefix = format!("- {}:", key); // Note: colon with optional space

    for (i, line) in lines.iter().enumerate() {
        // Check if we're entering a new section
        if line.starts_with("## ") {
            if *line == section_header {
                in_target_section = true;
            } else {
                // If we were in the target section and haven't updated the key,
                // insert it before leaving the section
                if in_target_section && !key_updated {
                    result.push(format!("- {}: {}", key, value));
                    key_updated = true;
                }
                in_target_section = false;
            }
        }

        // Skip empty lines and comments at the start of target section
        if in_target_section
            && !key_updated
            && (line.trim().is_empty() || line.trim().starts_with("<!--"))
        {
            result.push(line.to_string());
            continue;
        }

        // If in target section and this line has our key, update it
        if in_target_section && line.starts_with(&key_prefix) {
            result.push(format!("- {}: {}", key, value));
            key_updated = true;
        } else {
            result.push(line.to_string());
        }

        // If this is the last line and we're still in target section, add key if not updated
        if i == lines.len() - 1 && in_target_section && !key_updated {
            result.push(format!("- {}: {}", key, value));
        }
    }

    let mut final_result = result.join("\n");
    if !final_result.ends_with('\n') {
        final_result.push('\n');
    }

    // Update timestamp
    update_timestamp(&final_result, &timestamp.to_string())
}

/// Update the "Last updated" timestamp in the file.
fn update_timestamp(content: &str, timestamp: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut result = String::new();
    let mut found_timestamp = false;

    for line in &lines {
        if line.starts_with("> Last updated:") {
            result.push_str(&format!("> Last updated: {}\n", timestamp));
            found_timestamp = true;
        } else {
            result.push_str(line);
            result.push('\n');
        }
    }

    // If no timestamp found, add one after the title
    if !found_timestamp {
        let mut new_result = String::new();
        let mut added = false;
        for line in &lines {
            new_result.push_str(line);
            new_result.push('\n');
            if line.starts_with("# ") && !added {
                new_result.push_str(&format!("\n> Last updated: {}\n", timestamp));
                added = true;
            }
        }
        if !added {
            // No title found, add at beginning
            new_result = format!(
                "# User Profile\n\n> Last updated: {}\n\n{}",
                timestamp, result
            );
        }
        return new_result;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_new_file() {
        let result = create_new_user_file("Identity", "name", "Fabio");
        assert!(result.contains("# User Profile"));
        assert!(result.contains("## Identity"));
        assert!(result.contains("- name: Fabio"));
        assert!(result.contains("## Family")); // Default section
        assert!(result.contains("## Preferences")); // Default section
        assert!(result.contains("Last updated:"));
    }

    #[test]
    fn test_update_existing_section() {
        let content = "# User Profile\n\n## Identity\n\n- name: John\n";
        let result = update_section(content, "## Identity", "dog_name", "Max");
        assert!(result.contains("- name: John"));
        assert!(result.contains("- dog_name: Max"));
    }

    #[test]
    fn test_update_existing_key() {
        let content = "# User Profile\n\n## Identity\n\n- dog_name: OldValue\n";
        let result = update_section(content, "## Identity", "dog_name", "Max");
        assert!(result.contains("- dog_name: Max"));
        assert!(!result.contains("OldValue"));
    }

    #[test]
    fn test_add_new_section() {
        let content = "# User Profile\n\n## Identity\n\n- name: John\n";
        let result = add_new_section(content, "Work", "company", "ACME");
        assert!(result.contains("## Identity"));
        assert!(result.contains("## Work"));
        assert!(result.contains("- company: ACME"));
    }

    #[test]
    fn test_update_timestamp() {
        let content = "# User Profile\n\n> Last updated: 2020-01-01 00:00\n\n## Identity\n";
        let result = update_timestamp(content, "2026-02-23 15:30");
        assert!(result.contains("2026-02-23 15:30"));
        assert!(!result.contains("2020-01-01"));
    }

    #[test]
    fn test_update_section_with_comment() {
        let content = "# User Profile\n\n## Identity\n<!-- Basic facts -->\n- name: John\n";
        let result = update_section(content, "## Identity", "email", "john@example.com");
        assert!(result.contains("<!-- Basic facts -->"));
        assert!(result.contains("- name: John"));
        assert!(result.contains("- email: john@example.com"));
    }

    #[test]
    fn test_custom_category() {
        let result = create_new_user_file("Pets", "dog_name", "Max");
        assert!(result.contains("## Pets"));
        assert!(result.contains("- dog_name: Max"));
    }

    #[test]
    fn test_update_user_content_empty() {
        let result = update_user_content("", "Identity", "name", "Fabio");
        assert!(result.contains("# User Profile"));
        assert!(result.contains("- name: Fabio"));
    }

    #[test]
    fn test_update_user_content_existing_section() {
        let content = "# User Profile\n\n## Identity\n\n- name: John\n";
        let result = update_user_content(content, "Identity", "email", "john@test.com");
        assert!(result.contains("- name: John"));
        assert!(result.contains("- email: john@test.com"));
    }

    #[test]
    fn test_update_user_content_new_section() {
        let content = "# User Profile\n\n## Identity\n\n- name: John\n";
        let result = update_user_content(content, "Work", "company", "ACME");
        assert!(result.contains("## Identity"));
        assert!(result.contains("## Work"));
        assert!(result.contains("- company: ACME"));
    }

    // ── Path traversal regression tests (#18) ──────────────────────

    /// Verify that resolve_site_memory_path strips traversal from domain.
    #[test]
    fn test_site_memory_path_traversal_stripped() {
        use crate::browser::site_memory;
        let brain = std::path::PathBuf::from("/tmp/brain");

        // Normal domain → sites/trenitalia.com.md
        let normal = site_memory::resolve_site_memory_path(&brain, None, "trenitalia.com");
        assert!(
            normal.to_str().unwrap().ends_with("sites/trenitalia.com.md"),
            "normal domain: {normal:?}"
        );

        // Traversal domain → stripped to just the filename component
        let evil = site_memory::resolve_site_memory_path(&brain, None, "../../etc/passwd");
        assert!(
            !evil.to_str().unwrap().contains(".."),
            "traversal not stripped: {evil:?}"
        );
        assert!(
            evil.to_str().unwrap().contains("sites/"),
            "should stay in sites/: {evil:?}"
        );
    }

    /// Verify that leading-dot domains are rejected (prevent hidden files).
    #[test]
    fn test_site_memory_path_hidden_file_rejected() {
        use crate::browser::site_memory;
        let brain = std::path::PathBuf::from("/tmp/brain");

        let hidden = site_memory::resolve_site_memory_path(&brain, None, ".evil");
        assert!(
            hidden.to_str().unwrap().contains("_invalid_domain"),
            "leading dot should be rejected: {hidden:?}"
        );
    }

    /// Verify that empty domains are handled safely.
    #[test]
    fn test_site_memory_path_empty_domain() {
        use crate::browser::site_memory;
        let brain = std::path::PathBuf::from("/tmp/brain");

        let empty = site_memory::resolve_site_memory_path(&brain, None, "");
        assert!(
            empty.to_str().unwrap().contains("_invalid_domain"),
            "empty domain should be rejected: {empty:?}"
        );
    }
}
