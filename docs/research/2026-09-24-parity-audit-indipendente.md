# Audit tecnico indipendente — parità funzionale Homun ↔ Hermes

Data: 2026-09-24.  
Auditor: audit indipendente sul codice e prove locali (non sulle dichiarazioni della matrice).  
Homun sotto esame: `main` @ `5be85c01bf5e5472252ebf7ac4ba8074fce172e7` (albero pulito all’avvio; in seguito solo artefatti di audit).  
Riferimento Hermes: commit pinato `c9dca726514b709cf6e677d236a79fc8d0627f37`, checkout verificato in `.audit-hermes-ref/` (symlink `/tmp/homun-hermes-reference-20260923`).  
Evidenze: `docs/research/evidence/2026-09-24-parity-audit/`.

Questo documento **non certifica** parità e **non autorizza** correzioni di prodotto. Classifica lo stato osservato.

---

## 1. Verdetto

**La parità funzionale completa Homun ↔ Hermes non è raggiunta.**

La matrice e `STATO.md` dichiarano molte righe `verified` (H03–H04, H13, H16, H23–H35, H37–H46). L’ispezione del codice e le prove negative mostrano che una fascia ampia di queste righe sono:

- **simulazioni esposte come motore** (successo, URL, token, capture, delivery senza effetto reale);
- **componenti isolati** (REST `/v1/*` + unit test, **assenti** dal registro strumenti del ciclo agente in `agent_tool_registry.py`);
- **stato volatile** presentato come durevole (dizionari di processo / cache modulo senza SQLite né ripresa dopo restart).

Esiste un **nucleo parziale reale** (loop nativo, controlli, terminal Docker/local/SSH opzionali, file workspace, MCP supervisionato, parte di memoria/skill/delegazione/clarify) documentato da rapporti Ollama/Docker del 23–24 settembre. Quel nucleo **non** equivale alla matrice H01–H46.

Il commit Homun sotto audit è **lo stesso** (`5be85c01`) citato nel brief come sede dei falsi successi H41/H16/H34: **quei difetti sono ancora presenti e riprodotti**.

---

## 2. Ambiente e metodo

| Voce | Valore |
| --- | --- |
| Branch / commit Homun | `main` / `5be85c01` |
| Worktree parallelo | `/Users/fabio/.codex/worktrees/hermes-owned-core/homun2` @ stesso commit |
| Hermes pin | `c9dca726…` — `COMMIT_MATCH=OK` |
| Python | `engine/.venv` 3.13.12; `PYTHONPATH=engine/src` |
| Ollama | raggiungibile (`HTTP 200`) |
| Docker | **down** in questa sessione → ri-prove terminali container **non** rieseguite |
| Credenziali HA/Discord/Spotify/FAL/X/… | assenti → path HTTP reali **non** esercitati end-to-end |

Metodo: lettura matrice e handoff → fotografie Git → confronto ancore Hermes (vision, computer_use permissions) → percorso ingresso Homun → effetto → prove negative → distinzione test che certificano il mock vs comportamento richiesto.

Copertura dichiarata: **ispezione sistematica** delle righe marcate `verified` e delle priorità A/B/C; **campione** delle `partial` con rapporti precedenti; **non** riesecuzione di tutte le fixture Ollama storiche né di ogni voce dei cataloghi di integrazione della matrice.

---

## 3. Legenda stati osservati

| Codice | Significato |
| --- | --- |
| `REAL_PARTIAL` | Logica reale o effetti reali su un sottoinsieme; gap rispetto all’accettazione Hermes |
| `ISOLATED` | Modulo/API presenti; non collegati (o solo opzionalmente) al ciclo agente/prodotto |
| `SIMULATED` | Successo / artefatti sintetici senza backend o OS / trasporto reale |
| `VOLATILE` | Comportamento coerente in-process; perso a nuova istanza / restart processo |
| `ABSENT` | Capacità nominata nella matrice non trovata come implementazione Homun |
| `UNVERIFIABLE` | Bloccato da ambiente (Docker/credenziali); codice ispezionato ma prova E2E non fatta |

Una riga può combinare etichette (es. `ISOLATED+SIMULATED`).

---

## 4. Tabella completa H01–H46

