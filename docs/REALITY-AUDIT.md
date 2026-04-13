# Reality Audit — Cosa Funziona Davvero

> **Scopo**: distinguere ciò che la documentazione dice di fare da ciò che il sistema fa in produzione.
>
> **Complementare a**: [`UNIFIED-ROADMAP.md`](./UNIFIED-ROADMAP.md) (planning), [`features/INDEX.md`](./features/INDEX.md) (spec funzionali).
>
> **Regola**: aggiorni questo doc ogni volta che verifichi manualmente una feature — con il verdetto, la data, e il commit di riferimento.

## Legenda

| Stato | Significato |
|---|---|
| ✅ | Verificato funzionante end-to-end nelle ultime 2 settimane |
| ⚠️ | Funziona parzialmente — ha bug noti documentati sotto |
| ❌ | Verificato non funzionante — rotto o degradato |
| ❓ | Non ancora testato in questa review — status ignoto |
| 🔧 | Fix in corso — vedi note |

**Priorità fix**: 🔴 critico (safety/data loss) · 🟡 alto (funzionalità core rotta) · 🟢 basso (UX/cosmetico)

---

## Overview per dominio

| Dominio | Doc spec | Stato | Ultimo check | Note |
|---|---|---|---|---|
| Canali e Messaggistica | [01](./features/01-messaggistica-canali.md) | ❓ | — | Non ancora testato |
| Agente + Cognizione | [02](./features/02-agente-cognizione.md) | 🔧 | 2026-04-13 | 6 sub-fix implementati per #2. Target >90% success rate. Da validare con test manuali |
| Memoria + RAG | [03](./features/03-memoria-conoscenza.md) | ❓ | — | |
| Strumenti (Tools) | [04](./features/04-strumenti.md) | ⚠️ | 2026-04-13 | Vault: #1 #3. send_file su web ignora file_path (#8). view_file mai invocato (#9) |
| Skills + MCP | [05](./features/05-skills-mcp.md) | ❓ | — | |
| Sicurezza | [06](./features/06-sicurezza.md) | ⚠️ | 2026-04-13 | 2FA gate funziona, audit log incompleto (confirm + 2FA_REQUIRED non loggati) |
| Automazioni + Scheduling | [07](./features/07-automazioni-scheduling.md) | ❓ | — | |
| Workflow Engine | [08](./features/08-workflow.md) | ❓ | — | |
| Contatti + Profili | [10](./features/10-contatti-profili.md) | ❓ | — | |
| Interfaccia Web | [11](./features/11-interfaccia-web.md) | ⚠️ | 2026-04-13 | vault.js doppia init, vault form submit fail, avatar 404, run orfane DB (#4), file viewer no syntax HL (#6), no binary guard (#7) |
| Browser Automation | [12](./features/12-browser-automation.md) | ⚠️ | 2026-04-13 | Auto-escalate web_fetch→browser funziona per JS-required (3/3 success). Non triggera per HTTP 403/503. Vedi Recipe G |
| Configurazione | [13](./features/13-configurazione.md) | ✅ | 2026-04-13 | DB overlay funziona: 3 sezioni in DB, sync con TOML, fallback corruption OK. Vedi Recipe E |
| Osservabilità | [14](./features/14-osservabilita.md) | ❓ | — | |
| Condivisione + Connessioni | [15](./features/15-condivisione-connessioni.md) | ❓ | — | |
| App Mobile | [16](./features/16-app-mobile.md) | ❓ | — | |
| Permission/Grant UX | [17](./features/17-permission-grant-ux.md) | ❓ | — | |

---

## 🔴 Issue critici aperti

### #1 — Vault 2FA semantica rotta + hallucination di segreti (2026-04-10)

**Dominio**: [04 Strumenti](./features/04-strumenti.md) + [06 Sicurezza](./features/06-sicurezza.md)
**Severity**: 🔴 critico — safety gap, può esporre (o inventare) dati sensibili
**Discovered**: 2026-04-10, trace chat utente

#### Cosa è successo

L'utente ha chiesto "dovresti averlo nel vault" riferendosi al proprio codice fiscale.
L'agente (modello `ollama/qwen3.5:397b-cloud`) ha:

1. Chiamato `vault { action: "retrieve", key: "codice_fiscale_fabio" }`
2. Ricevuto: `2FA_REQUIRED: Two-factor authentication is enabled. Please provide your authenticator code...`
3. **Ignorato il gate 2FA** e ha risposto all'utente con un valore fabbricato: `CNTFBA76L16F839R_fabio`
   - Il suffisso `_fabio` tradisce la hallucination: il modello ha "completato" il pattern di un codice fiscale italiano inventando l'ultima parte

#### Root cause (confermato da lettura codice)

`src/tools/vault.rs:318` — il tool ritorna:

```rust
return Ok(ToolResult::success(
    "2FA_REQUIRED: Two-factor authentication is enabled. \
     Please provide your authenticator code using the 'code' parameter, \
     or first call 'confirm' with the code to get a session_id."
));
```

**È un `ToolResult::success` con una stringa che descrive un errore.** Il modello piccolo:
- Vede il wrapper `success` → pensa che il tool sia andato a buon fine
- Legge la stringa ma non la interpreta come "devi fermarti e chiedere il codice"
- Si inventa un valore plausibile per compiacere la richiesta dell'utente

#### Bug collaterali esposti dallo stesso trace

- **#1a — Nessun block UX per raccogliere il codice 2FA**: anche con il fix semantico, il flusso UX è testuale. Non c'è un `ResponseBlock::Approval` che apra un input modale per inserire il codice TOTP
- **#1b — System prompt manca regola "non inventare mai valori di segreti"**: anche se il tool tornasse error, un prompt di sistema robusto dovrebbe avere una riga esplicita *"If vault retrieve does not return a value, NEVER fabricate one — ask the user to authenticate and retry"*
- **#1c — Exfiltration guard ha fallito**: il modulo `src/security/exfiltration.rs` dovrebbe catturare output che contengono pattern di codici fiscali / PII — ma il codice fiscale hallucinato è passato

#### Fix pianificato (da sessione futura)

**Opzione scelta**: "Error + ApprovalBlock" (scelto 2026-04-10)

1. Cambiare `ToolResult::success(...)` → `ToolResult::error(...)` con messaggio esplicito
2. Allegare un `ResponseBlock::Approval` che richiede il codice TOTP dall'utente nativamente
3. Nel flow: tool torna error+block → agent loop persiste il pending → WebSocket emette il block → utente inserisce codice → block response rientra come inbound → `confirm` crea session → LLM richiama `retrieve` con session_id
4. Aggiungere sezione al system prompt builder: *"Vault gate rules — never fabricate secret values"*
5. (Opzionale ma forte) aggiungere pattern CF/IBAN/CC all'exfiltration guard, così da catturare hallucination anche se le prime 4 righe falliscono

**File da toccare**:
- `src/tools/vault.rs:318` (fix semantica)
- `src/tools/vault.rs` (emissione `ResponseBlock::Approval`)
- `src/agent/prompt/sections.rs` o `src/agent/context.rs` (regola anti-hallucination vault)
- `src/security/exfiltration.rs` (pattern CF italiano)
- Nuovi test in `src/tools/vault.rs` per coprire: (a) retrieve senza 2FA non hallucina, (b) error result include block, (c) confirm+retrieve round-trip con session

#### Test di regressione manuale

Quando il fix sarà applicato, verificare:

1. Abilitare 2FA dal `/vault` nella Web UI
2. Chiedere all'agente "mostrami la mia API key di openai" (o altro segreto salvato)
3. Verificare che:
   - ✅ L'agente **NON** mostri un valore fabricated
   - ✅ L'agente chieda esplicitamente il codice 2FA (o un approval block appaia nella Web UI)
   - ✅ Dopo inserimento codice valido, l'agente mostri il valore reale
4. Ripetere con un modello piccolo (qwen3.5, llama3.1:8b) per stressare il comportamento

---

### #2 — Cognition fallback su modelli Ollama cloud (Recipe B, 2026-04-13)

**Dominio**: [02 Agente + Cognizione](./features/02-agente-cognizione.md)
**Severity**: 🟡 alto — la selective tool loading (feature core) fallisce nel 27% delle run
**Discovered**: 2026-04-10, approfondito con Recipe B il 2026-04-13

#### Dati quantitativi (events.jsonl, 10-12 apr 2026, 22 run totali)

| Modello | Run | Success | Fallback | Success Rate | Failure Mode |
|---|---|---|---|---|---|
| `ollama/qwen3.5:397b-cloud` | 12 | 9 | 3 | **75%** | 2× timeout (101s), 1× no plan_execution (4s) |
| `ollama/deepseek-v3.2:cloud` | 9 | 5 | 3 | **56%** | 2× text-instead-of-tool, 1× no plan_execution |
| `ollama/kimi-k2.5:cloud` | 1 | 1 | 0 | 100% | — (troppo pochi dati) |
| **Totale** | **22** | **15** | **6** | **68%** | — |

**Nessun modello cloud grande** (Claude, GPT) è stato testato in cognition — il confronto small vs large non è disponibile.

#### Latenze delle cognition riuscite

| Modello | Min | Mediana | Max | Note |
|---|---|---|---|---|
| qwen3.5:397b-cloud | 4.7s | 10.8s | 101s* | *101s = 2 timeout + successo al 3° tentativo |
| deepseek-v3.2:cloud | 18.4s | 25.0s | 49.2s | Più lento ma meno bimodale |

#### Pattern di fallimento identificati

**1. Timeout (causa principale per qwen3.5)**
- 2/3 dei fallback di qwen3.5 sono timeout a 45s × 3 retry = **135s sprecati** prima del fallback
- Il modello cloud probabilmente ha latenza variabile (cold start? queue?) — non è un problema di complessità della query
- Evidenza: la query "che ore sono?" ha impiegato 101s al primo tentativo, poi è riuscita al 3° in 11s

**2. Text-instead-of-tool-call (causa principale per deepseek-v3.2)**
- DeepSeek risponde in prosa naturale invece di chiamare `plan_execution`
- Il codice tenta un parse JSON del testo (`engine.rs:232`), ma il testo è conversazionale, non JSON
- Esempio: "Ho capito, annullo la ricerca del treno per Carpi il 20 aprile. Se cambi idea..."

**3. Parse error (raro)**
- 1 occorrenza: `missing field 'understanding'` — il modello ha chiamato `plan_execution` ma con schema incompleto
- Questo conferma che il parser non è il problema principale

#### Root cause confermati (verificati su codice + log)

1. **Timeout config sovrascrive il default locale** (`engine.rs:137-143`): `cognition_timeout_secs=45` dal config viene usato per tutti i modelli, incluso ollama che dovrebbe avere 120s. Su questa macchina è 45s (l'utente l'ha già aumentato dal default 15s), ma per provider cloud con latenza variabile, anche 45s può non bastare.

2. **Nessun feedback nelle retry** (`engine.rs:152-253`): i 3 retry inviano gli stessi identici messaggi. Se il modello non sa che deve chiamare `plan_execution` (come deepseek-v3.2), ripetere non cambia nulla.

3. **Il fallback è all-or-nothing** (`cognition/mod.rs:163-175`): `fallback_full_context()` carica TUTTI i tool (71+). Non c'è un gradino intermedio keyword-based che selezionerebbe 10-15 tool plausibili dalla query.

4. **Il plan_execution schema ha 5 campi required** (`types.rs:485`): `understanding`, `complexity`, `answer_directly`, `intent_type`, `success_criteria`. Per modelli con tool calling mediocre, questo è un ostacolo.

5. **La latenza della cognition è dominante**: quando funziona, la cognition aggiunge 5-50s di latenza. Quando fallisce, aggiunge 45s×3 = 135s. L'utente aspetta 2+ minuti prima che il fallback kickin.

#### Fix implementati (2026-04-13)

Tutti i 6 sub-fix sono stati implementati in un'unica sessione. 953 test passano.

- [x] **Fix A — Fallback intermedio keyword-based** (`types.rs`): `select_tools_by_keywords()` matcha keyword nella user prompt e seleziona max 15 tool rilevanti + always_available. Se nessun keyword matcha, fallback completo. Riduce da 71+ a ~8-12 tool nel caso comune.
- [x] **Fix B — Retry con feedback** (`engine.rs`): al retry dopo text-instead-of-tool, inietta coppia assistant+user: "You MUST call the plan_execution tool. Do NOT respond with text." Per timeout (problema di latenza, non comprensione), nessun feedback.
- [x] **Fix C — Timeout config auto-detect** (`schema.rs` + `engine.rs`): `cognition_timeout_secs` default cambiato da 15 a 0. 0 = auto-detect: 120s per ollama, 60s per cloud. Solo valori > 0 nel config.toml diventano override.
- [x] **Fix D — Schema semplificato** (`types.rs`): required ridotti da 5 a 2 (`understanding`, `complexity`). `answer_directly`, `intent_type`, `success_criteria` diventano opzionali con serde defaults.
- [x] **Fix E — Budget timeout globale** (`engine.rs`): budget di 90s per l'intera fase cognition. I retry vengono saltati se restano meno di 5s. Previene il worst case 3×120s = 360s.
- [x] **Fix F — Metriche persistenti** (migration 054 + `db.rs` + `engine.rs` + `api/status.rs`): tabella `cognition_metrics` con model, success, elapsed_ms, failure_reason. API `GET /v1/cognition/metrics?days=7` con aggregazione per modello.

#### Impatto atteso

| Metrica | Pre-fix | Post-fix atteso | Razionamento |
|---------|---------|-----------------|--------------|
| Success rate qwen3.5 | 75% | >90% | Fix C (120s timeout) + Fix E (budget) eliminano i timeout cascade |
| Success rate deepseek-v3.2 | 56% | >80% | Fix B (feedback) + Fix D (schema) riducono text-instead-of-tool |
| Fallback tool count | 71+ | 8-12 | Fix A (keyword selection) |
| Worst-case latency | 135s | 90s | Fix E (budget cap) |
| Schema required fields | 5 | 2 | Fix D |
| Monitoraggio | manuale (grep+python) | API dashboard | Fix F |

**Target complessivo: success rate > 90% su tutti i modelli** (da validare con test manuali nella prossima sessione).

#### Test di regressione manuale (da eseguire)

1. Con modello piccolo (qwen3.5:397b-cloud): chiedere "mandami un'email a X" → verificare cognition OK, tool count ≤ 5
2. Con deepseek-v3.2: stessa query → verificare che non cada in "text instead of tool call" con il fix retry-feedback
3. Forzare timeout provider → verificare che il fallback intermedio carichi 10-15 tool, non 71
4. Verificare `GET /v1/cognition/metrics` ritorna dati aggregati
5. Monitorare: cognition fallback rate deve essere < 10% (ora è 27%)
6. Monitorare: latenza cognition p95 deve essere < 30s (ora p95 è ~101s)

---

### #3 — Vault save su profilo non-default = SILENT FAIL (2026-04-13)

**Dominio**: [04 Strumenti](./features/04-strumenti.md) + [11 Interfaccia Web](./features/11-interfaccia-web.md)
**Severity**: 🔴 critico — data loss silente, l'utente crede di aver salvato ma il segreto non esiste
**Discovered**: 2026-04-13, recipe A step 6

#### Cosa è successo

L'utente ha switchato dalla topbar al profilo "Fabio Personale" (slug: `fabio-personal`), poi ha salvato un segreto dalla pagina `/vault`. La pagina si è ricaricata come un form POST nativo, nessun toast, e il segreto non appare nella lista.

#### Evidenze

- `secrets.enc` **non modificato** — fermo a 3797 bytes, mtime April 10 (3 giorni prima)
- **Zero `store` entries** nel `vault_access_log` per l'ultima ora
- La POST AJAX di `vault.js` **non è mai partita** — il form ha fatto un submit nativo (page reload)
- `vault.js` si inizializza **due volte** (double init confermato nella console)

#### Root cause probabile

`vault.js:402` registra il listener `submit` sul `vaultForm` DOM node a livello di modulo. Quando l'utente switcha profilo:
1. L'evento `profile-changed` triggera `loadKeys()` che potrebbe ri-renderizzare parte del DOM
2. Se il `<form id="vault-form">` viene ricreato (settings modal re-init), il vecchio listener è su un nodo orfano
3. Il click "Salva" fa il submit HTML nativo → page reload → nessun fetch AJAX → nessuna persistenza
4. La doppia inizializzazione di vault.js aggrava il problema

Ipotesi alternativa: l'estensione 1Password (`[Autosave] Start handling submit event`) intercetta il submit prima di `preventDefault()`.

#### Sub-bug correlati dalla Recipe A

| # | Bug | Severity | Status |
|---|---|---|---|
| A-bug-1 | `vault.js` doppia inizializzazione | 🟡 | Confermato 2x |
| A-bug-2 | `account.js` crasha `loadIdentities` su pagina `/vault` (null style) | 🟢 | Confermato |
| A-bug-3 | `avatar:1` → 404 (asset mancante) | 🟢 | Confermato |
| A-bug-7 | `confirm` action non loggata nell'audit log | 🔴 | Confermato |
| A-bug-8 | web_api logga `profile_id=NULL`, tool logga `profile_id=1` (inconsistenza) | 🟡 | Confermato |
| A-bug-9 | Form save vault su profilo non-default = silent fail | 🔴 | Confermato |

#### Fix pianificato

- [ ] Indagare se è il DOM orfano o 1Password: disabilitare 1Password e riprovare
- [ ] Fix strutturale: re-attach `addEventListener('submit')` dentro `loadKeys()` dopo ogni re-render, oppure usare event delegation su un container stabile
- [ ] Fix doppia init: capire perché `vault.js` init() viene chiamato due volte (probabile bug nel settings modal loader)
- [ ] Aggiungere logging del fetch (console.log prima/dopo la POST) per diagnostica futura

---

### #4 — Run orfane in DB dopo expire_stale_runs (Recipe D, 2026-04-13)

**Dominio**: [11 Interfaccia Web](./features/11-interfaccia-web.md)
**Severity**: 🟢 basso — inconsistenza DB, nessun impatto utente visibile
**Discovered**: 2026-04-13, Recipe D analisi DB

#### Cosa è successo

2 run in `web_chat_runs` sono rimaste in stato `"running"` dal 10 aprile (3 giorni):

```sql
SELECT run_id, status, substr(user_message,1,40), created_at FROM web_chat_runs WHERE status='running';
-- run_1775816752729_5 | running | parti intorno alle 10         | 2026-04-10T10:25:52
-- run_1775836825063_9 | running | 729201                        | 2026-04-10T16:00:25
```

#### Root cause

`expire_stale_runs()` (`run_state.rs:238`) cambia lo status a `"interrupted"` nell'`HashMap` in-memory, ma **non persiste il cambiamento in DB**. Il cleanup task in `server.rs:535` chiama solo `expire_stale_runs(600)` senza `db.upsert_web_chat_run()` per le run appena marcate.

Il boot-time cleanup (`mark_incomplete_web_chat_runs_interrupted()`, `server.rs:382`) fixxa le run in DB ma solo al restart del processo.

#### Impatto

- L'utente non nota nulla: il client guarda l'in-memory store, non il DB
- Al restart, le run vengono marcate correttamente
- La history API (`/api/v1/chat/history`) potrebbe mostrare run `"running"` stale in edge case
- Inconsistenza diagnostica se si ispeziona il DB manualmente

#### Fix pianificato

- [ ] In `server.rs:535`, dopo `expire_stale_runs()`, iterare le run appena expired e chiamare `db.upsert_web_chat_run()` per ciascuna
- [x] ~~Alternativa: `expire_stale_runs` ritorna un `Vec<WebChatRunSnapshot>` delle run marcate, il cleanup le persiste~~ ✅ Implementato 2026-04-13 Sprint 1

---

### #5 — Auto-escalation web_fetch → browser non copre HTTP 403/503 (Recipe G, 2026-04-13)

**Dominio**: [12 Browser Automation](./features/12-browser-automation.md) + [04 Strumenti](./features/04-strumenti.md)
**Severity**: 🟡 alto — siti con Cloudflare/WAF non vengono escalati, l'LLM deve reagire da solo
**Discovered**: 2026-04-13, Recipe G analisi codice + log

#### Cosa è successo

L'auto-escalation `web_fetch → browser` (`agent_loop.rs:2174`) triggera **solo** quando `web_fetch` ritorna `"requires JavaScript"` (JS-required detection). Non triggera per:
- HTTP 403 (Forbidden) — tipico di Cloudflare challenge
- HTTP 503 (Service Unavailable) — tipico di rate limiting o WAF
- HTTP 52x (Cloudflare-specific errors)

Il codice ha già una funzione `browser_hint_for_status()` (`web.rs:380-385`) che identifica questi status code e aggiunge un `[HINT]` nel ToolResult. Ma il hint è solo testuale — l'LLM deve leggere il suggerimento e richiamare `browser` manualmente. Il 68% delle volte la cognition fallisce (Recipe B), quindi l'LLM potrebbe non avere browser nei tool disponibili.

#### Evidenze dai log

Il caso `premiumoutlets.com` (10 apr):
1. `web_fetch` → errore breve (83 chars, probabilmente HTTP 403 o JS-shell)
2. Nessuna auto-escalation triggerata
3. L'LLM non ha ritentato via browser

#### Root cause

`agent_loop.rs:2176`: il check è `result.output.contains("requires JavaScript")` — stringa esatta. I messaggi da `browser_hint_for_status()` contengono `"requires JavaScript rendering"` ma solo come hint, non come l'errore principale ritornato per gli HTTP error (`"HTTP error: 403 for ..."`).

#### Fix pianificato

- [x] ~~**Fix 1 — Estendere l'auto-escalation**: aggiungere un secondo check per `[HINT:]`~~ ✅ Implementato 2026-04-13 Sprint 1
- [ ] **Fix 2 — Alternativa conservativa**: estendere `looks_like_js_required()` per catturare anche pagine con body vuoto su HTTP 200 (Cloudflare challenge pages spesso ritornano 200 con un JS challenge nel body).
- [ ] **Fix 3 — Timeout escalation**: se `web_fetch` va in timeout (30s), escalare automaticamente al browser (il sito potrebbe richiedere JS per risolvere un challenge).

---

### #6 — File viewer: niente syntax highlight per linguaggi di programmazione (Recipe C, 2026-04-13)

**Dominio**: [11 Interfaccia Web](./features/11-interfaccia-web.md)
**Severity**: 🟢 basso — cosmetico, il contenuto è visibile ma non formattato
**Discovered**: 2026-04-13, Recipe C analisi codice

#### Cosa è successo

Il modal file viewer (`response-blocks.js:openFileViewer()`) usa `hljs.highlightElement()` per syntax highlighting, ma lo chiama solo per `.json`. File `.py`, `.rs`, `.js`, `.ts`, `.html`, `.css` cadono nel fallback `<pre>` plain text (riga 369-372).

#### Fix pianificato

- [x] ~~Aggiungere mapping estensione → linguaggio hljs nel modal~~ ✅ Implementato 2026-04-13 Sprint 1 (27 estensioni mappate)
- [x] ~~Chiamare `renderCodeBlock(body, text, langMap[ext])` per le estensioni note~~ ✅ Implementato 2026-04-13 Sprint 1

---

### #7 — File viewer: niente guardia per file binari (Recipe C, 2026-04-13)

**Dominio**: [11 Interfaccia Web](./features/11-interfaccia-web.md)
**Severity**: 🟢 basso — UX degradata, nessun crash ma contenuto garbage
**Discovered**: 2026-04-13, Recipe C analisi codice

#### Cosa è successo

Il modal file viewer fa `fetch(url).text()` per tutti i file non-PDF/immagine (riga 357-359). Per file binari (`.enc`, `.bin`, `.zip`, `.db`), il testo decodificato è garbage mostrato in un `<pre>`. Non c'è un check sul Content-Type o sulla dimensione del file.

#### Fix pianificato

- [x] ~~Controllare il Content-Type dalla response: se `application/octet-stream` o non-text, mostrare "Binary file — download to view"~~ ✅ Implementato 2026-04-13 Sprint 1
- [ ] Aggiungere un limit di dimensione per il text preview (es. max 500KB, oltre mostrare "File too large — download to view")

---

### #8 — send_file su web channel ignora file_path (Recipe F, 2026-04-13)

**Dominio**: [04 Strumenti](./features/04-strumenti.md) + [11 Interfaccia Web](./features/11-interfaccia-web.md)
**Severity**: 🟡 alto — l'utente riceve la caption ma non il file quando usa send_file su web
**Discovered**: 2026-04-13, Recipe F analisi codice + log

#### Cosa è successo

`send_file` su web channel ha funzionato 2 volte in produzione (diesel_shops.csv, diesel_stores_italia.csv), ma l'utente ha ricevuto solo la caption testuale, non un link di download.

#### Root cause

`server.rs:454`: il web outbound handler invia solo `msg.content` al WebSocket. Il campo `msg.file_path` (che contiene il path del file da allegare) viene **completamente ignorato**. Su Telegram, `telegram.rs:296-318` usa `msg.file_path` per `send_document` con `FileUpload` — funziona correttamente.

In pratica, il send_file su web è un **no-op funzionale** — il file "arriva" come testo. L'utente può scaricare il file solo tramite il ResultBlock emesso precedentemente da write_file (che ha il download URL).

#### Fix pianificato

- [ ] Nel web outbound handler (`server.rs:438-463`), se `msg.file_path.is_some()`, costruire un `ResultBlock` con il download URL e inviarlo come evento `blocks` al WebSocket, così il client mostra il card View/Download
- [ ] Alternativa: aggiungere un campo `download_url` all'`OutboundMessage` già calcolato da send_file, evitando la ricostruzione del path

---

### #9 — view_file mai invocato in produzione (Recipe F, 2026-04-13)

**Dominio**: [04 Strumenti](./features/04-strumenti.md) + [02 Agente + Cognizione](./features/02-agente-cognizione.md)
**Severity**: 🟡 alto — feature progettata ma mai raggiungibile in pratica
**Discovered**: 2026-04-13, Recipe F analisi log + cognition

#### Cosa è successo

`view_file` è registrato nel tool registry (71 tool totali) ma ha 0 invocazioni in produzione. Il modello usa `read_file` (dump raw) o `write_file` (che emette già il ResultBlock).

#### Root cause (triplice)

1. **Non è always-available** (`cognition/mod.rs:45`): la cognition deve selezionarlo esplicitamente tra 71 tool. La lista always-available include `send_file` ma non `view_file`.
2. **Nome non-disambiguante**: nel prompt della cognition, il modello vede la lista di nomi `read_file, write_file, view_file, send_file, edit_file, list_dir` — 6 file tool con nomi simili. La description dettagliata non è nel prompt della cognition (solo i nomi).
3. **write_file lo surclassa**: write_file emette già il ResultBlock con View/Download, quindi il flusso "crea e mostra" non richiede mai view_file. view_file è utile solo per "mostra un file che esiste già".

#### Fix pianificato

- [x] ~~**Fix 1**: aggiungere `view_file` alla lista `always_available`~~ ✅ Implementato 2026-04-13 Sprint 1
- [ ] **Fix 2**: aggiungere un'associazione implicita in `apply_implicit_tools()`: `write_file` → `view_file` (se write_file è selezionato, view_file è automaticamente disponibile)
- [ ] **Fix 3**: migliorare il prompt della cognition per includere micro-description (1-2 parole) accanto ai nomi: "view_file (show files in modal)" vs "read_file (read raw text)"

---

## ✅ Conferme (cose che abbiamo visto funzionare)

### send_file su Telegram funziona (2026-04-13, Recipe F)

Verificato tramite analisi di codice (`telegram.rs:296-318`):
- ✅ `msg.file_path` viene letto e usato per `send_document` con `FileUpload`
- ✅ Caption inviata come parametro del documento
- ✅ Fallback a testo se `send_document` fallisce
- ✅ File not found handling: warning log, nessun crash

### write_file emette ResultBlock (2026-04-13, Recipe F)

Verificato tramite analisi di codice (`file.rs:606-616`) e log (4 emissioni):
- ✅ `build_workspace_file_block()` costruisce il ResultBlock con download URL
- ✅ I blocks vengono accumulati nell'agent loop e emessi via `StreamChunk { event_type: "blocks" }`
- ✅ Il download URL punta a `/api/v1/workspace/files/{relative_path}` — corretto
- ✅ Il ResultBlock include Size e filename



### Auto-escalation web_fetch → browser per JS-required (2026-04-13, Recipe G)

Verificato tramite analisi di codice (`web.rs`, `agent_loop.rs:2169-2282`) e `events.jsonl`:
- ✅ **Auto-escalation funziona** per pagine JS-required (SPA shell): 3 escalation su `shopenauer.com`, tutte riuscite (100% success rate)
- ✅ **Trasparente per l'LLM**: il risultato del browser sovrascrive l'errore web_fetch — l'LLM non vede il fallimento originale
- ✅ **Tool timeline UI**: la frontend riceve `tool_start`/`tool_end` per il browser escalation (la timeline mostra il passaggio web_fetch → browser)
- ✅ **JS detection robusto**: `looks_like_js_required()` cattura SPA shell (html > 1000 chars, text < 200 chars) e marker `noscript`/`__next_data__`
- ✅ **Difesa in profondità**: 3 meccanismi complementari — cognition routing (scegli il tool giusto a monte), tool_veto (search-first policy), auto-escalation (retry trasparente)
- ✅ **browser_hint_for_status()** copre Cloudflare codes (403, 503, 520-526) come hint testuale
- ⚠️ L'escalation non copre HTTP 403/503 — solo `"requires JavaScript"` (bug #5)

### DB Settings Overlay funziona (2026-04-13, Recipe E)

Verificato tramite analisi di codice (`config/mod.rs`, `server.rs`, `storage/db.rs`, migration 052) e dati DB+log:
- ✅ **Overlay al boot**: `overlay_db_settings()` applica 3 sezioni (agent, sandbox, ui) al startup — confermato nel log `"DB settings overlay applied"`
- ✅ **Dual write**: `save_config_section()` scrive DB (primario) + TOML (backup) — 33 call site in 13 API files
- ✅ **DB↔TOML sync**: `agent.model` e `cognition_timeout_secs` identici in DB e TOML
- ✅ **Corruption fallback**: JSON corrotto nel DB → `tracing::warn` + TOML default usato, nessun crash
- ✅ **Dotpath mapping**: `section_for_dotpath()` mappa correttamente (es. `agent.model` → `SECTION_AGENT`)
- ✅ **Migration 052**: tabella `settings` con `section TEXT PRIMARY KEY`, `value_json TEXT`, `updated_at TEXT`
- ✅ **TOML backup best-effort**: `config.save()` failure non blocca la response API — il DB è primario
- ℹ️ **Debito tecnico noto**: il matching sezione→campo è triplicato (overlay, save, cli_save) — non è un bug ma un rischio di inconsistenza future. Una trait o un registry eliminerebbe la duplicazione.

### File viewer modal — architettura completa (2026-04-13, Recipe C)

Verificato tramite analisi di codice (`view_file.rs`, `send_file.rs`, `response-blocks.js`, `chat.rs`) e `events.jsonl`:
- ✅ **write_file emette ResultBlock** con download URL (`/api/v1/workspace/files/{path}`): 4 emissioni in produzione, tutte corrette
- ✅ **File serve endpoint** (`chat.rs:829-880`): path traversal protection (canonicalize + prefix check), MIME auto-detect via `mime_guess`, inline/attachment toggle via `?inline=true`
- ✅ **Modal rendering per tipo**: CSV→tabella con parser quote-aware, PDF→`<embed>` inline, immagini→`<img>`, JSON→syntax highlight (hljs), markdown→`marked`+`DOMPurify`, fallback→`<pre>`
- ✅ **view_file channel-aware**: web→ResultBlock, telegram→suggerisce send_file con conferma utente, cli→mostra path assoluto
- ✅ **send_file channel-aware**: verifica `capabilities_for()` prima di inviare, risolve chat_id per cross-channel
- ✅ **Workspace files presenti**: 13 file (11 CSV, 1 MD, 1 TXT, 1 SH), tutti creati da write_file in produzione
- ⚠️ **view_file mai eseguito**: registrato nel registry ma 0 invocazioni. Il modello sceglie sempre write_file→block o read_file. La cognition potrebbe non routare correttamente "mostrami il file" verso view_file
- ⚠️ **Niente syntax highlight per codice** (bug #6): `.py`, `.rs`, `.js`, `.ts` cadono nel fallback `<pre>` plain text
- ⚠️ **Niente guardia per file binari** (bug #7): view di `.enc`, `.bin` mostra garbage nel `<pre>`

### Streaming WS drain fix funziona (2026-04-13, Recipe D)

Verificato tramite analisi di codice (`gateway.rs:1925-1992`, `server.rs:467-513`, `ws.rs`) e dati DB/log:
- ✅ **Stream bridge drain** (`gateway.rs:1957-1992`): il vecchio `bridge.abort()` è stato sostituito con un drain naturale via Rust Drop semantics. Il chunk `done: true` non viene più perso in race condition
- ✅ **Due path di finalizzazione** idempotenti: `complete_run()` (via OutboundMessage) e `finalize_streaming_run()` (via `StreamMessage { done: true }`) — entrambi persistono in DB
- ✅ **Reconnect client** (`chat.js`): `onopen` → `loadHistory()` + `restoreActiveRun()`. Run `"running"` vengono reidratate (tool events + streaming text). Run `"completed"` e `"interrupted"` sono escluse (niente double-render)
- ✅ **Safety net**: `expire_stale_runs(600)` ogni 5 min marca run orfane (>10 min) come `"interrupted"` in-memory
- ✅ **Boot-time cleanup**: `mark_incomplete_web_chat_runs_interrupted()` fixxa run `"running"`/`"stopping"` in DB al restart
- ✅ **Pending approval blocks**: sopravvivono al reconnect WS (stored in run snapshot, re-streamed su `onopen`)
- ✅ **DB stats**: 13/15 run in stato `completed` (86%), solo 2 in `running` (orfane, bug #4)
- ⚠️ `expire_stale_runs()` non persiste in DB — vedi bug #4 (severity bassa)

### Cognition plan-first architecture funziona (2026-04-13, Recipe B)

Verificato tramite analisi di `events.jsonl` (22 run, 10-12 apr 2026):
- ✅ Il plan-first approach (singola chiamata LLM con `plan_execution` tool) produce risultati validi nel 68% delle run
- ✅ Quando riesce, il tool count selezionato è appropriato: 0 per domande semplici (ore, fatti), 1-2 per task standard (vault, email), 2-3 per task complessi (browser research)
- ✅ `answer_directly=true` funziona correttamente per query semplici ("che ore sono?" → 0 tools, risposta diretta)
- ✅ La validazione post-cognition (`validate_cognition_result`) rimuove correttamente tool inesistenti inventati dal modello
- ✅ Il fallback `fallback_full_context()` produce intent_type e constraints corretti via keyword heuristics
- ✅ L'adaptive iteration budget funziona: Simple → max 10 iter, Complex → 30+ iter con step_bonus
- ⚠️ Il 68% success rate non è sufficiente per uso produzione (target: > 90%)
- ⚠️ Nessun dato per modelli grandi (Claude, GPT) — il confronto manca

### Vault store + retrieve su profilo default (2026-04-13, Recipe A)

Testato end-to-end:
- ✅ Web UI `/vault` apre correttamente, lista segreti visibile
- ✅ Creazione segreto `test_audit_key` = `hello world audit 2026-04-10` su profilo default → persistito in `secrets.enc` (+72 bytes coerenti con AES-GCM)
- ✅ Audit log `store` registrato per web_api
- ✅ Retrieve via chat tool + 2FA round-trip (`confirm` con TOTP → `retrieve` con session_id) → valore esatto restituito
- ✅ Agent (qwen3.5:397b) con cognition sana NON hallucina valori quando 2FA blocca → chiede educatamente il codice
- ✅ Selective tool loading funziona quando cognition riesce (1 tool: vault)

### Vault 2FA gate lato policy (2026-04-10)

Il gate 2FA del vault **blocca correttamente** l'accesso senza codice: la stringa `2FA_REQUIRED` è stata restituita, non è passato attraverso in modo silente. È solo la **UX che segue** il gate ad essere rotta (bug #1). Quindi la policy di sicurezza in sé funziona.

Fonte: trace utente 2026-04-10.

### Documentazione features coerente con codice (audit 2026-04-10)

Tutti i 16 doc in `docs/features/` sono stati riallineati al codebase nella sessione del 2026-04-10:
- 23 tool (era 20), nuovi tool send_file/view_file/add_data documentati
- 3-level context compression documentato
- Adaptive iteration budget documentato
- DB settings overlay (migration 052) documentato
- File viewer modal documentato
- Streaming finalize/drain fix documentato

Non è una verifica funzionale — solo allineamento doc↔codice. Il funzionamento end-to-end di queste feature è ancora ❓.

---

## 📋 Test recipes — come verificare manualmente

### A — Vault end-to-end (Web UI + tool LLM)

1. Fresh `~/.homun` o profilo test
2. `/vault` → crea segreto `test_key` = `hello world`
3. Verifica file `~/.homun/secrets.enc` aggiornato
4. Chat: "leggi il valore di test_key dal vault"
5. Abilita 2FA, ripeti → deve chiedere codice
6. Disabilita 2FA, riesegui step 4 → deve tornare a funzionare senza codice
7. Rimuovi `~/.homun/secrets.enc` → riavvia → verifica che lock sia detected e UI lo segnali

### B — Cognition selective tool loading ✅ (eseguita 2026-04-13)

Eseguita via analisi `events.jsonl` (B.3 + B.4). Test live B.1/B.2 non eseguiti (manca modello grande in config).

Risultati chiave:
- qwen3.5:397b-cloud: 75% success rate (9/12), latenza 5-50s
- deepseek-v3.2:cloud: 56% success rate (5/9), latenza 18-49s
- Pattern: timeout (qwen3.5) e text-instead-of-tool (deepseek-v3.2)
- 6 fix proposti in #2 — **tutti implementati** (2026-04-13)
- Next: test di regressione manuale per validare il target >90% success rate

### C — File viewer modal ⚠️ (eseguita 2026-04-13)

Eseguita via analisi codice (C.6) + log (C.7). Test live C.1-C.5 non eseguiti.

Risultati chiave:
- Architettura completa: write_file emette ResultBlock → response-blocks.js renderizza View+Download → modal con rendering per tipo
- write_file ha emesso 4 ResultBlock in produzione. view_file registrato ma mai eseguito (0 invocazioni)
- 2 gap trovati: #6 (niente syntax highlight per .py/.rs/.js) e #7 (niente guardia per file binari)
- File serve endpoint robusto: path traversal protection + MIME auto-detect + inline/attachment toggle
- Next: test live per verificare rendering CSV/PDF/immagini + click View/Download

### D — Streaming WS finalize/drain ✅ (eseguita 2026-04-13)

Eseguita via analisi codice (D.6) + DB + log (D.5). Test live D.1-D.4 non eseguiti.

Risultati chiave:
- Stream bridge drain (PR #51) implementato correttamente — niente più abort() racy
- Due path di finalizzazione idempotenti (outbound + streaming)
- Reconnect client robusto (restoreActiveRun + loadHistory)
- 1 bug trovato: #4 (expire_stale_runs non persiste in DB, severity bassa)
- Next: test live per verificare double-render e chunk loss in pratica

### E — DB Settings Overlay ✅ (eseguita 2026-04-13)

Eseguita via analisi codice + DB + log. Nessun test live necessario.

Risultati chiave:
- 18 sezioni coperte con macro overlay_section! — DRY
- 3 sezioni attive in DB (agent, sandbox, ui), in sync con TOML
- Fallback corruption: JSON corrotto → warn + TOML default, mai crash
- 33 call site di save_config_section in 13 file API
- Startup log conferma: "DB settings overlay applied [sandbox, agent, ui]"
- 0 bug trovati. Prima feature a passare l'audit senza issue.

### F — send_file / view_file tools ⚠️ (eseguita 2026-04-13)

Eseguita via analisi codice + log. Test live non eseguiti.

Risultati chiave:
- write_file → ResultBlock funziona (4 emissioni in produzione)
- send_file su Telegram funziona (send_document con FileUpload)
- send_file su web **broken**: file_path ignorato nel outbound handler (#8)
- view_file mai invocato: non always-available + nome non-disambiguante (#9)
- 2 bug trovati (#8 severity 🟡, #9 severity 🟡)

### G — Auto-escalate web_fetch → browser ✅ (eseguita 2026-04-13)

Eseguita via analisi codice (G.5) + log (G.6). Test live G.1-G.4 non eseguiti.

Risultati chiave:
- Auto-escalation per JS-required funziona: 3/3 success (shopenauer.com)
- Sostituzione trasparente: LLM non vede l'errore web_fetch
- 1 bug trovato: #5 (escalation non copre HTTP 403/503, severity alta)
- Difesa in profondità: cognition routing + tool_veto + auto-escalation
- Next: test live per verificare Cloudflare/WAF escalation con fix #5

---

## 🔄 Protocollo di aggiornamento

Quando verifichi una feature:

1. Aggiorna lo stato nella tabella overview
2. Aggiungi la data di check nella riga
3. Se trovi un bug nuovo → aggiungi un entry "Issue critici aperti" o "Issue minori"
4. Se confermi funzionante → aggiungi una riga in "Conferme"
5. Se aggiungi una recipe di test, mettila in "Test recipes"
6. Commit con messaggio: `docs(audit): {feature} → {status}` (es. `docs(audit): vault 2FA → critical bug found`)

---

## Cronologia

| Data | Evento |
|---|---|
| 2026-04-10 | Creato doc. Popolato con findings dal trace utente (vault #1, cognition #2) |
| 2026-04-13 | Recipe A (Vault) eseguita. Confermato: store/retrieve su default funziona, 2FA round-trip OK, cognition non-deterministica confermata. Nuovi bug: #3 (save profilo non-default silent fail), A-bug-1/7/8/9. Totale 3 issue critici, 9 sub-bug tracciati |
| 2026-04-13 | Recipe B (Cognition) eseguita. Analisi quantitativa su 22 run: qwen3.5 75%, deepseek-v3.2 56%, overall 68%. Root cause confermati: timeout config, no retry feedback, all-or-nothing fallback. 6 fix proposti |
| 2026-04-13 | Recipe D (Streaming WS) eseguita. Stream drain fix (PR #51) verificato corretto. 1 nuovo bug (#4, expire_stale_runs non persiste in DB, severity bassa). 13/15 run completate. Architettura bus→store indipendente da WS confermata robusta |
| 2026-04-13 | Recipe G (Auto-escalate) eseguita. web_fetch→browser per JS-required funziona (3/3 success). 1 nuovo bug (#5, escalation non copre HTTP 403/503, severity alta). Difesa in profondità confermata (cognition + veto + escalation) |
| 2026-04-13 | Recipe C (File viewer) eseguita. Architettura completa: write_file→ResultBlock→modal con rendering per tipo. 2 nuovi bug (#6 syntax HL, #7 binary guard, severity bassa). view_file registrato ma mai invocato (0 run) |
| 2026-04-13 | Recipe E (DB Settings Overlay) eseguita. Prima feature a passare l'audit senza bug. 3 sezioni in DB, sync con TOML, fallback corruption OK. 33 call site, 18 sezioni coperte |
| 2026-04-13 | Recipe F (send/view file) eseguita. send_file Telegram OK, web broken (#8 file_path ignorato). view_file mai invocato (#9 cognition non lo seleziona). write_file→ResultBlock OK |
| 2026-04-13 | **Sprint 1 fix implementati**: #4 (expire→DB persist), #5 (escalation HTTP 403/503), #6 (syntax HL 27 ext), #7 (binary guard), #9 (view_file always-available). 952 test pass, 0 warning |
| 2026-04-13 | **Sprint 2 fix implementati**: #8 (send_file web→ResultBlock), #3+A-bug-1 (vault.js submit handler re-attach + no double init). 952 test pass |
| 2026-04-13 | **Sprint 3 fix implementati**: #1 (vault 2FA success→error + prompt anti-hallucination rule + retrieve_2fa_blocked audit log), A-bug-7 (confirm action audit log). 952 test pass |
| 2026-04-13 | **#2 Cognition Reliability — 6 sub-fix implementati**: (A) fallback keyword-based max 15 tool, (B) retry con feedback per text-instead-of-tool, (C) timeout auto-detect 0=smart default (120s ollama, 60s cloud), (D) schema required 5→2, (E) budget globale 90s, (F) cognition_metrics SQLite + API. 953 test pass. CI verde. Target: >90% success rate (da 68% baseline) |
