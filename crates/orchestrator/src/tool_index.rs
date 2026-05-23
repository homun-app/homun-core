use crate::{OrchestratorResult, ToolCard};
use local_first_capabilities::{CapabilityTool, ProviderId};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

pub struct ToolSearchIndexStore {
    connection: Connection,
}

impl ToolSearchIndexStore {
    pub fn open(path: impl AsRef<Path>) -> OrchestratorResult<Self> {
        let store = Self {
            connection: Connection::open(path)?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn open_in_memory() -> OrchestratorResult<Self> {
        let store = Self {
            connection: Connection::open_in_memory()?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn rebuild_from_tools(&self, tools: &[CapabilityTool]) -> OrchestratorResult<()> {
        self.connection.execute("DELETE FROM tool_search_fts", [])?;
        self.connection.execute("DELETE FROM tool_details", [])?;
        for tool in tools {
            self.upsert_tool(tool)?;
        }
        Ok(())
    }

    pub fn search(&self, query: &str, limit: usize) -> OrchestratorResult<Vec<ToolCard>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let fts_query = fts_query(query);
        if fts_query.is_empty() {
            return self.first_cards(limit);
        }
        let mut statement = self.connection.prepare(
            "
            SELECT d.card_json
            FROM tool_search_fts f
            JOIN tool_details d
              ON d.provider_id = f.provider_id AND d.tool_name = f.tool_name
            WHERE tool_search_fts MATCH ?1
            ORDER BY bm25(tool_search_fts), d.tool_name ASC
            LIMIT ?2
            ",
        )?;
        let rows = statement.query_map(params![fts_query, limit as i64], |row| {
            row.get::<_, String>(0)
        })?;
        let mut cards = Vec::new();
        for row in rows {
            cards.push(serde_json::from_str(&row?)?);
        }
        if cards.is_empty() {
            return self.first_cards(limit);
        }
        Ok(cards)
    }

    pub fn tool_detail(
        &self,
        provider_id: &ProviderId,
        tool_name: &str,
    ) -> OrchestratorResult<Option<CapabilityTool>> {
        self.connection
            .query_row(
                "
                SELECT tool_json
                FROM tool_details
                WHERE provider_id = ?1 AND tool_name = ?2
                ",
                params![provider_id.as_str(), tool_name],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| Ok(serde_json::from_str::<CapabilityTool>(&json)?))
            .transpose()
    }

    fn run_migrations(&self) -> OrchestratorResult<()> {
        self.connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS tool_details (
                provider_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                card_json TEXT NOT NULL,
                tool_json TEXT NOT NULL,
                PRIMARY KEY (provider_id, tool_name)
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS tool_search_fts USING fts5(
                provider_id UNINDEXED,
                tool_name UNINDEXED,
                search_text
            );
            ",
        )?;
        Ok(())
    }

    fn upsert_tool(&self, tool: &CapabilityTool) -> OrchestratorResult<()> {
        let card = ToolCard::from_tool(tool);
        self.connection.execute(
            "
            DELETE FROM tool_search_fts
            WHERE provider_id = ?1 AND tool_name = ?2
            ",
            params![tool.provider_id.as_str(), tool.name],
        )?;
        self.connection.execute(
            "
            INSERT INTO tool_details (provider_id, tool_name, card_json, tool_json)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(provider_id, tool_name) DO UPDATE SET
                card_json = excluded.card_json,
                tool_json = excluded.tool_json
            ",
            params![
                tool.provider_id.as_str(),
                tool.name,
                serde_json::to_string(&card)?,
                serde_json::to_string(tool)?,
            ],
        )?;
        self.connection.execute(
            "
            INSERT INTO tool_search_fts (provider_id, tool_name, search_text)
            VALUES (?1, ?2, ?3)
            ",
            params![
                tool.provider_id.as_str(),
                tool.name,
                search_text_for_tool(tool)
            ],
        )?;
        Ok(())
    }

    fn first_cards(&self, limit: usize) -> OrchestratorResult<Vec<ToolCard>> {
        let mut statement = self.connection.prepare(
            "
            SELECT card_json
            FROM tool_details
            ORDER BY tool_name ASC
            LIMIT ?1
            ",
        )?;
        let rows = statement.query_map(params![limit as i64], |row| row.get::<_, String>(0))?;
        let mut cards = Vec::new();
        for row in rows {
            cards.push(serde_json::from_str(&row?)?);
        }
        Ok(cards)
    }
}

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

fn fts_query(query: &str) -> String {
    query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.len() >= 2)
        .map(|term| format!("{}*", term.to_lowercase()))
        .collect::<Vec<_>>()
        .join(" OR ")
}
