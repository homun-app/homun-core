use crate::{gateway_legacy_data, gateway_logs_dir, panic_log};

pub(crate) fn install_gateway_process_bootstrap() {
    // Initialize structured logging. RUST_LOG controls verbosity per module:
    //   RUST_LOG=warn                       -> only warnings/errors (default-ish)
    //   RUST_LOG=homun_desktop_gateway=info -> gateway info+ (broker/turn/chat lifecycle)
    //   RUST_LOG=homun_desktop_gateway=debug -> verbose (per-event broker logging)
    //   RUST_LOG=trace                      -> everything (noisy, includes deps)
    // Default when RUST_LOG is unset: warn. Existing eprintln!/println! calls
    // still print but structured tracing events are filterable.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_target(false)
        .try_init();

    // P0 observability: leave a trail for every panic, even when the shell
    // is not capturing stdio. Fall back to the OS temp dir if HOME is unusable.
    panic_log::install(gateway_logs_dir().unwrap_or_else(|_| std::env::temp_dir()));

    // SECURITY (data at rest): make everything this process writes owner-only.
    // Personal stores are plaintext SQLite; 0644 would expose memory, contacts
    // and messages to other local users. Set before any file is created.
    #[cfg(unix)]
    // SAFETY: libc::umask has no preconditions; called once before stores open.
    unsafe {
        libc::umask(0o077 as libc::mode_t);
    }

    // Move any pre-rename data dir to the new ~/.homun location before anything
    // opens it.
    gateway_legacy_data::migrate_legacy_data_dir();
}
