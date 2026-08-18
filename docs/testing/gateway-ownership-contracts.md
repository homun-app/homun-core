# Gateway Ownership Contracts

Verificato 2026-08-04 sul branch `fabio/chat-lifecycle-consolidation`.

Questo documento fissa i confini eseguibili del gateway durante il taglio del
monolite. Il codice resta la verita': se una riga qui non e' coperta da un test
o da uno script di contract, va aggiornata prima di usarla come base.

## Gate obbligatori

Per ogni spostamento di ownership nel gateway:

```bash
cargo test -p local-first-desktop-gateway --test execution_ownership_inventory
python3 scripts/check_gateway_main_contract.py
python3 scripts/kernel_regression_gate.py
```

Se la modifica tocca il footer runtime, browser/activity, modello selezionato o
surface Electron:

```bash
cd apps/desktop && npm run test:ui-contract
HOMUN_RUN_KERNEL_LIVE_SMOKE=1 python3 scripts/kernel_regression_gate.py
```

## Owner estratti

| Owner | Responsabilita' |
| --- | --- |
| `crates/desktop-gateway/src/main.rs` | Composition root: costruzione `AppState`, ordine di startup, delega route/background, e codice condiviso non ancora estratto. Non deve riassorbire surface gia' estratte. |
| `crates/desktop-gateway/src/gateway_routes.rs` | Assemblaggio Axum: route protette, route pubbliche, WS, fallback statico e CORS. |
| `crates/desktop-gateway/src/gateway_boot_maintenance.rs` | Manutenzione sincrona di boot dopo apertura store e prima di recovery/worker. |
| `crates/desktop-gateway/src/gateway_turn_recovery.rs` | Recovery durable dei turni chat, projection startup, process generation e stato delivery iniziale. |
| `crates/desktop-gateway/src/gateway_background_startup.rs` | Servizi post-recovery: sweeper, VACUUM, worker, memory jobs, browser reaper, connector/proactivity. |
| `crates/desktop-gateway/src/gateway_turn_broker.rs` | Enqueue/resume/cancel dei turni chat, eventi, stream, activity projection e steering. |
| `crates/desktop-gateway/src/gateway_task_executor.rs` | DTO/read model queue task, status executor, approval/effect routes, acquire/lease/finalizzazione, worker, progress checkpoint e sync sessione task. |
| `crates/desktop-gateway/src/gateway_chat_threads.rs` | Lista e lifecycle thread chat: select, pin, rename, reorder, archive/delete, seen/attention. |
| `crates/desktop-gateway/src/gateway_chat_branches.rs` | Branch del transcript e active leaf selection. |
| `crates/desktop-gateway/src/gateway_chat_tasks.rs` | Azione transcript per creare task da messaggio. |
| `crates/desktop-gateway/src/gateway_chat_memory.rs` | Azione esplicita save-to-memory da messaggio e relativa proiezione wiki. |
| `crates/desktop-gateway/src/gateway_chat_streams.rs` | Trasporto stream chat e marker/eventi di output, senza ownership del broker. |
| `crates/desktop-gateway/src/gateway_chat_markers.rs` | Rimozione marker app-only prima della consegna plain text. |
| `crates/desktop-gateway/src/gateway_browser_tools.rs` | Schemi e parsing tool browser, `browser_done`, outcome hints e stale-ref recovery policy. |
| `crates/desktop-gateway/src/gateway_browser_runtime.rs` | Sidecar browser, checkpoint save/restore, sessioni warm, reaper e activity runtime. |
| `crates/desktop-gateway/src/gateway_capability_registry.rs` | Corpus discovery generico, materializzazione capability per turno, source labels/ranking, MCP/connector projection, search Composio e read model snapshot `/api/capabilities/snapshot`; non possiede routing semantico o dispatch tool. |
| `crates/desktop-gateway/src/gateway_capability_routing.rs` | Definizioni native workflow/atomic, registry semantico, decisione semantica turn/steering, binding deterministico plugin, forced tool e pruning tool per route; non possiede corpus discovery generico, dispatch tool o payload modello. |
| `crates/desktop-gateway/src/gateway_mcp_chat_tools.rs` | Naming/parse tool MCP chat e catalogo schema cached. |
| `crates/desktop-gateway/src/gateway_mcp_runtime.rs` | Transport MCP stdio/http, metadata connect/execution, secret header migration, discovery/cache e `run_mcp_chat_tool`. |
| `crates/desktop-gateway/src/gateway_mcp_connections.rs` | DTO/route MCP per connect, registry search, connected list e disconnect; non possiede execute. |
| `crates/desktop-gateway/src/gateway_mcp_execution.rs` | DTO/route MCP per execute da confirmation card, claim della source card, marker allow-server e resume/rewrite terminale; non possiede transport, timeout o parser conferma. |
| `crates/desktop-gateway/src/gateway_write_tool_allowlist.rs` | Persistenza e matching "always allow" per write-tool Composio/MCP, incluse route list/revoke; non possiede dispatch, approval routing o confirmation card. |
| `crates/desktop-gateway/src/gateway_thread_files.rs` | Cartella collegata per thread e route `@ file` search/read, con precedenza workspace attivo e anti path traversal; non possiede registry workspace o tool project write. |
| `crates/desktop-gateway/src/gateway_project_graph_routes.rs` | Fingerprint sorgenti, refresh Graphify, route `/api/memory/project-graph/*`, audit/repair integrity e backup; non possiede semantica storage del memory graph, facade memory o tool filesystem progetto. |
| `crates/desktop-gateway/src/gateway_transcription.rs` | Route chat transcription, validazione audio base64 e bridge contained-computer Whisper; non possiede browser, composer UI o model routing. |
| `crates/desktop-gateway/src/gateway_usage_routes.rs` | Route usage ledger, provider account snapshot, manual provider budget policy e model-usage suggestions; non possiede model registry, recorder o pricing store canonico. |
| `crates/desktop-gateway/src/gateway_tags.rs` | Route tag cross-project per project/thread, DTO CRUD/assignment e parse `TagEntity`; non possiede registry workspace, thread lifecycle o store schema. |
| `crates/desktop-gateway/src/gateway_update_routes.rs` | Route update/redeploy webhook e DTO di stato; non possiede startup, packaging o installer CI. |
| `crates/desktop-gateway/src/gateway_skill_routes.rs` | Route skills locali, enable/disable, catalogo ClawHub, preview/install e registry GitHub; non possiede seed default a boot, execution sandbox o skill scanner/catalog/security engine. |
| `crates/desktop-gateway/src/gateway_memory_publications.rs` | Route memory publication create/get/edit/approve/reject, DTO request, mapping errori facade e validazione scope owner; non possiede source grant management, semantica publication del `MemoryFacade` o registry workspace. |
| `crates/desktop-gateway/src/gateway_memory_sources.rs` | Route memory source grant list/upsert/revoke/candidates, DTO request/query, policy validation, grant/candidate projections e registry read di autorizzazione; non possiede persistenza workspace generale o storage semantics del `MemoryFacade`. |
| `crates/desktop-gateway/src/gateway_memory_bench.rs` | Adapter HTTP opt-in MemoryBench: DTO benchmark, materializzazione workspace benchmark, ingest governato, status e search; non possiede dashboard/export memory o registry workspace generale. |
| `crates/desktop-gateway/src/gateway_memory_ui_routes.rs` | Route read-only dashboard/export/items memory e full user-data export; non possiede MemoryBench, memory graph build/mutation o storage semantics del `MemoryFacade`. |
| `crates/desktop-gateway/src/gateway_memory_graph_routes.rs` | Route/proiezione `/api/memory/graph`, merge entity graph, import Graphify e scope resolver query/thread; non possiede maintenance/reconcile graph, persistence graph o helper relation condivisi. |
| `crates/desktop-gateway/src/gateway_memory_goals.rs` | Route `/api/memory/goals`, `/api/memory/project-briefing`, add/promote/suggest goals e DTO project context; non possiede rebuild wiki, turn-context prompt block o storage semantics del `MemoryFacade`. |
| `crates/desktop-gateway/src/gateway_memory_hygiene.rs` | Route `/api/memory/hygiene/suggestions`, payload suggerimenti merge person, normalizzazione entity-name e matching alias verificati; non possiede graph projection, graph persistence o source grants. |
| `crates/desktop-gateway/src/gateway_memory_wiki.rs` | Route `/api/memory/wiki` read/save, `/api/memory/consolidate`, registry edit manuali e rebuild pagine wiki derivate; non possiede graph projection, graph persistence o source grants. |
| `crates/desktop-gateway/src/gateway_memory_tools.rs` | Tool schema recall/decision/forget, registrazione decisioni, forget testuale/topic e route `/api/memory/decide` per confermare/rifiutare/cancellare/editare candidati; non possiede dashboard/export memory, graph projection o wiki rebuild non legati alle decisioni. |
| `crates/desktop-gateway/src/gateway_contacts.rs` | Route core rubrica `/api/memory/contacts*`, DTO `ContactView`, CRUD, merge, identity add/remove e helper memoria/handle/date condivisi; non possiede perimetri, relationship, fact profile o named profile CRUD. |
| `crates/desktop-gateway/src/gateway_contact_perimeter.rs` | Route `/api/memory/contacts/perimeter*`, DTO perimetro e normalizzazione fail-closed dello scope; non possiede CRUD contatti, profile o relationship. |
| `crates/desktop-gateway/src/gateway_contact_profile.rs` | Route `/api/memory/contacts/profile` e `/api/memory/contacts/profile/refresh`, distillazione LLM contact-profile e lettura fact dal graph; non possiede CRUD contatti, relationship o profili globali. |
| `crates/desktop-gateway/src/gateway_contact_relationships.rs` | Route `/api/memory/contacts/relationships*` e mirror/tombstone canonico nel memory graph; non possiede CRUD contatti, perimetri o contact profile. |
| `crates/desktop-gateway/src/gateway_contact_profiles.rs` | Route `/api/profiles*` e `/api/memory/contacts/assign-profile`, DTO named persona e binding contact/channel; non possiede CRUD contatti, perimetri, relationship o fact profile. |
| `crates/desktop-gateway/src/gateway_project_access.rs` | Grant di accesso progetto, persistenza `project-access`, route access/upsert/remove e resolver policy consumato da channels/automazioni; non possiede registry workspace, contact store o lifecycle channel. |
| `crates/desktop-gateway/src/gateway_workspaces.rs` | Registry `workspaces.json`, route CRUD/policy workspace, selezione workspace attivo a boot e purge retry-safe su delete; non possiede identity helpers, semantica store memory o manutenzione generica degli store. |
| `crates/desktop-gateway/src/gateway_model_routes.rs` | Surface HTTP runtime model/provider/roles (`/api/runtime/model*`, `/api/runtime/provider`, `/api/providers*`, `/api/model-profile`, `/api/roles`, `/api/routing-decisions`), DTO e proiezioni per Settings/composer; non possiede registry persistence, routing, payload provider o compaction. |
| `crates/desktop-gateway/src/gateway_model_routing.rs` | Risoluzione provider/modello, payload provider, compaction visibile al modello e policy reasoning. |
| `crates/desktop-gateway/src/gateway_tool_execution.rs` | Dispatch tool chat/browser, effect receipts e confini capability/computer/browse. |
| `crates/desktop-gateway/src/gateway_runtime_settings.rs` | DTO e route settings runtime persistiti. |
| `crates/desktop-gateway/src/gateway_user_preferences.rs` | Preferenze utente/setup: lingua, timezone, Ollama, approval routing. |
| `crates/desktop-gateway/src/gateway_process_events.rs` | Registri app event, WS process events e usage recorder. |