| ID | Dichiarato (matrice) | Osservato | Implementazione / collegamento prodotto | Prove eseguite | Limiti aperti |
| --- | --- | --- | --- | --- | --- |
| H01 | partial | `REAL_PARTIAL` | Loop nativo, cronologia, tool/result; registry per-run | Rapporti 23/09 + codice `agent_run*`; non rieseguito Ollama qui | Streaming/budget/usage completi; non “verified” |
| H02 | partial | `REAL_PARTIAL` | Steer/pause/cancel durevoli in controlli | Rapporto controls; I/O fisico cancel aperto | Cancel processo OS non certificato |
| H03 | verified | **`ISOLATED`** | `SideQuestionRunner` esiste; **nessun** import prodotto fuori dai test; solo tip `/btw` in `surface_tours_tips.py` | Unit con `mock_invoker` PASS | Non raggiungibile da chat/API agente |
| H04 | verified | **`ISOLATED` assembler / prodotto spezzato** | `PromptAssembler` + `@`-ref implementati; `agent_runs.py:183` chiama `initial_messages(obj, instr)` **senza** `cwd`/`workspace_root`/`expand_refs` → path default **non** carica AGENTS.md né espande `@` | Unit PASS; path prodotto ispezionato | Collegare `initial_messages(..., cwd=..., expand_refs=True)` al run |

| H05 | partial | `REAL_PARTIAL` | Checkpoint/pin; micro-compaction/cache aperti | Rapporto context | Caching/micro-compaction/memory flush |
| H06 | partial | `REAL_PARTIAL` | Retry tipizzati, overflow, liveness, continuation, repetition | Rapporti recovery/overflow/… | Credential refresh, fallback provider, streaming interrupt |
| H07 | partial | `REAL_PARTIAL` | Registry pin, search, spill/paging, bridge | Rapporti registry/bridge/results | Toolset/config parity ampia |
| H08 | partial | `REAL_PARTIAL` | Tool `clarify` in registry se policy | Codice + contratti | Delivery failure vs timeout su canali reali |
| H09 | partial | `REAL_PARTIAL` | Terminal Docker FG/BG, stdin, PTY query | Rapporti terminal; **Docker down** → non rieseguito | Timer indipendente Homun-off; full PTY screen |
| H10 | partial | `REAL_PARTIAL`+`ABSENT` | Docker + local + SSH opt-in; Modal/Singularity/Daytona/Vercel assenti | Codici backend; Docker down | Backend cloud assenti |
| H11 | partial | `REAL_PARTIAL` | List/read/search/write/patch/PDF/DOCX; no LSP/V4A | Rapporti workspace | LSP, V4A, altri extractors |
| H12 | partial | **`ISOLATED`** | `execution/checkpoint_manager.py` shadow git reale | Solo `test_checkpoints_and_worktrees.py`; **non** in `registry_for` / `agent_runs` | Esporre tool + wiring run |

