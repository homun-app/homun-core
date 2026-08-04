// In-process memory recall service wiring and facade projection.
use crate::*;

/// Impl in-process di [`MemoryRecallService`] che **delega** alle funzioni
/// esistenti del gateway senza cambiarne il behaviour (ADR 0022, Tappa 1).
///
/// L'estrazione vera (migrazione delle funzioni nel crate `memory`) è la Tappa
/// 4: qui si incapsula *delegando*. Mantiene `AppState` (clone a basso costo,
/// tutti i campi sono `Arc`) e condivide lo stesso `Arc<MemoryFacade>` (ADR 0027: lock-free).
///
/// Parità: `brief` riproduce esattamente la sequenza di assemblaggio del
/// system prompt (`main.rs:19476-19509`); `recall`/`learn` avvolgono
/// `relevant_memory_for_prompt`/`learn_from_exchange`.
pub(crate) struct InProcessMemoryRecallService {
    state: AppState,
    /// ADR 0022 (Tappa 4): embedding client astratto (capability trait). Il
    /// recall orchestrato nel crate lo consuma; questa impl gateway wrappa la
    /// cache LRU+TTL esistente (`embed_query_for_memory_recall`).
    embedding: std::sync::Arc<dyn local_first_memory::EmbeddingClient>,
    /// ADR 0022 (Tappa 4): LLM client per l'estrazione memoria (learn). Wrappa
    /// `extractor_openai_config` + POST `/chat/completions`.
    llm: std::sync::Arc<dyn local_first_memory::LlmClient>,
}

impl InProcessMemoryRecallService {
    pub(crate) fn new(
        state: AppState,
        embedding: std::sync::Arc<dyn local_first_memory::EmbeddingClient>,
        llm: std::sync::Arc<dyn local_first_memory::LlmClient>,
    ) -> Self {
        Self {
            state,
            embedding,
            llm,
        }
    }
}

pub(crate) fn install_memory_service_if_enabled(
    state: &mut AppState,
    embedding: Arc<dyn local_first_memory::EmbeddingClient>,
    llm: Arc<dyn local_first_memory::LlmClient>,
) {
    state.memory_service = memory_service_enabled().then(|| {
        Arc::new(InProcessMemoryRecallService::new(
            state.clone(),
            embedding,
            llm,
        )) as Arc<dyn MemoryRecallService>
    });
}

fn recall_scope_for_workspace(workspace: &MemoryWorkspaceId) -> MemoryScope {
    if workspace.as_str() == PERSONAL_WORKSPACE {
        MemoryScope::Personal
    } else {
        MemoryScope::Project(workspace.clone())
    }
}

pub(crate) fn recall_pack_on_facade(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    query: &str,
    query_vec: &[f32],
    graph_context: Option<&local_first_memory::GraphContextHook<'_>>,
) -> RecallPack {
    let scope = recall_scope_for_workspace(workspace);
    if facade.memory_health().is_err() {
        return RecallPack::from_hits(query.to_string(), scope, Vec::new())
            .with_status(local_first_memory::MemoryAccessStatus::Unavailable);
    }
    if memory_sources_enabled() && workspace.as_str() != PERSONAL_WORKSPACE {
        // Project lifecycle belongs to the gateway registry, not to the
        // memory store. The coordinator requests one authorization snapshot
        // per resolve/revalidation pass, so a deleted project is excluded
        // before its records are queried or its grant is audited.
        let source_allowed = |sources: &[local_first_memory::AuthorizedMemorySource]| {
            let available_projects = load_persisted_memory_source_workspace_ids();
            sources
                .iter()
                .map(|source| {
                    (source.grant_id.is_none()
                        && source.source_user_id == *user
                        && source.source_workspace_id == *workspace)
                        || source.source_workspace_id.as_str() == PERSONAL_WORKSPACE
                        || available_projects.as_ref().is_some_and(|projects| {
                            projects.contains(source.source_workspace_id.as_str())
                        })
                })
                .collect::<Vec<_>>()
        };
        let mut pack = local_first_memory::recall_authorized_sources_on_facade_with_source_filter(
            facade,
            user,
            workspace,
            query,
            query_vec,
            i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX),
            graph_context,
            &source_allowed,
        )
        .unwrap_or_else(|_| {
            RecallPack::from_hits(
                query.to_string(),
                MemoryScope::Project(workspace.clone()),
                Vec::new(),
            )
            .with_status(local_first_memory::MemoryAccessStatus::Unavailable)
        });
        if query_vec.is_empty()
            && pack.status != local_first_memory::MemoryAccessStatus::Unavailable
        {
            pack.status = local_first_memory::MemoryAccessStatus::Degraded;
        }
        return pack;
    }
    let mut pack = local_first_memory::recall_single_scope_pack(
        facade,
        user,
        workspace,
        query,
        query_vec,
        graph_context,
    );
    if query_vec.is_empty() {
        pack.status = local_first_memory::MemoryAccessStatus::Degraded;
    }
    pack
}

