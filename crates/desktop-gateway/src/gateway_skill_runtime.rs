//! Skill runtime helpers and tool schemas.
//!
//! Route state stays in `gateway_skill_routes`; execution dispatch stays in
//! `gateway_tool_execution`. This module owns the shared skill path, prompt
//! discovery helpers, progressive disclosure loading, and skill tool schemas.

use std::{collections::HashSet, fs, path::PathBuf};

use crate::{
    gateway_paths::gateway_data_dir,
    gateway_skill_routes::{load_skills_disabled, load_skills_origins, save_skills_origins},
    sandbox, skills,
};

/// Resolves the skills directory, creating it on demand so a fresh install has
/// a place for the user (or the future marketplace) to drop skill folders.
pub(crate) fn skills_dir() -> Result<PathBuf, std::io::Error> {
    let dir = skills::skills_root(&gateway_data_dir()?);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// `"Riepilogo Spese Q1"` -> `"riepilogo-spese-q1"`. Lowercase, alnum runs
/// joined by single hyphens, trimmed and capped for a stable skill directory id.
pub(crate) fn slugify_skill_name(name: &str) -> String {
    let mut out = String::new();
    let mut last_hyphen = true;
    for ch in name.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_hyphen = false;
        } else if !last_hyphen {
            out.push('-');
            last_hyphen = true;
        }
    }
    out.trim_matches('-')
        .chars()
        .take(48)
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// Creates a user-authored skill and marks its origin as authored.
pub(crate) fn create_skill(name: &str, description: &str, instructions: &str) -> String {
    let name = name.trim();
    let description = description.trim();
    let instructions = instructions.trim();
    if name.is_empty() || description.is_empty() || instructions.is_empty() {
        return "Creating a skill requires: name, description (WHEN to use it) and instructions (what to do).".to_string();
    }
    let Ok(data_dir) = gateway_data_dir() else {
        return "Data folder unavailable.".to_string();
    };
    let dir = skills::skills_root(&data_dir);
    let slug = slugify_skill_name(name);
    if slug.is_empty() {
        return "The name doesn't produce a valid id: use letters or numbers.".to_string();
    }
    let skill_dir = dir.join(&slug);
    if skill_dir.exists() {
        return format!("A skill with id '{slug}' already exists. Choose another name.");
    }
    if let Err(error) = fs::create_dir_all(&skill_dir) {
        return format!("Could not create the skill folder: {error}");
    }
    let desc_yaml =
        serde_json::to_string(description).unwrap_or_else(|_| format!("\"{description}\""));
    let content = format!(
        "---\nname: {name}\nslug: {slug}\nversion: 1.0.0\ndescription: {desc_yaml}\n---\n\n{instructions}\n"
    );
    if let Err(error) = fs::write(skill_dir.join("SKILL.md"), &content) {
        let _ = fs::remove_dir_all(&skill_dir);
        return format!("Could not write the skill: {error}");
    }
    let mut origins = load_skills_origins();
    origins.insert(slug.clone(), "authored".to_string());
    let _ = save_skills_origins(&origins);
    format!(
        "✅ Skill «{name}» created (id={slug}) and active. Try it: tell me \"use the skill {name}\" \
or ask me something that triggers it."
    )
}

/// Enabled installed skills as (id, name, description) for prompt discovery.
pub(crate) fn enabled_skills_summary() -> Vec<(String, String, String)> {
    let Ok(dir) = skills_dir() else {
        return Vec::new();
    };
    let disabled = load_skills_disabled();
    let origins = load_skills_origins();
    skills::scan_skills(&dir, &disabled, &origins)
        .into_iter()
        .filter(|skill| skill.enabled)
        .map(|skill| (skill.id, skill.name, skill.description))
        .collect()
}

