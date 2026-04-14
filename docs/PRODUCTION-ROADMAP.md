# Homun — Production Roadmap

> **Scopo**: piano tattico per arrivare a una **release production-ready** che un utente non-tecnico possa installare e usare.
>
> **Differenza rispetto agli altri doc**:
> - [`UNIFIED-ROADMAP.md`](./UNIFIED-ROADMAP.md) → strategia 12+ mesi, 4 fasi macro, posizionamento competitivo
> - [`REALITY-AUDIT.md`](./REALITY-AUDIT.md) → cosa è verificato funzionante / rotto, evidenze quantitative
> - **questo file** → cosa fare PROSSIMAMENTE, in sprint da 1 settimana, scope chiaro per ogni sessione Claude
>
> **Aggiornamento**: a ogni sprint completato → marca come ✅, aggiorna le metriche, aggiungi nuovi sprint scoperti.
>
> **Ultimo aggiornamento**: 2026-04-13

---

## Stato Attuale (snapshot)

| Asse | Stato | Dettaglio |
|---|---|---|
| **Codebase** | ✅ stabile | 953 test, 0 warning clippy, 121K LOC Rust |
| **Reality Audit** | 🟡 8/16 domini | 6✅ + 1⚠️ + 1🔧 (canali 4/7 con bug tracciabili); 8 domini ❓ non auditati |
| **Strategy roadmap** | ✅ Fase 1+2 done | Hardening + Apertura completate. Fase 3 (Consumer) parziale |
| **Distribuzione** | ❌ blocco | Nessun installer nativo. Solo build-from-source o Docker |
| **Mobile app** | 🚧 in progress | APP-1 done, APP-2 (block widgets, approvals) in progress |
| **Doc consumer** | 🟡 ok ma da rivedere | docs.homun.dev online, sito da rivedere, contributing TODO |

**Il blocker numero 1 per la produzione non è il codice — è la distribuzione.** Il binario funziona, ma un utente tipico non sa compilarlo.

---

## Sprint Plan — 10 sprint per "v1.0 Production"

Ogni sprint è dimensionato per **1 settimana di lavoro full-time** (o 2 settimane part-time). Ogni sprint produce un valore osservabile.

Lo scope è scritto in modo che una **nuova sessione Claude** possa iniziare da zero leggendo questo file + il riferimento puntato dallo sprint.

### Legenda

- **Tipo**: `audit` (verificare) / `fix` (sistemare bug noti) / `feature` (costruire nuovo) / `release` (preparare uscita)
- **Effort**: S (1-3 giorni) / M (3-5 giorni) / L (1+ settimana)
- **Blocker**: ⛔ blocca la produzione · 🟡 importante · 🟢 nice-to-have
- **Stato**: 🔲 todo · 🚧 in progress · ✅ done · ⏸️ rimandato

---

### Sprint 1 — Reality Audit chiusura ⛔ S ✅ 2026-04-14

**Obiettivo**: 0 bug noti aperti, validation finale del fix #2 cognition.

**Risultato**:
- 3/3 sub-bug fixati (A-bug-2, A-bug-3, A-bug-8)
- #2 Cognition: schema API `/v1/cognition/metrics` verificato dal codice sorgente, checklist di validazione live pronta in `REALITY-AUDIT.md` § #2 — esecuzione live pending utente (richiede batch di 16 query sui modelli cloud)
- 942 test pass, clippy produzione clean
- 3 commit granulari: `f7aa57d`, `c0d5ddd`, `e74c417`

**Scope**:
1. ✅ A-bug-2 — early-return guard in `loadIdentities()` e `loadDevices()` (`static/js/account.js`)
2. ✅ A-bug-3 — `get_avatar()` serve inline SVG placeholder 200 OK invece di 404 (`src/web/api/account.rs`)
3. ✅ A-bug-8 — `audit_log()` in `src/web/api/vault.rs` propaga `profile_id` via nuovo helper `resolve_profile_id_from_slug` (DRY: refactor di `get_vault_audit_log` per riusarlo)
4. 🔧 #2 Cognition — schema API verificato, checklist quantitativa pronta per user run

**File chiave**:
- `docs/REALITY-AUDIT.md` § sub-bug residui + § #2 Validazione Sprint 1
- `static/js/account.js` (A-bug-2)
- `src/web/api/account.rs` (A-bug-3)
- `src/web/api/vault.rs` (A-bug-8)