| H13 | verified | `REAL_PARTIAL` | `execute_code` + RPC locale; in registry se policy | `test_code_execution.py` PASS | Non default su ogni run |
| H14 | partial | `REAL_PARTIAL` | Public extract + DDG HTML + provider/X a tratti | Rapporti web; credenziali provider non tutte | Catalogo plugin web Hermes incompleto |
| H15 | partial | `REAL_PARTIAL` | Browser headless owned; dialog accept/console/vision aperti | Rapporti browser | Accept dialog, console, vision, profilo utente |
| **H16** | **verified** | **`SIMULATED`+`ISOLATED`** | `ComputerUseDriver` / `DesktopUiManager`; REST `/v1/desktop`; **non** in `registry_for` | Prove A (sotto); unit+API PASS certificando il mock | Nessun OS/TCC reale; Hermes usa cua-driver |
| H17 | partial | `REAL_PARTIAL` | memory_recall/remember/session_search | Codice + policy registry | Background review / learning graph |
| H18 | partial | `REAL_PARTIAL` | DualWrite/Mem0 opzionale | Codice | Plugin memoria catalogo Hermes |
| H19 | partial | `REAL_PARTIAL` | skill_search/view + quarantine | Codice | Platform setup scripts |
| H20 | partial | `REAL_PARTIAL` | propose/lifecycle; hub sync aperto | Codice | Hub/bundles/curator |
| H21 | partial | `REAL_PARTIAL` | `delegate_task` isolato | Codice | Immagini forward / schema repair E2E |
| H22 | partial | `REAL_PARTIAL` | poll/cancel + stato in run record | Codice | At-least-once delivery completa |
| **H23** | **verified** | **`ISOLATED`+SQLite reale** | `KanbanStore` WAL; REST `/v1/kanban`; **non** in agent registry | Restart SQLite OK; API PASS (unrestricted) | Non nel ciclo agente; nessun worker reale Hermes-like |
| **H24** | **verified** | **`REAL_PARTIAL`+`ISOLATED`** | `MoACoordinator` con executor iniettati | `test_moa.py` PASS (executor mock) | Non dimostrato nel loop prodotto con provider reali |
| **H25** | **verified** | **`VOLATILE`** (tool opt-in) | `GoalManager` su `_GLOBAL_GOAL_CACHE`; in registry se policy | Clear cache → goal perso | Non durevole a restart processo |
| **H26** | **verified** | **`ISOLATED`+`VOLATILE`** | `HeartbeatManager` + `_HEARTBEAT_CACHE`; **non** in registry/`agent_runs` | Solo unit test | Nessun path prodotto |
| **H27** | **verified** | **`ISOLATED`+`VOLATILE`** | `LoopManager` + `_LOOP_CACHE`; **non** in registry/`agent_runs` | Solo unit test | Nessun path prodotto |
| **H28** | **verified** | **`VOLATILE`** | `CronManager` → `_STORE_JOBS` dict modulo; tool opt-in | Clear store → job perso | Non SQLite; non daemon scheduler |
| **H29** | **verified** | **`VOLATILE`+`ABSENT` Chronos** | Incident/delivery in-memory; **nessun** plugin Chronos sotto `engine/` | Come H28; grep Chronos vuoto | Chronos da implementare o dichiarare gap |
| **H30** | **verified** | **`REAL_PARTIAL`+default volatile** | `SessionManager` CRUD/fork/export; tool opt-in | Unit PASS | `get_default_storage()` → `SessionStorage(":memory:")` (`session_manager.py:39-42`) |
| **H31** | **verified** | **`REAL_PARTIAL`+default volatile** | Codice WAL+FTS+repair reale | Unit su file temp PASS | Default prodotto `:memory:` annulla “survive restart” |

| **H32** | **verified** | **`VOLATILE`+`ISOLATED`** | Pairing/leases/rooms in dict | Codice | Persiste solo in-process |
| **H33** | **verified** | **`SIMULATED` outbound** | Parse inbound OK; `ChannelAdapter.send` → `delivered: True` senza rete | Telegram/Discord/Slack send fake | Catalogo piattaforme Hermes non coperto; no token |
| **H34** | **verified** | **`VOLATILE`+`SIMULATED` transport+`ISOLATED`** | `SurfaceGatewayManager` dict; REST `/v1/surfaces`; enum SSH senza client | Prove C; refs solo manager+route | Steering non nel ciclo agente |
| **H35** | **verified** | **`REAL_PARTIAL` OpenAI / `SIMULATED` MCP hosted** | `/v1/chat/completions` → models port; `HostedMcpAgentServer.homun_task` restituisce `status: completed` **senza** eseguire un agent run | Unit + codice | Idempotenza in-memory; ACP senza route prodotto chiara; MCP hosted sintetico |

| H36 | partial | `REAL_PARTIAL` | MCP approved + receipts | Rapporti MCP | OAuth/mTLS/sampling/elicitation |
| **H37** | **verified** | **`REAL_PARTIAL`+in-memory ledger** | `PluginManager` | Codice/test dedicati | Lifecycle E2E install/uninstall completo |
| **H38** | **verified** | **`REAL_PARTIAL`** | Provider profiles + pool | Unit; API DB path | Non tutti i plugin provider Hermes |
| **H39** | **verified** | **`SIMULATED`+gap espliciti misti** | Copilot: se “available” risponde testo sintetico **senza** spawn; missing → errore OK | Prova H39 | Codex/Relay/gateway: gap reporting vs runtime |
| **H40** | **verified** | **misto** | Path/URL safety + Vault Fernet su disco **reali**; `WriteApprovalGate` **volatile** e non collegato al consenso prodotto | Vault methods; gate perso su nuova istanza | Gate ≠ terminal/workspace approval reale |
| **H41** | **verified** | **`SIMULATED`+`ISOLATED`** | Vision/Image/Video/STT/TTS/Voice; REST `/v1/media`; no backend passato dalle route; **non** in registry | Prove A | Hermes scarica/valida/LLM; Homun inventa |
| **H42** | **verified** | **`VOLATILE`+`ISOLATED`** | Extractor + `DeliverableLedger` in-memory | Nuova istanza perde receipt | Consegne workspace immutabili (altro path) ≠ H42 ledger |
| **H43** | **verified** | **misto `ISOLATED`** | HA/Discord/Spotify: client HTTP reali se token; Yuanbao/Meetings: **dati finti** / join simulato | Yuanbao member_count=42; Meet join success senza browser | Credenziali assenti; catalogo integrazioni incompleto |
| **H44** | **verified** | **`ISOLATED`+parziale** | Profile/doctor/daemon helpers + REST | Unit/API | Packaging/nix/daemon OS non certificati |
| **H45** | **verified** | **`SIMULATED` default** | `BatchEvalRunner._default_mock_executor` successo sintetico | Default executor success=True | Trajectory/OTEL: componenti, non eval reale |
| **H46** | **verified** | **`ISOLATED`+file pet** | Companion ha file state; achievements/tours/cleanup/security/catalog REST | Codice | Non UX prodotto; catalog packs ≠ skill hub Hermes |

