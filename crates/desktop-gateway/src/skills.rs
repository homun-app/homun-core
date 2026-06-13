//! Local skill scanner for the Anthropic "Agent Skills" format.
//!
//! A skill is a directory containing a `SKILL.md` file with a YAML frontmatter
//! block (`name`, `description`, optional `license` / `allowed-tools` / `version`)
//! followed by a Markdown body. This is the same shape Claude uses under
//! `~/.claude/skills`; here skills live under
//! `~/.homun/skills/<id>/`.
//!
//! This module is intentionally *management only*: it reads and describes skills
//! so the UI can list, preview and enable/disable them. Executing a skill is a
//! separate concern (sandboxed runtime + explicit consent) and is not done here.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Resolves the skills directory under a gateway data dir.
pub fn skills_root(data_dir: &Path) -> PathBuf {
    data_dir.join("skills")
}

/// One skill, as shown in the master list (no body / file tree).
#[derive(Debug, Clone, Serialize)]
pub struct SkillSummary {
    /// Directory name — stable identifier and URL slug.
    pub id: String,
    /// Display name from frontmatter, falling back to the id.
    pub name: String,
    /// Trigger description from frontmatter (what the model reads to decide use).
    pub description: String,
    /// Whether the skill is active (not in the disabled set).
    pub enabled: bool,
    /// Where the skill came from: "local" for now; "github:owner/repo" later.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
}

/// A node in a skill's file tree (directories carry `children`).
#[derive(Debug, Clone, Serialize)]
pub struct SkillFileNode {
    pub name: String,
    /// Path relative to the skill root (POSIX separators).
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<SkillFileNode>,
}

/// Full detail for one skill: summary + rendered-ready body + file tree.
#[derive(Debug, Clone, Serialize)]
pub struct SkillDetail {
    #[serde(flatten)]
    pub summary: SkillSummary,
    /// Markdown body of SKILL.md with the frontmatter stripped.
    pub body: String,
    pub files: Vec<SkillFileNode>,
}

// ---------------------------------------------------------------- frontmatter

/// Parsed `SKILL.md` frontmatter. We parse only the keys we care about rather
/// than pulling in a full YAML dependency — the Agent Skills frontmatter is a
/// flat block, so a known-key scanner is both sufficient and robust.
#[derive(Debug, Default, Clone)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub license: Option<String>,
    pub version: Option<String>,
    pub allowed_tools: Vec<String>,
}

/// Splits a `SKILL.md` into (frontmatter, markdown body). If there is no
/// `---`-delimited frontmatter, returns a default frontmatter and the whole
/// content as body.
pub fn split_frontmatter(content: &str) -> (Frontmatter, String) {
    // Strip a UTF-8 BOM if present, then normalise to lines.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines();

    // The frontmatter must be the very first line (allowing trailing spaces).
    match lines.next() {
        Some(first) if first.trim_end() == "---" => {}
        _ => return (Frontmatter::default(), content.to_string()),
    }

    let mut fm_lines: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in lines.by_ref() {
        if line.trim_end() == "---" {
            closed = true;
            break;
        }
        fm_lines.push(line);
    }
    if !closed {
        // Unterminated frontmatter — treat the whole file as body.
        return (Frontmatter::default(), content.to_string());
    }

    let body = lines.collect::<Vec<_>>().join("\n").trim_start().to_string();
    (parse_frontmatter(&fm_lines), body)
}

