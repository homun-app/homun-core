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
| Codebase | ✅ stabile | 942 test, 0 clippy warnings (prod), 121K LOC Rust |
| Reality Audit | 🟡 9/16 domini, 14 bug aperti | 6✅ + 2⚠️ (canali + memoria/RAG) + 1🔧 cognition; 7 domini ❓. Bug: 5 canali (#10-#14, 2🔴+3🟡) + 9 memoria/RAG (#15-#18+#25-#29, 2🔴+7🟡). 4 🔴 totali da prioritizzare |
| Strategy roadmap | ✅ Fase 1+2 done | Hardening + Apertura completate |
| Production roadmap | 🚚 Sprint 1+2+3 ✅, Sprint 4 next | 7/10 sprint rimanenti per v1.0 |
| Production blocker | ⛔ Installer nativi assenti | Solo build-from-source o Docker |
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
| 2026-04-13 | Reality Audit completato (7 recipe), 9/11 bug fixati. PRODUCTION-ROADMAP creato con 10 sprint per v1.0 |
| 2026-04-10 | Sprint cleanup: rimossa Business feature dead code |
| 2026-03-25 | UNIFIED-ROADMAP Fase 1+2 marked complete |