---

## 5. Priorità A/B/C — risultati (gravità)

### P0 — Falsi successi esposti come motore (veridicità)

#### A. H41 Media — confermato sul codice attuale

| Problema | Dove | Impatto | Riproduzione |
| --- | --- | --- | --- |
| Immagine inesistente → successo + 42 token | `media_vision.py` L59–94 | Il modello/API crede all’analisi | `VisionAnalyzer().analyze_image("/nope.png")` → `error=None`, `tokens_used=42` (`h41_negative.json`) |
| Image/Video gen senza backend → URL interni | `media_image_gen.py` L90–98; `media_video_gen.py` L82–90 | Nessun media generato | `generate("a cat")` → `https://generated.images.internal/.../mock_img.png` |
| STT su WAV finto → testo sintetico | `media_stt.py` L74–80 | Trascrizione inventata | file `RIFFxxxx` → “Speech converted successfully.” |
| TTS → URL audio interno | `media_tts.py` L95–102 | Nessun audio | `https://audio.speech.internal/edge/speech.mp3` |
| Route senza `backend_dispatcher` | `media_api.py` L71–183 | API pubblica espone simulazione | `POST /v1/media/*` (test verde che **asserisce** URL `https://`) |
| Test certificano il mock | `test_h41_media.py` L36–40, L71–75, L201–216 | Regressione “verde” falsa | Suite unit PASS |

Confronto Hermes (`tools/vision_tools.py` al pin): download HTTP, validazione raster, chiamate LLM ausiliarie, errori su download/404 — **non** un fallback “successfully processed”.

#### B. H16 Computer use — confermato

| Problema | Dove | Impatto | Riproduzione |
| --- | --- | --- | --- |
| TCC `ready=True` hardcoded su Darwin | `computer_use_driver.py` L42–46 | Mentisce sui permessi | `get_status()` → accessibility/screen_recording True senza probe |
| App/finestre/PID predefiniti | L61–80 | Inventario falso | sempre Finder/Code/Terminal/Chrome |
| Capture 1×1 PNG, dichiara 1200×800 | L124–134 | Screenshot falso | `real_w=1,real_h=1` vs declared 1200×800 (`h16_h34_negative.json`) |
| Click/type `ok=True` senza OS | L152–171 | Azioni non avvenute | `perform_action("click"/"type")` ok |
| Preview elements hardcoded | `desktop_ui_manager.py` L200–208 | Drive preview finto | refs `btn-search` fissi |
| Non nel ciclo agente | `agent_tool_registry.py` | Isolato a REST | nessun tool desktop in registry default |

Hermes: `tools/computer_use/permissions.py` interroga `cua-driver` via subprocess JSON — Homun non lo fa.

#### C. H34 Surfaces — confermato

| Problema | Dove | Impatto | Riproduzione |
| --- | --- | --- | --- |
| Solo dict in memoria | `surface_gateway_manager.py` L31–36 | Perso a restart | nuova `SurfaceGatewayManager()` → 0 conn, snap=null |
| Transport `SSH`/`cloud` enum-only | `register_connection` | Nessun tunnel | `transport=ssh` registrato senza client |
| `drain_steering` non nel loop agente | refs solo manager+route | Steering inutile al modello | `h34_code_refs` |

### P0 — Altri falsi successi gravi trovati oltre al brief