impl MemoryRecallService for InProcessMemoryRecallService {
    fn brief(&self, scope: &MemoryScope, _user_message: &str) -> BriefingPack {
        // `scope` è portato per il contratto (isolation by construction); l'impl delegante
        // usa il workspace attivo del gateway, coerente con `relevant_memory_for_prompt`.
        // Lo scope diventa realmente autoritativo in Tappa 4. Qui l'assert garantisce
        // coerenza in debug (discrepanza = segnale di un bug nel wiring, non da zittire).
        debug_assert!(scope.workspace_id() == gateway_memory_workspace_id());

        // recent_work NON è cached: dipende da git log (non dalla memoria), va
        // ricalcolato fresco ogni brief() come nel path inline.
        let recent_work = recent_work_block(&self.state);

        // ADR 0022 (Tappa 1.5) — cache del briefing per i 3 blocchi memory-backed.
        // Hit solo se generation AND prompt_fingerprint combaciano.
        let user = gateway_memory_user_id();
        let workspace = gateway_memory_workspace_id();
        let memory_intent = scope
            .thread_id()
            .map(|thread_id| memory_intent_for_execution(&self.state, Some(thread_id)))
            .unwrap_or(semantic_decision::MemoryIntent {
                use_current_thread: true,
                search_personal: true,
                search_project: true,
                vault_value_requested: false,
                standalone_choice_request: false,
                durable_memory_candidate: false,
            });
        let fingerprint = prompt_fingerprint(
            &serde_json::to_string(&memory_intent).unwrap_or_else(|_| "memory-intent".to_string()),
        );
        let injection_policy = memory_injection_policy(&memory_intent);
        let scope_key = format!("{}|{}", user.as_str(), workspace.as_str());
        for attempt in 0..=1 {
            let generation = memory_facade(&self.state).briefing_generation(&user, &workspace);
            let source_fingerprint = memory_briefing_source_fingerprint(
                &self.state,
                &user,
                &workspace,
                i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX),
            );
            if let Some(cached) = revalidated_cached_briefing(
                &self.state,
                &user,
                &workspace,
                &scope_key,
                generation,
                source_fingerprint,
                fingerprint,
                || {},
            ) {
                return BriefingPack {
                    profile_block: cached.profile_block,
                    objective: cached.objective,
                    brief: cached.brief,
                    recent_work,
                    linked_hits: cached.linked_hits,
                };
            }

            let (memory_personal, memory_project) =
                gather_profile_memory_for_intent_with_provenance(&self.state, &memory_intent);
            let memory_open_loops = if injection_policy.include_cross_thread {
                gather_open_loops(&self.state, 6)
            } else {
                Vec::new()
            };
            let formatted_profile = format_memory_block_with_provenance(
                &memory_open_loops,
                &memory_personal,
                &memory_project,
                CHAT_MEMORY_BUDGET_CHARS,
            );
            let profile_block = formatted_profile.block;
            let linked_hits = formatted_profile.linked_hits;
            let objective = project_objective_block(&self.state);
            let brief = project_brief_block(&self.state);
            let current_generation =
                memory_facade(&self.state).briefing_generation(&user, &workspace);
            let current_source_fingerprint = memory_briefing_source_fingerprint(
                &self.state,
                &user,
                &workspace,
                i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX),
            );
            if current_generation != generation || current_source_fingerprint != source_fingerprint
            {
                if attempt == 0 {
                    continue;
                }
                return BriefingPack {
                    profile_block: None,
                    objective,
                    brief,
                    recent_work,
                    linked_hits: Vec::new(),
                };
            }

