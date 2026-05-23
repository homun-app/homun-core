use crate::{ProcessManagerResult, ProcessSnapshot, ProcessSpec};
use rusqlite::{Connection, params};
use std::path::Path;

pub struct ProcessRegistryStore {
    connection: Connection,
}

impl ProcessRegistryStore {
    pub fn open(path: impl AsRef<Path>) -> ProcessManagerResult<Self> {
        let connection = Connection::open(path)?;
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_in_memory() -> ProcessManagerResult<Self> {
        let connection = Connection::open_in_memory()?;
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    pub fn upsert_spec(&self, spec: &ProcessSpec) -> ProcessManagerResult<()> {
        self.connection.execute(
            "INSERT INTO process_specs (id, spec_json)
             VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET spec_json = excluded.spec_json",
            params![spec.id, serde_json::to_string(spec)?],
        )?;
        Ok(())
    }

    pub fn get_spec(&self, id: &str) -> ProcessManagerResult<Option<ProcessSpec>> {
        let mut statement = self
            .connection
            .prepare("SELECT spec_json FROM process_specs WHERE id = ?1")?;
        let mut rows = statement.query(params![id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let json: String = row.get(0)?;
        Ok(Some(serde_json::from_str(&json)?))
    }

    pub fn list_specs(&self) -> ProcessManagerResult<Vec<ProcessSpec>> {
        let mut statement = self
            .connection
            .prepare("SELECT spec_json FROM process_specs ORDER BY id")?;
        let specs = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<ProcessManagerResult<Vec<_>>>()?;
        Ok(specs)
    }

    pub fn record_snapshot(&self, snapshot: &ProcessSnapshot) -> ProcessManagerResult<()> {
        self.connection.execute(
            "INSERT INTO process_snapshots (process_id, snapshot_json)
             VALUES (?1, ?2)
             ON CONFLICT(process_id) DO UPDATE SET snapshot_json = excluded.snapshot_json",
            params![snapshot.process_id, serde_json::to_string(snapshot)?],
        )?;
        Ok(())
    }

    pub fn latest_snapshot(&self, id: &str) -> ProcessManagerResult<Option<ProcessSnapshot>> {
        let mut statement = self
            .connection
            .prepare("SELECT snapshot_json FROM process_snapshots WHERE process_id = ?1")?;
        let mut rows = statement.query(params![id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let json: String = row.get(0)?;
        Ok(Some(serde_json::from_str(&json)?))
    }

    fn migrate(&self) -> ProcessManagerResult<()> {
        self.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS process_specs (
                id TEXT PRIMARY KEY,
                spec_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS process_snapshots (
                process_id TEXT PRIMARY KEY,
                snapshot_json TEXT NOT NULL
            );",
        )?;
        Ok(())
    }
}
