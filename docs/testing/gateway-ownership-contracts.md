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
| `crates/desktop-gateway/src/gateway_task_executor.rs` | Queue task, approval routes, acquire/lease/finalizzazione, worker, progress checkpoint e sync sessione task. |
| `crates/desktop-gateway/src/gateway_chat_threads.rs` | Lista e lifecycle thread chat: select, pin, rename, reorder, archive/delete, seen/attention. |
| `crates/desktop-gateway/src/gateway_chat_branches.rs` | Branch del transcript e active leaf selection. |
| `crates/desktop-gateway/src/gateway_chat_tasks.rs` | Azione transcript per creare task da messaggio. |
| `crates/desktop-gateway/src/gateway_chat_memory.rs` | Azione esplicita save-to-memory da messaggio e relativa proiezione wiki. |
| `crates/desktop-gateway/src/gateway_chat_streams.rs` | Trasporto stream chat e marker/eventi di output, senza ownership del broker. |
| `crates/desktop-gateway/src/gateway_chat_markers.rs` | Rimozione marker app-only prima della consegna plain text. |
| `crates/desktop-gateway/src/gateway_browser_tools.rs` | Schemi e parsing tool browser, `browser_done`, outcome hints e stale-ref recovery policy. |
| `crates/desktop-gateway/src/gateway_browser_runtime.rs` | Sidecar browser, checkpoint save/restore, sessioni warm, reaper e activity runtime. |
| `crates/desktop-gateway/src/gateway_mcp_chat_tools.rs` | Naming/parse tool MCP chat e catalogo schema cached. |
| `crates/desktop-gateway/src/gateway_mcp_runtime.rs` | Transport MCP stdio/http, metadata connect/execution, secret header migration, discovery/cache e `run_mcp_chat_tool`. |
| `crates/desktop-gateway/src/gateway_mcp_connections.rs` | DTO/route MCP per connect, registry search, connected list e disconnect; non possiede execute. |
| `crates/desktop-gateway/src/gateway_mcp_execution.rs` | DTO/route MCP per execute da confirmation card, claim della source card, marker allow-server e resume/rewrite terminale; non possiede transport, timeout o parser conferma. |
| `crates/desktop-gateway/src/gateway_write_tool_allowlist.rs` | Persistenza e matching "always allow" per write-tool Composio/MCP, incluse route list/revoke; non possiede dispatch, approval routing o confirmation card. |
| `crates/desktop-gateway/src/gateway_thread_files.rs` | Cartella collegata per thread e route `@ file` search/read, con precedenza workspace attivo e anti path traversal; non possiede registry workspace o tool project write. |
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
