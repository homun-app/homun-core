# Parity reale Hermes vs Homun — 30 settembre 2026

Test differenziale black-box: stessi modelli (qwen3.5:4b via Ollama locale su 127.0.0.1:11434),
stessi prompt/task. Nessuna chiave API esterna. Hermes = commit pinned c9dca726 (.audit-hermes-ref, venv .venv).
Homun = working tree homun2 @ 131ffe05, motore `python -m homun serve --dev-insecure` su 127.0.0.1:8765.

## Ambiente
- Hermes provider: custom → http://127.0.0.1:11434/v1, model qwen3.5:4b (config:`~/.hermes/config.yaml`, backup `config.yaml.pre-parity-test`)
- Homun active connection: openai_compatible → http://127.0.0.1:11434/v1, qwen3.5:4b
- Docker attivo; immagine terminale Homun: alpine sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

## Risultati

| # | Capability | Hermes | Homun | Note |
|---|---|---|---|---|
| T1 | Core chat loop | PASS ("OK") | PASS (5s, "OK, sono Homun…") | Homun passa dall'interprete (kind=reply) |
| T2 | Agente crea file | PASS (file tool, host, /tmp/parity_hermes/parity_test.txt) | PASS (write_workspace_file + approvazione digest, workspace in data-dir) | Homun: immagine Docker pinned obbligatoria; run propose→approve + file-edit approve |
| T3 | Memoria cross-session | PASS ("Teal" in sessione nuova) | PASS solo con run `memory:true` (memory_recall trova il fatto); **il path conversazionale (post_message) NON inietta memoria** ("Non ho accesso ai tuoi dati personali") | Homun: capability opt-in per run; API memories CRUD+recall OK |
| T4 | Cron/scheduling + fire reale | PASS (job 5m, fired 08:23:52, cron_ok.txt scritto) — richiede gateway attivo | PASS (routine */5, fired 08:25, work "Routine parity" → ready) — schedule DBOS in-process | Entrambi durabili; architetture diverse |
| T5 | Skill catalogo | 57 skill builtin | 2 skill di workspace (agent/person), nessun catalogo builtin | Gap grande di catalogo, non di motore |
| T6 | Terminale | PASS (esecuzione su HOST, auto-approve in -z) | PASS (terminal_execute in container Docker pinned, exit 0) | Filosofie opposte: host+fiducia vs container+digest |
| T7 | API OpenAI-compat | PASS (:8642, bearer API_SERVER_KEY obbligatorio anche in loopback, model "hermes-agent") | PASS (:8765/v1/chat/completions, "API-OK") | Hermes: agent-backed; Homun: endpoint diretto |
| T8 | Canali | gateway con piattaforme configurabili (telegram/whatsapp/slack/...), WhatsApp via `hermes whatsapp` (QR interattivo, non testato) | 33 adattatori registrati (tutti disabled); onboarding WhatsApp API presente ma sidecar `wa-rs-bridge` (:8902) assente → errore tipizzato `bridge_unreachable` | Nessuno dei due testato end-to-end su canale reale |

## Differenze progettuali emerse
1. **Sicurezza di esecuzione**: Hermes esegue sull'host e chiede approvazioni interattive (auto in one-shot); Homun richiede immagine Docker pinned by digest + approvazioni digest esplicite (run, terminal job, file edit) via API.
2. **Capability model**: Hermes = tutto attivo di default (config globale); Homun = capability opt-in per singolo run (memory/skills/delegation/... default false).
3. **Memoria conversazionale**: Hermes inietta memoria in ogni sessione; Homun la espone solo come tool negli agent run — il semplice post_message non la usa (gap funzionale reale).
4. **Cron**: Hermes necessita del processo gateway; Homun ha lo scheduler DBOS dentro il motore.
5. **Skill**: Hermes porta un catalogo di 57 skill; Homun non ha catalogo iniziale.

## Non testati in questa passata
delegation/subagent (H21), steering/interrupt (H02), side questions (H03), compressione contesto (H05),
web/browser tools (H14/H15, richiedono rete), checkpoint/rollback (H12), MCP, plugins, media/voice (H41),
canali reali end-to-end (T8 approfondito), batch/evals (H45).

