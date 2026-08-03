use std::{env, fs, path::PathBuf};

/// What to do with the legacy data dir at startup. Pure decision -> unit-testable.
#[derive(Debug, PartialEq, Eq)]
enum LegacyDirAction {
    /// No legacy dir (fresh install or already migrated) -> nothing to do.
    Noop,
    /// Legacy exists, `~/.homun` does not -> rename it across.
    Migrate,
    /// BOTH exist -> can't rename; warn loudly instead of silently using `~/.homun`.
    WarnCollision,
}

fn legacy_dir_action(legacy_exists: bool, current_exists: bool) -> LegacyDirAction {
    match (legacy_exists, current_exists) {
        (false, _) => LegacyDirAction::Noop,
        (true, false) => LegacyDirAction::Migrate,
        (true, true) => LegacyDirAction::WarnCollision,
    }
}

/// One-time data-dir migration after the project rename to "homun". Existing
/// installs keep their data: if the legacy `~/.local-first-personal-assistant`
/// still exists and the new `~/.homun` does not, move it across. Never deletes or
/// overwrites anything; on failure we proceed with a fresh `~/.homun`.
///
/// If BOTH dirs exist the rename can't run, and on at least one machine a
/// pre-existing `~/.homun` (an unrelated older project) silently shadowed the real
/// data left in the legacy dir, making the app look "empty". We don't guess which
/// dataset wins (overwriting user data is never acceptable), but we make the split
/// LOUD so it can't pass unnoticed again.
pub(crate) fn migrate_legacy_data_dir() {
    let Ok(home) = env::var("HOME") else {
        return;
    };
    let home = PathBuf::from(home);
    let legacy = home.join(".local-first-personal-assistant");
    let current = home.join(".homun");
    match legacy_dir_action(legacy.exists(), current.exists()) {
        LegacyDirAction::Noop => {}
        LegacyDirAction::Migrate => match fs::rename(&legacy, &current) {
            Ok(()) => eprintln!(
                "[homun] migrated data dir {} -> {}",
                legacy.display(),
                current.display()
            ),
            Err(error) => eprintln!(
                "[homun] WARN: data-dir migration failed ({error}); starting fresh at {}",
                current.display()
            ),
        },
        LegacyDirAction::WarnCollision => eprintln!(
            "[homun] WARN: two data folders coexist - using {} but {} still exists \
             (possibly more recent data there). If the app looks EMPTY: stop the gateway, \
             set {} aside and rename {} to {}.",
            current.display(),
            legacy.display(),
            current.display(),
            legacy.display(),
            current.display(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{LegacyDirAction, legacy_dir_action};

    #[test]
    fn legacy_data_dir_decision() {
        // No legacy dir -> nothing to do (fresh install or already migrated).
        assert_eq!(legacy_dir_action(false, false), LegacyDirAction::Noop);
        assert_eq!(legacy_dir_action(false, true), LegacyDirAction::Noop);
        // Legacy present, ~/.homun absent -> clean rename.
        assert_eq!(legacy_dir_action(true, false), LegacyDirAction::Migrate);
        // BOTH present -> can't rename; must warn (the collision that stranded data
        // behind a pre-existing ~/.homun), never silently use the empty one.
        assert_eq!(
            legacy_dir_action(true, true),
            LegacyDirAction::WarnCollision
        );
    }
}