/// The HomunCoder methodology skill ids from the boot-seeded sync manifest.
pub(crate) fn homuncoder_skill_ids() -> HashSet<String> {
    skills_dir()
        .ok()
        .map(|dir| dir.join("homuncoder-skills.txt"))
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|content| {
            content
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn skill_prompt_instructions_block(
    enabled_skills: &[(String, String, String)],
    homuncoder: &HashSet<String>,
    is_project: bool,
) -> Option<String> {
    if enabled_skills.is_empty() {
        return None;
    }
    let lines = enabled_skills
        .iter()
        .map(|(id, name, desc)| format!("- {id}: {name} — {desc}"))
        .collect::<Vec<_>>()
        .join("\n");
    let methodology = if is_project
        && enabled_skills
            .iter()
            .any(|(id, _, _)| homuncoder.contains(id))
    {
        "\nMETHODOLOGY (HomunCoder) — for DEVELOPMENT work follow the evidence-first habits: \
plan with update_plan, REMEMBER/record decisions with their why, and VERIFY by executing \
(build/test/lint) before saying \"done\". When you apply one of these disciplines, call \
`use_skill` FIRST with the right skill (roadmap-first-planning, systematic-debugging, test-first-development, \
verification-before-completion, code-review-discipline, …) — so the user SEES which methodology \
you're following — and then follow its instructions. Don't just cite it: actually load it with use_skill."
    } else {
        ""
    };
    Some(format!(
        "INSTALLED SKILLS — when the request matches the description of one \
of these, PREFER it over the browser: call `use_skill` with its id to receive the complete \
instructions (SKILL.md). Then RUN the commands the skill indicates (e.g. `curl …`, `python …`) with the \
`run_in_sandbox` tool, which launches them in the contained computer, and use the output to reply.\n\
GENERATED FILES: if a skill or a command produces files (xlsx, pdf, csv, images, …), SAVE them in the \
environment folder `$OUTPUT_DIR` (e.g. `... --output \"$OUTPUT_DIR/report.xlsx\"`): files there \
automatically become artifacts downloadable by the user.{methodology}\n{lines}"
    ))
}

/// Loads an installed skill's SKILL.md body.
#[allow(dead_code)]
pub(crate) fn load_skill_body(id: &str) -> Option<String> {
    load_skill_body_and_sensitive(id).map(|(body, _)| body)
}

/// Loads a skill's adapted body plus its declared sensitive categories.
pub(crate) fn load_skill_body_and_sensitive(
    id: &str,
) -> Option<(String, Vec<skills::SensitiveCategory>)> {
    let dir = skills_dir().ok()?;
    let disabled = load_skills_disabled();
    let origins = load_skills_origins();
    skills::load_detail(&dir, id, &disabled, &origins)
        .ok()
        .flatten()
        .map(|detail| (adapt_skill_body(&detail.body, id), detail.summary.sensitive))
}

/// Extracts a skill id from a sandbox command that references
/// `/home/agent/skills/<id>/...`.
pub(crate) fn skill_id_from_command(command: &str) -> Option<String> {
    let marker = "/home/agent/skills/";
    let start = command.find(marker)? + marker.len();
    let rest = &command[start..];
    let id: String = rest
        .chars()
        .take_while(|c| *c != '/' && *c != ' ' && *c != '"' && *c != '\'')
        .collect();
    if id.is_empty() { None } else { Some(id) }
}

/// Adapts a SKILL.md body for execution in the contained computer.
pub(crate) fn adapt_skill_body(body: &str, id: &str) -> String {
    let base = sandbox::container_skill_dir(id);
    body.replace("{baseDir}", &base)
        .replace("${baseDir}", &base)
        .replace("{base_dir}", &base)
        .replace("{BASE_DIR}", &base)
        .replace("$BASEDIR", &base)
}

/// The skill-activation tool: loads a skill's full SKILL.md instructions on demand.
pub(crate) fn use_skill_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "use_skill",
            "description": "Load the full instructions (SKILL.md) of an installed skill, given its id. Call it when the request matches a skill listed in INSTALLED SKILLS, then follow the received instructions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "id of the skill, e.g. 'weather'" }
                },
                "required": ["id"]
            }
        }
    })
}