**Definition of Done**:
- [x] REALITY-AUDIT.md: 0 bug aperti nel tracker sub-bug (tutti ✅)
- [x] Cognition metrics API schema confermato (`src/web/api/status.rs:191-221`)
- [ ] Cognition live validation quantitativa eseguita dall'utente — pending, checklist pronta
- [x] cargo test pass (942) + clippy produzione clean

**Rischio**: BASSO. Fix piccoli, confinati. L'unico residuo è la validazione live cognition (non-blocking per Sprint 2: i 6 sub-fix sono già in main, il codice compila, i test passano).

---

### Sprint 2 — Audit Canali ⛔ L ✅ 2026-04-14

**Obiettivo**: garantire che i 7 canali funzionino end-to-end senza regressioni note.

**Risultato**:
- 7/7 canali auditati via **static code-analysis** (metodo Reality Audit stile Sprint 1, ~4.2K LOC Rust coperti)
- Parallelizzato con 3 Explore agent (batch A: Telegram+WhatsApp, batch B: Discord+Slack, batch C: Email+CLI+Web)
- **3 canali ✅ puliti**: CLI, Discord, Web
- **4 canali ⚠️ con bug tracciabili**: Telegram, WhatsApp, Slack, Email
- **5 nuovi bug aperti** (tutti tracciati in REALITY-AUDIT.md, nessuno fixato in Sprint 2 come da accordo "raccogli e prioritizza"):
  - #10 🔴 Capability drift `outbound_attachments` (WhatsApp+Email dichiarano support ma non implementano upload)
  - #11 🔴 Slack manca integrazione `ChannelHealthTracker` (circuit breaker cieco)
  - #12 🟡 Email `is_sender_allowed()` è dead code (defense-in-depth rotta)
  - #13 🟡 Health tracking cieco intra-channel (Telegram+WhatsApp+Slack non chiamano record_message/error)
  - #14 🟡 Telegram backoff fisso 5s (non exponential, spreca restart budget)
- **Pattern architetturali emersi**:
  - `ChannelHealthTracker` è opt-in e solo Discord lo usa correttamente → drift silenzioso tra canali
  - Capability table (`capabilities.rs`) aspirazionale, non auditata contro l'implementazione runtime
- Dominio "Canali e Messaggistica" passa da ❓ a ⚠️ in REALITY-AUDIT overview
- 942 test pass, clippy produzione clean (nessuna modifica codice in questo sprint)
- 1 commit doc-only pulito

