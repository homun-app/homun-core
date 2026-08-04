// Project and repository search tool schemas and handlers.
use crate::*;

/// Read-only query over the active project's CODE graph (imported by the project-map
/// builder). Answers "what calls X / what does X call / where does X live" by
/// traversing the calls/contains/method edges already in SQLite — no Graphify needed.
pub(crate) fn query_code_graph_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "query_code_graph",
            "description": "Query the code map of the active project: given a symbol (function, file, \
    class), list who calls it, what it calls and where it's located. Use it for questions about the \
    architecture/structure of the current project's code.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": { "type": "string", "description": "Name of the symbol to explore (e.g. \"cmd_add\", \"main.py\")" }
                },
                "required": ["symbol"]
            }
        }
    })
}

/// Read-only query over the active project's GIT HISTORY — the "why over time" leg of
/// memory. Commit messages = the why; `-S` (pickaxe) = when code containing a term
/// changed. Complements query_code_graph (current structure) and the decision wiki
/// (conversational why). No writes.
pub(crate) fn query_git_history_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "query_git_history",
            "description": "Query the git HISTORY of the active project: given a file, a symbol, or a \
    theme, returns the relevant commits (message = the WHY, with date) and when the related \
    code changed. Use it for 'why/when did X change', 'the history of Y', 'what \
    happened to this file'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "File, symbol or theme (e.g. \"trello_wrapper.py\", \"retry\", \"cache\")" }
                },
                "required": ["query"]
            }
        }
    })
}

pub(crate) fn github_search_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "github_search",
            "description": "Search REPOSITORIES on GitHub via API (fast and structured, NO browser). \
    Use it for \"search GitHub\", finding similar/competing projects, assessing the uniqueness of an idea, or \
    inspecting repos for stars/language/freshness. Returns the top repos sorted by stars. \
    ALWAYS PREFER it over the browser for GitHub queries.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search terms (name, problem/implementation keyword). Supports GitHub qualifiers, e.g. \"todo cli language:python stars:>50\"." }
                },
                "required": ["query"]
            }
        }
    })
}

/// Searches GitHub repositories via the public Search API (no auth needed for public repos;
/// fast + structured — the model should prefer this over driving the browser).
pub(crate) async fn github_search(state: &AppState, query: &str) -> String {
    let resp = state
        .http
        .get("https://api.github.com/search/repositories")
        .query(&[
            ("q", query),
            ("sort", "stars"),
            ("order", "desc"),
            ("per_page", "8"),
        ])
        .header("User-Agent", "Homun")
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await;
    let resp = match resp {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => return format!("GitHub search failed (HTTP {}).", r.status()),
        Err(_) => return "GitHub search failed (network).".to_string(),
    };
    let Ok(json) = resp.json::<serde_json::Value>().await else {
        return "Unreadable GitHub response.".to_string();
    };
    let items = json
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        return format!("No repository found on GitHub for «{query}».");
    }
    let mut out = format!("GitHub results for «{query}» (top by stars):");
    for it in items.iter().take(8) {
        let name = it.get("full_name").and_then(|v| v.as_str()).unwrap_or("?");
        let stars = it
            .get("stargazers_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let lang = it.get("language").and_then(|v| v.as_str()).unwrap_or("—");
        let desc = it.get("description").and_then(|v| v.as_str()).unwrap_or("");
        let url = it.get("html_url").and_then(|v| v.as_str()).unwrap_or("");
        let pushed = it.get("pushed_at").and_then(|v| v.as_str()).unwrap_or("");
        let desc_short: String = desc.chars().take(140).collect();
        out.push_str(&format!(
            "\n- {name} ⭐{stars} [{lang}] — {desc_short}\n  {url}  (aggiornato {})",
            pushed.get(0..10).unwrap_or(pushed)
        ));
    }
    out
}

