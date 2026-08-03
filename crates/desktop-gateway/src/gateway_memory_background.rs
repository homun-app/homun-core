//! Background memory maintenance jobs started after gateway recovery.
//!
//! This module owns long-running or delayed memory maintenance loops. Startup
//! ordering remains in `gateway_background_startup`.

use crate::*;

fn auto_consolidation_hours_from_env(raw: Option<&str>) -> u64 {
    raw.and_then(|value| value.parse().ok()).unwrap_or(0)
}

/// Optional background memory consolidation. OFF by default: consolidation runs an LLM
/// merge of near-duplicate memories that the user otherwise triggers explicitly, so
/// auto-running it is OPT-IN via `HOMUN_AUTO_CONSOLIDATE_HOURS` (cadence in hours, 0 =
/// off). When set, it consolidates the stable personal scope at that cadence -- bounded,
/// best-effort, never at boot.
pub(crate) fn spawn_memory_consolidation_tick(state: AppState) {
    let hours = auto_consolidation_hours_from_env(
        std::env::var("HOMUN_AUTO_CONSOLIDATE_HOURS")
            .ok()
            .as_deref(),
    );
    if hours == 0 {
        return;
    }
    eprintln!("memory auto-consolidation: enabled (every {hours}h, personal scope)");
    tokio::spawn(async move {
        let period = std::time::Duration::from_secs(hours.max(1) * 3600);
        loop {
            tokio::time::sleep(period).await;
            let user = gateway_memory_user_id();
            let personal = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
            let (merged, dropped) = consolidate_scope(&state, &user, &personal).await;
            if merged > 0 || dropped > 0 {
                eprintln!("memory auto-consolidation: merged {merged}, dropped {dropped}");
            }
        }
    });
}

/// WS5.2 -- embed EVERYTHING. One-shot startup catch-up that vectorizes any memory
/// still missing an embedding, across personal + every project scope, looping until
/// none remain (or the embed endpoint stops making progress). Off the startup
/// critical path. Closes the recall gap: embeddings were written only lazily (4-12
/// per op) and via consolidation (OFF by default) -> most extracted memories never got
/// a vector, so semantic recall covered a fraction (baseline: 391 vectors / 555 memories).
pub(crate) fn spawn_embedding_catchup(state: AppState) {
    tokio::spawn(async move {
        // Delay so it never competes with the HTTP bind / first turn.
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        let user = gateway_memory_user_id();
        let mut scopes = vec![PERSONAL_WORKSPACE.to_string()];
        for ws in load_workspaces_file().workspaces {
            if ws.id != base_workspace_id() && ws.id != PERSONAL_WORKSPACE {
                scopes.push(ws.id);
            }
        }
        const BATCH: usize = 64;
        let pending = |ws: &MemoryWorkspaceId| -> usize {
            memory_facade(&state)
                .refs_without_embeddings(&user, ws, BATCH)
                .ok()
                .map(|r| r.len())
                .unwrap_or(0)
        };
        let mut total = 0usize;
        for scope in scopes {
            let ws = MemoryWorkspaceId::new(&scope);
            loop {
                let before = pending(&ws);
                if before == 0 {
                    break;
                }
                backfill_embeddings(&state, &user, &ws, BATCH).await;
                let after = pending(&ws);
                if after >= before {
                    break; // no progress (embed endpoint down) -> retry next boot
                }
                total += before - after;
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
        }
        if total > 0 {
            eprintln!("memory embedding catch-up: vectorized {total} memories");
        }
    });
}

/// Boot-time memory hygiene sweep (ADR 0022 follow-up). Runs three delayed,
/// one-shot cleanups for every scope:
/// 1. `sweep_gap_facts` retires obsolete gap facts contradicted by confirmed facts.
/// 2. `promote_aged_candidates` confirms aged candidates (>10 min) that were never
///    rejected by the user.
/// 3. `expire_due_memories` marks memories beyond `valid_until` as stale, preserving
///    history while removing them from current recall.
pub(crate) fn spawn_memory_hygiene_sweep(state: AppState) {
    tokio::spawn(async move {
        // Delay so it never competes with the HTTP bind / first turn.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let user = gateway_memory_user_id();
        let mut scopes = vec![PERSONAL_WORKSPACE.to_string()];
        for ws in load_workspaces_file().workspaces {
            if ws.id != base_workspace_id() && ws.id != PERSONAL_WORKSPACE {
                scopes.push(ws.id);
            }
        }
        let mut total_gaps = 0usize;
        let mut total_promoted = 0usize;
        let mut total_expired = 0usize;
        let now_unix = OffsetDateTime::now_utc().unix_timestamp();
        for scope in scopes {
            let facade = memory_facade(&state);
            let ws = MemoryWorkspaceId::new(&scope);
            total_gaps += local_first_memory::sweep_gap_facts(facade, &user, &ws);
            total_promoted += local_first_memory::promote_aged_candidates(facade, &user, &ws);
            let lifecycle = MemoryLifecycleRequest {
                actor_id: "memory-maintenance".to_string(),
                user_id: user.clone(),
                workspace_id: ws,
                purpose: "temporal_expiry".to_string(),
            };
            match facade.expire_due_memories(&lifecycle, now_unix) {
                Ok(expired) => total_expired += expired,
                Err(error) => eprintln!("memory hygiene: temporal expiry failed: {error}"),
            }
        }
        if total_gaps > 0 {
            eprintln!("memory hygiene: retired {total_gaps} obsolete gap facts");
        }
        if total_promoted > 0 {
            eprintln!("memory hygiene: promoted {total_promoted} aged candidates");
        }
        if total_expired > 0 {
            eprintln!("memory hygiene: expired {total_expired} temporal memories");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::auto_consolidation_hours_from_env;

    #[test]
    fn gateway_memory_background_parses_optional_consolidation_cadence() {
        assert_eq!(auto_consolidation_hours_from_env(None), 0);
        assert_eq!(auto_consolidation_hours_from_env(Some("")), 0);
        assert_eq!(auto_consolidation_hours_from_env(Some("abc")), 0);
        assert_eq!(auto_consolidation_hours_from_env(Some("6")), 6);
    }
}