I moduli memory gia' estratti (`gateway_memory_*`, `gateway_recall_context.rs`,
`gateway_artifact_memory.rs`, `gateway_memory_tools.rs`) restano owner locali
delle singole funzioni di recall/learn/graph/wiki/tool, ma il flusso inline piu'
ampio di memoria non va ulteriormente tagliato senza una slice dedicata.

## Aree da non tagliare alla cieca

Queste aree sono ancora candidate a estrazione, ma richiedono un contratto
dedicato prima del movimento:

- loop agente e drain streaming: `run_agent_rounds`, `stream_chat_via_openai`,
  `run_agent_turn_into_message*`;
- memoria inline/brain/recall: `recall_memory`, `learn_via_service_or_inline`,
  `consolidate_scope`, `backfill_embeddings`;
- adapter concreti capability/MCP/Composio/vault/payment/browser;
- compatibilita' storica di messaggi/eventi persistiti.

## Checklist per una nuova estrazione

1. Scrivere prima un test RED in `crates/desktop-gateway/tests/execution_ownership_inventory.rs`.
2. Spostare solo l'owner scelto, lasciando `main.rs` come composition root.
3. Aggiornare `scripts/check_gateway_main_contract.py` con snippet vietati e assert positivi.
4. Aggiornare `apps/desktop/scripts/check-ui-contract.mjs` quando un contract UI cerca path sorgente specifici.
5. Eseguire il gate completo con `python3 scripts/kernel_regression_gate.py`.
6. Commit atomico con diff ristretto a owner, contract e documentazione.
