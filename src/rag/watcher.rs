//! Directory watcher for automatic RAG ingestion.
//!
//! Monitors directories from two sources:
//! - **DB watches** (`knowledge_watches` table) — each has namespace, profile, contacts.
//! - **Legacy dirs** (`config.knowledge.watch_dirs`) — backward compat, no scoping.
//!
//! Supports hot-reload: the API sends `WatchUpdate::Reload` after CRUD operations,
//! and the watcher reconfigures its notify watchers without restart.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::{mpsc, Mutex};

use super::chunker::is_supported;
use super::db::KnowledgeWatch;
use super::engine::RagEngine;
use crate::storage::Database;
use crate::utils::watcher::{spawn_watched, WatcherHandle};

/// Commands to hot-update the watcher's watched directories.
#[derive(Debug)]
pub enum WatchUpdate {
    /// Reload all watches from DB (after create/update/delete via API).
    Reload,
}

/// Context for a watched directory — used to scope ingested files.
#[derive(Debug, Clone)]
struct WatchContext {
    path: PathBuf,
    recursive: bool,
    profile_id: Option<i64>,
    namespace: Option<String>,
}

impl WatchContext {
    /// Create from a DB watch row.
    fn from_db(w: &KnowledgeWatch) -> Self {
        Self {
            path: PathBuf::from(&w.path),
            recursive: w.is_recursive(),
            profile_id: w.profile_id,
            namespace: Some(w.namespace.clone()),
        }
    }

    /// Create from a legacy config dir (no scoping).
    fn from_legacy(path: PathBuf) -> Self {
        Self {
            path,
            recursive: true,
            profile_id: None,
            namespace: None,
        }
    }
}

/// Watches directories for file changes and auto-ingests into the RAG engine.
pub struct RagWatcher {
    engine: Arc<Mutex<RagEngine>>,
    db: Database,
    legacy_dirs: Vec<PathBuf>,
    update_rx: mpsc::Receiver<WatchUpdate>,
}

impl RagWatcher {
    /// Create a new RAG watcher.
    ///
    /// - `db`: used to load watches from `knowledge_watches` table.
    /// - `legacy_dirs`: backward-compat dirs from `config.knowledge.watch_dirs`.
    /// - `update_rx`: receives reload signals from the API after CRUD changes.
    pub fn new(
        engine: Arc<Mutex<RagEngine>>,
        db: Database,
        legacy_dirs: Vec<PathBuf>,
        update_rx: mpsc::Receiver<WatchUpdate>,
    ) -> Self {
        Self {
            engine,
            db,
            legacy_dirs,
            update_rx,
        }
    }

    pub fn start(self) -> WatcherHandle {
        spawn_watched(move |stop_rx| self.watch_loop(stop_rx), "rag-watcher")
    }

    /// Load watch contexts from DB + legacy dirs.
    async fn load_contexts(&self) -> Vec<WatchContext> {
        let mut contexts = Vec::new();

        // DB watches (enabled only)
        match self.db.list_enabled_knowledge_watches().await {
            Ok(watches) => {
                for w in &watches {
                    contexts.push(WatchContext::from_db(w));
                }
            }
            Err(e) => tracing::warn!(error = %e, "Failed to load knowledge watches from DB"),
        }

        // Legacy dirs (always recursive, no scoping)
        for dir in &self.legacy_dirs {
            contexts.push(WatchContext::from_legacy(dir.clone()));
        }

        // Sort longest-path-first for prefix matching
        contexts.sort_by(|a, b| b.path.as_os_str().len().cmp(&a.path.as_os_str().len()));
        contexts
    }