| ID | Problema | File | Riproduzione |
| --- | --- | --- | --- |
| H33 | `send()` base restituisce sempre `delivered: True` | `channel_adapters.py` L41–60 | `TelegramAdapter().send("1","…")` senza token |
| H35 | `homun_task` / `homun_ask` / `homun_status` sintetici | `hosted_mcp_agent.py` L76–111 | `status: completed` / testo inventato senza run |
| H43 | Yuanbao inventa gruppo `member_count: 42` | `integration_yuanbao.py` L63–69 | `get_group_info("xyz")` |
| H43 | Meet “joined” + caption di sistema senza browser | `integration_meetings.py` L101–122 | `join_google_meet` |
| H39 | Copilot “available” → testo `[Copilot ACP]: Response to '…'` senza processo | `copilot_acp_client.py` L80 | `Fake.is_available=True; run_turn(...)` |
| H45 | Default eval executor sempre success | `batch_eval_runner.py` L59–70 | `BatchEvalRunner(dir).run_batch([...])` |
| H25 | Goal “persistenti” = cache modulo | `goal_manager.py` L36–50 | clear `_GLOBAL_GOAL_CACHE` |
| H28/H29 | Cron “durevole” = dict modulo | `cron_manager.py` L206–216 | clear `_STORE_JOBS` |
| H42 | Ledger consegne non sopravvive a nuova istanza | `deliverable_ledger.py` L35–39 | due istanze |
| H40 | WriteApprovalGate volatile (Vault invece sì) | `write_approval_gate.py` L55 | nuova istanza perde record |
| H04 | Path agente default bypassa PromptAssembler/@refs | `agent_runs.py:183` + `native_prompt.py:26-50` | `initial_messages` senza cwd/expand_refs |
| H03 | `/btw` solo tip + classe di test | `side_question.py`; nessun route | nessun call site prodotto |


### P1 — Componenti reali o semi-reali non integrati nel prodotto/agente

Non compaiono in `registry_for` (salvo policy esplicite sul run): desktop/media/surfaces/kanban/integrations/research/catalog.  
Collegati solo come router FastAPI in `app.py`.

SQLite reale ma isolato: **H23 Kanban**.  
Logica MoA/Session reale ma dipendenza da executor/storage wiring: **H24, H30–H31**.

### P2 — Capacità assenti o cataloghi non coperti

H10: Modal, Singularity, Daytona, Vercel.  
Inventari matrice (dozzine di messaging/model/web/browser/memory/image/video plugins): **non** implementati come catalogo Homun equivalente; non trattare l’assenza di credenziali come prova di assenza di codice, ma l’assenza di moduli adapter omonimi è osservabile.

### P3 — Ambiente

Docker down → non rieseguite fixture terminal/file Ollama+Docker di `docs/research/evidence/2026-09-23-hermes-parity/`.  
Ollama up → disponibile per future prove, non usata per certificare le righe simulate.

---

## 6. Falsi successi e simulazioni esposte come motore

Elenco operativo (non esaustivo di ogni stringa):

1. Vision: descrizione sintetica + 42 token su input inesistente.  
2. Image/Video generation: URL `*.internal` + `metadata.synthesized` / `simulated`.  
3. STT/TTS: testo/URL sintetici dopo check estensione.  
4. Computer use: permessi, finestre, PNG, click/type.  
5. Desktop preview: element list fissa.  
6. Channel outbound: `delivered: True` senza trasporto.  
7. Yuanbao group/members/stickers di default.  
8. Google Meet join + caption inventate.  
9. Copilot ACP risposta sintetica se non `simulated_response` e binary “presente”.  
10. Batch eval default mock.  
11. Surface transport kinds senza implementazione.  
12. Test `test_h41_media` / `test_h16_desktop` / `test_h34_surfaces` che **asseverano** i comportamenti sopra.

---

## 7. Componenti implementati ma non integrati

| Area | Superficie attuale | Mancanza |
| --- | --- | --- |
| H16 Desktop | `/v1/desktop` | Tool nativi agente + bridge OS |
| H34 Surfaces | `/v1/surfaces` | Persistenza, transport reali, drain → agent turn |
| H41 Media | `/v1/media` | Backend vision/gen/STT/TTS + tool agente |
| H23 Kanban | `/v1/kanban` + SQLite | Worker/agent claim loop, UI prodotto |
| H42–H46 | REST catalog/research/ops | Percorsi chat/lavoro canonici |
| H43 | `/v1/integrations` | Credenziali + wiring agent; Yuanbao/Meet da riscrivere |
| H25–H29 | Tool opzionali se policy run | Persistenza su storage Homun, scheduler processo |

