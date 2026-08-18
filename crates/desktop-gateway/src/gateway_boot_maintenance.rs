//! Idempotent gateway maintenance jobs that run after `AppState` is assembled.
//!
//! Keep this module scoped to boot-time cleanup/backfill work. Recovery,
//! worker startup, and long-running background services have separate owners.

use crate::AppState;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GatewayBootMaintenanceStep {
    InitActiveWorkspaceFromDisk,
    SeedDefaultSkills,
    GcStaleTasks,
    BackfillContacts,
    BackfillMentions,
    UnifyOwnerIdentity,
    CancelHomunCheckins,
}

const GATEWAY_BOOT_MAINTENANCE_STEPS: &[GatewayBootMaintenanceStep] = &[
    GatewayBootMaintenanceStep::InitActiveWorkspaceFromDisk,
    GatewayBootMaintenanceStep::SeedDefaultSkills,
    GatewayBootMaintenanceStep::GcStaleTasks,
    GatewayBootMaintenanceStep::BackfillContacts,
    GatewayBootMaintenanceStep::BackfillMentions,
    GatewayBootMaintenanceStep::UnifyOwnerIdentity,
    GatewayBootMaintenanceStep::CancelHomunCheckins,
];

trait GatewayBootMaintenanceRunner {
    fn init_active_workspace_from_disk(&mut self);
    fn seed_default_skills(&mut self);
    fn gc_stale_tasks(&mut self);
    fn backfill_contacts(&mut self);
    fn backfill_mentions(&mut self);
    fn unify_owner_identity(&mut self);
    fn cancel_homun_checkins(&mut self);
}

struct RuntimeGatewayBootMaintenanceRunner<'a> {
    state: &'a AppState,
}

impl GatewayBootMaintenanceRunner for RuntimeGatewayBootMaintenanceRunner<'_> {
    fn init_active_workspace_from_disk(&mut self) {
        crate::init_active_workspace_from_disk();
    }

    fn seed_default_skills(&mut self) {
        seed_default_skills();
    }

    fn gc_stale_tasks(&mut self) {
        crate::gateway_task_maintenance::gc_stale_tasks(self.state);
    }

    fn backfill_contacts(&mut self) {
        crate::backfill_contacts(self.state);
    }

    fn backfill_mentions(&mut self) {
        crate::backfill_mentions(self.state);
    }

    fn unify_owner_identity(&mut self) {
        crate::unify_owner_identity(self.state);
    }

    fn cancel_homun_checkins(&mut self) {
        crate::gateway_task_maintenance::cancel_homun_checkins(self.state);
    }
}

pub(crate) fn run_gateway_boot_maintenance(state: &AppState) {
    let mut runner = RuntimeGatewayBootMaintenanceRunner { state };
    run_gateway_boot_maintenance_steps(&mut runner);
}

fn run_gateway_boot_maintenance_steps(runner: &mut impl GatewayBootMaintenanceRunner) {
    for step in GATEWAY_BOOT_MAINTENANCE_STEPS {
        match step {
            GatewayBootMaintenanceStep::InitActiveWorkspaceFromDisk => {
                runner.init_active_workspace_from_disk()
            }
            GatewayBootMaintenanceStep::SeedDefaultSkills => runner.seed_default_skills(),
            GatewayBootMaintenanceStep::GcStaleTasks => runner.gc_stale_tasks(),
            GatewayBootMaintenanceStep::BackfillContacts => runner.backfill_contacts(),
            GatewayBootMaintenanceStep::BackfillMentions => runner.backfill_mentions(),
            GatewayBootMaintenanceStep::UnifyOwnerIdentity => runner.unify_owner_identity(),
            GatewayBootMaintenanceStep::CancelHomunCheckins => runner.cancel_homun_checkins(),
        }
    }
}

/// Bundled default-skills dir, staged into the app/container at build time.
/// Env override, else repo-relative for dev so local runs work without setup.
fn default_skills_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HOMUN_DEFAULT_SKILLS_DIR") {
        let path = PathBuf::from(p);
        if path.is_dir() {
            return Some(path);
        }
    }
    for base in ["resources/default-skills", "../resources/default-skills"] {
        let path = PathBuf::from(base);
        if path.is_dir() {
            return Some(path);
        }
    }
    None
}

/// Recursively copy `src` into `dst` (text skill trees only: no symlink graphs).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Non-cryptographic content hash of a whole skill tree (change detection only).
/// Default skills include scripts/assets as well as SKILL.md; hashing only the
/// manifest misses bundled implementation updates.
fn skill_tree_hash(dir: &Path) -> Option<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) -> std::io::Result<()> {
        let mut entries = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                walk(base, &path, out)?;
            } else if file_type.is_file() {
                let rel = path
                    .strip_prefix(base)
                    .map_err(|error| std::io::Error::other(error.to_string()))?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, fs::read(&path)?));
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    walk(dir, dir, &mut files).ok()?;
    if !files.iter().any(|(path, _)| path == "SKILL.md") {
        return None;
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for (path, bytes) in files {
        path.hash(&mut h);
        bytes.hash(&mut h);
    }
    Some(format!("{:016x}", h.finish()))
}