/// The skill-execution tool: runs a shell command from skill instructions inside
/// the contained-computer sandbox.
pub(crate) fn run_in_sandbox_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "run_in_sandbox",
            "description": "Run a shell command in the contained computer (isolated sandbox: bash, curl, python, git, compilers). Use it to: run commands/scripts, process data (incl. fetching STRUCTURED data — RSS/JSON APIs — with curl), and ABOVE ALL to VERIFY BY EXECUTING — run build/test/lint or execute the code and read the REAL output instead of assuming code or calculations are correct. Returns stdout/stderr. Iterate on failures until the verification passes. For browsing or SEARCHING rendered websites prefer the `browse` tool over scraping HTML with curl, and NEVER use this tool to continue a task started in a browser (a search, a form, a booking, a checkout): the site's interactive session lives in the browser session, so only another `browse` call can carry it. (A skill/automation's own instructions win — follow what its SKILL.md / steps say.)",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to run, e.g. \"curl -s https://example.com/feed.rss\" or \"pytest -q\"" },
                    "skill_id": { "type": "string", "description": "id of the context skill (optional; sets the working dir)" }
                },
                "required": ["command"]
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_skill_name_normalizes_stable_directory_ids() {
        assert_eq!(
            slugify_skill_name("  Riepilogo Spese Q1!! "),
            "riepilogo-spese-q1"
        );
        assert_eq!(slugify_skill_name("___"), "");
        assert_eq!(
            slugify_skill_name("abcdefghijklmnopqrstuvwxyz0123456789-extra-long-tail"),
            "abcdefghijklmnopqrstuvwxyz0123456789-extra-long"
        );
    }

    #[test]
    fn adapt_skill_body_substitutes_container_base_dir_aliases() {
        let body = "Run `python3 {baseDir}/scripts/x.py`, ${baseDir}/a, {base_dir}/b, {BASE_DIR}/c and $BASEDIR/d";
        let out = adapt_skill_body(body, "weather");

        assert!(out.contains("/home/agent/skills/weather/scripts/x.py"));
        assert!(out.contains("/home/agent/skills/weather/a"));
        assert!(out.contains("/home/agent/skills/weather/b"));
        assert!(out.contains("/home/agent/skills/weather/c"));
        assert!(out.contains("/home/agent/skills/weather/d"));
        assert!(!out.contains("{baseDir}"));
        assert!(!out.contains("${baseDir}"));
        assert!(!out.contains("{base_dir}"));
        assert!(!out.contains("{BASE_DIR}"));
        assert!(!out.contains("$BASEDIR"));
    }

    #[test]
    fn skill_id_from_command_extracts_id_from_contained_skill_path() {
        assert_eq!(
            skill_id_from_command(
                "python3 /home/agent/skills/polymarket-trade/scripts/p.py search btc"
            ),
            Some("polymarket-trade".to_string())
        );
        assert_eq!(
            skill_id_from_command("\"/home/agent/skills/research/SKILL.md\""),
            Some("research".to_string())
        );
        assert_eq!(skill_id_from_command("ls -la"), None);
        assert_eq!(skill_id_from_command("cat /home/agent/skills/"), None);
    }

    #[test]
    fn run_in_sandbox_schema_requires_command_not_skill_id() {
        let schema = run_in_sandbox_tool_schema();
        assert_eq!(
            schema.pointer("/function/name").and_then(|v| v.as_str()),
            Some("run_in_sandbox")
        );
        assert_eq!(
            schema
                .pointer("/function/parameters/required")
                .and_then(|v| v.as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str())
                        .collect::<Vec<_>>()
                }),
            Some(vec!["command"])
        );
        assert!(
            schema
                .pointer("/function/parameters/properties/skill_id")
                .is_some()
        );
    }

    #[test]
    fn use_skill_schema_requires_skill_id() {
        let schema = use_skill_tool_schema();
        assert_eq!(
            schema.pointer("/function/name").and_then(|v| v.as_str()),
            Some("use_skill")
        );
        assert_eq!(
            schema
                .pointer("/function/parameters/required")
                .and_then(|v| v.as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str())
                        .collect::<Vec<_>>()
                }),
            Some(vec!["id"])
        );
    }

    #[test]
    fn skill_prompt_instructions_block_renders_installed_skill_catalog() {
        let skills = vec![(
            "pdf".to_string(),
            "PDF".to_string(),
            "Read and create PDF files".to_string(),
        )];
        let block = skill_prompt_instructions_block(&skills, &HashSet::new(), true)
            .expect("installed skill block");

        assert!(block.contains("INSTALLED SKILLS"));
        assert!(block.contains("PREFER it over the browser"));
        assert!(block.contains("- pdf: PDF"));
        assert!(block.contains("Read and create PDF files"));
        assert!(!block.contains("METHODOLOGY (HomunCoder)"));
    }

    #[test]
    fn skill_prompt_instructions_block_adds_methodology_only_for_project_homuncoder() {
        let skills = vec![(
            "test-first-development".to_string(),
            "TDD".to_string(),
            "Write tests first".to_string(),
        )];
        let homuncoder = HashSet::from(["test-first-development".to_string()]);

        let project_block =
            skill_prompt_instructions_block(&skills, &homuncoder, true).expect("project block");
        assert!(project_block.contains("METHODOLOGY (HomunCoder)"));
        assert!(project_block.contains("call `use_skill` FIRST"));

        let personal_block =
            skill_prompt_instructions_block(&skills, &homuncoder, false).expect("personal block");
        assert!(!personal_block.contains("METHODOLOGY (HomunCoder)"));
    }

    #[test]
    fn skill_prompt_instructions_block_is_absent_without_enabled_skills() {
        assert!(skill_prompt_instructions_block(&[], &HashSet::new(), true).is_none());
    }
}