Registro default senza policy: solo `list_materials`, `read_material`, `search_materials` (`classification_probes.json`).

---

## 8. Esito test (distinzione)

| Suite | Comando | Esito | Nota |
| --- | --- | --- | --- |
| Unit H41/H16/H34 (no create_app) | `pytest …::test_vision_analysis …::test_computer_use_driver …::test_surface_gateway_manager` | **3 passed** | Certificano simulazione |
| API H16/H23/H34/H41 | stessi file `*_api*` / `*_fastapi*` con permessi full | **4 passed** | DB path ok fuori sandbox; ancora mock |
| Sample core (code exec, prompt/sideQ, sessions, cron, moa, heartbeat, loop) | `pytest test_code_execution … test_loop_manager` | **61 passed** | Unit / in-memory dove applicabile |
| H-suite create_app in sandbox | molte API | fail `sqlite3.OperationalError` | Limite ambiente sandbox, non prova di parità |
| Fixture Docker/Ollama storiche | — | **non rieseguite** | Docker down |

**Test verdi ≠ parità.** Diversi test verdi dimostrano esplicitamente il comportamento fittizio richiesto dal brief.

Prove locali riproduzioni (non pytest):  
`h41_negative.json`, `h16_h34_negative.json`, `classification_probes.json`, `more_false_success.json`, `environment.json`.

---

## 9. Piano di correzione ordinato

### 9.1 Veridicità e sicurezza (prima)

1. **H41**: rifiutare input inesistenti/malformati; senza backend configurato → errore tipizzato `unavailable`, mai URL/token inventati; route devono richiedere provider o fallire chiuso.  
2. **H16**: `ready` solo dopo probe reali (o `ready=false` + `installed=false`); nessun click/type/capture success senza driver OS; non pubblicare tool finché non c’è backend.  
3. **H33**: `send` senza transport/token → errore, non `delivered: True`.  
4. **H43 Yuanbao/Meetings**: rimuovere successi sintetici; Meet senza browser → unavailable.  
5. **H39 Copilot**: se binary assente → unavailable; se presente → spawn reale o errore, mai stringa finta.  
6. **H45**: nessun default mock success in path prodotto; richiedere executor reale.  
7. Allineare/eliminare test che certificano i mock come successo di prodotto; aggiungere regressioni negative.

### 9.2 Integrazione e persistenza

1. **H34 / H32 / H25 / H28–H29 / H42 ledger / WriteApprovalGate**: persistenza su storage Homun (SQLite/file) con restart/profile isolation; collegare steering/approvals al ciclo `agent_run`.  
2. Collegare capacità mature al `registry_for` solo con policy/version pin e ricevute.  
3. Kanban/MoA: worker e executor reali sul lavoro canonico, non solo REST.

### 9.3 Capacità mancanti

1. Backend H10 cloud; MCP OAuth/mTLS/sampling; LSP/V4A; cataloghi plugin Hermes (messaggistica, image/video providers, Chronos, …) come adapter Homun-owned.  
2. Timer terminale indipendente a motore spento; PTY full screen.

### 9.4 Verifiche ambientali

1. Ripetere fixture `tools/verification/*` con Docker up + Ollama.  
2. Prove reverse: credenziali mancanti, timeout, revoke, restart mid-flight, profilo cross.  
3. Solo dopo veridicità: aggiornare matrice (declassare `verified` spurî).

---

## 10. Criteri di chiusura per lacuna (esempi concreti)

Una lacuna è **chiusa** solo se valgono **tutti**:

1. Comportamento confrontato con sorgente Hermes al pin (o gap esplicito documentato).  
2. Percorso prodotto o tool agente raggiungibile (non solo classe + REST di demo).  
3. Prova positiva con effetto osservabile (file, processo, HTTP provider, OS).  
4. Prova negativa: input assente / backend off / auth denied → **errore tipizzato**, zero side-effect, niente successo simulato.  
5. Restart (nuova istanza processo o nuovo `*Manager()` + storage) conserva o riconcilia lo stato dichiarato durevole.  
6. Test aggiornati: non accettano URL interni / token fissi / `delivered: True` senza trasporto.  
7. Matrice aggiornata con evidenza datata; `verified` solo con i punti 1–6.

