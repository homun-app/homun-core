//! Startup integrity sweep for the personal SQLite stores (P0,
//! docs/confronto-codex-produzione.md §2).
//!
//! WHY: a corrupt store (power loss, disk error) is fatal AND silent today —
//! the open fails, the gateway dies, the user sees a broken app with no story.
//! Same philosophy as the browser CDP-wedge self-heal: detect → quarantine →
//! start fresh → tell the user. We NEVER delete: the corrupt file is renamed
//! to `<name>.corrupt-<epoch>.bak` (with its WAL/SHM) so data rescue stays
//! possible.
//!
//! CRITICAL SAFETY INVARIANT (P0 review): we quarantine ONLY on a *positive*
//! corruption verdict. A store that is merely busy/locked/unreadable is
//! `Inconclusive` and left UNTOUCHED. Rationale: 6 of the 7 stores are
//! rollback-journal, this binary holds no process lock (the single-instance
//! lock is Electron-side and is bypassed by the dev standalone gateway and by
//! `HOMUN_*_DB` overrides), so a live healthy store can legitimately be locked
//! by a concurrent writer. Moving a locked-but-healthy file out from under its
//! writer would be DATA LOSS — strictly worse than the crash-and-restart a
//! truly-corrupt file causes on the real open. When in doubt: do nothing.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::ffi::ErrorCode;
use rusqlite::{Connection, OpenFlags};

/// One store to verify: a short stable name (surfaced in /api/health) + path.
pub struct StoreCheck {
    pub name: &'static str,
    pub path: PathBuf,
}

/// Three-state integrity verdict. The middle state is the whole point: an
/// `Inconclusive` store is NEVER quarantined (see the module-level invariant).
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// Missing (fresh install) or quick_check returned "ok".
    Healthy,
    /// A POSITIVE corruption signal: file-is-not-a-database or on-disk
    /// corruption. Safe to quarantine — the real open would fail anyway.
    Corrupt,
    /// Ambiguous: locked/busy, unopenable, an I/O error, or an unrecognised
    /// failure. Could be a live healthy store. Leave it alone.
    Inconclusive,
}

/// Map a rusqlite query error to a verdict. Only unambiguous on-disk-corruption
/// codes count as `Corrupt`; everything else (busy/locked/anything) is treated
/// as `Inconclusive` so we never destroy a live store on ambiguity.
fn classify_query_error(err: &rusqlite::Error) -> Verdict {
    match err {
        rusqlite::Error::SqliteFailure(ffi_err, _) => match ffi_err.code {
            // `NotADatabase` (SQLITE_NOTADB) and `DatabaseCorrupt` (SQLITE_CORRUPT)
            // are definitive: the bytes are not a usable database. Empirically,
            // a pure-garbage file surfaces here as `NotADatabase` on quick_check.
            ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt => Verdict::Corrupt,
            // Busy/locked = a concurrent writer holds the DB; it is very likely
            // healthy. Any other code (I/O, cant-open, etc.) is ambiguous too.
            _ => Verdict::Inconclusive,
        },
        // Non-SQLite errors (e.g. type conversion) can't prove corruption.
        _ => Verdict::Inconclusive,
    }
}

/// Classify a store via PRAGMA quick_check. Missing file = `Healthy` (fresh
/// install). A read-only open followed by a non-"ok" verdict is corruption; a
/// failed open or a busy/ambiguous query error is `Inconclusive`.
fn classify(path: &Path) -> Verdict {
    if !path.exists() {
        return Verdict::Healthy;
    }
    let conn = match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        // Can't-open is ambiguous (locked, perms, or unopenable-corrupt). Do NOT
        // quarantine on ambiguity — destroying a live store is worse than the
        // crash-and-restart a truly-corrupt file would cause on the real open.
        Err(_) => return Verdict::Inconclusive,
    };
    // Short busy_timeout so a momentary writer doesn't immediately read as
    // inconclusive; a genuinely held lock still surfaces as DatabaseBusy.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    match conn.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0)) {
        Ok(v) if v == "ok" => Verdict::Healthy,
        // Opened AND read a non-"ok" verdict = real, reported corruption.
        Ok(_) => Verdict::Corrupt,
        Err(e) => classify_query_error(&e),
    }
}