## Suite interna Homun (contesto)
`npm run engine:test`: **1843 passed, 1 failed, 9 skipped** (228s). L'unico fallimento era una
regressione reale trovata dai test: `NameError: asyncio` in `src/homun/models/native_errors.py:207`
(classify_transport) — import mancante. Corretto in sessione (aggiunto `import asyncio`);
`tests/test_native_stream_transport.py` ora 23/23 verdi.

## Auto-approve (implementato in sessione, 30/09)
Supervision levels: `AgentProfile.autonomy_mode` (supervised|autonomous) esisteva già ma non era consumato.

Implementato:
- `engine/src/homun/application/approval_auto.py` — policy sweep: run `pending_approval` di agenti
  `autonomous` auto-approvati via il percorso canonico `agent_runs.approve` (digest+authority+journal);
  gate terminali in-run auto-approvati SOLO con policy `docker-offline-v1` (l'host `local-private-v1`
  mantiene sempre il gate umano); file-edit idem. Ogni decisione marcata `_approval_channel`.
- Hook nel delivery sweep (`runtime/workflows/agent_run.py::deliver_agent_runs`) con logging invece di silenzio.
- Cron: `CronJob.auto_approve` (contratto+manager+tools) → `CronAgentRunner` auto-approva la proposta
  staging (`policy:cron-auto-approve`); occurrence → `running` invece che `awaiting_approval`.
- Test: `engine/tests/test_approval_auto.py` (6 test, incluso regression sul hook dello sweep).
- Verifica live: agente "Vega" (autonomous) su motore in esecuzione → run `auto-run-1`
  approvato automaticamente dal pump (0.5s) e passato a `running` senza interazione umana.

## Memoria scoped + apprendimento (implementato e verificato live, 30/09 pomeriggio)

**Scope memoria** (`memory/types.py`, `memory/visibility.py`, entrambi i port):
- `MemoryNote.scope` ∈ {project, agent, person, global} + `subject_id` + `source_memory_id`;
  migrazione automatica dei payload legacy (project_id → project, altrimenti global).
- Composizione recall nei run: progetto del work + note work-bound + **craft dell'agente assegnato**.
  Le globali NON filtrano più nei run (leak cross-progetto chiuso); le note legacy work-bound
  restano visibili al proprio work.
- Scritture agente: sempre scope=project (mai global; work senza progetto → nota legata al work).
- `POST /memories/{id}/promote` (umano): promuove una lezione di progetto nella craft di un agente,
  con provenienza, dedup e guardia anti-leak (rifiuta testi che citano id proj_/mat_/work_…).
- Pack dossier: `GET /memories/packs/{agent}` (identità + craft + skill approvate dell'agente;
  **mai** memorie di progetto) e `POST /memories/packs/import` (skill importate in quarantena).

**Apprendimento** (`application/skill_reflection.py`, derivato da Hermes MIT):
- reflection post-run sui run completati con capability skills: prompt anti-degrado
  (lezione=regola+perché, niente narrazioni/id, stessa lezione=una regola, patch in posto),
  può solo patchare skill agent-authored o proporre nuove — tutto staged.
- Marker `skill.reflection` giornalato per run → idempotenza sweep.
- Tool in-run `skill_patch` (solo skill agent-authored; patch di approved → torna staged).
- Usage tracking: `usage_count`/`last_used_at` su `skill_view`.
- Fix bug reale trovato dal live test: validazione descrizione skill 60 vs 120 incoerenti
  (il modello finiva in retry-loop) → allineato a 120 + troncamento tollerante nel tool.

**Test**: +15 nuovi (test_memory_scoping.py, test_skill_reflection.py); suite 1859 passed / 0 failed.

**Verifica live** (`tools/parity/live_acceptance.py`, modello reale qwen3.5:4b):
- isolamento: agente Menta su progetto Beta vede la craft promossa da Alpha, NON vede la nota
  globale né le memorie di altri progetti (craft_visible=true, global_leak=false);
- apprendimento end-to-end: correzione del supervisore → skill "Price List Formatting Rule"
  proposta in-run (staged) → approvata dall'umano → **la reflection post-run l'ha raffinata**
  (revision +1, di nuovo staged) → dossier pack esportato con craft.

## Curatore + delivery cron (implementato e verificato live, 30/09 sera)

