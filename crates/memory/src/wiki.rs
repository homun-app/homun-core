use crate::{SQLiteMemoryStore, WikiPage, contains_secret};
use std::fs;
use std::path::{Path, PathBuf};

pub struct WikiFileStore {
    root: PathBuf,
}

impl WikiFileStore {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }

    pub fn write_page(&self, store: &SQLiteMemoryStore, page: &WikiPage) -> Result<(), String> {
        if contains_secret(&serde_json::Value::String(page.body.clone()))
            || contains_secret(&serde_json::Value::String(page.title.clone()))
        {
            return Err("wiki page contains raw secret content".to_string());
        }
        if page.path.starts_with('/') || page.path.split('/').any(|part| part == "..") {
            return Err("wiki page path must stay inside vault".to_string());
        }

        let path = self.root.join(&page.path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&path, markdown_for_page(page)).map_err(|error| error.to_string())?;
        store.record_wiki_page(page)
    }
}

fn markdown_for_page(page: &WikiPage) -> String {
    let linked_refs = page
        .linked_refs
        .iter()
        .map(|reference| format!("  - {}", reference))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "---\nmemory_ref: {}\nuser_id: {}\nworkspace_id: {}\ntype: wiki_page\nprivacy_domain: {}\nsensitivity: {}\nlinked_refs:\n{}\n---\n\n# {}\n\n{}\n",
        page.reference,
        page.user_id.as_str(),
        page.workspace_id.as_str(),
        page.privacy_domain.as_str(),
        serde_json::to_value(page.sensitivity)
            .ok()
            .and_then(|value| value.as_str().map(ToString::to_string))
            .unwrap_or_else(|| "private".to_string()),
        linked_refs,
        page.title,
        page.body
    )
}