/// Rename the corrupt store (and its WAL/SHM) aside. Returns whether the MAIN
/// file rename succeeded: the caller reports "recovered" ONLY on success, so a
/// failed quarantine (locked/EACCES) never produces a false recovery signal.
/// WAL/SHM moves are best-effort (a fresh DB must not inherit stale ones).
#[must_use]
fn quarantine(path: &Path) -> bool {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Move the main file first; its success is what we report on.
    let main_target = PathBuf::from(format!("{}.corrupt-{epoch}.bak", path.display()));
    let main_moved = std::fs::rename(path, &main_target).is_ok();
    // WAL/SHM alongside: best-effort so a fresh DB can't inherit stale ones.
    for suffix in ["-wal", "-shm"] {
        let source = PathBuf::from(format!("{}{suffix}", path.display()));
        if source.exists() {
            let target = PathBuf::from(format!("{}{suffix}.corrupt-{epoch}.bak", path.display()));
            let _ = std::fs::rename(&source, &target);
        }
    }
    main_moved
}

/// Verify every store; quarantine ONLY the ones with a positive corruption
/// verdict. Returns the names of the stores actually reset (main-file rename
/// succeeded) for /api/health, so the UI never claims a recovery that did not
/// happen. `Inconclusive` stores are logged and left untouched.
pub fn ensure_store_integrity(stores: &[StoreCheck]) -> Vec<String> {
    let mut recovered = Vec::new();
    for store in stores {
        match classify(&store.path) {
            Verdict::Healthy => {}
            Verdict::Inconclusive => {
                // Leave it alone — could be a live healthy store. The real open
                // below will either succeed (it was just locked) or fail loudly
                // (unopenable), which is no worse than today's behaviour.
                eprintln!(
                    "[store-integrity] {}: inconclusive (locked/unreadable) — leaving untouched: {}",
                    store.name,
                    store.path.display()
                );
            }
            Verdict::Corrupt => {
                if quarantine(&store.path) {
                    eprintln!(
                        "[store-integrity] {} failed quick_check → quarantined to *.corrupt-*.bak (fresh store will be created): {}",
                        store.name,
                        store.path.display()
                    );
                    recovered.push(store.name.to_string());
                } else {
                    // Quarantine failed: the corrupt file is STILL in place, so
                    // do NOT claim recovery. The real open will crash — same as
                    // today — but /api/health stays honest instead of lying that
                    // this store was reset.
                    eprintln!(
                        "[store-integrity] {} is CORRUPT but could not be quarantined (rename failed) — NOT reported as recovered; the next open of this store will fail: {}",
                        store.name,
                        store.path.display()
                    );
                }
            }
        }
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

    #[test]
    fn locked_healthy_store_is_not_quarantined() {
        // DATA-LOSS regression guard (P0 review): a healthy store that is merely
        // locked by a live writer must NOT be quarantined. Empirically, an
        // exclusive lock makes quick_check fail with DatabaseBusy, which
        // classify() maps to Inconclusive → skip.
        let dir = unique_tmp_dir("locked");
        let db = dir.join("live.sqlite");
        let writer = Connection::open(&db).expect("create db");
        writer.execute("CREATE TABLE t (id INTEGER)", []).expect("ddl");
        // Hold a write lock for the duration of the sweep. A short busy_timeout
        // in classify() means this returns quickly as busy, not a hang.
        writer.execute_batch("BEGIN EXCLUSIVE").expect("acquire exclusive lock");

        let recovered =
            ensure_store_integrity(&[StoreCheck { name: "live", path: db.clone() }]);

        assert!(recovered.is_empty(), "locked healthy store must not be reported recovered");
        assert!(db.exists(), "locked healthy store must stay in place");
        let bak_exists = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(!bak_exists, "a healthy-but-locked store must NOT be quarantined");

        drop(writer);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
