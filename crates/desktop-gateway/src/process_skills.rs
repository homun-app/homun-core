//! Gateway store + agent-facing helpers for **addons** (process-skills, ADR 0011).
//!
//! Single-tenant + JSON-file-backed (like `workspaces.json`/`providers.json`):
//! - `process-skills.json` — installed addons (seeded with the vetted invoicing
//!   example on first run);
//! - `skill-overlays.json` — per-instance customization overlays, keyed by addon id.
//!
//! The agent uses `addons_list_text` / `addon_show_text` / `addon_customize_text`
//! to let the user SEE and ADAPT a vetted addon by prompt. Customization goes
//! through the process-skill **contract** (`validate_overlay`): changes to LOCKED
//! invariants are rejected, never saved.

use local_first_process_skill::{
    apply_overlay, invoicing_example, validate_overlay, Overlay, ProcessSkill, Violation,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn base_dir() -> PathBuf {
    std::env::var("LFPA_DATA_DIR")
        .map(PathBuf::from)
        .ok()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| {
            std::env::var("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| std::env::temp_dir())
                .join(".homun")
        })
}

fn skills_path() -> PathBuf {
    base_dir().join("process-skills.json")
}

fn overlays_path() -> PathBuf {
    base_dir().join("skill-overlays.json")
}

#[derive(Serialize, Deserialize)]
struct SkillsFile {
    skills: Vec<ProcessSkill>,
}

#[derive(Default, Serialize, Deserialize)]
struct OverlaysFile {
    #[serde(default)]
    overlays: BTreeMap<String, Overlay>,
}

/// Installed addons. Seeds the vetted invoicing example on first run so there is
/// always something to demonstrate the contract against.
fn load_skills() -> Vec<ProcessSkill> {
    std::fs::read_to_string(skills_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<SkillsFile>(&raw).ok())
        .map(|file| file.skills)
        .filter(|skills| !skills.is_empty())
        .unwrap_or_else(|| vec![invoicing_example()])
}

fn load_overlays() -> OverlaysFile {
    std::fs::read_to_string(overlays_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<OverlaysFile>(&raw).ok())
        .unwrap_or_default()
}

fn save_overlays(file: &OverlaysFile) -> Result<(), String> {
    let _ = std::fs::create_dir_all(base_dir());
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(overlays_path(), json).map_err(|e| e.to_string())
}

fn base_skill(addon_id: &str) -> Option<ProcessSkill> {
    load_skills().into_iter().find(|skill| skill.id == addon_id)
}

/// The effective (customized) addon = base + stored overlay applied.
fn effective_skill(addon_id: &str) -> Option<ProcessSkill> {
    let base = base_skill(addon_id)?;
    let overlays = load_overlays();
    Some(match overlays.overlays.get(addon_id) {
        Some(overlay) => apply_overlay(&base, overlay),
        None => base,
    })
}

fn list_effective() -> Vec<ProcessSkill> {
    let overlays = load_overlays();
    load_skills()
        .into_iter()
        .map(|base| match overlays.overlays.get(&base.id) {
            Some(overlay) => apply_overlay(&base, overlay),
            None => base,
        })
        .collect()
}

enum CustomizeError {
    NotFound,
    Invalid(Vec<Violation>),
    Io(String),
}

/// Merges field changes into the stored overlay for an addon, validating the whole
/// overlay against the contract. Nothing is saved if any change hits a locked or
/// unknown field. Returns the effective addon on success.
fn customize(addon_id: &str, changes: BTreeMap<String, Value>) -> Result<ProcessSkill, CustomizeError> {
    let base = base_skill(addon_id).ok_or(CustomizeError::NotFound)?;
    let mut overlays = load_overlays();
    let mut overlay = overlays.overlays.get(addon_id).cloned().unwrap_or_default();
    for (key, value) in changes {
        overlay.changes.insert(key, value);
    }
    let violations = validate_overlay(&base, &overlay);
    if !violations.is_empty() {
        return Err(CustomizeError::Invalid(violations));
    }
    overlay.version += 1;
    let effective = apply_overlay(&base, &overlay);
    overlays.overlays.insert(addon_id.to_string(), overlay);
    save_overlays(&overlays).map_err(CustomizeError::Io)?;
    Ok(effective)
}

// ─── Agent-facing text helpers (return the tool-result string) ───

pub fn addons_list_text() -> String {
    let skills = list_effective();
    if skills.is_empty() {
        return "Nessun addon installato.".to_string();
    }
    let mut lines = vec!["Addon installati:".to_string()];
    for skill in skills {
        lines.push(format!("- {} (id={}) — {}", skill.name, skill.id, skill.description));
    }
    lines.push("Usa show_addon(id) per vederne i campi, customize_addon per adattarlo.".to_string());
    lines.join("\n")
}

pub fn addon_show_text(addon_id: &str) -> String {
    let Some(skill) = effective_skill(addon_id) else {
        return format!("Nessun addon con id '{addon_id}'. Usa list_addons.");
    };
    let mut out = format!(
        "Addon «{}» (id={}) v{}\n{}\n\nCampi configurabili (APERTO = adattabile, BLOCCATO = invariante):",
        skill.name, skill.id, skill.version, skill.description
    );
    for field in &skill.config {
        let zone = if field.editable {
            "APERTO"
        } else {
            "BLOCCATO"
        };
        out.push_str(&format!(
            "\n- {} «{}» = {} · {zone}",
            field.key, field.label, field.value
        ));
    }
    out.push_str("\n\nPassi:");
    for step in &skill.steps {
        out.push_str(&format!(
            "\n- {}{}",
            step.description,
            if step.locked { " (bloccato)" } else { "" }
        ));
    }
    out
}

pub fn addon_customize_text(addon_id: &str, changes_value: &Value) -> String {
    let Some(map) = changes_value.as_object() else {
        return "Le modifiche devono essere un oggetto {campo: valore}.".to_string();
    };
    let changes: BTreeMap<String, Value> = map
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if changes.is_empty() {
        return "Nessuna modifica indicata.".to_string();
    }
    match customize(addon_id, changes) {
        Ok(effective) => {
            let open: Vec<String> = effective
                .config
                .iter()
                .filter(|field| field.editable)
                .map(|field| format!("{}={}", field.key, field.value))
                .collect();
            format!(
                "✅ Personalizzazione salvata per «{}» (v{}). Campi aperti ora: {}",
                effective.name,
                effective.version,
                open.join(", ")
            )
        }
        Err(CustomizeError::NotFound) => format!("Nessun addon con id '{addon_id}'."),
        Err(CustomizeError::Invalid(violations)) => {
            let msgs: Vec<String> = violations
                .iter()
                .map(|v| format!("• '{}' — {}", v.key, v.reason))
                .collect();
            format!(
                "Non ho applicato NULLA: alcune modifiche violano il contratto del componente \
(i campi bloccati sono invarianti, es. fiscali/legali):\n{}",
                msgs.join("\n")
            )
        }
        Err(CustomizeError::Io(error)) => format!("Errore nel salvataggio: {error}"),
    }
}