/// Seeds bundled default skills into the user's skills dir. The operation is
/// non-destructive: user edits and deletions are preserved across app updates.
fn seed_default_skills() {
    let Ok(dest) = crate::skills_dir() else {
        return;
    };
    let marker = dest.join(".defaults-seeded");
    let Some(src) = default_skills_dir() else {
        return;
    };

    let seeded_path = dest.join(".seeded-defaults");
    let mut seeded: BTreeMap<String, Option<String>> = fs::read_to_string(&seeded_path)
        .map(|raw| {
            raw.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(|line| match line.split_once('\t') {
                    Some((id, hash)) => (id.to_string(), Some(hash.to_string())),
                    None => (line.to_string(), None),
                })
                .collect()
        })
        .unwrap_or_default();
    if seeded.is_empty()
        && marker.exists()
        && let Ok(entries) = fs::read_dir(&src)
    {
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().to_string();
            if entry.path().join("SKILL.md").is_file() && dest.join(&id).exists() {
                seeded.entry(id).or_insert(None);
            }
        }
    }

    let mut copied = 0usize;
    let mut updated = 0usize;
    if let Ok(entries) = fs::read_dir(&src) {
        for entry in entries.flatten() {
            let from = entry.path();
            if !from.is_dir() || !from.join("SKILL.md").is_file() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            let target = dest.join(entry.file_name());
            let bundled = skill_tree_hash(&from);

            if !target.exists() {
                if seeded.contains_key(&id) {
                    continue;
                }
                if copy_dir_recursive(&from, &target).is_ok() {
                    seeded.insert(id, bundled);
                    copied += 1;
                }
                continue;
            }

            let on_disk = skill_tree_hash(&target);
            let prev = seeded.get(&id).cloned().flatten();
            let unedited = match (&prev, &on_disk) {
                (Some(previous), Some(current)) => previous == current,
                (None, _) => true,
                _ => false,
            };
            if unedited && bundled.is_some() && bundled != on_disk {
                if prev.is_none() {
                    let _ = fs::copy(target.join("SKILL.md"), target.join("SKILL.md.bak"));
                }
                if copy_dir_recursive(&from, &target).is_ok() {
                    updated += 1;
                }
                seeded.insert(id, bundled);
            } else {
                seeded.insert(id, prev.or(on_disk));
            }
        }
    }
    if copied + updated > 0 {
        eprintln!("seed_default_skills: {copied} new, {updated} updated");
    }
    let _ = fs::write(
        &seeded_path,
        seeded
            .iter()
            .map(|(id, hash)| match hash {
                Some(hash) => format!("{id}\t{hash}"),
                None => id.clone(),
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    );

    let manifest = "homuncoder-skills.txt";
    let mut ids: BTreeSet<String> = BTreeSet::new();
    for base in [dest.join(manifest), src.join(manifest)] {
        if let Ok(raw) = fs::read_to_string(&base) {
            for line in raw.lines() {
                let id = line.trim();
                if !id.is_empty() {
                    ids.insert(id.to_string());
                }
            }
        }
    }
    if !ids.is_empty() {
        let body = ids.into_iter().collect::<Vec<_>>().join("\n");
        let _ = fs::write(dest.join(manifest), format!("{body}\n"));
    }

    let _ = fs::write(&marker, "1");
    if copied > 0 {
        eprintln!(
            "[homun] seeded {copied} default skill(s) into {}",
            dest.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{GatewayBootMaintenanceRunner, run_gateway_boot_maintenance_steps};

    #[derive(Default)]
    struct RecordingRunner {
        calls: Vec<&'static str>,
    }

    impl GatewayBootMaintenanceRunner for RecordingRunner {
        fn init_active_workspace_from_disk(&mut self) {
            self.calls.push("init_active_workspace_from_disk");
        }

        fn seed_default_skills(&mut self) {
            self.calls.push("seed_default_skills");
        }

        fn gc_stale_tasks(&mut self) {
            self.calls.push("gc_stale_tasks");
        }

        fn backfill_contacts(&mut self) {
            self.calls.push("backfill_contacts");
        }

        fn backfill_mentions(&mut self) {
            self.calls.push("backfill_mentions");
        }

        fn unify_owner_identity(&mut self) {
            self.calls.push("unify_owner_identity");
        }

        fn cancel_homun_checkins(&mut self) {
            self.calls.push("cancel_homun_checkins");
        }
    }

    #[test]
    fn runs_gateway_boot_maintenance_in_contract_order() {
        let mut runner = RecordingRunner::default();

        run_gateway_boot_maintenance_steps(&mut runner);

        assert_eq!(
            runner.calls,
            [
                "init_active_workspace_from_disk",
                "seed_default_skills",
                "gc_stale_tasks",
                "backfill_contacts",
                "backfill_mentions",
                "unify_owner_identity",
                "cancel_homun_checkins",
            ]
        );
    }

    #[test]
    fn skill_tree_hash_tracks_script_changes() {
        let root = std::env::temp_dir().join(format!(
            "homun-skill-hash-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).expect("scripts dir");
        std::fs::write(root.join("SKILL.md"), "---\nname: demo\n---\n# Demo\n").expect("skill");
        std::fs::write(scripts.join("run.sh"), "echo one\n").expect("script");

        let first = super::skill_tree_hash(&root).expect("first hash");
        std::fs::write(scripts.join("run.sh"), "echo two\n").expect("script update");
        let second = super::skill_tree_hash(&root).expect("second hash");
        let _ = std::fs::remove_dir_all(&root);

        assert_ne!(first, second);
    }
}