fn parse_frontmatter(fm_lines: &[&str]) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let mut idx = 0;
    while idx < fm_lines.len() {
        let line = fm_lines[idx];
        idx += 1;
        // Only treat unindented `key: ...` lines as top-level keys.
        if line.starts_with(char::is_whitespace) || line.trim().is_empty() {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = rest.trim();
        match key.as_str() {
            "name" => fm.name = non_empty(unquote(value)),
            "version" => fm.version = non_empty(unquote(value)),
            "license" => fm.license = non_empty(unquote(value)),
            "description" => {
                if is_block_scalar(value) {
                    let literal = value.starts_with('|');
                    let (text, consumed) = gather_block(&fm_lines[idx..], literal);
                    fm.description = non_empty(text);
                    idx += consumed;
                } else {
                    fm.description = non_empty(unquote(value).to_string());
                }
            }
            "allowed-tools" | "allowed_tools" | "tools" => {
                if value.is_empty() {
                    let (items, consumed) = gather_list(&fm_lines[idx..]);
                    fm.allowed_tools = items;
                    idx += consumed;
                } else if value.starts_with('[') {
                    fm.allowed_tools = parse_inline_list(value);
                } else {
                    fm.allowed_tools = value
                        .split(',')
                        .map(|s| unquote(s.trim()).to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                }
            }
            _ => {}
        }
    }
    fm
}

fn is_block_scalar(value: &str) -> bool {
    value.is_empty() || matches!(value, "|" | ">" | "|-" | ">-" | "|+" | ">+")
}

/// Collects an indented block scalar starting at `lines`. `literal` keeps line
/// breaks (`|`); otherwise lines are folded with spaces (`>`). Returns the
/// dedented text and how many lines were consumed.
fn gather_block(lines: &[&str], literal: bool) -> (String, usize) {
    let mut collected: Vec<String> = Vec::new();
    let mut consumed = 0;
    let mut base_indent: Option<usize> = None;
    for line in lines {
        let indent = line.len() - line.trim_start().len();
        if line.trim().is_empty() {
            collected.push(String::new());
            consumed += 1;
            continue;
        }
        let base = *base_indent.get_or_insert(indent);
        if indent < base {
            break;
        }
        collected.push(line[base.min(line.len())..].to_string());
        consumed += 1;
    }
    // Drop trailing blank lines.
    while collected.last().is_some_and(|l| l.is_empty()) {
        collected.pop();
    }
    let text = if literal {
        collected.join("\n")
    } else {
        collected
            .iter()
            .map(|l| l.trim())
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string()
    };
    (text, consumed)
}

/// Collects a YAML block list (`- item` lines) starting at `lines`.
fn gather_list(lines: &[&str]) -> (Vec<String>, usize) {
    let mut items = Vec::new();
    let mut consumed = 0;
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            consumed += 1;
            continue;
        }
        if !line.starts_with(char::is_whitespace) && line.contains(':') {
            break; // next top-level key
        }
        if let Some(item) = trimmed.strip_prefix('-') {
            let item = unquote(item.trim()).to_string();
            if !item.is_empty() {
                items.push(item);
            }
            consumed += 1;
        } else {
            break;
        }
    }
    (items, consumed)
}

fn parse_inline_list(value: &str) -> Vec<String> {
    value
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| unquote(s.trim()).to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn non_empty(value: impl AsRef<str>) -> Option<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

// ----------------------------------------------------------------- scanning

/// Scans the skills root and returns one summary per valid skill directory
/// (one that contains a `SKILL.md`). Missing root → empty list. Results are
/// sorted by display name (case-insensitive).
pub fn scan_skills(
    root: &Path,
    disabled: &BTreeSet<String>,
    origins: &BTreeMap<String, String>,
) -> Vec<SkillSummary> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut skills: Vec<SkillSummary> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|entry| {
            let dir = entry.path();
            let id = entry.file_name().to_string_lossy().to_string();
            if id.starts_with('.') {
                return None;
            }
            let manifest = dir.join("SKILL.md");
            let content = std::fs::read_to_string(&manifest).ok()?;
            let (fm, _) = split_frontmatter(&content);
            Some(summary_from(&id, fm, disabled, origins))
        })
        .collect();
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    skills
}

fn summary_from(
    id: &str,
    fm: Frontmatter,
    disabled: &BTreeSet<String>,
    origins: &BTreeMap<String, String>,
) -> SkillSummary {
    SkillSummary {
        name: fm.name.unwrap_or_else(|| id.to_string()),
        description: fm.description.unwrap_or_default(),
        enabled: !disabled.contains(id),
        source: origins.get(id).cloned().unwrap_or_else(|| "local".to_string()),
        version: fm.version,
        license: fm.license,
        allowed_tools: fm.allowed_tools,
        id: id.to_string(),
    }
}

