use crate::{
    gateway_paths::{
        gateway_browser_policy_database_path, gateway_capability_database_path,
        gateway_database_path, gateway_local_computer_database_path, gateway_memory_database_path,
        gateway_task_database_path, gateway_vault_database_path,
    },
    store_integrity::{self, StoreCheck},
};

const GATEWAY_STORE_NAMES: &[&str] = &[
    "desktop-gateway",
    "task-runtime",
    "local-computer-session",
    "browser-url-policy",
    "memory",
    "vault",
    "capability-registry",
];

/// P0 resilience sweep: verify every personal store before anything opens it.
/// Corrupt files are quarantined by `store_integrity`; the returned names are
/// surfaced through `/api/health` as `recovered_stores`.
pub(crate) fn ensure_gateway_store_integrity() -> Result<Vec<String>, std::io::Error> {
    Ok(store_integrity::ensure_store_integrity(
        &gateway_store_checks()?,
    ))
}

fn gateway_store_checks() -> Result<Vec<StoreCheck>, std::io::Error> {
    Ok(vec![
        StoreCheck {
            name: GATEWAY_STORE_NAMES[0],
            path: gateway_database_path()?,
        },
        StoreCheck {
            name: GATEWAY_STORE_NAMES[1],
            path: gateway_task_database_path()?,
        },
        StoreCheck {
            name: GATEWAY_STORE_NAMES[2],
            path: gateway_local_computer_database_path()?,
        },
        StoreCheck {
            name: GATEWAY_STORE_NAMES[3],
            path: gateway_browser_policy_database_path()?,
        },
        StoreCheck {
            name: GATEWAY_STORE_NAMES[4],
            path: gateway_memory_database_path()?,
        },
        StoreCheck {
            name: GATEWAY_STORE_NAMES[5],
            path: gateway_vault_database_path()?,
        },
        StoreCheck {
            name: GATEWAY_STORE_NAMES[6],
            path: gateway_capability_database_path()?,
        },
    ])
}

#[cfg(test)]
mod tests {
    use super::GATEWAY_STORE_NAMES;

    #[test]
    fn health_recovery_store_names_are_stable() {
        assert_eq!(
            GATEWAY_STORE_NAMES,
            &[
                "desktop-gateway",
                "task-runtime",
                "local-computer-session",
                "browser-url-policy",
                "memory",
                "vault",
                "capability-registry",
            ]
        );
    }
}
