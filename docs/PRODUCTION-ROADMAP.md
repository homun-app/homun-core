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
> **Ultimo aggiornamento**: 2026-04-15 — Sprint 10 Fase A ✅, v1.0.0 pre-tag state

---

## Stato Attuale (snapshot) — 2026-04-15 post Sprint 10 Fase A

| Asse | Stato | Dettaglio |
|---|---|---|
| **Codebase** | ✅ v1.0.0 | 982 test (+34 Sprint 9 observability), 0 nuovi warning clippy, 121K LOC Rust, `Cargo.toml` version 1.0.0 + repository `homun-app/homun` |
| **Reality Audit** | ✅ 16/16 domini | Sprint 2+3+4+5+6 audit completati + Sprint 9 Osservabilità ✅ + Sprint 7 Mobile ✅. 47 bug tracciati (5 🔴 + 31 🟡 + 11 🟢), documentati in CHANGELOG.md Known Issues con workaround per ogni 🔴. Condivisione + Permission UX marcati "non-core v1.0, audit deferred post-v1.0" |
| **Strategy roadmap** | ✅ Fase 1+2 done | Hardening + Apertura completate. INST-1..4 + OBS-1..3 + UPD-1 + APP-1..2 tutti ✅. Fase 3 (Consumer) in wait-for-demand post-v1.0 |
| **Distribuzione** | ✅ v1.0 ready (Fase A) | Installer scaffolded + smoke runbook aggiornato con Sprint 9 verification. 4-lane maintainer VM smoke test pending (Fase B) |
| **Observability** | ✅ Sprint 9 done | `/metrics` + X-Request-ID trace ID + panic handler + crash reports + 4-channel submission + daily update checker |
| **Docs release** | ✅ v1.0 done (Fase A) | CHANGELOG.md v1.0.0 comprehensive + docs/PRODUCTION-RELEASE-NOTES.md nuovo + README.md user-facing refresh + CONTRIBUTING.md PolyForm-aware + smoke test runbook 4-lane |
| **Mobile app** | ✅ APP-2 done | APP-1 + APP-2 thread-first completati Sprint 7. APP-3 (push, offline, widget) rimandato post-v1.0 |
| **Split repo** | ⏸️ maintainer pending | Codice pronto, playbook `docs/MIGRATION-SPLIT-REPO.md` ready, Phase 1-9 = maintainer task Fase B (~30 min) |
| **Sito homun.app** | ⏸️ maintainer pending | Repo separato `homun-app/docs`, refresh pending maintainer Fase B |
| **Tag v1.0.0** | ⏸️ maintainer pending | Dipende da split repo migration + 4-lane smoke test + Apple cert (opzionale) |

**Fase A (Claude) completata 2026-04-15**: 5 commit puliti preparano tutto il materiale offline per v1.0. **Fase B (maintainer)**: split repo + smoke test reali + tag push + sito + announcement = handoff documentato in [`docs/PRODUCTION-RELEASE-NOTES.md`](./PRODUCTION-RELEASE-NOTES.md) "Handoff checklist".

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

### Sprint 4 — Audit Sicurezza End-to-End ⛔ M ✅ 2026-04-14

**Obiettivo**: validare il modello di sicurezza in scenari adversarial.

**Razionale**: Homun ha vault, exfiltration guard, content labeling, 2FA, sandbox. Sono tutti implementati ma non testati come **catena**. Un attacker model verifica se lo scudo regge.

