# Session Primer — Start Here

> **Per chi è questo doc**: una nuova sessione Claude (o un nuovo contributor umano) che deve **iniziare a lavorare su Homun da zero**.
>
> **Obiettivo**: in 5 minuti capisci dove sei, cosa è in corso, dove andare per ogni tipo di task.
>
> **Lunghezza target**: < 200 righe. Se diventa più lungo, refactora in doc specializzati.
>
> **Aggiornamento**: a ogni cambio di stato globale del progetto (sprint completato, milestone raggiunta, doc importante creato).

---

## In una frase

Homun è un **assistente AI personale in single binary Rust** (~121K LOC, 953 test, 0 warning) che vive sulla macchina dell'utente e si gestisce via Telegram/WhatsApp/Discord/Slack/Email/Web/CLI. Stato: **Alpha v0.2 → strada per v1.0 production**.

---

## Stato attuale (snapshot)

| Asse | Stato | Note |
|---|---|---|
| Codebase | ✅ stabile | 948 test (+6 cross-stack fixtures Sprint 7), 0 clippy warnings (prod), 121K LOC Rust |
| Reality Audit | 🟡 15/16 domini, 47 bug aperti | 6✅ + 7⚠️ (canali + memoria/RAG + sicurezza + skills/MCP + contatti/profili + automazioni + workflow) + 1🔧 cognition; 1 dominio ❓ rimanente (Osservabilità; Mobile+Condivisione non-core per v1.0). Bug: 5 canali (#10-#14) + 9 memoria/RAG (#15-#18+#25-#29) + 9 sicurezza (#30-#38) + 14 skills/MCP/contatti (#39-#56) + 10 automazioni/workflow/heartbeat (#57-#66, **1🔴**+6🟡+3🟢). **5 🔴 totali**: #10, #11, #18, #26, #57 (invariati post Sprint 7 — Sprint 7 era feature non audit). **Bug #60 mitigato client-side Sprint 7** via ResultBlock redact (server-side fix OutputSink resta aperto). FP cumulativo: Sprint 3:1 + Sprint 4:2 + Sprint 5:8 + Sprint 6:2 = **13 FP totali**. **ISO-3 cross-subsystem table chiusa** a 4✅+2⚠️+2❌ |
| Strategy roadmap | ✅ Fase 1+2 done, APP-2 ✅ | Hardening + Apertura completate. APP-2 mobile ✅ Sprint 7 (thread-first pivot) |
| Production roadmap | 🚚 Sprint 1+2+3+4+5+6+7 ✅, Sprint 8 next | 3/10 sprint rimanenti per v1.0 |
| Production blocker | ⛔ Installer nativi assenti | Solo build-from-source o Docker. Sprint 8 dedicato |
| Mobile app | ✅ APP-2 done | APP-1 + APP-2 thread-first completati Sprint 7 (11 commit homun-app, cross-stack fixture contract, 26 Flutter test). APP-3 (push, offline) rimandato |
| Last update | 2026-04-14 | |

---

## Where do I go for...?

| Cosa devi fare | Vai a |
|---|---|
| **Lavorare sul prossimo task** | [`PRODUCTION-ROADMAP.md`](./PRODUCTION-ROADMAP.md) → trova lo Sprint con `🔲` più alto |
| **Capire i bug noti** | [`REALITY-AUDIT.md`](./REALITY-AUDIT.md) → sezione "Issue tracciati" |
| **Capire la strategia long-term** | [`UNIFIED-ROADMAP.md`](./UNIFIED-ROADMAP.md) → sezione "Piano Esecutivo — 4 Fasi" |
| **Scrivere codice** | [`../CLAUDE.md`](../CLAUDE.md) → "Regole di Programmazione" + "Integration Points" |
| **Capire il "perché" del progetto** | [`PROJECT.md`](./PROJECT.md) |
| **Capire un dominio specifico** (canali, memoria, ecc.) | [`features/INDEX.md`](./features/INDEX.md) → 17 doc per-dominio |
| **Capire l'architettura interna di un servizio** | [`services/`](./services/) → 17 doc per-servizio |
| **Trust model + sicurezza** | [`TRUST-MODEL.md`](./TRUST-MODEL.md) + [`features/06-sicurezza.md`](./features/06-sicurezza.md) |
| **Setup per testare in locale** | [`GETTING-STARTED.md`](./GETTING-STARTED.md) |
| **Convenzioni di sviluppo** | [`DEVELOPMENT.md`](./DEVELOPMENT.md) |
| **Test (run, scrivere, debug)** | [`TESTING-GUIDE.md`](./TESTING-GUIDE.md) |

---

## Doc map — cosa è cosa

```
docs/
├── SESSION-PRIMER.md        ← SEI QUI: start here per nuove sessioni
├── PRODUCTION-ROADMAP.md    ← TACTICAL: 10 sprint per arrivare a v1.0
├── REALITY-AUDIT.md         ← BUG TRACKING: cosa è rotto/funziona, evidenze
├── UNIFIED-ROADMAP.md       ← STRATEGIC: 4 fasi, 12+ mesi, posizionamento
├── PROJECT.md               ← VISION: perché Homun esiste
├── PRODUCTION-READINESS.md  ← STORICO: checklist apr 1, profile isolation
├── GETTING-STARTED.md       ← USER: install + first steps
├── DEVELOPMENT.md           ← DEV: convenzioni
├── TESTING-GUIDE.md         ← DEV: come testare
├── TRUST-MODEL.md           ← SECURITY: principal types, trust boundaries
├── REMOTE-ACCESS.md         ← OPS: SSH tunnel, Tailscale, reverse proxy
├── SANDBOX-RUNTIME-BASELINE.md ← OPS: docker image baseline
├── features/
│   ├── INDEX.md             ← 17 spec funzionali per-dominio
│   ├── 01-...17-*.md
├── services/
│   ├── README.md            ← 17 architecture deep-dive per-servizio
│   ├── *.md
├── adr/                     ← Architecture Decision Records (storici)
│   └── (vedi sezione "Doc storici" sotto)
```

---

## Workflow per una nuova sessione (template)

Quando inizi una sessione Claude per lavorare su uno sprint:

```
Contesto: sto lavorando allo Sprint N di docs/PRODUCTION-ROADMAP.md.
Leggi questi file prima di iniziare (in ordine):
1. docs/SESSION-PRIMER.md  (overview rapido)
2. docs/PRODUCTION-ROADMAP.md  (sezione Sprint N specifica)
3. docs/REALITY-AUDIT.md  (per stato bug se rilevante)
4. CLAUDE.md  (per regole di codice)
5. [file specifici elencati nello sprint sotto "File chiave"]

Poi proponi un piano in 3-5 step e chiedi conferma prima di scrivere codice.
```

**Regole d'oro per sessioni produttive**:
- ✅ **Plan mode obbligatorio** se modifichi >3 file (Shift+Tab x2)
- ✅ `cargo check` dopo ogni edit Rust (auto via hook)
- ✅ `cargo test` dopo ogni step significativo
- ✅ Commit piccoli e frequenti (1 sprint = 1+ commit)
- ❌ Mai modificare doc storici (`adr/`, `PRODUCTION-READINESS.md`)
- ❌ Mai aggiungere TODO abbandonati nel codice — apri issue nel REALITY-AUDIT
- ❌ Mai disabilitare test — fixali

---

## Pronto per iniziare?

**Se stai facendo il primo onboarding**, leggi in quest'ordine:
1. Questo file (sei qui ✓)
2. [`PROJECT.md`](./PROJECT.md) — vision (~10 min)
3. [`CLAUDE.md`](../CLAUDE.md) — regole codice + architecture overview (~15 min)
4. [`PRODUCTION-ROADMAP.md`](./PRODUCTION-ROADMAP.md) — cosa fare (~10 min)

**Se sei una sessione Claude pronta a lavorare**, usa il template "Workflow per una nuova sessione" sopra e parti dallo Sprint con `🔲` più alto in [`PRODUCTION-ROADMAP.md`](./PRODUCTION-ROADMAP.md).

---

## Doc storici (non aggiornare, riferimenti per contesto)

Questi doc descrivono decisioni passate o blueprint mai implementati. **Non sono lo stato attuale del codice**:

- `adr/AGENT-ARCHITECTURE-V2.md` — blueprint redesign aprile 2 (NON implementato — il sistema attuale ha cognition diversa)
- `adr/AGENT-REDESIGN-CONTEXT.md` — context dump della session di redesign (storico)
- `PRODUCTION-READINESS.md` — checklist isolation profile/contact aprile 1 (la maggior parte ✅, alcune ⏸️ rimandate a v3 multi-user)

---

## Cronologia stato globale

| Data | Cambiamento |
|---|---|
| 2026-04-14 | Production Sprint 1 ✅ — A-bug-2/3/8 fixati, cognition #2 checklist pronta (live validation pending). 0 bug aperti |
| 2026-04-14 | Production Sprint 2 ✅ — Audit Canali: 7/7 code-audited (~4.2K LOC via 3 Explore agent paralleli), 3 ✅ (CLI/Discord/Web) + 4 ⚠️ (Telegram/WhatsApp/Slack/Email), 5 bug tracciati #10-#14 (no fix, raccogli+prioritizza). Dominio Canali ❓→⚠️ |
| 2026-04-14 | Production Sprint 3 ✅ — Audit Memoria + RAG: 16 assi M1-M8 + R1-R8 via 2 Explore agent paralleli (~5.7K LOC), 11/16 ✅ puliti, 5/16 con bug. 9 bug nuovi #15-#18 + #25-#29 (2🔴+7🟡), 1 falso positivo corretto (#27). Pattern: post-fetch scoping cross-subsistema, detect_injection on-tool-use, importance 1-5 sotto-enforced, file I/O senza bounds, orphan HNSW. ISO-3/ISO-4 ✅ da code review. Dominio Memoria+RAG ❓→⚠️. 2 🔴 (#18 path traversal, #26 DoS) candidati Sprint 4 |
| 2026-04-14 | Production Sprint 4 ✅ — Audit Sicurezza End-to-End: 15 assi S1-S15 via 3 Explore agent paralleli (~4K LOC). **10/15 ✅ puliti** (safety prompt + cross-channel labeling + auth/rate/CSRF + 2FA chain post-fix #1 + e-stop + trusted devices + sandbox core enforcement). 5/15 con gap. 9 bug nuovi #30-#38 (**0 🔴** + 7🟡 + 2🟢): #30 exfiltration PII IT mancanti + dual registry, #31 single call site, #32 context_compactor short-bypass, #33 vault_leak resolve no validation, #34 remember bypassa check_path_permission (second-line per #18), #35 sandbox silent fallback None, #36 Seatbelt allow_paths no canonicalize, #37 pairing HashMap unbounded, #38 dual redact_vault_values. **2 falsi positivi corretti**: (1) CSPRNG claim — rand 0.8 thread_rng IS crypto-safe ChaCha12+OsRng, (2) pairing cleanup claim — auto-scheduled in gateway.rs:579. Pattern: single-call-site fragile, dual pattern registries, skip-on-short, second-line missing, silent fallback. Cross-check Sprint 3: #18 aggravato, #26 nessuna difesa residua (no DefaultBodyLimit trovato), #27 design OK + nuovo gap. Dominio Sicurezza ✅→⚠️. 4🔴 totali invariati (#10, #11, #18, #26). 23 bug aperti. Attacker model live scenari rimandati a "Sprint Fix Sicurezza". 942 test pass, 0 warning clippy |
| 2026-04-14 | Production Sprint 5 ✅ — Audit Skills + MCP + Contatti + Profili: 16 assi (SK1-SK6 + M1-M4 + C1-C6) via 3 Explore agent paralleli, **~15.5K LOC** (più grande audit Sprint finora). **14 bug nuovi #39-#56 (0🔴 + 11🟡 + 3🟢)**: Skills #39 pattern bypass whitespace, #40 cumulative threshold, #41 TOCTOU scan, #42 creator smoke test unsandboxed, #43 adapter YAML escape, #44 skill output no redact (defense-in-depth); MCP #45 OAuth state no server validation, #46 redirect_uri no whitelist, #47 vault_key collision multi-instance, #48 refresh contention, #49 non-atomic Notion rotation, #50 unbounded image decode, #51 subprocess env inheritance, #52 lifecycle gaps (stderr+shutdown+health); Contatti+Profili #53 sender_id injection, #54 bio/notes self-surface, #55 MCP no profile scoping (ISO-3 gap), #56 gateway overrides no cross-profile validation. **8 falsi positivi corretti** (record Sprint 5): 4 su C3 perimeter enforcement (agent_loop.rs:844/858/1031/888 prova tutto loaded + enforced), C5-2 vault profile scoping (vault.rs:36), C5-3 skills profile scoping (loader.rs:72), Skills trust model #34 (wrong layer), MCP M3-5 auto-smentito. **ISO-3 cross-subsystem verified**: 5/7 sottosistemi profile-scoped (memoria + RAG + vault + skills + contact perimeter), 2 gap (#55 MCP, #56 gateway overrides). Pattern **"agent confidence ≠ correctness"** consolidato in 3 sprint (1+2+8 FP): gli Explore agent leggono parzialmente e dichiarano feature broken 🔴 anche quando sono enforced 500 righe più in basso nel chiamante. Verification read non opzionale. Cross-check Sprint 4: #31 aggravato (#44), #35 confermato (#42), S8 aggravato (#52b MCP shutdown no per-peer timeout). Dominio "Skills + MCP" ❓→⚠️, "Contatti + Profili" ❓→⚠️. **13/16 domini coperti**. Totale bug: 23→37. 942 test pass, 0 warning clippy |
| 2026-04-14 | Production Sprint 7 ✅ — Mobile App APP-2 completion: **primo feature sprint post Sprint 1** (cambio modalità da audit a implementation). **Discovery key all'avvio**: PRODUCTION-ROADMAP Sprint 7 era out-of-sync con `homun-app/docs/ROADMAP.md` — Activity feed + Approvals page pianificate qui erano state rimosse dal mobile team per product decision **thread-first**. Scope rigenerato su base ROADMAP mobile reale. **5 step**: (1) **triage** di 5700 righe uncommitted su `main` di homun-app in 8 commit logici (docs + deps + platform + theme + core + chat models+data + chat UI + shell+app) — prima c'era 1 solo commit e tutto il lavoro APP-2 era a rischio disco; (2) **fix 3 rischi**: ApprovalBlock confirmation sheet (approve + deny), _pendingAssistantBlocks preservati cross _refreshHistory (reconnect mid-stream), _ThreadProfileChip onRetry con warn color; (3) **cross-stack fixture contract** 5 JSON fixtures canoniche in `docs/block-fixtures/` + byte-identical copia in `homun-app/test/fixtures/blocks/` + 6 Rust test + 6 Flutter test (schema drift → CI failure); (4) **polish**: drawer `_DrawerConversationDot` distingue running (ok verde pulsante) da needs-attention (warn ambra statico) + Semantics labels, ResultBlock client-side redact cross bug #60 (mask su labels sensibili) con 9 test; (5) **doc reconciliation** + Sprint 8 prompt. **Verifica APP-2 pre-sprint**: l'explorer ha trovato tutti e 5 i block widget già renderizzati con tap handlers wired, profile switcher già in topbar, thread-first shell già 2-page IndexedStack — il 60% di Sprint 7 era **triage** più che implementazione. **Bug cross-check**: ✅ #60 mitigato client-side, 📝 #57 fuori scope mobile, 📝 #62 serve `require_2fa` server-side. **Test**: 942→948 Rust (+6 fixture), 11→26 Flutter (+15). `flutter analyze` invariato, `cargo test` + `cargo clippy` clean. **Pattern nuovi Sprint 7**: (a) **"my-own-doc ≠ reality"** (estensione del pattern "agent confidence ≠ correctness" ai doc tattici), (b) **"cross-repo fixture duplication as tested invariant"** (la duplicazione si trasforma in invariante quando due suite leggono gli stessi file), (c) **"smart onTap pattern"** (widget figlio decide callback in base al proprio stato). Dominio Mobile ❓→✅. APP-2 ✅ in UNIFIED-ROADMAP. 3/10 sprint rimanenti. 11 commit homun-app + 2 homunbot senza Co-Authored-By |
| 2026-04-14 | Production Sprint 6 ✅ — Audit Automazioni + Workflow + Heartbeat: 16 assi (A1-A6 + W1-W4 + H1-H2) via 3 Explore agent paralleli, **~11K LOC** Rust+JS. **10 bug nuovi #57-#66 (1🔴 + 6🟡 + 3🟢)**. **#57 🔴** (primo nuovo 🔴 in 2 sprint): automations+workflow `profile_id` stored in DB ma NON enforced a fire time — `CronEvent` struct (cron.rs:17-26) manca campo profile_id per prompt path, `workflows/engine.rs:481 execute_step` non chiama `set_session_profile_id` prima di `process_message`. Resolver cascade cade al global default. **Chiude la tabella ISO-3 cross-subsystem** con il 3° gap architetturale tracciato. 🟡: #58 cron UTC only, #59 flow_json no server validation, #60 results API unredacted (cross #31+#44), #61 workflow approval no timeout (cross #37), #62 workflow approval no 2FA (cross S7), #63 workflow approve API no profile validation (cross #56). 🟢: #64 HeartbeatService never instantiated, #65 workflow retry no backoff (DRY vs utils/retry.rs), #66 missing agent_id silent fallback. **2 falsi positivi corretti** in verification read: (1) A2 "event triggers never evaluated" smentito da `evaluate_automation_trigger` at automations.rs:864 chiamato da 811; (2) **contraddizione cross-batch** tra Batch A+B vs Batch C su ISO-3 — verification read ha distinto "stored" da "enforced", confermando Batch A+B. Primo sprint dove la verification read ha **evitato una contraddizione silente cross-batch**. FP count cumulativo: Sprint 3:1 + Sprint 4:2 + Sprint 5:8 + Sprint 6:2 = **13 FP totali**. Pattern nuovi Sprint 6: **"stored ≠ enforced" ISO-3 anti-pattern** (variante negativa del pattern consolidato Sprint 5), **feature declared/disabled in production** (#64), **single call site redact 3° manifestazione** (#60), **DRY violation utils/retry.rs prima istanza concreta** (#65). **ISO-3 cross-subsystem — tabella chiusa**: 4/7 ✅ (memoria+RAG, vault, skills, contact perimeter) + 2 ⚠️ (#55 MCP, #56 gateway overrides) + 2 ❌ (#57 automations+workflow). 3 gap totali tutti architetturali. Dominio "Automazioni + Scheduling" ❓→⚠️, "Workflow Engine" ❓→⚠️. **15/16 domini coperti** (resta solo Osservabilità). Totale bug aperti: 37→47, **5 🔴 totali** (era 4). 942 test pass, 0 warning clippy |
| 2026-04-13 | Reality Audit completato (7 recipe), 9/11 bug fixati. PRODUCTION-ROADMAP creato con 10 sprint per v1.0 |
| 2026-04-10 | Sprint cleanup: rimossa Business feature dead code |
| 2026-03-25 | UNIFIED-ROADMAP Fase 1+2 marked complete |