    /// Find the watch context that owns a file path (longest-prefix match).
    fn match_context<'a>(contexts: &'a [WatchContext], file: &Path) -> Option<&'a WatchContext> {
        contexts.iter().find(|ctx| file.starts_with(&ctx.path))
    }

    /// Configure notify watchers from contexts.
    fn configure_watcher(watcher: &mut RecommendedWatcher, contexts: &[WatchContext]) {
        for ctx in contexts {
            if ctx.path.exists() {
                let mode = if ctx.recursive {
                    RecursiveMode::Recursive
                } else {
                    RecursiveMode::NonRecursive
                };
                match watcher.watch(&ctx.path, mode) {
                    Ok(()) => tracing::info!(path = %ctx.path.display(), "RAG watcher active"),
                    Err(e) => {
                        tracing::warn!(path = %ctx.path.display(), error = %e, "Failed to watch")
                    }
                }
            } else {
                tracing::warn!(path = %ctx.path.display(), "Watch dir does not exist, skipping");
            }
        }
    }

    async fn watch_loop(mut self, mut stop_rx: tokio::sync::oneshot::Receiver<()>) -> Result<()> {
        let (tx, mut rx) = mpsc::channel::<PathBuf>(100);

        let mut watcher: RecommendedWatcher = {
            let tx = tx.clone();
            notify::recommended_watcher(move |res: Result<Event, notify::Error>| match res {
                Ok(event) => {
                    if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                        for path in event.paths {
                            if path.is_file() && is_supported(&path) {
                                let _ = tx.try_send(path);
                            }
                        }
                    }
                }
                Err(e) => tracing::warn!(error = %e, "RAG watcher error"),
            })?
        };

        // Initial load
        let mut contexts = self.load_contexts().await;
        Self::configure_watcher(&mut watcher, &contexts);

        if contexts.is_empty() {
            tracing::debug!("RAG watcher: no directories to watch");
        }

        loop {
            tokio::select! {
                _ = &mut stop_rx => break,

                // Hot-reload signal from API
                update = self.update_rx.recv() => {
                    match update {
                        Some(WatchUpdate::Reload) => {
                            tracing::info!("RAG watcher: reloading watches from DB");
                            // Drop old watcher to unwatch all
                            drop(watcher);
                            contexts = self.load_contexts().await;
                            // Recreate notify watcher
                            let tx2 = tx.clone();
                            watcher = notify::recommended_watcher(
                                move |res: Result<Event, notify::Error>| match res {
                                    Ok(event) => {
                                        if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                                            for path in event.paths {
                                                if path.is_file() && is_supported(&path) {
                                                    let _ = tx2.try_send(path);
                                                }
                                            }
                                        }
                                    }
                                    Err(e) => tracing::warn!(error = %e, "RAG watcher error"),
                                },
                            )?;
                            Self::configure_watcher(&mut watcher, &contexts);
                            tracing::info!(count = contexts.len(), "RAG watcher reconfigured");
                        }
                        None => break, // channel closed
                    }
                }

                // File change event
                path = rx.recv() => {
                    let Some(first_path) = path else { break };
                    // Debounce: collect paths for 500ms
                    let mut paths = vec![first_path];
                    let debounce = tokio::time::sleep(Duration::from_millis(500));
                    tokio::pin!(debounce);
                    loop {
                        tokio::select! {
                            _ = &mut debounce => break,
                            _ = &mut stop_rx => {
                                drop(watcher);
                                return Ok(());
                            }
                            more = rx.recv() => {
                                match more {
                                    Some(p) => {
                                        if !paths.contains(&p) {
                                            paths.push(p);
                                        }
                                    }
                                    None => break,
                                }
                            }
                        }
                    }
                    // Ingest collected files with their watch context
                    let mut engine = self.engine.lock().await;
                    for p in paths {
                        let ctx = Self::match_context(&contexts, &p);
                        let profile_id = ctx.and_then(|c| c.profile_id);
                        let namespace = ctx.and_then(|c| c.namespace.as_deref());
                        match engine.reingest_file(&p, "watcher", profile_id, None, namespace).await {
                            Ok(Some(id)) => {
                                tracing::info!(
                                    path = %p.display(),
                                    source_id = id,
                                    namespace = namespace.unwrap_or("(none)"),
                                    "Auto-ingested file"
                                );
                            }
                            Ok(None) => {} // unchanged
                            Err(e) => {
                                tracing::warn!(path = %p.display(), error = %e, "Failed to auto-ingest");
                            }
                        }
                    }
                }
            }
        }

        drop(watcher);
        tracing::debug!("RAG watcher stopped cleanly");
        Ok(())
    }
}