**Scope** (recipe stile Reality Audit, eseguita come annunciato):
1. ✅ **Telegram**: ⚠️ 2 bug (#13 health, #14 backoff) + minor silent attachment
2. ✅ **WhatsApp**: ⚠️ 2 bug (#10 capability drift, #13 health), grace period + exp backoff OK
3. ✅ **Discord**: tutti 7 assi ✅ — unico canale con health tracking corretto
4. ✅ **Slack**: ⚠️ 2 bug (#11 health struct, #13 health calls), Socket Mode + polling fallback OK
5. ✅ **Email**: ⚠️ 3 bug (#10 capability, #12 dead code + minor proactive claim), IMAP IDLE + vault OK
6. ✅ **CLI**: tutti 7 assi ✅ (dove applicabile) — capability 100% accurate, zero bug
7. ✅ **Web (WebSocket)**: tutti 7 assi ✅ — fix #8 (send_file ResultBlock) confermato in `ws.rs:219-226`

**File chiave** (tutti auditati):
- ✅ `src/channels/{cli,telegram,whatsapp,discord,slack,email}.rs`
- ✅ `src/channels/capabilities.rs`, `traits.rs`, `health.rs`
- ✅ `src/agent/auth.rs`, spot-check `gateway.rs`
- ✅ `src/web/ws.rs`
- ✅ `docs/features/01-messaggistica-canali.md` (spec confermata coerente)

**Definition of Done**:
- [x] Tabella `Verified channels` in REALITY-AUDIT.md con stato 7×9 (Auth, Text, Attach, Caps, Proactive, Health, Reconnect, Overall) per ogni canale
- [x] Tutti i canali auditati: 3 ✅ puliti + 4 ⚠️ con bug documentati
- [x] REALITY-AUDIT.md aggiornato (overview row ❓→⚠️, nuova Recipe H in Conferme, 5 nuovi issue #10-#14, cronologia)
- [x] PRODUCTION-ROADMAP.md: Sprint 2 ✅ + Sprint Summary table aggiornata + cronologia
- [x] SESSION-PRIMER.md cronologia aggiornata
- [x] cargo test pass (942, baseline invariata) + clippy clean

**Rischio**: Si è verificato come previsto ALTO — **5 bug trovati** come stimato. Niente fix implementato in questo sprint (decisione architetturale: raccogli + prioritizza). Fix a prioritizzare in sprint dedicato (probabile candidato Sprint 4 o 5).

---

### Sprint 3 — Audit Memoria + RAG ⛔ M ✅ 2026-04-14

**Obiettivo**: garantire che il "cervello" silenzioso dell'agente produca risultati rilevanti.

**Risultato**:
- Audit sistematico di memoria agent + RAG via **static code-analysis** (~5.7K LOC totali, 16 assi M1-M8 + R1-R8)
- Parallelizzato con 2 Explore agent (batch A memoria 2.5K LOC, batch B RAG 3.2K LOC)
- **11/16 assi ✅ puliti**: M3 pruning, M5 daily files, M7 perf, M8 errors, R2 hybrid search, R4 watcher, R6 cloud, R8 errors; M1/M2/M4 con bug non-bloccanti
- **9 nuovi bug tracciati** (nessuno fixato come da metodo Sprint 2 "raccogli e prioritizza"):
  - **#15** 🟡 `importance=0` collassa il search score (memoria)
  - **#16** 🟡 Consolidation parsing accetta `"importance": "high"` → default 0
  - **#17** 🟡 Namespace filter post-SQL (Rust) vs hard SQL block da spec
  - **#18** 🔴 **Path traversal** via `site` param nel tool `remember`
  - **#25** 🟡 RAG non gestisce file non-UTF8 (silent data loss)
  - **#26** 🔴 **No size limit** RAG → DoS via 1GB PDF
  - **#27** 🟡 `detect_injection` gap architetturale (on-tool-use, downgrade da 🔴 dopo verification read)
  - **#28** 🟡 Orphan HNSW vectors su `remove_source`
  - **#29** 🟡 RAG profile/namespace scoping post-fetch
- **Pattern architetturali emersi**:
  1. Post-fetch scoping cross-subsistema (memoria M4 + RAG R7): isolation in Rust filter_map, non SQL WHERE
  2. `detect_injection` on-tool-use vs on-ingest: design choice valida ma da esplicitare nella spec
  3. Importance range 1-5 sotto-enforced (clamp solo in consolidator, non in insert)
  4. File I/O senza bounds (#18 tool, #26 RAG): entry-point validation mancante cross-module
  5. Orphan side-effects: cascade DB OK ma HNSW `.usearch` non segue il cascade
- **ISO-3 / ISO-4** (profile/contact isolation): ✅ da code review — logic corretta, live test ground truth rimandato post-v1.0
- Dominio "Memoria + RAG": ❓ → ⚠️ in REALITY-AUDIT overview
- 942 test pass, clippy produzione clean (nessuna modifica codice)
- 1 commit doc-only

**Scope** (recipe stile Reality Audit, eseguita come annunciato):
1. ✅ **M1** Memory search quality (RRF, sanitize, decay): bug #15
2. ✅ **M2** Consolidation correctness (payload, parsing, redaction): bug #16
3. ✅ **M3** Pruning + budget (importance*recency ASC): pulito
4. ✅ **M4** Isolation (profile/contact/namespace): bug #17 (post-filter)
5. ✅ **M5** Daily files + brain dir: pulito
6. ✅ **M6** Tool `remember`: **bug #18 🔴** path traversal
7. ✅ **M7** Performance + HNSW bound: pulito
8. ✅ **M8** Error handling: pulito
9. ✅ **R1** Multi-format ingest (37 ext): **bug #26 🔴** DoS + #25 encoding
10. ✅ **R2** Hybrid search quality: pulito
11. ✅ **R3** Sensitive classifier + vault-gating: bug #27 gap architetturale
12. ✅ **R4** Directory watcher: pulito
13. ✅ **R5** DB schema + HNSW persistence: bug #28 orphan vectors
14. ✅ **R6** Cloud RAG (MCP): pulito
15. ✅ **R7** Isolation (profile/namespace): bug #29 (post-fetch)
16. ✅ **R8** Error handling + parser panic paths: pulito

**File chiave** (tutti auditati):
- ✅ `src/agent/memory.rs`, `memory_search.rs`, `memory_db.rs`, `embeddings.rs`
- ✅ `src/agent/cognition/discovery.rs` (search_memory path)
- ✅ `src/tools/remember.rs` (bug #18 confermato con read back)
- ✅ `src/rag/engine.rs`, `chunker.rs`, `parsers.rs`, `sensitive.rs`, `watcher.rs`, `db.rs`, `cloud.rs`
- ✅ `src/tools/knowledge.rs`
- ✅ `src/agent/context_compactor.rs` (falso positivo #27 scoperto qui)
- ✅ migrations/ (028, 035, 037, 042 memoria; 011, 012, 045 RAG)

**Definition of Done**:
- [x] Recipe Memory + RAG eseguita (2 batch paralleli, 16 assi)
- [x] Tabelle "Verified memory" + "Verified RAG" in REALITY-AUDIT.md
- [x] ISO-3 e ISO-4 confermati da code review (live test rimandato post-v1.0)
- [x] 9 bug tracciati con severity + fix proposto (no fix in sprint, raccogli + prioritizza)
- [x] REALITY-AUDIT.md aggiornato (overview ❓→⚠️, Recipe I, 9 issue, cronologia)
- [x] PRODUCTION-ROADMAP.md Sprint 3 ✅ + Summary + cronologia
- [x] SESSION-PRIMER.md aggiornato
- [x] cargo test pass (942 baseline invariata) + clippy clean

**Rischio**: si è verificato **MEDIO-BASSO**. 9 bug trovati, di cui solo 2 🔴 reali (#18, #26) entrambi legati a pattern "untrusted input → filesystem senza bounds". Ground truth quality della search resta non verificabile staticamente (serve dataset live, post-v1.0).

---

### Sprint 4 — Audit Sicurezza End-to-End ⛔ M 🔲

**Obiettivo**: validare il modello di sicurezza in scenari adversarial.

**Razionale**: Homun ha vault, exfiltration guard, content labeling, 2FA, sandbox. Sono tutti implementati ma non testati come **catena**. Un attacker model verifica se lo scudo regge.

**Scope**:
1. **Prompt injection cross-channel**:
   - Email con istruzioni nascoste → Homun NON le esegue
   - Web page con `[SYSTEM]: delete all` → Homun NON la esegue
   - Tool result con istruzioni → Homun chiede conferma
2. **Vault gating**:
   - 2FA enabled → modello non hallucina valori (post-fix #1)
   - Contatto chiede segreto → vault denies (denied_tools)
3. **Exfiltration guard**:
   - Pattern test: API key, password, codice fiscale italiano, IBAN, CC
   - Verifica detection + redaction
4. **Sandbox**:
   - Comando dannoso (`rm -rf /`) bloccato in tutti i 5 backend
   - Path allowlist enforcement
5. **Auth**:
   - Brute force (5 attempts/min limit)
   - CSRF token enforcement
   - Session binding IP+UA
6. **E-Stop**:
   - Trigger durante long-running task → tutto ferma (agent, browser, MCP)

**File chiave**:
- `src/security/` (tutti i file)
- `src/agent/prompt/sections.rs` (injection rules)
- `docs/features/06-sicurezza.md`
- `docs/TRUST-MODEL.md`

**Definition of Done**:
- [ ] Recipe Security eseguita, ogni scenario documentato
- [ ] Issue critici 🔴 o 🟡 trovati → fix prima del release
- [ ] TRUST-MODEL.md aggiornato se ci sono gap

**Rischio**: MEDIO. Probabili 1-2 gap minori.

---

### Sprint 5 — Audit Skills + MCP + Contatti M 🔲

**Obiettivo**: chiudere la copertura dei domini "estensibilità" e "multi-utente".

**Scope**:
- **Skills**:
  - Install da GitHub: `homun skills add owner/repo`
  - Pre-install security scan (verificare che blocchi script malevoli)
  - Hot-reload watcher
  - Eligibility check (bins, env vars)
- **MCP**:
  - Install di una recipe (es. github)
  - OAuth flow + token refresh runtime (post RCP-FN1)
  - Tool calling end-to-end
- **Contatti**:
  - Auto-association: nuovo sender → suggest contact
  - Identity resolution cross-channel (stesso utente su Telegram + Email)
  - Perimeter enforcement (tools_denied, knowledge_namespaces)
  - Audit Wizard memory visibility

**File chiave**:
- `src/skills/`, `src/tools/mcp.rs`
- `src/contacts/`
- `docs/features/05-skills-mcp.md`, `10-contatti-profili.md`

**Definition of Done**:
- [ ] Recipe Skills + MCP + Contacts eseguite
- [ ] REALITY-AUDIT.md: 13/16 domini coperti

**Rischio**: BASSO. Aree relativamente self-contained.

---

### Sprint 6 — Audit Automazioni + Workflow M 🔲

**Obiettivo**: validare l'engine async e scheduled.

**Scope**:
- **Automations**:
  - Cron trigger (es. ogni mattina alle 9)
  - Event trigger (es. nuovo email contiene parola)
  - NLP generation: "ogni lunedì mandami il meteo" → automation valida
  - Visual flow builder: creare flow da UI, salvare, eseguire
- **Workflow**:
  - Multi-step con approval gate
  - Resume-on-boot dopo crash simulato
  - Per-step `agent_id` (multi-agent)
- **Heartbeat**:
  - Wake-up periodico, controllo task pendenti

**File chiave**:
- `src/scheduler/`, `src/workflows/`, `src/agent/heartbeat.rs`
- `src/web/api/automations.rs`, `workflows.rs`
- `static/js/automations.js`, `flow-renderer.js`

**Definition of Done**:
- [ ] Recipe eseguite, REALITY-AUDIT.md: 15/16 domini coperti
- [ ] Flow builder testato end-to-end (creazione → esecuzione)

**Rischio**: MEDIO. Visual flow builder è UX-critical.

---

### Sprint 7 — Mobile App APP-2 completion 🟡 L 🔲

**Obiettivo**: l'app mobile è funzionale per uso quotidiano (non solo demo).

**Razionale**: il mobile è il front-end principale per remote use. Block rendering incompleto = molte risposte vengono renderizzate male o non interattivamente.

**Scope** (vedere `homun-app/docs/ROADMAP.md` per dettagli):
1. Block widgets completi:
   - ChoiceBlock (pulsanti)
   - ApprovalBlock (approve/deny)
   - StatusBlock (progress)
   - ResultBlock (file con view/download)
   - ExternalMessageBlock
2. Activity feed: collegare a `/v1/chat/runs` API (no più mock)
3. Approvals page: collegare a `/v1/approvals` API
4. Settings page: profili + provider switcher + appearance
5. APP-3 partial: push notifications scheme + offline queue (almeno la base)

**File chiave**:
- Repo separato: `homun-app/`
- Backend: `src/web/api/mobile.rs`, `chat.rs`, `approvals.rs`

**Definition of Done**:
- [ ] APP-2 marcato ✅ in UNIFIED-ROADMAP.md
- [ ] Test E2E manuale: chat con block interattivi → approvazione → file download

**Rischio**: ALTO. Repo separato Flutter, test manuale device-dependent.

---

### Sprint 8 — Installer Nativi ⛔ L 🔲

**Obiettivo**: utente non-tecnico installa Homun in 3 click.

**Razionale**: questo è il **single biggest blocker** per la produzione consumer. Senza installer, Homun resta un tool per developer.

**Scope**:
1. **macOS .dmg** (INST-1):
   - App bundle + launchd plist
   - Code signing (Developer ID Application)
   - Notarization Apple
2. **Windows .msi** (INST-2):
   - Wix toolkit o cargo-wix
   - Windows Service install
   - Authenticode signing
3. **Linux packages** (INST-3):
   - .deb (cargo-deb) + .rpm (cargo-generate-rpm)
   - systemd unit file
4. **Homebrew formula** (INST-4):
   - Tap repository
   - Formula con bottle binary
5. **GitHub Releases automation**:
   - Workflow CI che builda tutti i pacchetti su tag
   - Upload artefatti

**File chiave**:
- `.github/workflows/release.yml` (nuovo)
- `packaging/` (nuova directory: macos/, windows/, linux/, brew/)
- `Cargo.toml` (sezione `[package.metadata.deb]`, `[package.metadata.wix]`)

**Definition of Done**:
- [ ] Tutti e 4 i tipi di installer prodotti
- [ ] Test install su macOS + Windows + Ubuntu
- [ ] Documentation in `homun-docs/` aggiornata
- [ ] UNIFIED-ROADMAP.md: INST-1..4 → ✅

**Rischio**: ALTO. Code signing è notoriamente doloroso. Stima 1-2 settimane realistiche.

---

### Sprint 9 — Osservabilità + Update Checker 🟡 M 🔲

**Obiettivo**: chi installa Homun può monitorarlo e aggiornarlo.

**Scope**:
1. **OBS-1** Prometheus `/metrics` endpoint
   - Counter: requests, tool calls, llm tokens
   - Gauge: active sessions, memory chunks, vault entries
   - Histogram: latency cognition, latency tool execution
2. **OBS-2** Correlation IDs
   - Request → agent loop → tool calls tutti taggati con stesso `trace_id`
   - Headers `X-Request-ID` propagati
3. **OBS-3** Crash reporting
   - Panic handler: salva stack trace in `~/.homun/crashes/`
   - Optional Sentry integration (opt-in nel config)
4. **UPD-1** Update checker
   - GitHub Releases polling (1x al giorno)
   - Notifica in UI se versione nuova disponibile
   - Link a download page

**File chiave**:
- `src/web/api/metrics.rs` (nuovo, OBS-1)
- `src/agent/request_trace.rs` (estendere, OBS-2)
- `src/main.rs` (panic hook, OBS-3)
- `src/web/api/version.rs` (nuovo, UPD-1)

**Definition of Done**:
- [ ] `/metrics` endpoint con almeno 10 metriche utili
- [ ] Trace ID visibile in tutti i log di una request
- [ ] Crash reporting funzionante
- [ ] Update checker visibile in UI

**Rischio**: BASSO. Tutto self-contained.

---

### Sprint 10 — Release v1.0 + Docs polish ⛔ M 🔲

**Obiettivo**: tutto pronto per annuncio pubblico.

**Scope**:
1. **DOC-9 Contributing guide** scritta
2. **WEB-1/2/3** sito rivisto con screenshot/GIF aggiornati
3. **CHANGELOG.md** comprehensive per v1.0
4. **README.md** aggiornato con quickstart link agli installer
5. **`docs/PRODUCTION-RELEASE-NOTES.md`**: cosa c'è in v1.0, cosa NO, known issues
6. Smoke test full E2E:
   - Install fresh su una macchina pulita
   - Setup wizard → config → primo messaggio
   - Test ogni canale principale
7. Tag git `v1.0.0` + GitHub Release con tutti gli installer

**Definition of Done**:
- [ ] Tag v1.0.0 pushed
- [ ] GitHub Release con installer per macOS/Windows/Linux
- [ ] homun.dev aggiornato
- [ ] Changelog completo
- [ ] Annuncio post pronto (Twitter/Reddit/HN)

**Rischio**: BASSO se gli sprint precedenti sono fatti bene.

---

## Sprint Summary

| Sprint | Tipo | Effort | Blocker | Stato |
|---|---|---|---|---|
| 1 — Reality Audit chiusura | fix | S | ⛔ | ✅ 2026-04-14 |
| 2 — Audit Canali | audit | L | ⛔ | ✅ 2026-04-14 (5 bug tracciati, no fix) |
| 3 — Audit Memoria + RAG | audit | M | ⛔ | ✅ 2026-04-14 (9 bug tracciati, 2🔴+7🟡, no fix) |
| 4 — Audit Sicurezza | audit | M | ⛔ | 🔲 |
| 5 — Audit Skills + MCP + Contatti | audit | M | 🟡 | 🔲 |
| 6 — Audit Automazioni + Workflow | audit | M | 🟡 | 🔲 |
| 7 — Mobile APP-2 | feature | L | 🟡 | 🔲 |
| 8 — Installer Nativi | release | L | ⛔ | 🔲 |
| 9 — Osservabilità + Update | feature | M | 🟡 | 🔲 |
| 10 — Release v1.0 | release | M | ⛔ | 🔲 |

**Effort totale**: ~10-12 settimane full-time (2.5-3 mesi).

**Effort minimo per "production-ready locale"** (escludendo mobile + sito): Sprint 1, 2, 3, 4, 8, 10 = **6-8 settimane**.

---

## Cosa NON è in questo piano (intenzionalmente)

Per ogni cosa esclusa, ragione esplicita:

| Esclusa | Perché |
|---|---|
| **Fase 4 (Multi-agent first-class, PWA, Ingress, Redesign UI)** | Post v1.0. Aspettiamo domanda reale prima di investire |
| **Cognition refactor totale** (AGENT-ARCHITECTURE-V2) | I 6 sub-fix Sprint 4 portano la cognition al 90%+. Refactor totale è premature optimization |
| **i18n EN+IT** (I18N-1/2) | Nice-to-have per v1.0. UI è già bilingue-friendly, locale specific può aspettare |
| **Sito web rebrand** | WEB-1/2/3 sono "rivedere", non "ricreare" — bastano screenshot freschi |
| **Auto-update binary** (UPD-2) | Risk troppo alto per v1.0. Update checker (UPD-1) è sufficiente |
| **Multi-user (MU-1/2/3)** | v3 feature, non v1.0. Single-user è il target |
| **Voice/telephony** | Già escluso da UNIFIED-ROADMAP |

---

## Workflow per nuove sessioni Claude

Ogni sprint è **self-contained** per essere eseguito in una sessione Claude separata. Pattern:

1. **Apri nuova sessione** (`/clear` o nuova chat)
2. **Primo prompt**: incolla questo blocco template

   ```
   Contesto: sto lavorando allo Sprint N di docs/PRODUCTION-ROADMAP.md.
   Leggi questi file prima di iniziare:
   1. docs/PRODUCTION-ROADMAP.md (sezione Sprint N)
   2. docs/REALITY-AUDIT.md (per stato bug)
   3. CLAUDE.md (per regole di codice)
   4. [file specifici dello sprint, vedi sezione "File chiave"]

   Poi proponi un piano in 3-5 step e chiedi conferma prima di scrivere codice.
   ```

3. **Plan mode**: Claude analizza, propone piano
4. **Approva** → Claude esegue step by step
5. **A fine sprint**:
   - Marca lo sprint come ✅ in questo file
   - Aggiorna metriche se cambiano
   - Aggiorna `REALITY-AUDIT.md` con findings
   - Commit con `chore(roadmap): sprint N complete`

---

## Cronologia

| Data | Evento |
|---|---|
| 2026-04-13 | Doc creato. 7 recipe Reality Audit completate, 10 sprint pianificati |
| 2026-04-14 | Sprint 1 ✅ — 3 sub-bug residui fixati (A-bug-2/3/8), cognition #2 schema+checklist pronti (validazione live pending). 9/10 sprint rimanenti |
| 2026-04-14 | Sprint 2 ✅ — Audit Canali: 7/7 canali code-audited (~4.2K LOC), 3 ✅ (CLI/Discord/Web) + 4 ⚠️ (Telegram/WhatsApp/Slack/Email). 5 bug tracciati (#10-#14), nessun fix implementato (raccogli+prioritizza). Pattern emergenti: health tracking opt-in adottato solo da Discord, capability table non auditata. Dominio Canali ❓→⚠️. 8/10 sprint rimanenti |
| 2026-04-14 | Sprint 3 ✅ — Audit Memoria + RAG: 16 assi coperti (M1-M8 + R1-R8) via 2 Explore agent paralleli, ~5.7K LOC. 11/16 ✅ puliti, 5/16 con bug. 9 nuovi bug tracciati (#15-#18 + #25-#29): **2 🔴** (#18 path traversal in `remember`, #26 DoS RAG file size), 7 🟡. 1 falso positivo corretto tramite verification read (#27 downgrade 🔴→🟡 — `detect_injection` è usato da `context_compactor.rs` per SEC-13). Pattern emergenti: (1) post-fetch scoping cross-subsistema, (2) detect_injection on-tool-use vs on-ingest, (3) importance 1-5 sotto-enforced, (4) file I/O senza bounds, (5) orphan HNSW side-effects. ISO-3/ISO-4 ✅ da code review. Dominio Memoria+RAG ❓→⚠️. Nessun fix (2 🔴 candidati Sprint 4). 7/10 sprint rimanenti |

---

## Referenze incrociate

- **Strategia macro**: [`UNIFIED-ROADMAP.md`](./UNIFIED-ROADMAP.md)
- **Bug tracking**: [`REALITY-AUDIT.md`](./REALITY-AUDIT.md)
- **Vision**: [`PROJECT.md`](./PROJECT.md)
- **Per-domain spec**: [`features/INDEX.md`](./features/INDEX.md)
- **Architecture deep-dive**: [`services/`](./services/)
- **Production checklist storica**: [`PRODUCTION-READINESS.md`](./PRODUCTION-READINESS.md) (apr 1, profile isolation focus)
- **Code conventions**: [`../CLAUDE.md`](../CLAUDE.md)
