use crate::ToolCard;
use local_first_capabilities::search::{bm25_rank_indices, tokenize};
use local_first_capabilities::{CapabilityTool, ProviderId};

/// In-memory corpus of policy-visible tools the planner ranks for progressive tool
/// disclosure (load the few most relevant tools, discover the rest on demand).
///
/// WHY in-memory (F1.a convergence): this corpus is rebuilt from the visible tools on EVERY
/// planning entry and is never persisted. The previous implementation
/// (`ToolSearchIndexStore`) was a SQLite FTS5 virtual table — but every construction site
/// opened it `in_memory` and `rebuild_from_tools`'d it each turn, so all of FTS5's reason
/// to exist (persistence, incremental updates, huge-corpus scale) was dead weight, and its
/// `term*` prefix-OR ranking diverged from the chat loop's Okapi BM25. Now it's a plain
/// `Vec` ranked by the SHARED ranker in `local_first_capabilities::search` — the exact same
/// ranker the chat loop's `find_capability` uses, so "what the planner finds" can no longer
/// drift from "what chat finds" (caposaldo #5: one engine, no parallel implementation).
#[derive(Default)]
pub struct ToolCorpus {
    tools: Vec<CapabilityTool>,
}

impl ToolCorpus {
    /// Replace the corpus with the current policy-visible tools (called once per planning
    /// entry, before any search).
    pub fn rebuild_from_tools(&mut self, tools: &[CapabilityTool]) {
        self.tools = tools.to_vec();
    }

    /// Rank the corpus for `query` and return up to `limit` compact [`ToolCard`]s, best
    /// first. When the query matches nothing, fall back to a sample of the corpus so the
    /// planner is never starved of tools by an off-vocabulary query — the same resilience
    /// the FTS5 store gave by returning its first rows on an empty match.
    pub fn search(&self, query: &str, limit: usize) -> Vec<ToolCard> {
        if limit == 0 || self.tools.is_empty() {
            return Vec::new();
        }
        let docs: Vec<Vec<String>> = self
            .tools
            .iter()
            .map(|tool| tokenize(&search_text_for_tool(tool)))
            .collect();
        let mut ranked = bm25_rank_indices(&docs, query, limit);
        if ranked.is_empty() {
            ranked = (0..self.tools.len().min(limit)).collect();
        }
        ranked
            .into_iter()
            .map(|index| ToolCard::from_tool(&self.tools[index]))
            .collect()
    }

    /// Fetch the full typed tool behind a card the planner selected.
    pub fn tool_detail(&self, provider_id: &ProviderId, tool_name: &str) -> Option<CapabilityTool> {
        self.tools
            .iter()
            .find(|tool| &tool.provider_id == provider_id && tool.name == tool_name)
            .cloned()
    }
}

/// The text a tool is indexed by: name + description + the policy-relevant facets, so a
/// query can hit on any of them. Kept identical to the retired FTS5 store's index text so
/// retrieval quality is unchanged apart from the (better) ranker.
fn search_text_for_tool(tool: &CapabilityTool) -> String {
    format!(
        "{} {} {:?} {:?} {} {}",
        tool.name,
        tool.description,
        tool.provider_kind,
        tool.action,
        tool.privacy_domains.join(" "),
        tool.sensitivity
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use local_first_capabilities::{ActionClass, CapabilityProviderKind};

    fn tool(name: &str, description: &str) -> CapabilityTool {
        CapabilityTool {
            name: name.to_string(),
            provider_id: ProviderId::new("native"),
            provider_kind: CapabilityProviderKind::Native,
            action: ActionClass::Read,
            description: description.to_string(),
            privacy_domains: vec!["local".to_string()],
            sensitivity: "private".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        }
    }

    #[test]
    fn ranks_relevant_tool_first_and_loads_detail_lazily() {
        let mut corpus = ToolCorpus::default();
        corpus.rebuild_from_tools(&[
            tool("calendar_create_event", "create a calendar event with attendees"),
            tool("email_send", "send an email message to a contact"),
            tool("browser_navigate", "open a URL in the browser and read the page"),
        ]);
        let cards = corpus.search("open a website and read it", 1);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].tool_name, "browser_navigate");
        let detail = corpus
            .tool_detail(&ProviderId::new("native"), "browser_navigate")
            .expect("detail present");
        assert_eq!(detail.name, "browser_navigate");
    }

    #[test]
    fn off_vocabulary_query_falls_back_to_a_sample() {
        let mut corpus = ToolCorpus::default();
        corpus.rebuild_from_tools(&[tool("a_tool", "alpha"), tool("b_tool", "beta")]);
        // No term matches, but the planner still gets a non-empty sample.
        let cards = corpus.search("zzzz qqqq", 5);
        assert_eq!(cards.len(), 2);
    }
}