**Risultato**:
- Audit sistematico via **static code-analysis** di 15 assi (S1-S15) coprendo security surface
- Parallelizzato con 3 Explore agent (batch A injection+exfil+vault leak, batch B auth+2FA+estop+pairing+devices, batch C sandbox 5 backend+FS ACL+cross-check Sprint 3), ~4K LOC coperti
- **10/15 assi ✅ puliti**: S1 safety prompt rules, S5 cross-channel labeling, S6 web auth+rate limit+CSRF, S7 2FA TOTP chain (post-fix #1), S8 e-stop propagation, S10 trusted devices + token revocation, S12 per-backend enforcement core (Docker/Bubblewrap/Seatbelt)
- **5/15 assi con gap**: S2 (injection detect short bypass), S3 (exfiltration PII coverage), S4 (vault leak tech debt), S9 (pairing DoS), S11+S13+S14+S15 (sandbox+ACL+cross-check)
- **9 nuovi bug tracciati** (**0 🔴** + 7 🟡 + 2 🟢), nessun fix implementato (raccogli e prioritizza, coerente con Sprint 2+3):
  - #30 🟡 Exfiltration: PII italiane mancanti (CF, IBAN, CC+Luhn, phone) + dual registry divergente
  - #31 🟡 Exfiltration single call site (`agent_loop.rs:3107`)
  - #32 🟡 `context_compactor.rs:19` skip-on-short <100 chars bypassa injection detect
  - #33 🟡 `vault_leak::resolve_vault_references` non valida key existence
  - #34 🟡 `remember` bypassa `check_path_permission` — second-line per Sprint 3 #18
  - #35 🟡 Sandbox silent fallback a None senza UI signal
  - #36 🟢 Seatbelt `append_allow_paths` non canonicalizza symlink
  - #37 🟡 Pairing `pending` HashMap unbounded DoS
  - #38 🟢 Dual `redact_vault_values` definitions (dead code)
- **2 falsi positivi corretti** in verification read:
  - "CSPRNG weakness in pairing": smentito — `rand = "0.8"` → `thread_rng()` usa `ReseedingRng<ChaCha12Core, OsRng>` (crypto-safe)
  - "pairing cleanup non auto-scheduled": smentito — `gateway.rs:579` spawna periodic task
- **Cross-check Sprint 3**:
  - #18 path traversal: confermato aperto + aggravato (nuovo #34 no second-line)
  - #26 RAG DoS: confermato, **nessun `DefaultBodyLimit` trovato in `src/web/`** (axum multipart unlimited by default)
  - #27 detect_injection on-tool-use: confermato design OK, nuovo gap #32 short-bypass
- **Pattern architetturali emersi**:
  1. Single-call-site defenses: `redact()` chiamato 1 volta (fragile)
  2. Dual pattern registries: exfiltration.rs vs rag/sensitive.rs divergono su PII
  3. Skip-on-short: perf vs safety trade-off errato
  4. Second-line missing: `remember` non usa l'ACL system disponibile
  5. Silent fallback: sandbox auto→None (stesso pattern di #10 capability drift)
- **Attacker model live scenari NON eseguiti** (code-only audit): email injection, web page injection, sandbox `rm -rf`, brute force auth, CSRF, e-stop durante long task. Rimandati a futuro "Sprint Fix Sicurezza" che metterà in opera le difese pre-validate qui.
- Dominio "Sicurezza" ✅ → ⚠️ in REALITY-AUDIT overview (downgrade da ✅ 2026-04-13 "solo vault 2FA verified")
- 942 test pass, clippy produzione clean (nessuna modifica codice in questo sprint)
- 1 commit doc-only pulito

**Scope** (recipe stile Reality Audit, eseguita come annunciato):
1. ✅ **Prompt injection cross-channel**: S1 safety rules + S5 labeling ✅, S2 detect_injection ⚠️ (#32 short bypass)
2. ✅ **Vault gating + 2FA**: S7 ✅ (post-fix #1 verified), S10 ✅ token revocation immediata
3. ✅ **Exfiltration guard**: S3 ⚠️ (#30 PII mancanti, #31 single call site), S4 ⚠️ (#33 fabricated refs, #38 dead code)
4. ✅ **Sandbox**: S11 ⚠️ (#35 silent fallback), S12 ✅ per-backend core OK, S13 ⚠️ (#36 symlink), S14 ⚠️ (#34 remember bypass)
5. ✅ **Auth**: S6 ✅ (PBKDF2 600k constant-time, sliding window rate limit, CSRF HttpOnly+Secure+SameSite)
6. ✅ **E-Stop**: S8 ✅ (sequenza corretta stop→network→browser→MCP→subagents)
7. ✅ **Pairing**: S9 ⚠️ (#37 HashMap unbounded, ma CSPRNG OK e cleanup auto-scheduled — 2 FP corretti)
8. ✅ **Cross-check Sprint 3**: S15 ❌ (#18 aggravato, #26 nessuna difesa residua, #27 #32 gap)

**File chiave** (tutti auditati):
- ✅ `src/security/{exfiltration,estop,pairing,totp,two_factor,vault_leak}.rs`
- ✅ `src/agent/{prompt/sections,context_compactor,agent_loop,memory}.rs`
- ✅ `src/tools/{vault,remember,file}.rs` + `src/tools/sandbox/{mod,resolve,backends}.rs`
- ✅ `src/web/{auth,api/devices,api/account}.rs`
- ✅ `src/browser/site_memory.rs` (cross-check #18)
- ✅ `Cargo.toml` (rand version verification → falso positivo CSPRNG corretto)
- ✅ `docs/features/06-sicurezza.md` + `docs/TRUST-MODEL.md` (spec confermata coerente)

**Definition of Done**:
- [x] Recipe Security eseguita, ogni scenario tracciato con evidenza path:line
- [x] Tabella "Verified security" 15×stato in REALITY-AUDIT.md
- [x] 9 bug tracciati con severity + fix proposto (no fix in sprint, raccogli + prioritizza)
- [x] 2 falsi positivi corretti in verification read + documentati per metodo futuro
- [x] Cross-check findings Sprint 3 (#18, #26, #27) completato
- [x] Dominio "Sicurezza" degradato a ⚠️ con evidenza recente 2026-04-14
- [x] REALITY-AUDIT.md aggiornato (overview ✅→⚠️, Recipe J, 9 issue, cronologia)
- [x] PRODUCTION-ROADMAP.md Sprint 4 ✅ + Summary + cronologia
- [x] SESSION-PRIMER.md aggiornato
- [x] cargo test pass (942 baseline invariata) + clippy produzione clean

**Rischio**: si è verificato **BASSO**. 0 bug 🔴 in Sprint 4 (il modulo core auth/vault/e-stop è solido). I 7 🟡 sono tutti su coverage e visibilità, non su safety critica. I 2 FP corretti mostrano che il metodo "verification read prima di committare 🔴" funziona — senza sarebbero stati 2 fix non necessari.

---

### Sprint 5 — Audit Skills + MCP + Contatti + Profili M ✅ 2026-04-14

**Obiettivo**: chiudere la copertura dei domini "estensibilità" (Skills + MCP) e "multi-utente" (Contatti + Profili). Cross-check ISO-3 cross-subsystem (Sprint 3 aveva verificato solo memoria+RAG).

**Risultato**:
- 3 domini (Skills + MCP + Contatti + Profili) auditati via **static code-analysis** (~15.5K LOC Rust totali — più grande audit Sprint finora)
- Parallelizzato con 3 Explore agent (Batch A Skills, Batch B MCP, Batch C Contatti + Profili), 16 assi totali (SK1-SK6 + M1-M4 + C1-C6)
- **14 nuovi bug tracciati (0 🔴 + 11 🟡 + 3 🟢)**: #39-#56 — tutti coverage/hardening gaps, nessuna rottura funzionale
- **8 falsi positivi corretti** in verification read (record Sprint 5, vs 1 Sprint 3 + 2 Sprint 4): 4 su C3 perimeter enforcement (agent_loop.rs:844/858/1031/888 prova tutto), C5-2 vault profile scoping (vault.rs:36), C5-3 skills profile scoping (loader.rs:72), Skills trust model #34, MCP M3-5 error propagation
- **ISO-3 cross-subsystem verified**: 5/7 sottosistemi profile-scoped correttamente (memoria + RAG + vault + skills + contact perimeter). Gap: MCP #55 singleton globale, gateway overrides #56 no cross-profile validation
- **Pattern architetturali confermati**:
  - **Agent confidence ≠ correctness**: verification read è non-opzionale per i 🔴
  - **ISO-3 pattern consolidato**: `*_for_profile()` + `scan_*_with_profile()` + `load_perimeter()` è lo schema replicabile
  - **Single call site fragile** (cross Sprint 4 #31): #44 conferma, skill executor output bypassa redact
  - **Silent unsafe default** (cross Sprint 4 #35): #42 conferma, creator smoke test unsandboxed
  - **Vault key hardcoded asymmetry**: #47 preset MCP collidono per multi-instance vs skills profile-scoped
- Dominio "Skills + MCP" passa da ❓ a ⚠️ in REALITY-AUDIT overview
- Dominio "Contatti + Profili" passa da ❓ a ⚠️ in REALITY-AUDIT overview
- 13/16 domini coperti (verso target 16/16 per v1.0)
- Totale bug aperti: 23 → 37 (+14 Sprint 5), 4 🔴 totali invariati (#10, #11, #18, #26)
- 942 test pass, clippy produzione clean (nessuna modifica codice in questo sprint)
- 1 commit doc-only pulito

**Scope originale (eseguito)**:
- **Skills** (6 assi SK1-SK6): SK1 install GitHub, SK2 pre-install security scan, SK3 hot-reload watcher, SK4 eligibility + invocation policy, SK5 LLM creator, SK6 adapter legacy manifest
- **MCP** (4 assi M1-M4): M1 install recipe + OAuth init, M2 token refresh runtime, M3 tool calling end-to-end, M4 server lifecycle
- **Contatti + Profili** (6 assi C1-C6): C1 auto-association, C2 identity resolution, C3 perimeter enforcement, C4 context injection, C5 ISO-3 cross-subsystem, C6 wizard memory visibility

**File auditati**:
- Skills: `src/skills/*.rs` (11 file), `src/tools/skill_create.rs`, `src/agent/skill_activator.rs`
- MCP: `src/tools/mcp.rs`, `src/tools/mcp_token_refresh.rs`, `src/mcp_setup.rs`, `src/skills/mcp_registry.rs`, `src/web/api/mcp/*.rs` (6 file)
- Contatti + Profili: `src/contacts/*.rs`, `src/profiles/*.rs`, `src/gateways/*.rs`, `src/agent/profile_resolver.rs`, `src/web/api/contacts.rs`, `profiles.rs`
- Cross-check: `src/agent/agent_loop.rs` (call sites perimeter/redact), `src/tools/vault.rs`

**Definition of Done**:
- [x] 16 assi auditati (SK1-SK6 + M1-M4 + C1-C6)
- [x] Tabelle "Verified Skills" + "Verified MCP" + "Verified Contacts + Profiles" in REALITY-AUDIT.md
- [x] 14 bug tracciati come #39-#56 con severity + location + fix proposto
- [x] 8 falsi positivi corretti in verification read + documentati per metodo
- [x] Cross-check findings Sprint 4 (#31, #32, #34, #35, #37, S8) completato
- [x] ISO-3 cross-subsystem table finale (5/7 verified + 2 gap documentati)
- [x] REALITY-AUDIT.md aggiornato (overview Skills+MCP e Contatti+Profili ❓→⚠️, Recipe K, 14 issue + 8 FP, cronologia)
- [x] PRODUCTION-ROADMAP.md Sprint 5 ✅ + Summary + cronologia
- [x] SESSION-PRIMER.md aggiornato (13/16 domini, 37 bug)
- [x] cargo test pass (942 baseline invariata) + clippy produzione clean

**Rischio**: si è verificato **BASSO**. 0 bug 🔴 in Sprint 5. I 11 🟡 sono tutti coverage + defense-in-depth + design gap. Gli 8 FP sono il segnale più importante: il metodo "agent parallelo" è potente ma non sufficiente senza verification read. Pattern consolidato → addendum in CLAUDE.md.

---

### Sprint 6 — Audit Automazioni + Workflow M ✅ 2026-04-14

**Obiettivo**: validare l'engine async e scheduled (automations + workflow + heartbeat), chiudere la tabella ISO-3 cross-subsystem con l'ultimo sottosistema rimanente.

**Risultato**:
- 3 sottosistemi (Automations + Workflow Engine + Heartbeat) auditati via **static code-analysis** (~11K LOC Rust+JS totali)
- Parallelizzato con 3 Explore agent (Batch A Automations ~5K LOC 6 assi A1-A6, Batch B Workflow+Heartbeat ~2K LOC 6 assi W1-W4+H1-H2, Batch C Cross-check Sprint 3+4+5 findings 6 pattern), 16 assi totali
- **10 nuovi bug tracciati (1 🔴 + 6 🟡 + 3 🟢)**: #57-#66
- **1 nuovo 🔴 critico** — primo nuovo 🔴 in 2 sprint (Sprint 4+5 avevano 0 🔴 nuovi): **#57** automations+workflow profile_id stored in DB ma NON enforced a fire time. Due manifestazioni con unico root cause: (1) `CronEvent` struct (cron.rs:17-26) manca il campo profile_id → prompt path risolve profile via resolver cascade → global default; (2) `execute_step` (workflows/engine.rs:481-483) non chiama `set_session_profile_id` prima di `process_message`, e `process_message` signature manca profile_id parameter. **Chiude la tabella ISO-3 cross-subsystem** con il 3° gap architetturale
- **2 falsi positivi corretti** in verification read:
  1. **A2 "Event triggers never evaluated"** (Batch A) — `evaluate_automation_trigger` esiste a `scheduler/automations.rs:864`, chiamato da 811 via `evaluate_and_complete_automation_run`. Agent aveva saltato la call chain
  2. **Batch C "automations profile-scoped ✅"** — **contraddizione cross-batch** con Batch A+B. Verification read ha distinto "stored in DB" da "enforced at fire time" (Batch A+B corretti)
- **FP count cumulativo cross-sprint**: Sprint 3:1 + Sprint 4:2 + Sprint 5:8 + Sprint 6:2 = **13 FP totali**. Pattern "agent confidence ≠ correctness" riconfermato. Sprint 6 è **il primo sprint dove la verification read ha evitato una contraddizione interna silente** (A5 vs #55) invece di solo correggere un verdetto singolo
- **ISO-3 cross-subsystem — tabella finale chiusa**: 4/7 ✅ (memoria+RAG, vault, skills, contact perimeter) + 2 ⚠️ (MCP #55, gateway overrides #56) + 2 ❌ (automations+workflow #57). Tutti e 3 i gap sono architetturali, non rotture funzionali
- **Pattern architetturali nuovi Sprint 6**:
  - **"Stored ≠ enforced" anti-pattern** (NEW): variante negativa del pattern ISO-3 consolidato. Campo presente in DB ma mai propagato al runtime via `set_session_profile_id` o equivalente. Il fix strutturale richiede estensione signature `process_message` o introduzione `forced_profile_id` in `MessageMetadata`
  - **Single call site redact** (3° manifestazione — cross #31 Sprint 4 + #44 Sprint 5): #60 automation/workflow results API unredacted. Il trait `OutputSink` proposto Sprint 5 diventa sempre più giustificato
  - **Unbounded pending state** (cross #37 Sprint 4): #61 workflow approval gate no timeout. Stessa classe bug del pairing HashMap
  - **DRY violation vs utils/retry.rs** (NEW prima istanza concreta): #65 workflow retry home-grown immediate. CLAUDE.md regola esplicita violata
  - **Feature declared, disabled in production** (NEW): #64 HeartbeatService defined + tested ma zero call site in produzione. Da cercare altrove come anti-pattern
- Dominio "Automazioni + Scheduling" passa da ❓ a ⚠️ in REALITY-AUDIT overview
- Dominio "Workflow Engine" passa da ❓ a ⚠️ in REALITY-AUDIT overview
- **15/16 domini coperti** (resta solo Osservabilità; Mobile + Condivisione tracciati ma non audit-core per v1.0)
- Totale bug aperti: 37 → 47 (+10 Sprint 6), **5 🔴 totali** (era 4) — primo nuovo 🔴 in 2 sprint
- 942 test pass, clippy produzione clean (nessuna modifica codice in questo sprint)
- 1 commit doc-only pulito

**Scope originale (eseguito)**:
- **Automations** (6 assi A1-A6): A1 cron trigger, A2 event trigger, A3 NLP flow generation, A4 visual flow canvas, A5 ISO-3 profile scoping (gap closure), A6 safety enforcement
- **Workflow Engine** (4 assi W1-W4): W1 resume-on-boot, W2 approval gate UX, W3 per-step agent_id, W4 retry + error propagation
- **Heartbeat** (2 assi H1-H2): H1 proactive wake-up, H2 idempotency + safety
- **Cross-check Sprint 3+4+5** (6 pattern): #31, #34, #35, #47, #55, #56 su tutti e 3 i sottosistemi

**File auditati**:
- Scheduler: `src/scheduler/{cron,automations,db,mod}.rs` (~2.2K LOC)
- Workflow: `src/workflows/{engine,db,mod}.rs` (~1.5K LOC)
- Heartbeat: `src/agent/heartbeat.rs` (104 LOC — full read)
- Tools: `src/tools/{automation,workflow}.rs`
- Web API: `src/web/api/{automations,workflows}.rs`
- JS: `static/js/{automations,flow-renderer,auto-validate,workflows}.js`
- Cross-check: `src/agent/gateway.rs` (CronEvent dispatch + InboundMessage builder), `src/agent/agent_loop.rs` (profile resolution 712-777 + process_message 384-390)
- Verification reads (6): cron.rs:17-26 struct, cron.rs:288-295 fire path, gateway.rs:1568-1581 InboundMessage, agent_loop.rs:712-777 cascade, workflows/engine.rs:481-483 execute_step, grep `set_session_profile_id` (4 call sites, 0 in scheduler/workflows)

**Definition of Done**:
- [x] 16 assi auditati (A1-A6 + W1-W4 + H1-H2)
- [x] Tabelle "Verified Automations" + "Verified Workflow" + "Verified Heartbeat" in REALITY-AUDIT.md
- [x] 10 bug tracciati come #57-#66 con severity + location + fix proposto
- [x] 2 falsi positivi corretti in verification read + documentati per metodo
- [x] Cross-check findings Sprint 3+4+5 (#31, #34, #35, #47, #55, #56) completato con tabella
- [x] ISO-3 cross-subsystem table finale chiusa (4✅ + 2⚠️ + 2❌ = 8/8)
- [x] REALITY-AUDIT.md aggiornato (overview Automazioni+Workflow ❓→⚠️, Recipe M, 10 issue + 2 FP, cronologia)
- [x] PRODUCTION-ROADMAP.md Sprint 6 ✅ + Summary + cronologia
- [x] SESSION-PRIMER.md aggiornato (15/16 domini, 47 bug)
- [x] cargo test pass (942 baseline invariata) + clippy produzione clean

**Rischio**: si è verificato **MEDIO** (come da attesa). **1 🔴 scoperto** (#57 ISO-3 gap) — atteso visto che Sprint 6 era l'ultimo gap ISO-3 cross-subsystem da chiudere. Verification read ha **evitato una contraddizione silente** tra batch A+B e batch C che altrimenti sarebbe stata committata. Il metodo "3 agent paralleli + verification read" si conferma robusto per audit multi-file, ma **serve anche per risolvere conflitti inter-batch**, non solo per validare 🔴 singoli.

---

### Sprint 7 — Mobile App APP-2 completion 🟡 L ✅ 2026-04-14

**Obiettivo**: l'app mobile è funzionale per uso quotidiano (non solo demo).

**Risultato**:
- **APP-2 marcato ✅** con 11 commit granulari tra homunbot + homun-app
- **Pivot thread-first confermata**: "Activity feed" e "Approvals page" esplicitamente rimossi dallo scope (decisione di prodotto del team mobile, documentata in `homun-app/docs/ROADMAP.md` e `homun-app/README.md`)
- **Triage di 5700 righe uncommitted su `main` di homun-app** in 8 commit logici (docs, deps, platform, theme, core, chat models+data, chat UI, shell+app), prima c'era 1 solo commit e tutto il lavoro APP-2 era a rischio
- **5 block widgets verificati funzionanti**: tutti e 5 (choice, approval, status, result, external_message) renderizzano con tap handlers e `block_response` wired
- **Profile switcher thread-scoped già implementato**: `_ThreadProfileChip` in topbar di `chat_thread_page.dart` chiama `/v1/chat/profile` via `chatRepository.updateProfile`
- **3 bug di robustness fix**:
  1. `ApprovalBlock` ora ha confirmation sheet (approve E deny, mirror del pattern `_handleChoiceSelected`) — evita tap accidentale su deny irreversibile
  2. `_pendingAssistantBlocks` preserved cross `_refreshHistory` — se socket disconnette mid-stream tra 'blocks' e 'response' event, i block vengono riattaccati all'ultimo assistant message su reconnect
  3. `_ThreadProfileChip` con `onRetry` — se profile load fallisce, chip mostra "Profilo offline · riprova" con warn color, tap retry invece di aprire sheet
- **Cross-stack fixture contract** con 5 JSON fixtures (`docs/block-fixtures/` source of truth + byte-identical copy in `homun-app/test/fixtures/blocks/`) + 6 nuovi test Rust + 6 nuovi test Flutter → schema drift tra backend Rust e client Flutter diventa CI failure
- **Polish UX**: drawer `_DrawerConversationDot` distingue "running" (ok/verde pulsante) da "needs attention" (warn/ambra statico) via Semantics labels
- **Defense-in-depth cross bug #60**: ResultBlock field values sono masked client-side quando label matcha pattern sensibili (token|password|secret|api_key|bearer|credential|auth_key|private_key|access_key) — preserva primi 3 char + max 12 bullets
- **Test**: 948 Rust test pass (+6 fixture), 26 Flutter test pass (+15 nuovi), `flutter analyze` invariato (3 info pre-esistenti), `cargo test` baseline 942→948
- **Doc reconciliation**: PRODUCTION-ROADMAP Sprint 7 riscritto, UNIFIED-ROADMAP APP-2 → ✅ con nota thread-first, SESSION-PRIMER cronologia

**Scope reale eseguito** (diverso da quello originalmente pianificato — audit del PRODUCTION-ROADMAP ha scoperto drift con il mobile team ROADMAP):
1. **Triage + baseline commit** di 5700 righe uncommitted (8 commit logici)
2. **Fix 3 rischi** flaggati da code review: approval confirm dialog, pending blocks preserve, profile retry
3. **Cross-stack fixture contract** + 12 nuovi test (Rust + Flutter)
4. **Polish UX**: drawer badge distinction + ResultBlock client-side redact
5. **Doc reconciliation** + generate Sprint 8 prompt

**Scope cancellato** (out-of-sync vs mobile ROADMAP):
- ❌ Activity feed separata (rimossa per product decision thread-first)
- ❌ Approvals page separata (rimossa per product decision thread-first)
- ❌ Block widgets "completi" (già implementati tutti e 5 pre-sprint, solo validati)
- ❌ Settings page profili+provider+appearance (già implementata pre-sprint come ProfilePage)
- ❌ APP-3 base push notifications / offline queue (rimandato a sprint futuro dedicato APP-3)

**File chiave**:
- Repo separato: `homun-app/` (committed as 11 commits Sprint 7, da 1 solo commit a 12 totali)
- Backend: `src/tools/response_blocks.rs` (+144 righe test), `docs/block-fixtures/` (nuova, 5 JSON + README)

**Commit**:
- **homunbot**: `bba8891 test(response_blocks)` (fixtures + Rust cross-stack tests)
- **homun-app**: `56e55d6 docs(app)` + `3d89f54 chore(deps)` + `870b082 chore(platform)` + `426cac4 feat(theme)` + `ea9aab8 feat(core)` + `bbdd9b1 feat(chat) models+data` + `6f4af82 feat(chat,pairing) UI` + `6dcd778 feat(shell,app)` + `81dd99f fix(chat) 3 risks` + `3a9d1b4 test(chat) cross-stack` + `da16c03 feat(chat) polish`

**Bug cross-check Sprint 3-6 addressed**:
- ✅ **#60** (workflow results unredacted): mitigato client-side via ResultBlock redact (defense-in-depth, il fix server-side resta aperto — è un gap OutputSink trait cross-subsystem)
- 📝 **#57** (ISO-3 profile_id stored not enforced): **NON risolto** — è un backend gap, fuori scope mobile. Il client mobile espone comunque il profile attivo via `_ThreadProfileChip`, ma il profile displayed può essere quello risolto al fire time dell'automation (che cade al global default). Serve Sprint Fix ISO-3 dedicato.
- 📝 **#62** (workflow approval no 2FA server-side): **NON risolto in questo sprint** — il mobile avrebbe bisogno di biometric-gate per ApprovalBlock con flag `require_2fa`, ma il flag server-side non esiste ancora. Il biometric lock app-level (`app_lock_provider`) già chiede autenticazione all'apertura dell'app, che è una difesa parziale.

**Definition of Done**:
- [x] APP-2 marcato ✅ in UNIFIED-ROADMAP.md (con nota thread-first pivot)
- [x] Test E2E verified via test harness: parse → render → interact → block_response → backend recv (cross-stack fixture suite)
- [x] 11 commit granulari conventional, no Co-Authored-By
- [x] cargo test pass (948) + flutter test pass (26) + flutter analyze clean
- [x] PRODUCTION-ROADMAP Sprint 7 ✅, SESSION-PRIMER cronologia, Sprint 8 prompt generato

**Rischio rivisto a posteriori**: era marcato ALTO a priori (repo separato Flutter, test manuale device-dependent), in realtà è stato **BASSO-MEDIO** perché: (a) tutto il codice APP-2 era già scritto pre-sprint, il lavoro era triage + polish + test + doc, (b) test cross-stack ha rimpiazzato il test manuale device-dependent per la parte block contract, (c) nessun test manuale su device reale è stato richiesto visto che le 26 unit+widget test coprono il contract backend/client.

**Discovery chiave**: **PRODUCTION-ROADMAP Sprint 7 era out-of-sync con `homun-app/docs/ROADMAP.md`** da almeno 2 settimane. Lo sprint ha iniziato trovando questo gap (Activity feed + Approvals page già rimossi dal mobile team ma ancora nello scope PRODUCTION-ROADMAP) e ha rigenerato lo scope in base al ROADMAP mobile reale. **Lesson consolidata: gli audit Sprint 2-6 cercavano drift tra spec funzionale e codice Rust — Sprint 7 ha mostrato che lo stesso drift può esistere tra doc tattici homunbot e doc di dominio di repo collegati.** Pattern "agent confidence ≠ correctness" si estende a "my-own-doc ≠ reality".

---

### Sprint 8 — Installer Nativi ⛔ L ✅ 2026-04-14

**Obiettivo**: utente non-tecnico installa Homun in 3 click.

**Razionale**: questo è il **single biggest blocker** per la produzione consumer. Senza installer, Homun resta un tool per developer.

**Pivot strategico a metà Sprint**: INST-2 (Windows .msi) rescopato a **Windows-via-WSL2** dopo analisi costi Authenticode cert ($600-900 primo anno + HSM). Vedi bug #67 in REALITY-AUDIT.md per la decisione completa.

**Scope realizzato**:
1. **macOS .dmg** (INST-1) ✅:
   - `packaging/macos/Info.plist.template` — bundle metadata versioned
   - `packaging/macos/homun-launcher` — shell wrapper che spawna `homun gateway` background + apre browser su localhost:8777
   - `packaging/macos/create-dmg.sh` — end-to-end con 3 modalità (unsigned, signed, signed+notarized) gate su env vars Apple
   - Smoke test locale unsigned: `Homun-0.1.0-arm64.dmg` 12MB, mount verified, bundle structure OK
2. **Windows via WSL2** (INST-2 rescopato) ✅:
   - `docs/INSTALL-WINDOWS-WSL.md` — guida completa step-by-step con 3 startup modes (foreground, systemd in WSL, Windows Task Scheduler), 3 gotchas documentati (vault file-based, WSL hibernation, Windows Defender), sezione troubleshooting
   - `packaging/windows/README.md` — placeholder docs la decisione + riserva la directory per futuro .msi
   - Bug #67 tracciato come 📝 DEFERRED (non-bug, tracked decision)
3. **Linux packages** (INST-3) ✅:
   - `packaging/linux/homun.service` — unit systemd system-level con hardening completo
   - `packaging/linux/debian/{postinst,prerm,postrm}` — maintainer scripts (system user, purge semantics)
   - `Cargo.toml [package.metadata.deb]` + `[package.metadata.generate-rpm]`
   - Smoke test locale: `homun_0.1.0-1_arm64.deb` (metadata + layout verified), `homun-0.1.0-1.x86_64.rpm` (v3 binary produced)
4. **Homebrew formula** (INST-4) ✅:
   - `packaging/brew/homun.rb.template` — formula ibrida binary-bottle + source-fallback
   - `packaging/brew/README.md` — documenta setup manuale del tap repo `homunbot/homebrew-tap` (azione utente)
5. **GitHub Releases automation** ✅:
   - `.github/workflows/release.yml` — triggered su `v*` tag, matrix Linux (amd64+arm64) + macOS (x64+arm64), no Windows runner, graceful signing fallback, env-routed inputs per injection safety, sha256 checksums + gh release upload --clobber

**File chiave creati** (9 file, 1210 righe):
- `.github/workflows/release.yml` (318 righe)
- `packaging/linux/{homun.service, debian/postinst, debian/prerm, debian/postrm}`
- `packaging/macos/{Info.plist.template, homun-launcher, create-dmg.sh}`
- `packaging/brew/{homun.rb.template, README.md}`
- `packaging/windows/README.md`
- `docs/INSTALL-WINDOWS-WSL.md`
- `docs/INSTALLER-SIGNING-SETUP.md`
- `docs/INSTALLER-SMOKE-TEST.md`
- `Cargo.toml` (+72 righe metadata deb + rpm)

**Cross-check vincoli Sprint 4-5** (verification read):
- **Keychain namespace** `dev.homun.secrets`: solo call site in `src/storage/secrets.rs:29`, invariato. Upgrade path build-from-source → installer non rompe vault esistente ✅
- **Data paths**: tutti via `dirs::home_dir().join(".homun")`, tolleranti a `HOME` override usato nei systemd unit e maintainer script ✅
- **Skills preservation**: `apt remove` preserva `~/.homun/skills/`, solo `apt purge` wipe ✅

**Definition of Done**:
- [x] INST-1 macOS .dmg unsigned path funzionante (smoke test locale), signed path scaffolded (gated su Apple secrets, doc completa in INSTALLER-SIGNING-SETUP.md)
- [x] INST-2 Windows — rescopato a WSL2 path, guida completa INSTALL-WINDOWS-WSL.md, #67 tracciato
- [x] INST-3 Linux .deb + .rpm + systemd unit prodotti e validated localmente
- [x] INST-4 Homebrew formula scaffold + tap repo setup docs
- [x] `.github/workflows/release.yml` builda tutti i pacchetti su tag push, graceful degradation signed/unsigned
- [x] `docs/INSTALLER-SMOKE-TEST.md` con procedure fresh-install per 3 OS + stato corrente
- [x] `docs/INSTALLER-SIGNING-SETUP.md` con step-by-step Apple cert + Authenticode future path
- [x] UNIFIED-ROADMAP.md INST-1..4 → ✅
- [x] Bug #67 tracciato in REALITY-AUDIT (scelta tecnica, non bug)
- [x] 948 Rust test pass, cargo clippy clean

**Rischio**: MITIGATO. Il pivot WSL elimina la parte più dolente (Windows signing). macOS signing resta come task follow-up **user-side** (il maintainer configura i 6 GitHub Secrets seguendo INSTALLER-SIGNING-SETUP.md — azione 30 min).

**Artefatti da test tag push reale**: Sprint 8 ha committato lo scaffolding ma **non ha pushato un tag `v*`** — il primo vero end-to-end release-workflow run avverrà quando il maintainer decide di tagger un `v0.1.1`. È l'ultima validazione prima di considerare Sprint 8 pienamente chiuso.

---

### Sprint 9 — Osservabilità + Update Checker 🟡 M ✅ 2026-04-15

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

### Sprint 10 — Release v1.0 + Docs polish ⛔ M ✅ 2026-04-15 (Fase A — Claude)

**Obiettivo**: tutto il materiale offline pronto per la release v1.0. Il tag push + smoke test reali + sito refresh + announcement restano maintainer task (Fase B).

**Risultato Fase A (Claude)**: 5 commit puliti preparano tutto quello che si può preparare senza accesso a VM / GitHub UI / homun.app repo.

**Scope Fase A (Claude)**:
1. ✅ **Version bump v1.0.0 + URL migration `homunbot/homun` → `homun-app/homun`** (commit `15285fa`)
   - `Cargo.toml` version `0.1.0` → `1.0.0` + `repository` URL
   - 12 file docs/packaging/CI aggiornati con URL nuovo
   - `env!("CARGO_PKG_VERSION")` propaga automaticamente al codice (zero `.rs` toccati)
2. ✅ **CHANGELOG.md v1.0.0 comprehensive + `docs/PRODUCTION-RELEASE-NOTES.md`** (commit `3346472`)
   - CHANGELOG Keep a Changelog format, 17 sezioni Added per 16 domini + Mobile, Changed pivot mobile+Windows+cognition+license, Removed Business Autopilot, Security 6 audit summary + 47 bug + 13 FP pattern, Fixed batch pre-Sprint 2, Infrastructure 982 test, Known Issues tabella esplicita dei 5 🔴 con workaround
   - PRODUCTION-RELEASE-NOTES maintainer-facing: executive summary, what's NOT in v1.0 (7 esclusioni con reasoning), compatibility matrix (OS + LLM tier A/B/C + channel maturity + sandbox), upgrade path v0.2→v1.0, post-release monitoring 7 giorni, known issues fix effort estimates, 6 scenari "what could go wrong", handoff checklist, rollback plan
3. ✅ **README.md user-facing refresh + CONTRIBUTING.md** (commit `ce81e83`)
   - README nuovo tagline "Single binary. Privacy-first. Local-first. Multi-channel.", Quick install 4-target (macOS .dmg/brew, Ubuntu/Debian .deb, Fedora/RHEL .rpm, Windows WSL2), "What you get" 17 bullet, CLI commands, Documentation links, Docker demotato ad Advanced, PolyForm license explicit
   - CONTRIBUTING nuovo: license model explanation (PolyForm non-OSI, source private), what you CAN contribute (bugs/features/crashes/docs), what you CANNOT (source PRs/binary redistribution), security vulnerability reporting + audit access request, code of conduct, release cadence
4. ✅ **INSTALLER-SMOKE-TEST.md runbook v1.0 + Sprint 9 verification** (commit `c3f70de`)
   - Version + URL migration nei command examples
   - Common checklist 7 → **11 check**: 8 crash reporter (panic controllato → JSON file redatto), 9 `/metrics` endpoint Prometheus format, 10 X-Request-ID echo + log grep, 11 update checker chip con dummy tag
   - Evidence tarball instruction (save logs+crashes+metrics per target)
   - Nuova sezione "Release v1.0 runbook" 4-lane parallelo (Ubuntu .deb / Fedora .rpm / macOS signed .dmg / Windows WSL2) + decision tree su failure + Sprint 9 observability non-negoziabile
   - Status table: 11 target tutti ⏸️ maintainer VM pending (Claude non può eseguire smoke test da questa sessione)
5. ✅ **Doc reconciliation + Ad-interim Ops Notes** (commit corrente)
   - PRODUCTION-ROADMAP Sprint 10 ✅ + Summary + cronologia
   - UNIFIED-ROADMAP Fase 2 closing banner + "Post-v1.0 Steady State" nuova sezione
   - SESSION-PRIMER stato "v1.0 released (Fase A done, Fase B pending maintainer)"
   - features/INDEX.md metrics bumped (982 test, 53 migrations, 16/16 domini)
   - CLAUDE.md scale update (982 test, production status bump)
   - REALITY-AUDIT.md: Mobile + Osservabilità ✅, Condivisione + Permission UX marcati "non-core v1.0, audit deferred"
   - Blocco "Ad-interim Ops Notes post-v1.0" generato in chat come reference doc maintainer

**Scope Fase B (maintainer — handoff post Claude)**:
1. ⏸️ Eseguire `docs/MIGRATION-SPLIT-REPO.md` Phase 1-9 (~30 min GitHub UI manual)
2. ⏸️ `~/.homun/config.toml [support] crash_submit_github = true` post-migrazione
3. ⏸️ Apple Developer cert + 6 GitHub Secrets upload su `homun-app/homun-core` (opzionale — CI degrada a unsigned)
4. ⏸️ Smoke test 4-lane fresh-install su VM pulite (~2 ore)
5. ⏸️ `homun.app` sito refresh (repo separato `homun-app/docs`)
6. ⏸️ `git tag -a v1.0.0` + push sul private repo
7. ⏸️ Verifica GitHub Release visibile + Homebrew formula aggiornata via tap
8. ⏸️ Announcement post drafted per HN/Reddit/Twitter

**Definition of Done Fase A** (✅ tutto completato da Claude):
- [x] Cargo.toml version 1.0.0 + repository URL `homun-app/homun`
- [x] CHANGELOG.md v1.0.0 comprehensive
- [x] docs/PRODUCTION-RELEASE-NOTES.md nuovo
- [x] README.md v1.0 user-facing + CONTRIBUTING.md nuovo
- [x] docs/INSTALLER-SMOKE-TEST.md runbook v1.0 + Sprint 9 checks
- [x] Doc reconciliation (PRODUCTION-ROADMAP, UNIFIED-ROADMAP, SESSION-PRIMER, features/INDEX, CLAUDE.md, REALITY-AUDIT)
- [x] Ad-interim Ops Notes block shown in chat
- [x] 982 Rust test baseline preserved, 0 nuovi clippy warning

**Definition of Done Fase B** (maintainer):
- [ ] Split repo migration eseguita
- [ ] 4-lane smoke test pass on fresh VMs
- [ ] Tag v1.0.0 pushed
- [ ] GitHub Release pubblicata con artefatti + SHA256
- [ ] homun.app aggiornato
- [ ] Announcement post draftato

**Rischio**: BASSO. Fase A è doc-only + version bump, ha preservato la baseline 982 test senza regression. Fase B dipende dal maintainer per le operazioni con side effects irreversibili (tag push, privatizzazione repo, publishing).

---

## Sprint Summary

| Sprint | Tipo | Effort | Blocker | Stato |
|---|---|---|---|---|
| 1 — Reality Audit chiusura | fix | S | ⛔ | ✅ 2026-04-14 |
| 2 — Audit Canali | audit | L | ⛔ | ✅ 2026-04-14 (5 bug tracciati, no fix) |
| 3 — Audit Memoria + RAG | audit | M | ⛔ | ✅ 2026-04-14 (9 bug tracciati, 2🔴+7🟡, no fix) |
| 4 — Audit Sicurezza | audit | M | ⛔ | ✅ 2026-04-14 (9 bug tracciati, 7🟡+2🟢, 0 🔴, 2 FP corretti, no fix) |
| 5 — Audit Skills + MCP + Contatti + Profili | audit | M | 🟡 | ✅ 2026-04-14 (14 bug tracciati, 0🔴+11🟡+3🟢, 8 FP corretti, ISO-3 5/7 verified, no fix) |
| 6 — Audit Automazioni + Workflow | audit | M | 🟡 | ✅ 2026-04-14 (10 bug tracciati, 1🔴+6🟡+3🟢, 2 FP corretti, ISO-3 table chiusa, no fix) |
| 7 — Mobile APP-2 | feature | L | 🟡 | ✅ 2026-04-14 (11 commit homun-app triage 5700 righe uncommitted + 3 risk fix + cross-stack fixture contract + polish. APP-2 ✅ thread-first pivot. Scope rivisto su `homun-app/docs/ROADMAP.md` — Activity feed + Approvals page rimosse per product decision. 948 Rust test + 26 Flutter test) |
| 8 — Installer Nativi | release | L | ⛔ | ✅ 2026-04-14 (INST-1/3/4 scaffolded + smoke-tested local; INST-2 rescoped to WSL2 via Windows cert cost analysis; .github/workflows/release.yml with graceful signing fallback; 9 new files + 3 docs; bug #67 tracked deferral) |
| 9 — Osservabilità + Update | feature | M | 🟡 | ✅ 2026-04-15 (OBS-1 metrics endpoint con 12 metriche + 4 hot-path instrumentate; OBS-2 trace ID end-to-end via task-local + X-Request-ID middleware + 7 canali wrapped; OBS-3 panic handler + crash reports + 4-channel submission API gated by [support] config; UPD-1 daily GitHub Releases poll + topbar chip + platform hints; 4 commit puliti, 982 test, 0 nuovi clippy warning) |
| 10 — Release v1.0 | release | M | ⛔ | ✅ 2026-04-15 **Fase A** (5 commit Claude: version bump 1.0.0 + URL migration homun-app + CHANGELOG.md v1.0 comprehensive + PRODUCTION-RELEASE-NOTES.md maintainer meta-doc + README.md user-facing refresh 4-installer + CONTRIBUTING.md PolyForm-aware + INSTALLER-SMOKE-TEST.md runbook 4-lane + 11-check con Sprint 9 verification + doc reconciliation all 6 layer); **Fase B** pending maintainer (split repo migration + smoke test VM + tag push + homun.app + announcement) |

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
| 2026-04-14 | Sprint 4 ✅ — Audit Sicurezza End-to-End: 15 assi coperti (S1-S15) via 3 Explore agent paralleli, ~4K LOC. **10/15 ✅ puliti** (safety prompt, cross-channel labeling, web auth+rate+CSRF, 2FA chain post-fix #1, e-stop propagation, trusted devices, sandbox backend enforcement core). 5/15 con gap. 9 nuovi bug tracciati (**0 🔴** + 7 🟡 + 2 🟢): #30 exfiltration PII IT mancanti + dual registry, #31 exfiltration single call site, #32 context_compactor short-bypass, #33 vault_leak resolve no key validation, #34 remember bypassa check_path_permission (second-line per #18), #35 sandbox silent fallback None, #36 Seatbelt allow_paths no symlink canonicalize, #37 pairing HashMap unbounded DoS, #38 dual redact_vault_values definitions. **2 falsi positivi corretti** in verification read: (1) CSPRNG claim smentito (rand 0.8 thread_rng IS crypto-safe ChaCha12+OsRng), (2) pairing cleanup claim smentito (auto-scheduled in gateway.rs:579). Pattern emergenti: (1) single-call-site defenses fragile, (2) dual pattern registries divergenti, (3) skip-on-short bypass, (4) second-line missing, (5) silent fallback (stesso pattern di Sprint 2 #10 capability drift). Cross-check Sprint 3: #18 aggravato + #34, #26 confermato (no `DefaultBodyLimit` trovato), #27 confermato design + nuovo gap #32. Dominio Sicurezza ✅→⚠️. Nessun fix implementato (raccogli e prioritizza). Attacker model live scenari rimandati a "Sprint Fix Sicurezza". 942 test pass, 0 warning clippy. 6/10 sprint rimanenti |
| 2026-04-14 | Sprint 5 ✅ — Audit Skills + MCP + Contatti + Profili: 16 assi coperti (SK1-SK6 + M1-M4 + C1-C6) via 3 Explore agent paralleli, **~15.5K LOC** (più grande audit Sprint finora). **14 nuovi bug tracciati (0 🔴 + 11 🟡 + 3 🟢)**: Skills (#39-#44) pattern bypass whitespace + cumulative threshold + TOCTOU scan + creator smoke test unsandboxed + adapter YAML escape + executor output no redact; MCP (#45-#52) OAuth state + redirect_uri + vault_key collision + refresh contention + non-atomic rotation + unbounded image + subprocess env + lifecycle gaps; Contatti+Profili (#53-#56) sender_id injection + bio/notes self-surface + MCP no profile scoping + gateway overrides no cross-profile validation. **8 falsi positivi corretti** in verification read (record Sprint 5, vs 1 Sprint 3 + 2 Sprint 4): 4 su C3 perimeter enforcement (agent_loop.rs:844/858/1031/888 prova che il perimeter è loaded + tool filter + privacy constraint + namespace filter tutti enforced), C5-2 vault profile scoping (vault.rs:36 vault_prefix_for_profile), C5-3 skills profile scoping (loader.rs:72 profile_slug + scan_directory_with_profile), Skills trust model #34 (check_path_permission è layer sbagliato per skill executor pre-trusted), MCP M3-5 auto-smentito (bail! catchato da Result). **ISO-3 cross-subsystem verified**: 5/7 sottosistemi profile-scoped (memoria + RAG + vault + skills + contact perimeter), 2 gap (#55 MCP singleton globale, #56 gateway overrides). **Pattern consolidato "agent confidence ≠ correctness"** — verification read è non opzionale. Cross-check Sprint 4: #31 aggravato (#44 skill output no redact), #35 confermato (#42 smoke test default unsafe), #37 ProfileRegistry bounded ✅, S8 aggravato (#52b MCP shutdown no per-peer timeout). Dominio "Skills + MCP" ❓→⚠️, "Contatti + Profili" ❓→⚠️. **13/16 domini coperti**. Totale bug: 23→37, 4 🔴 invariati. 942 test pass, 0 warning clippy. 5/10 sprint rimanenti |
| 2026-04-14 | Sprint 7 ✅ — Mobile App APP-2 completion: **primo feature sprint post Sprint 1**, cambio modalità da audit a implementation. **Discovery chiave all'avvio**: PRODUCTION-ROADMAP Sprint 7 era out-of-sync con `homun-app/docs/ROADMAP.md` da ~2 settimane — Activity feed + Approvals page pianificate qui erano già state rimosse dal mobile team per product decision thread-first. Scope rigenerato su base ROADMAP mobile reale. **5 step eseguiti**: (1) **triage + baseline commit** di 5700 righe uncommitted su `main` di homun-app in 8 commit logici (56e55d6 docs + 3d89f54 deps + 870b082 platform + 426cac4 theme + ea9aab8 core + bbdd9b1 chat models+data + 6f4af82 chat UI + 6dcd778 shell+app) — prima c'era 1 solo commit e tutto il lavoro APP-2 era a rischio disco; (2) **fix 3 rischi** flaggati da code review (81dd99f): ApprovalBlock confirm dialog (mirror del pattern _handleChoiceSelected per approve E deny), _pendingAssistantBlocks preserved cross _refreshHistory (attacca all'ultimo assistant msg se history ha blocks vuoti), _ThreadProfileChip onRetry (warn color + "Profilo offline · riprova" su error-without-cached-profile); (3) **cross-stack fixture contract** Rust↔Flutter (bba8891 homunbot + 3a9d1b4 homun-app): 5 JSON fixtures canoniche in `docs/block-fixtures/` + byte-identical copia in `homun-app/test/fixtures/blocks/`, 6 nuovi Rust test (fixture_*_roundtrip + variant completeness) + 6 nuovi Flutter test → schema drift diventa CI failure; (4) **polish UX** (da16c03): drawer `_DrawerConversationDot` distingue running (ok verde pulsante) da needs-attention (warn ambra statico) + Semantics labels, ResultBlock client-side redact defense-in-depth per bug #60 (mask su labels che matchano token|password|secret|api_key|bearer|credential|auth_key|private_key|access_key, preserva prefix 3 char + max 12 bullets, 9 nuovi test); (5) **doc reconciliation + Sprint 8 prompt**. **Verifica APP-2 pre-sprint**: l'explorer ha trovato tutti e 5 i block widgets già renderizzati con tap handlers wired, profile switcher già in topbar, thread-first shell già 2-page IndexedStack con zero residui Activity/Approvals — il 60% di Sprint 7 era il **triage** più che l'implementazione, il che rende il rischio originale "ALTO" in realtà **BASSO-MEDIO**. **Bug cross-check**: ✅ #60 mitigato client-side (server-side fix OutputSink trait resta aperto), 📝 #57 fuori scope mobile (gap backend ISO-3), 📝 #62 non risolto (serve flag `require_2fa` server-side). **Test**: 942→948 Rust (+6 fixture), 11→26 Flutter (+15, di cui 6 cross-stack fixtures + 9 redact). `flutter analyze` invariato (3 info pre-esistenti). `cargo test` + `cargo clippy` clean. **Pattern nuovi Sprint 7**: (a) "my-own-doc ≠ reality" — estensione del pattern "agent confidence ≠ correctness" ai doc tattici, (b) "buildable intermediates vs logical grouping" — scelta di commit su grouping logico (DX) vs buildable intermediates (bisect) con verifica analyze+test solo finale è il trade-off corretto per triage retroattivo, (c) "smart onTap pattern" — widget figlio decide quale callback usare in base al proprio stato invece di esporre flag al parent, (d) "cross-repo fixture duplication as tested invariant" — la duplicazione tra due repo si trasforma in "invariante testato" quando due suite indipendenti leggono gli stessi file. Dominio Mobile app: 🚧→✅. **APP-2 ✅ in UNIFIED-ROADMAP**. 3/10 sprint rimanenti (Sprint 8, 9, 10). |
| 2026-04-14 | Sprint 6 ✅ — Audit Automazioni + Workflow + Heartbeat: 16 assi coperti (A1-A6 + W1-W4 + H1-H2) via 3 Explore agent paralleli, **~11K LOC** Rust+JS. **10 nuovi bug tracciati (1 🔴 + 6 🟡 + 3 🟢)**: #57 🔴 automations+workflow profile_id stored ma NON enforced a fire time (CronEvent struct manca campo profile_id + workflow execute_step non setta session profile prima di process_message — **ISO-3 cross-subsystem gap**, chiude la tabella finale con il 3° gap architetturale), #58 🟡 cron UTC-only no timezone support, #59 🟡 flow_json no server-side schema validation, #60 🟡 automation/workflow results API unredacted (cross-check #31+#44 single call site), #61 🟡 workflow approval gate no timeout (cross-check #37 unbounded pattern), #62 🟡 workflow approval no 2FA (cross-check Sprint 4 S7), #63 🟡 workflow approve API no profile validation (cross-check #56), #64 🟢 HeartbeatService defined never instantiated (feature disabled), #65 🟢 workflow retry no exponential backoff (DRY violation vs utils/retry.rs), #66 🟢 missing agent_id silent fallback no warn. **2 falsi positivi corretti** in verification read: (1) A2 "event triggers never evaluated" — smentito da `evaluate_automation_trigger` at automations.rs:864 chiamato da 811 via lifecycle completion handler; (2) **contraddizione cross-batch** tra Batch A+B ("automations profile scoping ⚠️") vs Batch C ("automations profile-scoped ✅") — verification read ha distinto "stored in DB" da "enforced at fire time", confermando la tesi Batch A+B. Primo sprint dove la verification read ha **evitato una contraddizione interna silente**. FP count cumulativo cross-sprint: Sprint 3:1 + Sprint 4:2 + Sprint 5:8 + Sprint 6:2 = **13 FP totali**. **ISO-3 cross-subsystem — tabella chiusa a 4/7 ✅ + 2 ⚠️ + 2 ❌** (automations+workflow #57 è il 3° e ultimo gap architetturale tracciato). Pattern nuovi Sprint 6: **"stored ≠ enforced" ISO-3 anti-pattern** (variante negativa del pattern consolidato Sprint 5), **feature declared/disabled in production** (#64), **single call site redact 3° manifestazione** (#60), **DRY violation utils/retry.rs prima istanza concreta** (#65). Dominio "Automazioni + Scheduling" ❓→⚠️, "Workflow Engine" ❓→⚠️. **15/16 domini coperti** (resta solo Osservabilità; Mobile+Condivisione non-core). Totale bug aperti: 37→47, **5 🔴 totali** (era 4) — primo nuovo 🔴 in 2 sprint. 942 test pass, 0 warning clippy. 4/10 sprint rimanenti |
| 2026-04-15 | Sprint 9 ✅ — Osservabilità + Update Checker: **secondo feature dev sprint Rust core** dopo Sprint 7 mobile (cambio modalità da release eng Sprint 8 a feature core). **5 step**: (1) **OBS-1 metrics primitive + endpoint** (`f4d62ee`): `src/metrics.rs` registry zero-deps con 3 famiglie (counter/gauge/histogram), Prometheus text format v0.0.4 rendering, lock-free hot path per (name, labels) già visti via `RwLock` read + `Arc<AtomicU64>`, gauge stora f64 come `to_bits()`, histogram CAS loop su sum_bits. `src/web/api/metrics.rs` handler `/api/v1/metrics` sempre auth-gated + `/metrics` root path conditional su `[metrics] public = true`. 12 metriche registrate (6 instrumentate live: requests_total, tool_calls_total, llm_tokens_total, cognition_latency, tool_execution_latency, llm_latency; 6 gauge TBD per le componenti owner che le scrivono in mutate-time: active_sessions, memory_chunks, vault_entries, rag_documents, uptime, heartbeat_last_fire — l'ultima è una mitigazione passiva di bug #64 perché resta a 0 se HeartbeatService non viene mai instanziato). 4 chokepoint instrumentati zero-scatter: `ToolRegistry::execute`, `run_cognition`, `process_message_with_retry`, `ReliableProvider::chat`. **+12 test** (10 metrics::tests + 2 web::api::metrics::tests). (2) **OBS-2 trace ID end-to-end** (`c0f4f37`): `tokio::task_local!` `TASK_TRACE_ID: String` parallelo a `TASK_PROFILE_SCOPE`, `current_trace_id()` + `new_trace_id()` (8 hex chars UUID v4 truncated). `src/web/trace.rs` middleware HTTP che legge `X-Request-ID` validato via whitelist `[a-zA-Z0-9_-]{4,128}` (rifiuta log injection / JSON escape / SQL-ish / path traversal / non-ASCII / lengths fuori range), entra in scope, echo on response. Layered come outermost in `WebServer::start()` per coprire anche auth-rejected/404. `dispatch_to_agent` in `gateway.rs` refactorato in outer/inner pair, l'outer wrappa in `TASK_TRACE_ID.scope(new_trace_id(), ...)` — single chokepoint per 6 canali (Telegram/Discord/Slack/WhatsApp/Email/Web-via-bus). CLI canale wrappato separatamente (one_shot + interactive). `RequestTracer::new` legge `current_trace_id()` per unificare `RequestTrace.id` == `X-Request-ID` echoed == `trace_id` nei log. **+5 test** (2 logs::tests con scope round-trip + new_trace_id_unique, 3 web::trace::tests con is_well_formed accept/reject/boundary). (3) **OBS-3 panic handler + crash reports + 4-channel submission** (`a35fc12`): `src/crash_reporter.rs` installa `std::panic::set_hook` come **prima riga** di `async fn main()` (cattura panic durante rustls/CLI/config/DB init). Cattura panic message + location + force-captured backtrace + version + OS/arch + last 200 log records dal ring buffer in-memory + trace_id da task-local. JSON serializzato → redatto via `crate::security::redact` (PII eliminate) → scritto in `~/.homun/crashes/YYYY-MM-DD_HH-MM-SS_<trace_id>.json`. Anti-loop guard `AtomicBool CRASH_IN_PROGRESS` previene panic-during-panic. `take_hook()` chained al default per preservare stderr output. **No Sentry, no SaaS, no telemetry backend** — pattern "GitHub as telemetry" via 4 submission channels gated da `[support]` config: clipboard markdown (sempre on), download JSON (sempre on), GitHub issue pre-filled URL (gated `crash_submit_github`, default OFF finché public repo non creato), mailto URL pre-filled (gated `crash_submit_email`, default OFF finché email non settata). `src/web/api/crashes.rs` 4 endpoint (list/get/delete/formats) con path traversal defense. `percent_encode` inline RFC 3986 per evitare urlencoding crate dep. **+12 test** (5 crash_reporter::tests + 7 web::api::crashes::tests). `[support]` config con default `public_repo = "homun-app/homun"` (decisione split repo Sprint 9). (4) **UPD-1 update checker** (`4c0fd20`): `src/updates.rs` `check_for_update` polla `api.github.com/repos/{repo}/releases/latest` con User-Agent + Accept, parse `tag_name` (strip leading 'v'), confronto via `semver::Version` (handles prerelease semver: 1.0.0 > 1.0.0-rc1). Drafts e prereleases skipped silently. `detect_platform_hint()` parse `/etc/os-release` per Debian-family vs Red Hat-family, macOS suggests brew, Windows suggests WSL apt. **Notifier-only, mai auto-updater** (auto-update è UPD-2 post-v1.0). `spawn_update_checker(state)` task tokio dentro `WebServer::start()`, INITIAL_DELAY 60s + DEFAULT_POLL_INTERVAL 24h, scrive in `AppState.update_status: Arc<RwLock<Option<UpdateInfo>>>`. `[updates] check_enabled = true` default, opt-out granulare. `src/web/api/updates.rs` GET `/v1/updates/status` legge la cache (no GitHub call per scrape, UI può pollare ogni 5 min senza rate limit). `static/js/topbar.js` non-dismissable chip leftmost, CSS variabili per tema, link a release URL, platform hint as tooltip. **+5 test** (semver ordering + prerelease + invalid + platform hint non-empty + UpdateInfo serde roundtrip). `semver = "1"` declared come direct dep (era già in transitive tree, no nuovi crates). (5) **doc reconciliation** (this commit): `docs/features/14-osservabilita.md` esteso con sezioni 9-12 per OBS-1/2/3 + UPD-1, `docs/MIGRATION-SPLIT-REPO.md` nuovo playbook 30-min step-by-step per il maintainer (Phase 0 pre-flight → Phase 1 create public repo → Phase 2 transfer code → Phase 3 privatize → Phase 4 Cargo.toml + wa-rs + tap → Phase 5 cross-repo PAT + release.yml → Phase 6 re-add Apple secrets → Phase 7 flip config → Phase 8 verify → Phase 9 cleanup, con templates SECURITY.md + issue templates), PRODUCTION-ROADMAP.md Sprint 9 ✅ + Summary + cronologia, UNIFIED-ROADMAP.md OBS-1/2/3 + UPD-1 → ✅, SESSION-PRIMER.md cronologia + 16/16 domini coperti, REALITY-AUDIT.md mitigazione passiva bug #64, CLAUDE.md tree structure aggiornata. **Pattern nuovi Sprint 9**: (a) **"4 chokepoint per N metriche"** (un solo punto per Tool/Cognition/Request/Provider copre 12+ metriche senza scatter — opposite del Shotgun Metrics Injection); (b) **"task-local sopravvive a thread migration"** (test `yield_now().await` dimostra che il pattern è correct under tokio scheduling, vs `thread_local` che si romperebbe); (c) **"GitHub as telemetry backend"** (consensual user-driven crash submission via 4 feature-flagged channels invece di SaaS forwarding — mantiene privacy-first positioning); (d) **"notifier-only update checker"** (rispetta package manager nativo di ogni installer, mai overwrite del binary); (e) **"feature-flag for strategic decisions"** (estensione del pattern Sprint 8 graceful-degradation-on-secrets a `crash_submit_*` boolean che permettono di abilitare submission channels post-decisione split-repo senza rebuild); (f) **"split repo as deferred decision"** (`homun-app/homun` + `homun-app/homun-core` org creata da utente, codice prepared via `[support]` config defaults, migrazione manuale tracciata in MIGRATION-SPLIT-REPO.md per Sprint 10 o tra-sprint). Dominio Osservabilità ❓→✅ — **16/16 domini coperti** per la prima volta. **Test**: 948→982 Rust (+34: 12 OBS-1 + 5 OBS-2 + 12 OBS-3 + 5 UPD-1). cargo clippy clean su tutto il codice nuovo (16 warning pre-esistenti unchanged). **Git**: 5 commit puliti senza Co-Authored-By: f4d62ee OBS-1 metrics, c0f4f37 OBS-2 trace ID, a35fc12 OBS-3 crash reports, 4c0fd20 UPD-1 update checker, [questo commit] doc + roadmap + migration playbook + Sprint 10 prompt. 1/10 sprint rimanente (Sprint 10 release v1.0). **Maintainer task residui Sprint 9** (out-of-scope per il codice, in scope per il maintainer prima di Sprint 10): eseguire `MIGRATION-SPLIT-REPO.md` Phase 1-9 (~30 min), aggiornare `[support] crash_submit_github = true` post-migration, opzionalmente settare `[support] email` se si vuole offrire mailto submission |
| 2026-04-15 | **Sprint 10 ✅ Fase A (Claude)** — Release v1.0 + Docs polish: **ultimo sprint tattico**, release engineering + doc polish (no feature dev). Approccio a due fasi nette: **Fase A** (Claude, questa sessione) prepara tutto il materiale offline; **Fase B** (maintainer) esegue split repo, smoke test reali su VM, tag push, sito refresh, announcement — cose che Claude non può fare senza accesso a VM / homun.app repo / GitHub UI. **5 commit puliti Fase A**: (1) `15285fa` `chore(release): bump version to 1.0.0 + migrate URLs to homun-app org` — Cargo.toml version `0.1.0` → `1.0.0` + repository URL `homunbot/homun` → `homun-app/homun`, 12 file docs/packaging/CI aggiornati con URL nuovo. Il codice produzione usa `env!("CARGO_PKG_VERSION")` in 9 siti (main.rs, updates.rs, crash_reporter.rs, web/server.rs, health.rs, status.rs) → il bump Cargo.toml propaga automaticamente, zero `.rs` touched. I test fixtures con `"0.1.0"` in crash_reporter.rs + crashes.rs sono self-contained (confrontano fixture con sé stessa, non con `CARGO_PKG_VERSION`) → continuano a passare post-bump. `cargo test` exit 0, **982 baseline preservato**. (2) `3346472` `docs(release): add CHANGELOG.md v1.0.0 + PRODUCTION-RELEASE-NOTES.md` — CHANGELOG.md riscritto da zero in Keep a Changelog 1.1.0 format (sostituisce l'obsoleto `[Unreleased]` del 2026-03-17 che listava dead state come Business Autopilot + 18 migrations): `## [1.0.0] — 2026-04-15` con 17 sezioni Added per 16 domini + Mobile + Observability + Installers, Changed (4 pivot strategici: mobile thread-first, Windows WSL-first, cognition always-on, license MIT→PolyForm), Removed (Business Autopilot dead code), Security (6 audit sprint summary, 47 bug tracciati, 13 FP, ISO-3 table chiusa, "agent confidence ≠ correctness" pattern), Fixed (batch pre-Sprint 2: #1-#9, A-bug-2/3/8, provider hot-reload, browser cleanup, WebSocket TLS), Infrastructure (982 Rust test + 26 Flutter + 53 migrations), **Known issues tabella esplicita dei 5 🔴** (#10/#11/#18/#26/#57) con severity + domain + workaround per ciascuno. `docs/PRODUCTION-RELEASE-NOTES.md` nuovo meta-doc privato per il maintainer: executive summary, what's NOT in v1.0 (7 esclusioni con reasoning), compatibility matrix (OS + LLM tier A/B/C + channel maturity + sandbox), upgrade path v0.2→v1.0 (fresh install, keep `~/.homun/`, migrations idempotenti, vault `dev.homun.secrets` keychain unchanged per Sprint 8 verification), post-release monitoring 7 giorni (GitHub issues rate, crash reports, `/metrics` dashboard baseline ranges, update checker uptake), known issues root cause + fix effort (#18 + #26 come hotfix candidates 1 day effort combined), 6 scenari "what could go wrong in first 7 days" (apt deps, macOS notarization stale, Homebrew SHA256 race, update checker loop, crash reporter self-panic, vault keychain rename), handoff checklist Fase A/Fase B, rollback plan. (3) `ce81e83` `docs(release): user-facing README v1.0 + CONTRIBUTING.md` — README.md full refresh: nuovo tagline "Single binary. Privacy-first. Local-first. Multi-channel.", Quick install 4-target (macOS .dmg/brew + Ubuntu/Debian .deb + Fedora/RHEL .rpm + Windows WSL2) con command examples concreti, "What you get" 17 bullet densi, CLI commands canonici, Documentation links (CHANGELOG + CONTRIBUTING + INSTALL-WINDOWS-WSL + homun.app), Docker demotato ad "Advanced" section (non più happy path), build-from-source ridotto a pointer al private repo `homun-app/homun-core`, PolyForm license explicit "source-private, user-visible". CONTRIBUTING.md nuovo: license model explanation upfront (PolyForm non-OSI, source private, no public PRs), what you CAN contribute (bugs con issue template + trace ID Sprint 9, features via Discussions first, crash reports 4-channel Sprint 9, docs improvements sui file pubblici), what you CANNOT (public source PRs, binary redistribution), security vulnerability reporting (security@homun.app + GitHub Advisories + audit access request per researchers), code of conduct 3-strike, release cadence (hotfix on-demand, minor 4-6 weeks, major 12-18 months, one-person maintainer note). (4) `c3f70de` `docs(smoke-test): v1.0 runbook + Sprint 9 verification steps` — version + URL migration in tutti command examples, common checklist **7 → 11 check**: nuovi 8 (crash reporter: trigger panic → JSON file redatto in ~/.homun/crashes/ + /api/v1/crashes list + content redatto), 9 (/metrics endpoint Prometheus format via curl + homun_* metrics + public path conditional), 10 (X-Request-ID echo header + log grep trace_id), 11 (update checker chip con dummy v99.0.0 tag entro 60s). Evidence tarball instruction (salva logs+crashes+metrics per target in `smoke-evidence-<target>-<date>.tgz` allegato alla GitHub Release). Nuova sezione "Release v1.0 runbook" con 4-lane parallelo 2-ore (Ubuntu 22.04 .deb / Fedora 40 .rpm / macOS signed .dmg / Windows 11 WSL2), decision tree su failure (1 flake retry / 1 reproducible blocked / 2+ triage + re-run), spiegazione esplicita che i 4 nuovi check Sprint 9 sono non-negoziabili per v1.0 (verificano observability plumbing end-to-end). Status table aggiornata: tutti i 11 target ⏸️ "maintainer VM pending" — Claude non può eseguire smoke test da questa sessione. (5) **questo commit** — doc reconciliation Fase A: PRODUCTION-ROADMAP Sprint 10 ✅ + Summary + cronologia (questa entry), "Stato Attuale snapshot" completo rifatto a "v1.0.0 pre-tag", Definition of Done split in Fase A (Claude) + Fase B (maintainer); UNIFIED-ROADMAP Fase 2 closing banner "Apertura al Mondo Esterno completata (INST-1..4 + OBS-1..3 + UPD-1 + APP-1..2 ✅)" + nuova sezione "Post-v1.0 Steady State"; SESSION-PRIMER stato "v1.0 released (Fase A done)"; features/INDEX.md metrics bump (982 test, 53 migrations, 16/16 domini); CLAUDE.md scale update (982 test, production status v1.0); REALITY-AUDIT.md (Mobile + Osservabilità marcati ✅, Condivisione + Permission UX → "non-core v1.0, audit deferred post-v1.0"). **Pattern nuovi Sprint 10**: (a) **"Fase A / Fase B split"** — quando uno sprint contiene sia doc preparation (agent-safe) sia operazioni irreversibili con side effects esterni (VM smoke test, split repo, tag push, publishing), separa nettamente in 2 fasi con handoff esplicito invece di tentare di fare tutto in una sessione. Riduce il rischio di errori catastrofici su operazioni che Claude non può verificare, mantiene accountability chiara. (b) **"Version bump as propagation"** — un singolo byte change nel manifest (`0.1.0` → `1.0.0` in `Cargo.toml:3`) propaga via `env!` a 9 siti di codice produzione senza toccare alcun `.rs`. Quando le version string sono centralizzate correttamente questo è un release di 30 secondi; quando sono sparse per il codebase diventa un sprint. (c) **"CHANGELOG consolidates the narrative"** — riscrivere il CHANGELOG per v1.0 costringe a rileggere ogni sprint 1-9 e decidere cosa è "Added" (new feature) vs "Changed" (pivot) vs "Removed" (dead code) vs "Security" (audit finding) vs "Fixed" (pre-sprint bug). È un esercizio di riconciliazione narrativa che rivela inconsistenze che nessun altro doc chiama (es. Business Autopilot era marcato "removed" in features/INDEX ma "added" nel CHANGELOG obsoleto). (d) **"Smoke test runbook as pre-commitment"** — documentare i 4 lane paralleli, i 11 check per-lane, e il decision tree su failure prima ancora di eseguire i test elimina l'improvvisazione day-of-release. Il maintainer al momento del tag push ha solo da eseguire il runbook meccanicamente. (e) **"CONTRIBUTING.md as expectation-setter"** — un progetto privato-source sotto licenza non-OSI ha requisiti contributivi molto diversi da un progetto open source tradizionale. Mettere la license model explanation come **prima sezione** di CONTRIBUTING evita che contributori interessati sprechino tempo a preparare PR al source che non esiste pubblicamente. **Test**: 982 baseline preservato (zero regression da version bump + doc edit). `cargo check` 0.21s (cached). **Git**: 5 commit puliti senza Co-Authored-By: 15285fa version bump, 3346472 CHANGELOG + release notes, ce81e83 README + CONTRIBUTING, c3f70de smoke test runbook, [questo commit] doc reconciliation. **Sprint 10 Fase A COMPLETATA, v1.0.0 pre-tag state. Fase B = maintainer task**: (1) esecuzione `docs/MIGRATION-SPLIT-REPO.md` Phase 1-9 (~30 min), (2) flip `[support] crash_submit_github = true`, (3) Apple cert + 6 GitHub Secrets (opzionale), (4) 4-lane smoke test su VM pulite ~2 ore, (5) sito `homun.app` refresh (repo `homun-app/docs`), (6) `git tag -a v1.0.0` + push sul private repo, (7) verifica GitHub Release + Homebrew formula, (8) announcement post drafted. **0/10 sprint rimanenti** — post-Sprint 10 la fase "tactical sprint" finisce e inizia la fase "steady-state operations" (Ad-interim Ops Notes generato in chat come reference doc maintainer) |
| 2026-04-14 | Sprint 8 ✅ — Installer Nativi: **release engineering sprint** (cambio modalità da feature/audit), primo sprint dove i cert + packaging sono protagonisti vs Rust code. **Pivot strategico a metà Sprint**: INST-2 (Windows .msi + Authenticode) rescopato a **Windows-via-WSL2 doc-only path** dopo analisi costi reali ($600-900 primo anno cert OV/EV + HSM obbligatorio post-2023 + SignPath bloccato da licenza PolyForm non-OSI). **9 nuovi file produzione** (1200+ righe) + **3 doc** (signing setup, smoke test, Windows WSL install): `.github/workflows/release.yml` (318 righe, env-routed per injection safety, graceful signing fallback, matrix Linux-amd64/arm64 + macOS-x64/arm64, no Windows runner), `packaging/linux/{homun.service,debian/postinst,prerm,postrm}` (systemd system-level + maintainer scripts), `packaging/macos/{Info.plist.template,homun-launcher,create-dmg.sh}` (3-mode build: unsigned/signed/signed+notarized), `packaging/brew/{homun.rb.template,README.md}` (hybrid binary-bottle + source-fallback formula + tap setup docs), `packaging/windows/README.md` (placeholder + decision record), `Cargo.toml` (+72 righe `[package.metadata.deb]` + `[package.metadata.generate-rpm]`). **Smoke test locale (su dev machine arm64 macOS)**: (1) `cargo deb --no-build` produce `homun_0.1.0-1_arm64.deb` con layout FHS corretto (usr/bin + lib/systemd/system + usr/share/doc), control file con deps risolte (adduser, ca-certificates, libsqlite3-0), 3 maintainer scripts embedded in control.tar.xz; (2) `cargo generate-rpm --arch x86_64 --auto-req disabled` produce `homun-0.1.0-1.x86_64.rpm` v3 binary; (3) `bash packaging/macos/create-dmg.sh` produce `Homun-0.1.0-arm64.dmg` 12MB unsigned, montaggio hdiutil verifica bundle `Homun.app/Contents/{Info.plist,MacOS/homun,MacOS/homun-launcher}` + symlink Applications per drag-to-install. **Verification read cross-sprint** (pattern consolidato): `src/storage/secrets.rs:29` ha **unico call site** per `KEYCHAIN_SERVICE = "dev.homun.secrets"` → upgrade path build-from-source → installer non rompe il vault esistente ✅. Data paths tutti via `dirs::home_dir()` con tolleranza a `HOME` override nei systemd unit + maintainer script ✅. **Bug #67 tracciato** come 📝 DEFERRED (decisione tecnica, non bug) — 48° entry della tabella ma primo 📝. **Pattern nuovi Sprint 8**: (a) **"graceful degradation on secrets"** — il workflow CI produce artefatti unsigned se i secrets non ci sono, aggiunge warning automatico alle release notes, non fallisce; il maintainer può abilitare signing caricando 6 GitHub Secrets senza ulteriori commit — **feature-flag pattern esteso a signing**, (b) **"WSL2 come primo-target-class per Windows"** — il kernel Linux vero dentro Hyper-V lightweight permette di distribuire UN binario per 4 piattaforme (Ubuntu + Fedora + macOS-brew + Windows-WSL), consolidando security model e audit surface vs farne 2 paralleli (Linux nativo + Windows nativo) con cert divergenti, (c) **"cert-cost → scope-pivot"** — quando un vincolo esterno (cert $600/anno) eccede il budget di progetto, il rescope WSL elimina l'intera categoria di bug (Windows-specific paths, Credential Manager vs file vault, registry, MSI/signtool complexity) in cambio di un ~15 min extra setup utente. Dominio Distribuzione ❌→✅ (prima volta). **Sprint 8 è il primo sprint con artefatti production-ready per 3 OS target** (non più solo build-from-source o Docker). **Test**: 948 Rust test invariati (nessun cambio Rust), `cargo clippy` clean. **Git**: 5 commit puliti senza Co-Authored-By: c0b132a linux .deb/.rpm + systemd, 3881462 ci release.yml, c54269d macos .app + dmg, 837f230 homebrew + WSL guide, [questo commit] smoke test docs + roadmap updates + Sprint 9 prompt. 2/10 sprint rimanenti (Sprint 9 osservabilità + Sprint 10 release v1.0) |

---

## Referenze incrociate

- **Strategia macro**: [`UNIFIED-ROADMAP.md`](./UNIFIED-ROADMAP.md)
- **Bug tracking**: [`REALITY-AUDIT.md`](./REALITY-AUDIT.md)
- **Vision**: [`PROJECT.md`](./PROJECT.md)
- **Per-domain spec**: [`features/INDEX.md`](./features/INDEX.md)
- **Architecture deep-dive**: [`services/`](./services/)
- **Production checklist storica**: [`PRODUCTION-READINESS.md`](./PRODUCTION-READINESS.md) (apr 1, profile isolation focus)
- **Code conventions**: [`../CLAUDE.md`](../CLAUDE.md)
