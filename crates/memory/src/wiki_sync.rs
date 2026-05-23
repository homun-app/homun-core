use crate::{DataSensitivity, MemoryRef, PrivacyDomain, UserId, WorkspaceId, contains_secret};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiCorrectionSyncReport {
    pub created_candidates: usize,
    pub unchanged: usize,
    pub conflicted: usize,
    pub rejected: usize,
    pub candidate_refs: Vec<MemoryRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ParsedWikiCorrection {
    pub wiki_ref: MemoryRef,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub linked_refs: Vec<MemoryRef>,
    pub title: String,
    pub body: String,
}

pub(crate) fn parse_wiki_markdown(markdown: &str) -> Result<ParsedWikiCorrection, String> {
    let Some(rest) = markdown.strip_prefix("---\n") else {
        return Err("wiki markdown missing frontmatter".to_string());
    };
    let Some((frontmatter, content)) = rest.split_once("\n---\n") else {
        return Err("wiki markdown missing frontmatter terminator".to_string());
    };

    let mut wiki_ref = None;
    let mut user_id = None;
    let mut workspace_id = None;
    let mut privacy_domain = None;
    let mut sensitivity = None;
    let mut linked_refs = Vec::new();
    let mut in_linked_refs = false;

    for line in frontmatter.lines() {
        if let Some(value) = line.strip_prefix("memory_ref: ") {
            wiki_ref = Some(MemoryRef::from_str(value)?);
            in_linked_refs = false;
        } else if let Some(value) = line.strip_prefix("user_id: ") {
            user_id = Some(UserId::new(value));
            in_linked_refs = false;
        } else if let Some(value) = line.strip_prefix("workspace_id: ") {
            workspace_id = Some(WorkspaceId::new(value));
            in_linked_refs = false;
        } else if let Some(value) = line.strip_prefix("privacy_domain: ") {
            privacy_domain = Some(PrivacyDomain::new(value));
            in_linked_refs = false;
        } else if let Some(value) = line.strip_prefix("sensitivity: ") {
            sensitivity = Some(
                serde_json::from_value(serde_json::Value::String(value.to_string()))
                    .map_err(|error| error.to_string())?,
            );
            in_linked_refs = false;
        } else if line == "linked_refs:" {
            in_linked_refs = true;
        } else if in_linked_refs {
            if let Some(value) = line.trim().strip_prefix("- ") {
                linked_refs.push(MemoryRef::from_str(value)?);
            }
        }
    }

    let content = content.trim_start();
    let (title, body) = if let Some(title_line) = content.strip_prefix("# ") {
        let (title, body) = title_line.split_once('\n').unwrap_or((title_line, ""));
        (title.trim().to_string(), body.trim().to_string())
    } else {
        ("Untitled".to_string(), content.trim().to_string())
    };

    if contains_secret(&serde_json::Value::String(body.clone()))
        || contains_secret(&serde_json::Value::String(title.clone()))
    {
        return Err("wiki correction contains raw secret content".to_string());
    }

    Ok(ParsedWikiCorrection {
        wiki_ref: wiki_ref.ok_or_else(|| "wiki markdown missing memory_ref".to_string())?,
        user_id: user_id.ok_or_else(|| "wiki markdown missing user_id".to_string())?,
        workspace_id: workspace_id
            .ok_or_else(|| "wiki markdown missing workspace_id".to_string())?,
        privacy_domain: privacy_domain
            .ok_or_else(|| "wiki markdown missing privacy_domain".to_string())?,
        sensitivity: sensitivity.ok_or_else(|| "wiki markdown missing sensitivity".to_string())?,
        linked_refs,
        title,
        body,
    })
}