**Curatore** (`application/skill_curator.py`, derivato da Hermes curator MIT):
- pass di manutenzione interval-gated (24h, stato in data-dir) nel pump;
- archivia (mai cancella) skill agent-authored staged stantie (>7gg) e approved mai usate (>30gg);
  le skill delle persone sono intoccabili; tutto via comandi skill.archive giornalati e reversibili;
- rotta `POST /v1/workspaces/{ws}/skills/curate` (forzatura, solo persone).

**Delivery cron → canali** (`application/cron_deliveries.py`):
- consumo della coda cron_deliveries: target `chat` (messaggio engine nella conversazione di origine)
  e `<platform>:<chat>` (via adapter + send_with_media_dispatch); retry fino a 3 con errori tipizzati
  (channel_unconfigured / channel_unsupported / delivery_transport_failed…);
- pass nel pump; rotte `GET /v1/cron/deliveries`, `POST /v1/cron/deliveries/dispatch`;
- **nuova rotta `POST /v1/cron/jobs`**: creazione job da persona (parity con `hermes cron create`) —
  prima i job si creavano solo via tool agente.

**Bug trovati e corretti dai test live** (nessuno era regressione delle feature nuove):
1. pump rotto da shadowing di `deliver_pending` (import locale) — UnboundLocalError ad ogni pass;
   run in coda mai partiti. Fix: alias dell'import.
2. `list_workspace_files` con `path:"."` (comportamento variabile del modello) rifiutato come
   traversal → PermissionDenied → run bloccato. Fix: normalizzazione di "." e "./" a radice.
3. Osservabilità: i fallimenti resume/advance erano silenziosi → logging permanente dei DomainError.

**Verifica live** (`tools/parity/homun_battery2.py`): T1 OK (9,7s); T2 agente autonomo completato
in 27,5s con scrittura file e **zero approvazioni manuali** (auto-approve run+edit); curatore live
(0 archiviati: nessuna skill stantia per età); cron job creato via API con auto_approve → fired →
delivery `sent` → messaggio recapitato nella conversazione target.

**Suite finale: 1863 passed / 9 skipped / 0 failed.**

## Batteria parity Hermes rifatta (30/09 sera, stesso modello qwen3.5:4b via Ollama)
- Hermes: T1 OK · T2 file OK · T6 terminale OK · T3 memoria "Teal" OK (identico al mattino).
- Homun: vedi battery sopra — con il pomeriggio di lavoro: run autonomi senza click,
  memoria scoped con isolamento cross-progetto verificato, apprendimento con gate umano,
  cron con delivery, curatore.

## Catalogo builtin + default out-of-the-box (implementato e verificato live, 30/09 notte)

Il gap del mattino: Hermes partiva con 57 skill builtin e tutti i toolset attivi; Homun con 0 skill
e capability opt-in per run. Tre chiusure:

