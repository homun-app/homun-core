//! Capability discovery registry owner.
//!
//! Owns model-visible capability schemas, typed registry entries, lexical ranking,
//! connector toolkit search, and best-effort connected-tool pre-retrieval. Keep
//! these contracts here so `main.rs` only materializes the per-turn corpus.

use crate::gateway_identity::gateway_user_id;
use crate::gateway_memory_dedup::cosine;

/// The discovery meta-tool: the model searches connected-service tools by intent
/// instead of receiving all of them up front (progressive tool disclosure).
pub(crate) fn find_capability_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "find_capability",
            "description": "Discover and ACTIVATE the tools NOT present in your base set. Describe what you want to DO (e.g. \"navigate or read a web page\", \"search repositories on GitHub\", \"list/read the user's files and folders\", \"run commands in a sandbox\", \"create a document/artifact\", \"schedule a recurring task\"). Returns the suitable tools, ALREADY CALLABLE from the next turn. Call it BEFORE giving up or falling back to the browser: the browser itself activates from here and is the last resort.",
            "parameters": {
                "type": "object",
                "properties": {
                    "intent": {
                        "type": "string",
                        "description": "What you want to do, in plain words (e.g. \"search on GitHub\", \"read a user's PDF\", \"navigate a site\")."
                    }
                },
                "required": ["intent"]
            }
        }
    })
}

/// Meta-tool: unified capability discovery. Lets the model find what to CONNECT
/// for a user need, searching across all three connector ecosystems at once.
pub(crate) fn suggest_capabilities_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "suggest_capabilities",
            "description": "When the user wants to do something you might NOT already be able to do \
    (browser automation, access to a service/app, data, etc.), search the available connectors - \
    MCP servers (official registry), Skills (marketplace) and Composio (1000+ cloud services) - and propose \
    what to CONNECT. Use a short query on the intent (e.g. 'browser automation', 'google calendar', \
    'excel', 'github'). Returns suggestions to present to the user along with how to connect them.",
            "parameters": {
                "type": "object",
                "properties": {
                    "need": {
                        "type": "string",
                        "description": "What the user wants to do, in a few words/keywords (e.g. \
    'automate the browser', 'send email', 'read excel files')."
                    }
                },
                "required": ["need"]
            }
        }
    })
}

/// One searchable capability in the UNIFIED registry: a deferred native tool, an installed
/// skill, or a connected connector tool. `schema` is Some for tools/connectors (pushed into
/// the live tool set on match); None for skills (the model loads them with `use_skill`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CapabilitySource {
    NativeTool,
    NativeWorkflow,
    NativeAtomic,
    TemplateCatalog,
    Skill,
    McpTool,
    ConnectorTool,
}

#[derive(Clone)]
pub(crate) struct CapabilityEntry {
    pub(crate) key: String,
    pub(crate) desc: String,
    pub(crate) text: String,
    pub(crate) schema: Option<serde_json::Value>,
    pub(crate) is_skill: bool,
    pub(crate) source: CapabilitySource,
}

pub(crate) fn capability_entry_from_tool_schema(
    schema: serde_json::Value,
    source: CapabilitySource,
) -> Option<CapabilityEntry> {
    let name = schema
        .pointer("/function/name")
        .and_then(|v| v.as_str())
        .filter(|name| !name.is_empty())?
        .to_string();
    let desc = schema
        .pointer("/function/description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let source_text = match source {
        CapabilitySource::NativeTool => "native tool",
        CapabilitySource::NativeWorkflow => "native workflow",
        CapabilitySource::NativeAtomic => "native atomic tool",
        CapabilitySource::TemplateCatalog => "template catalog",
        CapabilitySource::Skill => "skill",
        CapabilitySource::McpTool => "mcp connected tool",
        CapabilitySource::ConnectorTool => "connector tool",
    };
    Some(CapabilityEntry {
        key: name.clone(),
        desc: desc.chars().take(140).collect(),
        text: format!("{source_text} {name} {desc}"),
        schema: Some(schema),
        is_skill: false,
        source,
    })
}

pub(crate) fn mcp_capability_entries(schemas: &[serde_json::Value]) -> Vec<CapabilityEntry> {
    schemas
        .iter()
        .cloned()
        .filter_map(|schema| capability_entry_from_tool_schema(schema, CapabilitySource::McpTool))
        .collect()
}

pub(crate) fn connector_capability_entry(
    slug: String,
    schema: serde_json::Value,
) -> Option<CapabilityEntry> {
    let mut entry = capability_entry_from_tool_schema(schema, CapabilitySource::ConnectorTool)?;
    // Composio's slug is the dispatch key. Keep it authoritative even if a malformed
    // schema carries a different function name.
    entry.key = slug;
    Some(entry)
}

/// Tokenizer for capability search and keyword-overlap prefilters. Delegates to the SHARED
/// tokenizer (F1.a) so the chat loop and the orchestrator planner split text identically.
pub(crate) fn cap_tokenize(s: &str) -> Vec<String> {
    local_first_capabilities::search::tokenize(s)
}

