use anyhow::{bail, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::rand::{SecureRandom, SystemRandom};

use crate::app_factory::db::AppUserRow;

pub const APP_SESSION_COOKIE_PREFIX: &str = "homun_app_session_";
const SESSION_ID_LEN: usize = 32;

#[derive(Debug, Clone)]
pub struct AppAuthUser {
    pub app_slug: String,
    pub app_user_id: i64,
    pub email: String,
    pub display_name: String,
    pub role: String,
}

pub fn cookie_name(slug: &str) -> String {
    format!("{APP_SESSION_COOKIE_PREFIX}{}", slug.replace('-', "_"))
}

pub fn generate_session_id() -> Result<String> {
    let rng = SystemRandom::new();
    let mut bytes = [0u8; SESSION_ID_LEN];
    rng.fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("RNG failed generating app session id"))?;
    Ok(B64.encode(bytes))
}

pub fn can_manage_users(role: &str) -> bool {
    role == "admin"
}

pub fn can_create_record(role: &str) -> bool {
    matches!(role, "admin" | "approver" | "employee")
}

pub fn can_run_action(role: &str, action: &str) -> bool {
    match role {
        "admin" => true,
        "approver" => matches!(action, "approve" | "reject"),
        _ => false,
    }
}

pub fn ensure_role(predicate: bool, message: &str) -> Result<()> {
    if !predicate {
        bail!("{message}");
    }
    Ok(())
}

impl From<(&str, AppUserRow)> for AppAuthUser {
    fn from((app_slug, row): (&str, AppUserRow)) -> Self {
        Self {
            app_slug: app_slug.to_string(),
            app_user_id: row.id,
            email: row.email,
            display_name: row.display_name,
            role: row.role,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_name_is_slug_scoped() {
        assert_eq!(
            cookie_name("ferie-permessi"),
            "homun_app_session_ferie_permessi"
        );
    }

    #[test]
    fn role_permissions_are_fail_closed() {
        assert!(can_manage_users("admin"));
        assert!(!can_manage_users("approver"));
        assert!(can_create_record("employee"));
        assert!(can_run_action("approver", "approve"));
        assert!(!can_run_action("employee", "approve"));
    }

    #[test]
    fn session_ids_are_url_safe_and_unique() {
        let first = generate_session_id().unwrap();
        let second = generate_session_id().unwrap();

        assert_ne!(first, second);
        assert_eq!(first.len(), 43);
        assert!(first
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
    }
}