pub(crate) fn query_git_history(query: &str) -> String {
    let q = query.trim();
    if q.is_empty() {
        return "Indicate a file, symbol or topic.".to_string();
    }
    let ws = gateway_memory_workspace_id();
    let folder = load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id == ws.as_str())
        .and_then(|w| w.folder)
        .filter(|f| !f.trim().is_empty());
    let Some(folder) = folder else {
        return "This scope is not a project with a folder.".to_string();
    };
    let root = std::path::Path::new(&folder);
    let is_git = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !is_git {
        return "This project isn't under git yet (no history to consult).".to_string();
    }
    let run = |args: &[&str]| -> String {
        std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let fmt = "--pretty=format:%h %ad %s";
    let date = "--date=short";
    // Commit MESSAGES mentioning the term (the explicit "why").
    let by_msg = run(&["log", fmt, date, "-n", "10", "-i", &format!("--grep={q}")]);
    // Commits that CHANGED code containing the term (pickaxe: when X appeared/changed).
    let by_code = run(&["log", fmt, date, "-n", "10", &format!("-S{q}")]);
    // If the query is (or matches) a path, its file history too.
    let by_path = if q.contains('.') || q.contains('/') {
        run(&["log", fmt, date, "-n", "10", "--", &format!("*{q}*")])
    } else {
        String::new()
    };
    if by_msg.is_empty() && by_code.is_empty() && by_path.is_empty() {
        return format!("No commit found for «{q}» (maybe it's code not yet committed).");
    }
    let mut out = format!("Git history for «{q}»:\n");
    if !by_msg.is_empty() {
        out.push_str(&format!("\n**Commits that mention it (why):**\n{by_msg}\n"));
    }
    if !by_path.is_empty() {
        out.push_str(&format!("\n**File history:**\n{by_path}\n"));
    }
    if !by_code.is_empty() {
        out.push_str(&format!(
            "\n**When the code with «{q}» changed:**\n{by_code}\n"
        ));
    }
    out
}

pub(crate) fn query_code_graph(state: &AppState, symbol: &str) -> String {
    let needle = symbol.trim().to_lowercase();
    if needle.is_empty() {
        return "Specify a symbol (function/file) to explore.".to_string();
    }
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let ws = gateway_memory_workspace_id();
    let entities = facade.list_entities_for_ui(&user, &ws).unwrap_or_default();
    // Only the code graph (entities imported from the project map).
    let code: Vec<_> = entities
        .iter()
        .filter(|e| e.entity_type.starts_with("code_"))
        .collect();
    if code.is_empty() {
        return "There's no code map for this project yet.".to_string();
    }
    let Some(target) = code
        .iter()
        .find(|e| e.name.to_lowercase() == needle)
        .or_else(|| {
            code.iter()
                .find(|e| e.name.to_lowercase().contains(&needle))
        })
    else {
        return format!("I can't find «{symbol}» in the project's code map.");
    };
    let tref = target.reference.to_string();
    let name_by_ref: std::collections::HashMap<String, String> = entities
        .iter()
        .map(|e| (e.reference.to_string(), e.name.clone()))
        .collect();
    let rels = facade.list_relations_for_ui(&user, &ws).unwrap_or_default();
    let mut calls: Vec<String> = Vec::new(); // target → X (outgoing)
    let mut callers: Vec<String> = Vec::new(); // X → target (incoming)
    let mut container: Option<String> = None;
    for r in &rels {
        let s = r.source_ref.to_string();
        let t = r.target_ref.to_string();
        if s == tref {
            if r.relation_type == "contains" {
                continue; // target contains children — list as calls below if relevant
            }
            if let Some(n) = name_by_ref.get(&t) {
                calls.push(n.clone());
            }
        } else if t == tref {
            if r.relation_type == "contains" {
                container = name_by_ref.get(&s).cloned();
            } else if let Some(n) = name_by_ref.get(&s) {
                callers.push(n.clone());
            }
        }
    }
    calls.sort();
    calls.dedup();
    calls.truncate(20);
    callers.sort();
    callers.dedup();
    callers.truncate(20);
    let mut out = format!("**{}**", target.name);
    if let Some(c) = container {
        out.push_str(&format!(" (in {c})"));
    }
    out.push('\n');
    if callers.is_empty() {
        out.push_str("- No known callers.\n");
    } else {
        out.push_str(&format!("- Called by: {}\n", callers.join(", ")));
    }
    if !calls.is_empty() {
        out.push_str(&format!("- Uses/calls: {}\n", calls.join(", ")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_project_search_tools_export_canonical_schema_names() {
        assert_eq!(
            query_code_graph_tool_schema()["function"]["name"],
            serde_json::json!("query_code_graph")
        );
        assert_eq!(
            query_git_history_tool_schema()["function"]["name"],
            serde_json::json!("query_git_history")
        );
        assert_eq!(
            github_search_tool_schema()["function"]["name"],
            serde_json::json!("github_search")
        );
    }

    #[test]
    fn gateway_project_search_tools_git_history_rejects_empty_query() {
        assert_eq!(
            query_git_history("   "),
            "Indicate a file, symbol or topic."
        );
    }
}
