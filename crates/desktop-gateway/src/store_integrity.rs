//! Startup integrity sweep for the personal SQLite stores (P0,
//! docs/confronto-codex-produzione.md §2).
//!
//! WHY: a corrupt store (power loss, disk error) is fatal AND silent today —
//! the open fails, the gateway dies, the user sees a broken app with no story.
//! Same philosophy as the browser CDP-wedge self-heal: detect → quarantine →
//! start fresh → tell the user. We NEVER delete: the corrupt file is renamed
//! to `<name>.corrupt-<epoch>.bak` (with its WAL/SHM) so data rescue stays
//! possible.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};

/// One store to verify: a short stable name (surfaced in /api/health) + path.
pub struct StoreCheck {
    pub name: &'static str,
    pub path: PathBuf,
}

/// PRAGMA quick_check outcome. Missing file = healthy (fresh install).
fn is_healthy(path: &Path) -> bool {
    if !path.exists() {
        return true;
    }
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    conn.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0))
        .map(|verdict| verdict == "ok")
        .unwrap_or(false)
}

fn quarantine(path: &Path) {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Move WAL/SHM alongside the main file: a fresh DB must not inherit them.
    for suffix in ["", "-wal", "-shm"] {
        let source = PathBuf::from(format!("{}{suffix}", path.display()));
        if source.exists() {
            let target = PathBuf::from(format!("{}{suffix}.corrupt-{epoch}.bak", path.display()));
            let _ = std::fs::rename(&source, &target);
        }
    }
}

/// Verify every store; quarantine the corrupt ones. Returns the names of the
/// stores that were reset, for /api/health (the UI can tell the user which
/// data area restarted fresh and where the backup lives).
pub fn ensure_store_integrity(stores: &[StoreCheck]) -> Vec<String> {
    let mut recovered = Vec::new();
    for store in stores {
        if is_healthy(&store.path) {
            continue;
        }
        eprintln!(
            "[store-integrity] {} failed quick_check → quarantined to *.corrupt-*.bak (fresh store will be created): {}",
            store.name,
            store.path.display()
        );
        quarantine(&store.path);
        recovered.push(store.name.to_string());
    }
    recovered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "homun-integrity-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create tmp dir");
        dir
    }

    #[test]
    fn healthy_store_is_untouched() {
        let dir = unique_tmp_dir("healthy");
        let db = dir.join("ok.sqlite");
        let conn = Connection::open(&db).expect("create db");
        conn.execute("CREATE TABLE t (id INTEGER)", []).expect("ddl");
        drop(conn);

        let recovered = ensure_store_integrity(&[StoreCheck { name: "ok", path: db.clone() }]);
        assert!(recovered.is_empty());
        assert!(db.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_store_is_quarantined_and_reported() {
        let dir = unique_tmp_dir("corrupt");
        let db = dir.join("broken.sqlite");
        // Bigger than a valid empty DB and NOT starting with the SQLite magic.
        std::fs::write(&db, vec![0x42; 8192]).expect("write garbage");

        let recovered = ensure_store_integrity(&[StoreCheck { name: "broken", path: db.clone() }]);
        assert_eq!(recovered, vec!["broken".to_string()]);
        assert!(!db.exists(), "corrupt file must be moved away");
        let bak_exists = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(bak_exists, "quarantined backup must exist");
        // A fresh open on the original path now works.
        Connection::open(&db).expect("fresh store opens");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_store_is_healthy() {
        let dir = unique_tmp_dir("missing");
        let db = dir.join("never-created.sqlite");
        let recovered = ensure_store_integrity(&[StoreCheck { name: "missing", path: db }]);
        assert!(recovered.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