/// Loads full detail for one skill by id. Returns `Ok(None)` if the skill
/// directory or its `SKILL.md` does not exist. The id is validated to a single
/// path segment to prevent directory traversal.
pub fn load_detail(
    root: &Path,
    id: &str,
    disabled: &BTreeSet<String>,
    origins: &BTreeMap<String, String>,
) -> std::io::Result<Option<SkillDetail>> {
    if !is_safe_id(id) {
        return Ok(None);
    }
    let dir = root.join(id);
    let manifest = dir.join("SKILL.md");
    if !manifest.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&manifest)?;
    let (fm, body) = split_frontmatter(&content);
    let summary = summary_from(id, fm, disabled, origins);
    let files = build_file_tree(&dir, &dir, 0, &mut 0);
    Ok(Some(SkillDetail { summary, body, files }))
}

/// Rejects ids that are not a single safe path segment (no separators, no `..`).
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
}

/// Builds a depth- and count-capped file tree for the skill directory.
fn build_file_tree(root: &Path, dir: &Path, depth: usize, count: &mut usize) -> Vec<SkillFileNode> {
    const MAX_DEPTH: usize = 4;
    const MAX_NODES: usize = 300;
    if depth > MAX_DEPTH || *count >= MAX_NODES {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut nodes: Vec<SkillFileNode> = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        if *count >= MAX_NODES {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        *count += 1;
        let children = if is_dir {
            build_file_tree(root, &path, depth + 1, count)
        } else {
            Vec::new()
        };
        nodes.push(SkillFileNode { name, path: rel, is_dir, children });
    }
    // Directories first, then files, each alphabetically.
    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    nodes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_frontmatter() {
        let md = "---\nname: skill-creator\ndescription: Create new skills and improve them.\nlicense: MIT\n---\n# Skill Creator\n\nBody here.";
        let (fm, body) = split_frontmatter(md);
        assert_eq!(fm.name.as_deref(), Some("skill-creator"));
        assert_eq!(
            fm.description.as_deref(),
            Some("Create new skills and improve them.")
        );
        assert_eq!(fm.license.as_deref(), Some("MIT"));
        assert!(body.starts_with("# Skill Creator"));
    }

    #[test]
    fn parses_block_scalar_description_and_tools_list() {
        let md = "---\nname: pdf\ndescription: |\n  Extract text from PDFs.\n  Handles scanned pages too.\nallowed-tools:\n  - Read\n  - Bash\n---\nbody";
        let (fm, _) = split_frontmatter(md);
        assert_eq!(
            fm.description.as_deref(),
            Some("Extract text from PDFs.\nHandles scanned pages too.")
        );
        assert_eq!(fm.allowed_tools, vec!["Read", "Bash"]);
    }

    #[test]
    fn folded_description_and_inline_tools() {
        let md = "---\nname: x\ndescription: >\n  one\n  two\nallowed-tools: [Read, Write, Bash]\n---\nb";
        let (fm, _) = split_frontmatter(md);
        assert_eq!(fm.description.as_deref(), Some("one two"));
        assert_eq!(fm.allowed_tools, vec!["Read", "Write", "Bash"]);
    }

    #[test]
    fn no_frontmatter_returns_whole_body() {
        let md = "# Just markdown\n\ntext";
        let (fm, body) = split_frontmatter(md);
        assert!(fm.name.is_none());
        assert_eq!(body, md);
    }

    #[test]
    fn comma_separated_tools_and_quotes() {
        let md = "---\nname: \"Quoted Name\"\ndescription: 'single quoted'\nallowed-tools: Read, Write\n---\n";
        let (fm, _) = split_frontmatter(md);
        assert_eq!(fm.name.as_deref(), Some("Quoted Name"));
        assert_eq!(fm.description.as_deref(), Some("single quoted"));
        assert_eq!(fm.allowed_tools, vec!["Read", "Write"]);
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(!is_safe_id("../etc"));
        assert!(!is_safe_id("a/b"));
        assert!(!is_safe_id(".."));
        assert!(is_safe_id("skill-creator"));
    }
}