1. **Catalogo builtin** (`application/builtin_skills.py` generato dal ref Hermes MIT c9dca726,
   sottoinsieme aziendale curato di 19 skill: docx/xlsx/pdf/powerpoint, meeting-action-items,
   weekly-review-planning, product-price-monitor, grounded-citations, competitor-news-monitor,
   6 skill software-development, design-md/architecture-diagram/humanizer, blocked-page-recovery).
   Seeding idempotente all'avvio (`application/skill_seeding.py` + rotta `POST /skills/seed`):
   una skill esistente (qualsiasi stato, anche archiviata dall'utente) non viene MAI più toccata.
   Le builtin sono person-authored/approved con `author_id=homun:builtin` → il curatore le ignora.
2. **Capability di conoscenza ON di default**: `memory` e `skills` si attivano da soli quando la
   connessione supporta i tool nativi (RunRequest: `bool | None`, None = "non specificato");
   opt-out esplicito vince sempre; sulle connessioni non-native restano off (gate invariato).
3. **Allowlist tool per agente**: `project.agent_tool_overrides` (già modellato, mai consumato)
   ora arriva al run come `allowed_tools` dell'assignee.

**Live**: workspace con 22 skill (19 builtin + esistenti); run proposto via HTTP SENZA flag →
memory+skills attivi con memory_recall/skill_search/memory_remember nei tool; con opt-out → off.
**Suite: 1866 passed / 0 failed** (helper di test scripted resi espliciti memory/skills:False;
un test dict-esatto reso a membership per l'arrivo del catalogo).

**Aggiornamento (decisione di prodotto): catalogo COMPLETO.** La prima versione portava solo il
sottoinsieme aziendale (19); su decisione del proprietario il catalogo include ora **tutte le 58
skill** del ref Hermes ("ognuno può usarlo come vuole sul suo pc"): anche apple/*, media, social,
devops. Homun cura la disponibilità (surface policy, allowlist per agente), mai il contenuto.
Il seeding riallinea SOLO i tag delle builtin mai toccate (body identico, revision 1, approved);
ogni modifica umana resta intoccabile. API skills ora espone `author_id` (badge "builtin" in UI).
Live: 61 skill nel workspace (58 builtin + 3 preesistenti), tag normalizzati.

## Repo catalogo skill dedicato + sync dal repo (30/09 notte, dopo la decisione "portiamole tutte")

Upstream confermato: **github.com/NousResearch/hermes-agent** (remote del ref pinato), skill in `skills/`.

- **`~/Projects/Homun/homun-skills`**: repository dedicato, port completo 1:1 (58 skill,
  layout originale `<categoria>/<nome>/SKILL.md` + references/scripts/templates, 321 file),
  `manifest.json` con versione catalogo + repo/commit upstream, LICENSE/NOTICE MIT.
  Commit locale `0b28cb5` (non ancora spinto su GitHub).
- **Engine**: `application/skill_catalog_sync.py` — sync da un checkout del repo
  (`POST /v1/workspaces/{ws}/skills/sync {"path": ...}`; bootstrap via env
  `HOMUN_SKILL_CATALOG_DIR` altrimenti seeding embedded). Regole: nuova → seeded approved
  (`homun:builtin`); builtin intatta dall'ultimo sync (hash body nello stato) → aggiornata;
  **modificata da umani → mai toccata** (`kept_human`). Support file → `resources`
  (cap 64KB/file, 24 file/skill, solo testo; binari/overflow segnalati nel report).
- Lo snapshot embedded (`builtin_skills.py`) resta come fallback primo avvio; il repo è la
  fonte di verità per gli aggiornamenti (flusso: aggiornare ref → re-port → sync).
- Live: sync 58/58 aggiornate con resources (pdf 20 file, github 16), `kept_human` 0; il gap
  dei support file (26 skill li citavano a vuoto) è chiuso: 24 skill ora li espongono.
- API `/skills` ora espone `resources` (lista file) oltre ad `author_id`.
**Suite: 1868 passed / 0 failed.**

## Adattamento vocabolario Hermes→Homun (catalogo v2, 30/07 notte-fonda)

Le skill portate verbatim parlavano ancora Hermes (write_file ×29, read_file ×25, browser_navigate,
~/.hermes ×30+, CLI `hermes …`). Chiuse con:

- **Generatore permanente** `tools/parity/regen_homun_skills.py`: port + **traduzione** dei body
  (TOOL_MAP/PATH_MAP/CLI_MAP), nota di adattamento con provenienza in testa a ogni body,
  5 skill hermes-agent-only (`hermes-agent`, `computer-use`, `dogfood`,
  `hermes-agent-skill-authoring`, `inspecting-hermes-desktop-dom`) mantenute verbatim nel repo
  ma flaggate `hermes_only` nel manifest. Rigenera anche l'embedded `builtin_skills.py` (53 skill).
- **Sync v2**: skip delle hermes-only; igiene del catalogo (builtin pristine non più presenti →
  archiviate); opzione `rebase` — il drift solo-macchina (journal: tutti i comandi con prefisso
  catalog-sync:/builtin-skill:/curate:) può essere ribasato, **le modifiche umane mai**.
- Verifiche: 0 riferimenti operativi residui nei body adattati (grep su repo e su workspace live);
  live sync finale: 58 viste, 5 hermes-only saltate, 2 ribasate+aggiornate, 0 kept_human, 0 errori;
  55 approvate di cui 53 con nota di adattamento.
- Nota operativa: la prima regen aveva cancellato il .git del repo (rmtree) — perso il commit v1
  (rigenerabile); il generatore ora preserva .git. Repo attuale: commit `08aeafe`.
**Suite: 1870 passed / 0 failed.**

**Aggiornamento: note per-body rimosse.** Su richiesta, i body non portano più il commento
"Adapted for Homun…" (attribuzione MIT interamente a livello di repo: LICENSE/NOTICE/manifest
col commit upstream; verify: 0 occorrenze nei body). Vantaggio: ~30 token/skill in meno nel
contesto. Durante il sync di allineamento emerso e corretto un difetto del sync stesso: i
command_id dei patch ora sono univoci per tentativo (include la revisione) — un intento
registrato-ma-fallito non avvelena più le riesecuzioni con lo stesso id. Sync finale:
17 aggiornate, 0 errori, 0 kept_human; 55 approvate senza nota. Suite 1870.

## Artefatti
- Script riusabili: tools/parity/homun_cmd.sh, tools/parity/t2_homun_agent_file.sh, tools/parity/t6_homun_terminal.sh
- Evidenza run: t2_homun_run.json (questa directory)
- File creati dagli agenti: /tmp/parity_hermes/{parity_test.txt,term_test.txt,cron_ok.txt};
  engine data-dir …/execution/workspaces/<hash>/{parity_test.txt,term_test.txt}
- Routine di test fermata (routine_e1dJpEiDQzNHSg stopped) e cron Hermes rimosso dopo il test.

## Batteria estesa pomeriggio: le aree "mai testate" (30/09 sera)

Obiettivo: uscire dal buio sulle aree elencate come "non testate in questa passata".
Metodo: superficie via probe black-box sul motore live + esercizio profondo dove contava.

| Area | Superficie | Esercizio | Esito |
|---|---|---|---|
| Steering/interrupt (H02) | route_message → steer atomico | **LIVE**: run nativo Vega in volo, messaggio "step2 → 'done 2 rivisto'" | **PASS** — `agent_control: steer`, ack, run completato, step2.txt contiene "done 2 rivisto" |
| Capability surface | 1 run pending con tutti i flag | probe | **42 tool registrati**: browser×7, web×3 (search/extract/x), delegation×3, goals×8+subgoals, clarify×2, cron, session_manage, execute_code, gateway_manage, memory×4, skills×5 |
| Memoria conversazionale (T3 gap) | — | **LIVE** (chiuso in sessione, commit 3f1191d8) | **PASS** — conversazione pura ricorda "teal"; isolamento cross-persona verificato (PIN di Marta non arriva a Fabio) |
| Compressione contesto (H05) | `micro_compaction` in RunToolPolicy | unit (test_agent_overflow.py) | superficie+unit OK, non esercitata live |
| Checkpoint/rollback (H12) | sessions API + session_manage tool | unit (test_checkpoints_and_worktrees, test_c1_checkpoints_lsp, test_canonical_sessions, 13 file session_*) | molto coperto a unit, non esercitato live |
| MCP | /mcp/servers CRUD + test + tools per work + propose/approve | unit (test_agent_mcp) | OK |
| Plugins | API enable/disable/data/reload-config | unit | OK |
| Media/voice (H41) | /media/tts/synthesize, /media/voice/wake-check, wake-word | parziale | superficie presente |
| Batch/evals (H45) | /research/batch/run + BatchEvalRunner | **NESSUN test** | **gap reale**: implementazione ed endpoint senza unit test |

Conclusione: quasi tutto esisteva già ed è coperto dai test; il buco era l'esercizio live.
Veri gap rimasti: batch/evals senza test; web/browser/delegation/media da esercizio live end-to-end.

## Chiusura gap in autonomia (30/09 notte)

Azzerati i gap azzerabili emersi dalla batteria estesa:

| Gap | Chiusura | Verifica |
|---|---|---|
| Batch/evals senza test | `tests/test_batch_eval.py` (5): aggregazione, eccezioni, resume da checkpoint, rifiuto senza executor, endpoint HTTP (200/503) | unit |
| Governance entità | comandi `work.archive` / `conversation.archive` (reversibili, `restore:true`) con permessi write + version; già esistevano team/project/material/skill archive | unit (5) + **live dogfood**: 7 archiviazioni di probe via command bus |
| approval_channel non esposto | il campo `_approval_channel` veniva scartato da pydantic (il chip "auto-approvazione prevista" non aveva mai dati); ora `public()` lo espone come `approval_channel` ufficiale + campo RunView + tipo/pannello web | unit (1) |
| Badge autonomia UI | la UI offriva `strict/semi/autonomous` ma il motore accetta solo `supervised/autonomous` → salvataggi rotti e agente supervisionato etichettato "Semi-autonomo"; allineati livelli, template e badge | live UI: 2 Autonomo / 2 Supervisione umana / 0 residui |
| Scope memoria non visibile | tipo + `memoryScopeLabel` + badge nelle viste elenco/recall; nota person ora etichettata "Personale · person_fabio" | live UI |
| Catalogo skill non navigabile | pannello "Catalogo Skill" (57 skill, ricerca, filtri con conteggi, corpo espandibile, uso, risorse) + sync dal repository + `usage_count`/`last_used_at` esposti dall'API | live UI: ricerca "price" → 2 risultati |
| Web tools mai esercitati (H14) | **LIVE**: run con `web_pages:true`, agente chiama `web_extract` su example.com → 200 + contenuto | live |
| Delegation mai esercitata (H21) | **LIVE**: senza team approvato → blocco tipizzato `delegation_agent_not_approved` (security ok); con team Vega+Bruno → child run assegnato a Bruno, `_delegation_result.result = "BANANA"` esatto | live end-to-end |

Nota: la nota "teal" era duplicata (globale del mattino pre-scope + person di oggi); eliminata la globale, tenuta la person.

## Approval relay (30/07... no: 30/09 notte-buia)

Richieste di autorizzazione da mobile: la persona collega la propria identità di canale
(WhatsApp/Telegram/webhook) con un codice COLLEGA inviato DAL canale; da lì ogni gate
di sua proprietà (run, comando terminale, modifica file) genera una notifica con codice
monouso a 15 minuti, e la risposta "A <codice>" / "R <codice>" decide.

- Sicurezza: solo l'identità collegata decide; codici monouso; scadenza rifiutata;
  gate su lavori archiviati mai notificati; approvazioni SOLO tramite i percorsi
  canonici (digest + autorità owner/reviewer + journal) con timbro `relay:<platform>`.
- Verifica live (adapter webhook come "telefono"): enroll → notifica → "A WMVE5W" →
  run queued con `approval_channel: relay:webhook` nell'API. Rifiuto run = cancellazione
  pulita della proposta (mai partita).
- UI: riga "Autorizzazioni da mobile" nel pannello Code di revisione (canale collegato
  o codice COLLEGA da inviare).
- Suite: 1898 passed / 0 failed. Checker architettura: verde (nessun ciclo
  application→routes; canale ingress sotto le 800 righe).
- Da fare: collegamento reale del bridge WhatsApp (sidecar :8902, binario già previsto),
  adapter Telegram già presente nel registry.

## Computer-use a tre livelli (30/07... no: 30/07 era luglio. 30/09 notte-2)

Design concordato: hard-block (mai), superfici sensibili denaro (sempre umano,
non allowlistabile), allowlist per-app (recinto dell'autonomia).

- Policy pura (`computer_use_policy.py`): hard-block ereditati da Hermes
  (combo distruttive, pattern typing) + euristica sensibili IT/EN (banche,
  PayPal, pagamenti, bonifici, IBAN, CVV…) che fallisce-safe verso il gate.
- Job (`computer_use_jobs.py`): gate digest-pinned sul pattern terminal
  (id = digest del contenuto, replay idempotente, approve ricontrolla il
  digest), approve/reject con autorità owner/reviewer, canale timbrato.
- Allowlist = AgentProfile.computer_use_apps: app allowlistata corre senza
  gate SOLO per agenti autonomi; supervisionati gate sempre.
- Backend (`computer_use_backend.py`): MCP-over-stdio verso cua-driver,
  risoluzione binario (env/venv/PATH), BackendUnavailableError tipizzato con
  hint di installazione — mai successi finti.
- Tool `computer_use` registrato con capability `computer_use:true` nei run
  (policy cua-driver-supervised-v1); gate computer-use notificati anche sul
  relay WhatsApp (quarto tipo di gate).
- Skill portata nel repo homun-skills (vocabolario + sezione governance
  Homun) → catalogo a 55 voci, 58 approvate nel workspace live.
- Fix incidentale: sync catalogo senza percorso ora è rifiutato (400
  tipizzato) — prima archiviava tutto il catalogo usando la cwd.
- Verifica live: agente autonomo con allowlist → run con capability → tool
  registrato. Esecuzione reale in attesa del binario cua-driver sul desktop.
- Suite: 1918 passed / 0 failed (+20: policy, gate, approve, digest, relay).
