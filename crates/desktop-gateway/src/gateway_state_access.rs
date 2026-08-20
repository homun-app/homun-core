use super::*;

#[derive(Debug)]
pub(crate) struct GatewayError {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl GatewayError {
    pub(crate) fn store(error: rusqlite::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "chat_store_error",
            message: error.to_string(),
        }
    }

    pub(crate) fn task(error: local_first_task_runtime::TaskRuntimeError) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "task_runtime_error",
            message: error.to_string(),
        }
    }

    pub(crate) fn local_computer(error: String) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "local_computer_error",
            message: error,
        }
    }

    pub(crate) fn memory(error: String) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "memory_error",
            message: error,
        }
    }

    pub(crate) fn capability(error: local_first_capabilities::CapabilityError) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "capability_error",
            message: error.to_string(),
        }
    }
}

pub(crate) fn lock_store(state: &AppState) -> Result<MutexGuard<'_, ChatStore>, GatewayError> {
    state.chat_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "chat_store_lock_error",
        message: error.to_string(),
    })
}

pub(crate) fn lock_task_store(state: &AppState) -> Result<MutexGuard<'_, TaskStore>, GatewayError> {
    state.task_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "task_store_lock_error",
        message: error.to_string(),
    })
}

pub(crate) fn lock_computer_store(
    state: &AppState,
) -> Result<MutexGuard<'_, LocalComputerSessionStore>, GatewayError> {
    state.computer_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "local_computer_store_lock_error",
        message: error.to_string(),
    })
}

pub(crate) fn lock_browser_url_policies(
    state: &AppState,
) -> Result<MutexGuard<'_, BrowserUrlPolicyStore>, GatewayError> {
    state
        .browser_url_policies
        .lock()
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "browser_url_policy_lock_error",
            message: error.to_string(),
        })
}

/// ADR 0027: the facade is lock-free - the store owns concurrency per-op. Direct &-access;
/// never held across a model/embed call (that was the HTTP-hot-path freeze this move removes).
pub(crate) fn memory_facade(state: &AppState) -> &MemoryFacade {
    &state.memory_facade
}

pub(crate) fn lock_vault_store(
    state: &AppState,
) -> Result<MutexGuard<'_, SQLiteVaultStore>, GatewayError> {
    state.vault_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "vault_store_lock_error",
        message: error.to_string(),
    })
}

pub(crate) fn lock_capability_registry(
    state: &AppState,
) -> Result<MutexGuard<'_, CapabilityRegistryStore>, GatewayError> {
    state
        .capability_registry
        .lock()
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "capability_registry_lock_error",
            message: error.to_string(),
        })
}

/// Runs VACUUM on all SQLite stores to reclaim free space. Called at startup
/// and periodically (every 24h via the worker loop). Safe but can be slow on
/// large databases - runs without holding other locks.
pub(crate) fn vacuum_all_stores(state: &AppState) {
    if let Ok(store) = state.chat_store.lock()
        && let Err(error) = store.vacuum()
    {
        eprintln!("VACUUM chat store: {error}");
    }
    if let Ok(store) = lock_task_store(state)
        && let Err(error) = store.vacuum()
    {
        eprintln!("VACUUM task store: {error:?}");
    }
    {
        let facade = memory_facade(state);
        if let Err(error) = facade.vacuum() {
            eprintln!("VACUUM memory store: {error}");
        }
    }
    if let Ok(store) = state.usage_store.lock()
        && let Err(error) = store.vacuum()
    {
        eprintln!("VACUUM usage store: {error}");
    }
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}