            briefing_cache().put(
                scope_key.clone(),
                CachedBriefing {
                    generation,
                    source_fingerprint,
                    prompt_fingerprint: fingerprint,
                    pack_sans_recent_work: BriefingPack {
                        profile_block: profile_block.clone(),
                        objective: objective.clone(),
                        brief: brief.clone(),
                        recent_work: None,
                        linked_hits: linked_hits.clone(),
                    },
                },
            );
            return BriefingPack {
                profile_block,
                objective,
                brief,
                recent_work,
                linked_hits,
            };
        }
        unreachable!("bounded briefing rebuild loop always returns")
    }

    fn recall<'a>(
        &'a self,
        query: &'a str,
        scope: &'a MemoryScope,
    ) -> local_first_memory::BoxFuture<'a, RecallPack> {
        // ADR 0022 (Tappa 4): recall ora ORCHESTRATO nel crate via
        // `recall_on_facade`. Lo scope è argomento esplicito (isolation by
        // construction — chiude il debito Tappa 1). Il graph-context è iniettato
        // come callback dal gateway (pure-facade, sarà spostato in sub-tappa).
        let user = gateway_memory_user_id();
        // Lo scope del trait è autoritativo: lo usiamo, non più la globale.
        let workspace = scope.workspace_id();
        let embedding = self.embedding.clone();
        let state = self.state.clone();
        let scope_owned = scope.clone();
        Box::pin(async move {
            // Fase 1: embed OFF the lock (l'unico await prima del lock, come nel
            // path gateway originale — così il MutexGuard non attraversa un await).
            let query_vec = local_first_memory::embed_query(embedding.as_ref(), query).await;
            // Fase 2: lock + search sync. Il guard vive solo in questo scope sync.
            let block = {
                let facade = memory_facade(&state);
                // Graph-context callback: inietta workflow_status / artifact_provenance.
                // Le fn libere del gateway sono Sync; il closure è + Sync.
                let graph_context: Option<&local_first_memory::GraphContextHook<'_>> =
                    Some(&|facade, user, workspace, q| {
                        if let Some(workflow) =
                            workflow_status_context_for_query(facade, user, workspace, q)
                        {
                            return Some(workflow);
                        }
                        artifact_provenance_context_for_query(facade, user, workspace, q)
                    });
                recall_pack_on_facade(facade, &user, &workspace, query, &query_vec, graph_context)
            };
            let mut pack = block;
            pack.scope = scope_owned;
            pack
        })
    }

    fn learn<'a>(
        &'a self,
        exchange: &'a Exchange,
        scope: &'a MemoryScope,
    ) -> local_first_memory::BoxFuture<'a, ()> {
        // ADR 0022 (Tappa 4): learn ora ORCHESTRATO nel crate via
        // `learn_on_facade`. Lo scope è argomento esplicito (isolation by
        // construction). project_name + hooks (grafo/episode/backfill) sono
        // gateway-side e iniettati (saranno migrati in sub-tappa).
        let user = gateway_memory_user_id();
        let workspace = scope.workspace_id();
        let llm = self.llm.clone();
        let state = self.state.clone();
        let exchange = exchange.clone();
        Box::pin(async move {
            let active = workspace.clone();
            let project_name = if active.as_str() != PERSONAL_WORKSPACE {
                load_workspaces_file()
                    .workspaces
                    .into_iter()
                    .find(|w| w.id.as_str() == active.as_str())
                    .map(|w| w.name)
            } else {
                None
            };
            // Fase 1 (sync, lock): prepara il prompt (gating + known loops).
            let prompt = {
                let facade = memory_facade(&state);
                local_first_memory::prepare_learn_prompt(
                    facade,
                    &user,
                    &active,
                    &exchange,
                    project_name.as_deref(),
                )
            };
            let Some((system, user_content)) = prompt else {
                return;
            };
            // Fase 2 (off-lock): LLM estrattore via capability trait (no guard attiva).
            let Some(content) = llm.chat(&system, &user_content).await else {
                return;
            };
            // Fase 3 (sync, lock re-acquisito): parse + routing + persist + hooks.
            let facade = memory_facade(&state);
            let hooks = local_first_memory::LearnHooks {
                persist_graph: Some(
                    &|facade, user, workspace, entities, relations, project_ws| {
                        persist_graph(facade, user, workspace, entities, relations, project_ws);
                    },
                ),
                store_episode: Some(&|facade, user, thread_id, episode, active| {
                    store_episode(facade, user, thread_id, episode, active);
                }),
                backfill_embeddings: None, // backfill async: resta al tick periodico.
            };
            local_first_memory::persist_learn_extraction(
                facade, &user, &active, &content, &exchange, hooks,
            );
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_memory_recall_service_maps_recall_scope_from_workspace() {
        assert!(matches!(
            recall_scope_for_workspace(&MemoryWorkspaceId::new(PERSONAL_WORKSPACE)),
            MemoryScope::Personal
        ));

        match recall_scope_for_workspace(&MemoryWorkspaceId::new("project-a")) {
            MemoryScope::Project(workspace) => assert_eq!(workspace.as_str(), "project-a"),
            other => panic!("project workspace must map to MemoryScope::Project, got {other:?}"),
        }
    }
}
