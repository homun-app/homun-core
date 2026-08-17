use std::{fs, path::Path};

/// True if a candidate path stays inside `root` after canonicalization.
pub(crate) fn path_within(root: &Path, candidate: &Path) -> bool {
    match (root.canonicalize(), candidate.canonicalize()) {
        (Ok(r), Ok(c)) => c.starts_with(&r),
        _ => false,
    }
}

/// Make every top-level file in the data directory owner-only (0600). The
/// personal stores are plaintext on disk; world-readable files would expose
/// memory, contacts and messages to another local user or casual backups.
#[cfg(unix)]
pub(crate) fn harden_data_at_rest(base: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    let mut fixed = 0usize;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        // Already owner-only? leave it. Otherwise group/other have some access.
        if meta.permissions().mode() & 0o077 == 0 {
            continue;
        }
        if fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o600)).is_ok() {
            fixed += 1;
        }
    }
    if fixed > 0 {
        eprintln!(
            "[gateway] data-at-rest: tightened {fixed} file(s) to 0600 in {}",
            base.display()
        );
    }
}

#[cfg(not(unix))]
pub(crate) fn harden_data_at_rest(_base: &Path) {}

/// Writes a file readable/writable only by the current user (0600 on Unix).
#[cfg(unix)]
pub(crate) fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
pub(crate) fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_within_rejects_parent_traversal() {
        let temp_dir = std::env::temp_dir().join(format!(
            "gateway-file-security-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&temp_dir).unwrap();
        let inside = temp_dir.join("inside.txt");
        let outside = temp_dir.with_file_name(format!(
            "gateway-file-security-outside-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::write(&inside, b"inside").unwrap();
        fs::write(&outside, b"outside").unwrap();

        assert!(path_within(&temp_dir, &inside));
        assert!(!path_within(&temp_dir, &outside));

        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn write_private_file_creates_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = std::env::temp_dir().join(format!(
            "gateway-file-security-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&temp_dir).unwrap();
        let path = temp_dir.join("secret");

        write_private_file(&path, b"secret").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(fs::read(&path).unwrap(), b"secret");
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn harden_data_at_rest_tightens_top_level_files_only() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = std::env::temp_dir().join(format!(
            "gateway-file-security-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let nested = temp_dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let top_level = temp_dir.join("store.sqlite");
        let nested_file = nested.join("tool");
        fs::write(&top_level, b"db").unwrap();
        fs::write(&nested_file, b"tool").unwrap();
        fs::set_permissions(&top_level, fs::Permissions::from_mode(0o644)).unwrap();
        fs::set_permissions(&nested_file, fs::Permissions::from_mode(0o755)).unwrap();

        harden_data_at_rest(&temp_dir);

        assert_eq!(
            fs::metadata(&top_level).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&nested_file).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let _ = fs::remove_dir_all(temp_dir);
    }
}