/// Best-effort pre-retrieval of connected-service (Composio) tools for the user's
/// message, run once at turn start so the model already has the relevant tools
/// without a find_capability hop.
pub(crate) async fn auto_retrieve_composio(
    http: &reqwest::Client,
    query: &str,
    catalog: &[(String, String, serde_json::Value)],
    k: usize,
) -> Vec<serde_json::Value> {
    const RRF_K: f32 = 60.0;
    if catalog.is_empty() || k == 0 {
        return Vec::new();
    }
    let q_tokens: std::collections::BTreeSet<String> = cap_tokenize(query).into_iter().collect();
    if q_tokens.is_empty() {
        return Vec::new();
    }
    let mut keyword: Vec<(usize, usize)> = catalog
        .iter()
        .enumerate()
        .map(|(i, (_, haystack, _))| {
            (
                i,
                q_tokens
                    .iter()
                    .filter(|t| haystack.contains(t.as_str()))
                    .count(),
            )
        })
        .filter(|(_, score)| *score > 0)
        .collect();
    keyword.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    keyword.truncate(24);
    if keyword.is_empty() {
        return Vec::new();
    }
    let keyword_rank: std::collections::HashMap<usize, usize> = keyword
        .iter()
        .enumerate()
        .map(|(rank, (i, _))| (*i, rank))
        .collect();
    let dense_rank: std::collections::HashMap<usize, usize> =
        if std::env::var("HOMUN_COMPOSIO_DENSE").is_ok() {
            let dense_usage = || {
                let mut usage = local_first_inference_usage::UsageContext::new(
                    uuid::Uuid::new_v4().to_string(),
                    local_first_inference_usage::InferencePurpose::Embedding,
                    gateway_user_id().as_str(),
                );
                usage.purpose_detail = Some("dense_tool_ranking".to_string());
                usage
            };
            match crate::embed_text(http, query, &dense_usage()).await {
                Some(q_vec) => {
                    let mut scored: Vec<(usize, f32)> = Vec::new();
                    for (i, _) in keyword.iter().take(8) {
                        if let Some(v) =
                            crate::embed_text(http, &catalog[*i].1, &dense_usage()).await
                        {
                            scored.push((*i, cosine(&q_vec, &v)));
                        }
                    }
                    scored
                        .sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                    scored
                        .iter()
                        .enumerate()
                        .map(|(rank, (i, _))| (*i, rank))
                        .collect()
                }
                None => std::collections::HashMap::new(),
            }
        } else {
            std::collections::HashMap::new()
        };
    let mut fused: Vec<(usize, f32)> = keyword
        .iter()
        .map(|(i, _)| {
            let kr = keyword_rank
                .get(i)
                .map(|r| 1.0 / (RRF_K + *r as f32))
                .unwrap_or(0.0);
            let dr = dense_rank
                .get(i)
                .map(|r| 1.0 / (RRF_K + *r as f32))
                .unwrap_or(0.0);
            (*i, kr + dr)
        })
        .collect();
    fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    fused
        .into_iter()
        .take(k)
        .map(|(i, _)| catalog[i].2.clone())
        .collect()
}

/// BM25 ranking over the unified capability corpus. Thin wrapper over the SHARED ranker
/// (`local_first_capabilities::search`) so chat discovery and planner discovery cannot drift.
pub(crate) fn bm25_rank<'a>(
    corpus: &'a [CapabilityEntry],
    query: &str,
    limit: usize,
) -> Vec<&'a CapabilityEntry> {
    let docs: Vec<Vec<String>> = corpus
        .iter()
        .map(|entry| local_first_capabilities::search::tokenize(&entry.text))
        .collect();
    local_first_capabilities::search::bm25_rank_indices(&docs, query, limit)
        .into_iter()
        .map(|index| &corpus[index])
        .collect()
}

/// Keyword search over the connected-tool catalog. Scores each tool by how many
/// query tokens appear in its "slug + description" haystack; returns the top `k`
/// as (slug, schema). An empty query returns the first `k` (a sensible browse).
pub(crate) fn search_composio_catalog(
    index: &[(String, String, serde_json::Value)],
    query: &str,
    k: usize,
) -> Vec<(String, serde_json::Value)> {
    let tokens: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3)
        .map(str::to_string)
        .collect();
    let mut scored: Vec<(usize, &(String, String, serde_json::Value))> = index
        .iter()
        .map(|entry| {
            let score = if tokens.is_empty() {
                1
            } else {
                tokens
                    .iter()
                    .filter(|t| entry.1.contains(t.as_str()))
                    .count()
            };
            (score, entry)
        })
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));

    const TOOLKIT_FULL_CAP: usize = 24;
    let mut out: Vec<(String, serde_json::Value)> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let toolkit_of = |slug: &str| slug.split('_').next().unwrap_or("").to_string();
    if let Some((_, top)) = scored.first() {
        let prefix = toolkit_of(&top.0);
        if !prefix.is_empty() {
            for entry in index.iter() {
                if out.len() >= TOOLKIT_FULL_CAP {
                    break;
                }
                if toolkit_of(&entry.0) == prefix && seen.insert(entry.0.clone()) {
                    out.push((entry.0.clone(), entry.2.clone()));
                }
            }
        }
    }
    let total_cap = k.max(TOOLKIT_FULL_CAP);
    for (_, entry) in scored {
        if out.len() >= total_cap {
            break;
        }
        if seen.insert(entry.0.clone()) {
            out.push((entry.0.clone(), entry.2.clone()));
        }
    }
    out
}