Esempi specifici:

- **H41 vision**: file mancante → HTTP 4xx/errore dominio; PNG reale + modello vision (o unavailable se non configurato); zero `tokens_used=42` di default.  
- **H16 capture**: dimensioni PNG IHDR == width/height dichiarati; click su fixture OS cambia stato osservabile.  
- **H34**: dopo kill processo API, session/approvals/steering ripristinati da DB; `drain_steering` consumato nel turn agente.  
- **H33 send**: senza token → errore; con token di test → messaggio visibile sul canale di prova.  
- **H25/H28**: dopo restart processo, goal/job ancora presenti.

---

## 11. Checklist per continuare l’audit (non coperto a fondo qui)

- [ ] Rieseguire tutte le fixture in `docs/research/evidence/2026-09-23-hermes-parity/*.json` con Docker up.  
- [ ] Tracciare path completi chat → modello → tool → consenso → receipt per H08/H12/H17–H22 con Ollama.  
- [ ] Audit riga-per-riga inventari integrazione (model-providers, messaging pages, web/browser/memory/image/video plugins).  
- [ ] Verificare Heartbeat/Loop persistenza file vs solo RAM (sospetto analogo a H25).  
- [ ] ACP/Hosted MCP / OpenAI streaming E2E con client esterni.  
- [ ] Plugin enable/disable senza stale capabilities su disco reale.  
- [ ] Credential pool failover su provider reali (H38).  
- [ ] UI Electron: emitter desktop reale vs `DesktopUiManager` mock.  
- [ ] Confrontare hash manifest Hermes `00f3300b…` con checkout `.audit-hermes-ref`.  
- [ ] Declassare formalmente gli stati `verified` spurî nella matrice dopo conferma prodotto.

---

## 12. Riferimenti evidenza

- `docs/research/evidence/2026-09-24-parity-audit/environment.json`  
- `…/h41_negative.json`  
- `…/h16_h34_negative.json`  
- `…/classification_probes.json`  
- `…/more_false_success.json`  
- `…/core_unit_sample.txt` (61 passed)  
- `…/api_tests_unrestricted.txt` (4 passed API mock)  
- Hermes pin: `.audit-hermes-ref` @ `c9dca726…` (gitignored)

---

## 13. Addendum — follow-up ispezioni parallele (stesso commit)

Due esplorazioni indipendenti ([Scan H23-H46](dd310a6e-a891-4c64-a8f9-069d6a39003f), [Audit verified rows](f7c084b8-8497-4f05-bbe9-dee26a22f6fc)) sono state **ricontrollate sul sorgente** e integrate sopra. Correzioni rispetto alla prima stesura della tabella:

| Tema | Prima stesura | Dopo verifica |
| --- | --- | --- |
| H03 | possibile REAL_PARTIAL | **ISOLATED** — `SideQuestionRunner` solo nei test |
| H04 | REAL_PARTIAL “verified wiring” | Assembler reale ma **non usato** dal create-run default |
| H12 | REAL_PARTIAL | **ISOLATED** — non in registry |
| H26/H27 | VOLATILE sospetto | **ISOLATED+VOLATILE** — cache modulo e fuori `agent_runs` |
| H30/H31 | REAL_PARTIAL | Codice SQLite reale; **default `:memory:`** spezza restart |
| H35 | REAL_PARTIAL generico | OpenAI parziale; **MCP hosted sintetico** |
| H29 Chronos | “assente” generico | **Confermato assente** nel tree `engine/` |

Divergenza tra le due esplorazioni su H04 (`REAL_WIRED` vs path spezzato): prevale il path prodotto `agent_runs.py:183` → `initial_messages` senza `cwd`/`expand_refs` (`native_prompt.py` entra in PromptAssembler solo se quei kwargs sono valorizzati).

---

**Conclusione operativa:** trattare le righe H03, H04 (path prodotto), H12, H16, H25–H29, H33 (outbound), H34, H35 (MCP hosted), H39, H41, H42 ledger, H43 (Yuanbao/Meet), H45 default, e H30/H31 col default `:memory:`, come **non paritarie / fuorvianti** finché non passano i criteri della §10. Il nucleo H01–H11/H36 parziale (con terminal/file/MCP dove già evidenziato storicamente) resta il terreno credibile; la matrice attuale **sovra-dichiara** lo stato `verified`.
