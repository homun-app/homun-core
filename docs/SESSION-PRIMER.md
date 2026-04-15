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

Homun è un **assistente AI personale in single binary Rust** (~121K LOC, 982 test, 0 nuovi warning) che vive sulla macchina dell'utente e si gestisce via Telegram/WhatsApp/Discord/Slack/Email/Web/CLI. Stato: **v1.0.0 pre-tag — Sprint 10 Fase A ✅ (doc prep completa), Fase B ⏸️ (maintainer task: split repo migration + tag push + smoke test VM + sito refresh + announcement)**.

---

## Stato attuale (snapshot)

| Asse | Stato | Note |
|---|---|---|
| Codebase | ✅ v1.0.0 | 982 test, 0 nuovi clippy warning, 121K+ LOC Rust, `Cargo.toml` v1.0.0 + repository `homun-app/homun` |
| Reality Audit | ✅ **16/16 domini** (core v1.0), 47 bug aperti + 1 deferred | Mobile + Osservabilità ✅ Sprint 7/9. Bug: 5 canali + 9 memoria/RAG + 9 sicurezza + 14 skills/MCP/contatti + 10 automazioni/workflow/heartbeat + 1 decision (#67 📝). **5 🔴 totali** (#10/#11/#18/#26/#57), tutti documentati in CHANGELOG.md Known Issues con workaround. Condivisione + Permission UX: spec OK, audit deferred post-v1.0 (non-core v1.0 scope). FP cumulativo: 13 totali. ISO-3 cross-subsystem table chiusa a 4✅+2⚠️+2❌ |
| Strategy roadmap | ✅ Fase 1+2 completate | Hardening + Apertura + Installer + Osservabilità + Update checker + Mobile APP-2 tutti ✅. Fase 3 Consumer: ⏸️ wait-for-demand (gate: 100+ utenti + zero 🔴 >30gg + feedback incorporato + scope ri-definito) |
| Production roadmap | ✅ Sprint 1-10 Fase A ✅ | **0/10 sprint tattici rimanenti** — Sprint 10 Fase B = maintainer task handoff |
| Distribuzione | ✅ v1.0 docs ready (Fase A) | Installer scaffolded + smoke runbook aggiornato 11-check + Sprint 9 verification. 4-lane maintainer VM smoke test pending (Fase B) |
| Observability | ✅ Sprint 9 done | `/metrics` Prometheus endpoint + 12 metriche, trace ID end-to-end via X-Request-ID + task-local, panic handler con crash reports redatti + 4-channel submission API, daily update checker con platform hints. Topbar chip notifier-only |
| Release docs | ✅ v1.0 done (Fase A) | CHANGELOG.md v1.0.0 comprehensive + docs/PRODUCTION-RELEASE-NOTES.md nuovo (meta-doc privato maintainer) + README.md user-facing refresh + CONTRIBUTING.md PolyForm-aware + smoke test runbook 4-lane |
| Mobile app | ✅ APP-2 done | APP-1 + APP-2 thread-first completati Sprint 7. APP-3 (push, offline) rimandato post-v1.0 |
| Split repo | ⏸️ maintainer pending | Playbook `docs/MIGRATION-SPLIT-REPO.md` ready Phase 1-9, eseguibile ~30 min manual GitHub UI |
| Sito homun.app | ⏸️ maintainer pending | Repo separato `homun-app/docs`, refresh pending Fase B |
| Tag v1.0.0 | ⏸️ maintainer pending | Dipende da split repo + 4-lane smoke test + Apple cert (opzionale) |
| Announcement post | ⏸️ maintainer pending | HN/Reddit/Twitter draft timing discrezionale |
| Last update | 2026-04-15 | Sprint 10 Fase A closed, v1.0.0 pre-tag state |

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
| 2026-04-15 | **Production Sprint 10 ✅ Fase A (Claude) — Release v1.0 + Docs polish**: **ultimo sprint tattico**, doc polish + release engineering. Approccio 2-fasi: Fase A (Claude, questa sessione) prepara materiale offline; Fase B (maintainer) esegue operazioni side-effect esterne. **5 commit puliti**: (1) `15285fa` version bump 1.0.0 + URL migration homunbot/homun→homun-app/homun in 12 file (env!(CARGO_PKG_VERSION) propaga automaticamente, zero .rs touched); (2) `3346472` CHANGELOG.md v1.0.0 comprehensive (Keep a Changelog 1.1.0, 17 Added sezioni per 16 domini + Mobile + Observability + Installers, Changed 4 pivot strategici, Removed Business Autopilot, Security 6 audit summary + 13 FP pattern "agent confidence ≠ correctness", Fixed batch pre-Sprint 2, Known Issues tabella esplicita 5 🔴 con workaround) + docs/PRODUCTION-RELEASE-NOTES.md nuovo (executive summary, what's NOT in v1.0 7 esclusioni, compatibility matrix OS+LLM tier+channels+sandbox, upgrade path v0.2→v1.0, post-release monitoring 7gg, known issues fix effort #18+#26 hotfix candidates 1day combined, 6 scenari "what could go wrong", rollback plan, handoff checklist); (3) `ce81e83` README.md user-facing refresh (tagline "Single binary Privacy-first Local-first Multi-channel", Quick install 4-target concrete commands, "What you get" 17 bullet, Docker demotato ad Advanced, PolyForm explicit) + CONTRIBUTING.md nuovo (license model upfront, what CAN/CANNOT contribute, security vulnerability reporting + audit access, code of conduct, release cadence); (4) `c3f70de` INSTALLER-SMOKE-TEST.md runbook v1.0 + Sprint 9 verification (version+URL update, common checklist 7→**11 check** con nuovi 8 crash reporter + 9 /metrics + 10 X-Request-ID echo + 11 update checker chip, evidence tarball instruction, 4-lane parallel runbook, decision tree su failure, 11 target marcati ⏸️ maintainer VM pending); (5) **questo commit** doc reconciliation 6-layer (PRODUCTION-ROADMAP Sprint 10 ✅ Fase A + Summary + cronologia estesa, UNIFIED-ROADMAP Fase 2 closing banner + "Post-v1.0 Steady State" gate con 4 criteri + cadence + red lines, SESSION-PRIMER stato v1.0 pre-tag, features/INDEX metrics bump 982 test / 53 migrations / 16/16 domini, CLAUDE.md scale 982 + production status v1.0, REALITY-AUDIT Mobile+Osservabilità ✅ + Condivisione/Permission UX deferred) + blocco "📖 Ad-interim Ops Notes — gestione post-v1.0" generato in chat come reference doc per il maintainer. **Pattern nuovi Sprint 10**: (a) "Fase A / Fase B split" — separa doc prep (agent-safe) da operazioni irreversibili con side effects esterni (VM smoke test, split repo, tag push, publishing); (b) "Version bump as propagation" — singolo byte change in Cargo.toml:3 propaga via env! a 9 siti produzione senza toccare alcun .rs; (c) "CHANGELOG consolidates the narrative" — riscrivere il CHANGELOG per v1.0 costringe a rileggere ogni sprint 1-9 e riconciliare inconsistenze; (d) "Smoke test runbook as pre-commitment" — documenta 4 lane + 11 check + decision tree prima del tag push; (e) "CONTRIBUTING.md as expectation-setter" — license model come prima sezione evita PR-to-nonexistent-source. **Test**: 982 baseline preservato (zero regression da version bump + doc edit). `cargo check` 0.21s cached. **Maintainer Fase B**: split repo (~30 min) + flip crash_submit_github + Apple cert opzionale + 4-lane smoke test VM ~2h + homun.app refresh + `git tag -a v1.0.0` + push + GitHub Release verifica + announcement. **0/10 sprint tattici rimanenti** — post-Sprint 10 la fase "tactical sprint" finisce e inizia la fase "steady-state operations" |
| 2026-04-15 | Production Sprint 9 ✅ — Osservabilità + Update Checker: secondo feature dev sprint Rust core (post Sprint 7 mobile). **5 step**: OBS-1 metrics primitive zero-deps + Prometheus `/metrics` endpoint dual-mount (auth `/api/v1/metrics` sempre + root `/metrics` conditional su `[metrics] public = true`) + 12 metriche con 4 chokepoint instrumentati zero-scatter (ToolRegistry::execute, run_cognition, process_message_with_retry, ReliableProvider::chat) + commit f4d62ee; OBS-2 trace ID end-to-end via `tokio::task_local!` `TASK_TRACE_ID` + middleware HTTP `X-Request-ID` con whitelist validator + `dispatch_to_agent` outer/inner refactor che wrappa 6 canali in single chokepoint + CLI wrap separato + RequestTracer unification + commit c0f4f37; OBS-3 panic handler installato come prima riga di main() + `~/.homun/crashes/` JSON redatti via `crate::security::redact` + anti-loop `AtomicBool` + 4-channel submission API gated da `[support]` config + percent_encode inline RFC 3986 + commit a35fc12; UPD-1 daily background poller in `WebServer::start()` + `semver::Version` compare + `detect_platform_hint` parse `/etc/os-release` + cache in AppState + topbar chip + commit 4c0fd20; doc reconciliation con `docs/features/14-osservabilita.md` esteso + nuovo `docs/MIGRATION-SPLIT-REPO.md` playbook 30-min Phase 0-9. **Pattern nuovi**: "4 chokepoint per N metriche", "task-local sopravvive thread migration", "GitHub as telemetry backend", "notifier-only update checker", "feature-flag for strategic decisions", "split repo as deferred decision". Dominio Osservabilità ❓→✅ — **16/16 domini coperti**. Test 948→982 (+34). Git 5 commit puliti senza Co-Authored-By. 1/10 sprint rimanente. **Maintainer task**: eseguire MIGRATION-SPLIT-REPO playbook, flippare `crash_submit_github` post-migration |
| 2026-04-14 | Production Sprint 1 ✅ — A-bug-2/3/8 fixati, cognition #2 checklist pronta (live validation pending). 0 bug aperti |
| 2026-04-14 | Production Sprint 2 ✅ — Audit Canali: 7/7 code-audited (~4.2K LOC via 3 Explore agent paralleli), 3 ✅ (CLI/Discord/Web) + 4 ⚠️ (Telegram/WhatsApp/Slack/Email), 5 bug tracciati #10-#14 (no fix, raccogli+prioritizza). Dominio Canali ❓→⚠️ |
| 2026-04-14 | Production Sprint 3 ✅ — Audit Memoria + RAG: 16 assi M1-M8 + R1-R8 via 2 Explore agent paralleli (~5.7K LOC), 11/16 ✅ puliti, 5/16 con bug. 9 bug nuovi #15-#18 + #25-#29 (2🔴+7🟡), 1 falso positivo corretto (#27). Pattern: post-fetch scoping cross-subsistema, detect_injection on-tool-use, importance 1-5 sotto-enforced, file I/O senza bounds, orphan HNSW. ISO-3/ISO-4 ✅ da code review. Dominio Memoria+RAG ❓→⚠️. 2 🔴 (#18 path traversal, #26 DoS) candidati Sprint 4 |
| 2026-04-14 | Production Sprint 4 ✅ — Audit Sicurezza End-to-End: 15 assi S1-S15 via 3 Explore agent paralleli (~4K LOC). **10/15 ✅ puliti** (safety prompt + cross-channel labeling + auth/rate/CSRF + 2FA chain post-fix #1 + e-stop + trusted devices + sandbox core enforcement). 5/15 con gap. 9 bug nuovi #30-#38 (**0 🔴** + 7🟡 + 2🟢): #30 exfiltration PII IT mancanti + dual registry, #31 single call site, #32 context_compactor short-bypass, #33 vault_leak resolve no validation, #34 remember bypassa check_path_permission (second-line per #18), #35 sandbox silent fallback None, #36 Seatbelt allow_paths no canonicalize, #37 pairing HashMap unbounded, #38 dual redact_vault_values. **2 falsi positivi corretti**: (1) CSPRNG claim — rand 0.8 thread_rng IS crypto-safe ChaCha12+OsRng, (2) pairing cleanup claim — auto-scheduled in gateway.rs:579. Pattern: single-call-site fragile, dual pattern registries, skip-on-short, second-line missing, silent fallback. Cross-check Sprint 3: #18 aggravato, #26 nessuna difesa residua (no DefaultBodyLimit trovato), #27 design OK + nuovo gap. Dominio Sicurezza ✅→⚠️. 4🔴 totali invariati (#10, #11, #18, #26). 23 bug aperti. Attacker model live scenari rimandati a "Sprint Fix Sicurezza". 942 test pass, 0 warning clippy |
| 2026-04-14 | Production Sprint 5 ✅ — Audit Skills + MCP + Contatti + Profili: 16 assi (SK1-SK6 + M1-M4 + C1-C6) via 3 Explore agent paralleli, **~15.5K LOC** (più grande audit Sprint finora). **14 bug nuovi #39-#56 (0🔴 + 11🟡 + 3🟢)**: Skills #39 pattern bypass whitespace, #40 cumulative threshold, #41 TOCTOU scan, #42 creator smoke test unsandboxed, #43 adapter YAML escape, #44 skill output no redact (defense-in-depth); MCP #45 OAuth state no server validation, #46 redirect_uri no whitelist, #47 vault_key collision multi-instance, #48 refresh contention, #49 non-atomic Notion rotation, #50 unbounded image decode, #51 subprocess env inheritance, #52 lifecycle gaps (stderr+shutdown+health); Contatti+Profili #53 sender_id injection, #54 bio/notes self-surface, #55 MCP no profile scoping (ISO-3 gap), #56 gateway overrides no cross-profile validation. **8 falsi positivi corretti** (record Sprint 5): 4 su C3 perimeter enforcement (agent_loop.rs:844/858/1031/888 prova tutto loaded + enforced), C5-2 vault profile scoping (vault.rs:36), C5-3 skills profile scoping (loader.rs:72), Skills trust model #34 (wrong layer), MCP M3-5 auto-smentito. **ISO-3 cross-subsystem verified**: 5/7 sottosistemi profile-scoped (memoria + RAG + vault + skills + contact perimeter), 2 gap (#55 MCP, #56 gateway overrides). Pattern **"agent confidence ≠ correctness"** consolidato in 3 sprint (1+2+8 FP): gli Explore agent leggono parzialmente e dichiarano feature broken 🔴 anche quando sono enforced 500 righe più in basso nel chiamante. Verification read non opzionale. Cross-check Sprint 4: #31 aggravato (#44), #35 confermato (#42), S8 aggravato (#52b MCP shutdown no per-peer timeout). Dominio "Skills + MCP" ❓→⚠️, "Contatti + Profili" ❓→⚠️. **13/16 domini coperti**. Totale bug: 23→37. 942 test pass, 0 warning clippy |
| 2026-04-14 | Production Sprint 8 ✅ — Installer Nativi: **primo release-engineering sprint** (cambio modalità da feature/audit). **Pivot strategico a metà Sprint**: INST-2 Windows .msi + Authenticode rescopato a Windows-via-WSL2 doc-only path dopo analisi costi reali cert ($600-900/anno OV/EV + HSM post-2023 obbligatorio + SignPath bloccato da licenza PolyForm non-OSI). **5 step**: (1) Linux `packaging/linux/` — `homun.service` systemd system-level + debian maintainer scripts (postinst/prerm/postrm) + `Cargo.toml [package.metadata.deb]` + `[package.metadata.generate-rpm]`; local smoke test produce `.deb` arm64 + `.rpm` x86_64 con layout FHS corretto, control file con deps risolte (adduser + ca-certificates + libsqlite3-0), maintainer scripts embedded in control.tar.xz. (2) `.github/workflows/release.yml` — triggered su `v*` tag, matrix Linux amd64+arm64 + macOS x64+arm64 (**no Windows runner**), graceful signing fallback via env gating, all inputs env-routed per injection safety (GitHub Actions workflow injection mitigation). (3) macOS `packaging/macos/` — `Info.plist.template` versioned, `homun-launcher` shell wrapper che spawna `homun gateway` background + open browser su `http://localhost:8777`, `create-dmg.sh` end-to-end con 3 mode (unsigned/signed/signed+notarized) gate su env vars Apple; local smoke test produce `Homun-0.1.0-arm64.dmg` 12MB unsigned, montato via hdiutil, bundle structure verified (Info.plist + homun + homun-launcher + Applications symlink). (4) Homebrew + Windows-WSL — `packaging/brew/homun.rb.template` hybrid binary-bottle + source-fallback formula, `packaging/brew/README.md` documenta setup manuale `homunbot/homebrew-tap` repo; `docs/INSTALL-WINDOWS-WSL.md` guida completa 15 min (wsl --install → apt install → first run → 3 startup modes foreground/systemd/Task Scheduler + 3 gotchas vault file-based/hibernation/Defender + troubleshooting); `packaging/windows/README.md` placeholder + decision record. (5) Doc reconciliation — `docs/INSTALLER-SIGNING-SETUP.md` step-by-step Apple cert export + 6 GitHub Secrets + Authenticode future path + cost breakdown, `docs/INSTALLER-SMOKE-TEST.md` procedure fresh-install per 3 OS target, bug #67 📝 tracked decision in REALITY-AUDIT (primo 📝 entry), PRODUCTION-ROADMAP Sprint 8 ✅ + Summary + cronologia, UNIFIED-ROADMAP INST-1..4 ✅. **Verification read cross-sprint** (pattern consolidato "agent confidence ≠ correctness"): `src/storage/secrets.rs:29` ha **unico call site** per `KEYCHAIN_SERVICE = "dev.homun.secrets"` → upgrade path build-from-source → installer non rompe vault esistente ✅; data paths tutti via `dirs::home_dir()` con tolleranza a `HOME` override nei systemd unit e maintainer script ✅. **Pattern nuovi Sprint 8**: (a) **"graceful degradation on secrets"** — CI produce artefatti unsigned se secrets non presenti, aggiunge warning automatico alle release notes, non fallisce; il maintainer abilita signing caricando 6 GitHub Secrets senza ulteriori commit (feature-flag pattern esteso a signing); (b) **"WSL2 come primo-target-class per Windows"** — un binario per 4 piattaforme (Ubuntu + Fedora + macOS-brew + Windows-WSL), consolida security model e audit surface vs 2 paralleli (Linux + Windows nativo) con cert divergenti; (c) **"cert-cost → scope-pivot"** — quando un vincolo esterno eccede il budget, rescope elimina una categoria intera di bug in cambio di ~15 min setup extra utente. Dominio Distribuzione ❌→✅ (prima volta). **Primo sprint con artefatti production-ready per 3 OS target**. **Git**: 5 commit puliti NO Co-Authored-By: c0b132a linux, 3881462 release.yml, c54269d macos, 837f230 homebrew+WSL, [questo commit] Step 5 docs+roadmap+Sprint 9 prompt. 948 Rust test invariati, clippy clean. 2/10 sprint rimanenti (Sprint 9 osservabilità + Sprint 10 v1.0 release) |
| 2026-04-14 | Production Sprint 7 ✅ — Mobile App APP-2 completion: **primo feature sprint post Sprint 1** (cambio modalità da audit a implementation). **Discovery key all'avvio**: PRODUCTION-ROADMAP Sprint 7 era out-of-sync con `homun-app/docs/ROADMAP.md` — Activity feed + Approvals page pianificate qui erano state rimosse dal mobile team per product decision **thread-first**. Scope rigenerato su base ROADMAP mobile reale. **5 step**: (1) **triage** di 5700 righe uncommitted su `main` di homun-app in 8 commit logici (docs + deps + platform + theme + core + chat models+data + chat UI + shell+app) — prima c'era 1 solo commit e tutto il lavoro APP-2 era a rischio disco; (2) **fix 3 rischi**: ApprovalBlock confirmation sheet (approve + deny), _pendingAssistantBlocks preservati cross _refreshHistory (reconnect mid-stream), _ThreadProfileChip onRetry con warn color; (3) **cross-stack fixture contract** 5 JSON fixtures canoniche in `docs/block-fixtures/` + byte-identical copia in `homun-app/test/fixtures/blocks/` + 6 Rust test + 6 Flutter test (schema drift → CI failure); (4) **polish**: drawer `_DrawerConversationDot` distingue running (ok verde pulsante) da needs-attention (warn ambra statico) + Semantics labels, ResultBlock client-side redact cross bug #60 (mask su labels sensibili) con 9 test; (5) **doc reconciliation** + Sprint 8 prompt. **Verifica APP-2 pre-sprint**: l'explorer ha trovato tutti e 5 i block widget già renderizzati con tap handlers wired, profile switcher già in topbar, thread-first shell già 2-page IndexedStack — il 60% di Sprint 7 era **triage** più che implementazione. **Bug cross-check**: ✅ #60 mitigato client-side, 📝 #57 fuori scope mobile, 📝 #62 serve `require_2fa` server-side. **Test**: 942→948 Rust (+6 fixture), 11→26 Flutter (+15). `flutter analyze` invariato, `cargo test` + `cargo clippy` clean. **Pattern nuovi Sprint 7**: (a) **"my-own-doc ≠ reality"** (estensione del pattern "agent confidence ≠ correctness" ai doc tattici), (b) **"cross-repo fixture duplication as tested invariant"** (la duplicazione si trasforma in invariante quando due suite leggono gli stessi file), (c) **"smart onTap pattern"** (widget figlio decide callback in base al proprio stato). Dominio Mobile ❓→✅. APP-2 ✅ in UNIFIED-ROADMAP. 3/10 sprint rimanenti. 11 commit homun-app + 2 homunbot senza Co-Authored-By |
| 2026-04-14 | Production Sprint 6 ✅ — Audit Automazioni + Workflow + Heartbeat: 16 assi (A1-A6 + W1-W4 + H1-H2) via 3 Explore agent paralleli, **~11K LOC** Rust+JS. **10 bug nuovi #57-#66 (1🔴 + 6🟡 + 3🟢)**. **#57 🔴** (primo nuovo 🔴 in 2 sprint): automations+workflow `profile_id` stored in DB ma NON enforced a fire time — `CronEvent` struct (cron.rs:17-26) manca campo profile_id per prompt path, `workflows/engine.rs:481 execute_step` non chiama `set_session_profile_id` prima di `process_message`. Resolver cascade cade al global default. **Chiude la tabella ISO-3 cross-subsystem** con il 3° gap architetturale tracciato. 🟡: #58 cron UTC only, #59 flow_json no server validation, #60 results API unredacted (cross #31+#44), #61 workflow approval no timeout (cross #37), #62 workflow approval no 2FA (cross S7), #63 workflow approve API no profile validation (cross #56). 🟢: #64 HeartbeatService never instantiated, #65 workflow retry no backoff (DRY vs utils/retry.rs), #66 missing agent_id silent fallback. **2 falsi positivi corretti** in verification read: (1) A2 "event triggers never evaluated" smentito da `evaluate_automation_trigger` at automations.rs:864 chiamato da 811; (2) **contraddizione cross-batch** tra Batch A+B vs Batch C su ISO-3 — verification read ha distinto "stored" da "enforced", confermando Batch A+B. Primo sprint dove la verification read ha **evitato una contraddizione silente cross-batch**. FP count cumulativo: Sprint 3:1 + Sprint 4:2 + Sprint 5:8 + Sprint 6:2 = **13 FP totali**. Pattern nuovi Sprint 6: **"stored ≠ enforced" ISO-3 anti-pattern** (variante negativa del pattern consolidato Sprint 5), **feature declared/disabled in production** (#64), **single call site redact 3° manifestazione** (#60), **DRY violation utils/retry.rs prima istanza concreta** (#65). **ISO-3 cross-subsystem — tabella chiusa**: 4/7 ✅ (memoria+RAG, vault, skills, contact perimeter) + 2 ⚠️ (#55 MCP, #56 gateway overrides) + 2 ❌ (#57 automations+workflow). 3 gap totali tutti architetturali. Dominio "Automazioni + Scheduling" ❓→⚠️, "Workflow Engine" ❓→⚠️. **15/16 domini coperti** (resta solo Osservabilità). Totale bug aperti: 37→47, **5 🔴 totali** (era 4). 942 test pass, 0 warning clippy |
| 2026-04-13 | Reality Audit completato (7 recipe), 9/11 bug fixati. PRODUCTION-ROADMAP creato con 10 sprint per v1.0 |
| 2026-04-10 | Sprint cleanup: rimossa Business feature dead code |
| 2026-03-25 | UNIFIED-ROADMAP Fase 1+2 marked complete |