pub(crate) fn search_connector_capability_entries(
    index: &[(String, String, serde_json::Value)],
    query: &str,
    k: usize,
) -> Vec<CapabilityEntry> {
    search_composio_catalog(index, query, k)
        .into_iter()
        .filter_map(|(slug, schema)| connector_capability_entry(slug, schema))
        .collect()
}

pub(crate) fn capability_source_label(source: CapabilitySource) -> &'static str {
    match source {
        CapabilitySource::McpTool => "mcp",
        CapabilitySource::NativeWorkflow => "workflow",
        CapabilitySource::NativeAtomic => "atomic",
        CapabilitySource::TemplateCatalog => "template",
        CapabilitySource::NativeTool => "tool",
        CapabilitySource::Skill => "skill",
        CapabilitySource::ConnectorTool => "connector",
    }
}

pub(crate) fn capability_discovery_trace_line(
    intent: &str,
    entries: &[CapabilityEntry],
) -> Option<String> {
    if entries.is_empty() {
        return None;
    }
    let names = entries
        .iter()
        .take(6)
        .map(|entry| format!("{}:{}", capability_source_label(entry.source), entry.key))
        .collect::<Vec<_>>()
        .join(", ");
    let intent = intent.trim();
    let intent = if intent.is_empty() {
        "(intent)"
    } else {
        intent
    };
    Some(format!("capability discovery `{intent}` -> {names}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(name: &str, description: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": { "type": "object", "properties": {} }
            }
        })
    }

    fn catalog_entry(slug: &str, desc: &str) -> (String, String, serde_json::Value) {
        (
            slug.to_string(),
            format!("{slug} {desc}").to_lowercase(),
            schema(slug, desc),
        )
    }

    #[test]
    fn owner_exposes_discovery_tool_schemas() {
        assert_eq!(
            find_capability_tool_schema()
                .pointer("/function/name")
                .and_then(|value| value.as_str()),
            Some("find_capability")
        );
        assert_eq!(
            suggest_capabilities_tool_schema()
                .pointer("/function/name")
                .and_then(|value| value.as_str()),
            Some("suggest_capabilities")
        );
    }

    #[test]
    fn owner_projects_mcp_and_connector_entries_with_typed_sources() {
        let mcp = mcp_capability_entries(&[schema(
            "mcp__filesystem__read_file",
            "Read a file from filesystem",
        )]);
        assert_eq!(mcp[0].key, "mcp__filesystem__read_file");
        assert_eq!(mcp[0].source, CapabilitySource::McpTool);

        let connector =
            connector_capability_entry("GMAIL_SEND_EMAIL".to_string(), schema("BROKEN", "Send"))
                .expect("connector entry");
        assert_eq!(connector.key, "GMAIL_SEND_EMAIL");
        assert_eq!(connector.source, CapabilitySource::ConnectorTool);
    }

    #[test]
    fn owner_ranks_and_traces_capability_discovery() {
        let corpus = vec![
            CapabilityEntry {
                key: "gmail_send".to_string(),
                desc: "send an email message via gmail".to_string(),
                text: "send an email message via gmail".to_string(),
                schema: None,
                is_skill: false,
                source: CapabilitySource::NativeTool,
            },
            CapabilityEntry {
                key: "calendar_list".to_string(),
                desc: "list upcoming calendar events".to_string(),
                text: "list upcoming calendar events".to_string(),
                schema: None,
                is_skill: false,
                source: CapabilitySource::McpTool,
            },
        ];
        let ranked = bm25_rank(&corpus, "calendar event", 2);
        assert_eq!(ranked[0].key, "calendar_list");
        let trace = capability_discovery_trace_line("calendar event", &[ranked[0].clone()])
            .expect("trace line");
        assert!(trace.contains("mcp:calendar_list"), "{trace}");
    }

    #[test]
    fn owner_returns_full_connector_toolkit_for_best_match() {
        let index = vec![
            catalog_entry(
                "GMAIL_FETCH_EMAILS",
                "Fetch a list of email messages from Gmail",
            ),
            catalog_entry("GMAIL_SEND_EMAIL", "Send an email message via Gmail"),
            catalog_entry(
                "GOOGLECALENDAR_EVENTS_LIST",
                "List calendar events in a time range",
            ),
        ];
        let hits = search_connector_capability_entries(&index, "send gmail email", 8);
        let keys: Vec<&str> = hits.iter().map(|entry| entry.key.as_str()).collect();

        assert!(keys.contains(&"GMAIL_FETCH_EMAILS"));
        assert!(keys.contains(&"GMAIL_SEND_EMAIL"));
        assert!(!keys.contains(&"GOOGLECALENDAR_EVENTS_LIST"));
    }
}
