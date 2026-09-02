# Production Readiness Roadmap

Verificato 2026-09-02 su `main`.

Questo documento e' la lista unica di ripartenza per portare Homun verso una
release production-grade. `docs/STATO.md` resta lo stato vivo dettagliato; le
matrici in `docs/testing/` restano la copertura per dominio. Qui ogni blocco
deve avere owner, criterio di chiusura e verifica ripetibile.

## Regola Di Chiusura

Un blocco e' chiuso solo quando:

1. l'owner canonico e' identificato;
2. esiste una fixture owner-level, un audit read-only o uno smoke live
   ripetibile;
3. l'audit reale distingue bug corrente da debito storico;
4. il comando di verifica e' registrato qui o in `docs/STATO.md`;
5. la modifica e' su `main` con CI verde prima di tagliare una release.

## Stato Corrente

Ultimo audit reale verificato:

```bash
python3 scripts/audit_homun_state.py --max-findings-per-code 3 --max-timeline-events 20
```

Esito:

- `ok=true`
- `errors=0`
- `warnings=151`

Warning residui:

| Priorita' | Codice | Conteggio | Owner | Stato | Done |
| --- | --- | ---: | --- | --- | --- |
| P0 | `completed_turn_with_unreconciled_delivered_plan` | 28 | `runtime_plan_projection` | parziale | turni terminali con risposta consegnata non lasciano piano UI incoerente; i 28 residui correnti vengono chiusi da repair controllata o nuovo turno, non da mutazioni manuali |
| P1 | `agent_run_missing_model_attribution` | 23 | `model_routing` | storico da classificare | Auto/Unavailable sempre spiegabile da `agent_runs` o `agent_run_events.prompt_snapshot`; residui separati come legacy non riparabile |
| P1 | `legacy_memory_without_evidence` | 100 | `memory_provenance` | storico da migrare/classificare | memoria live moderna ha evidence; memoria legacy e' migrata con evidenza, archiviata o esclusa con regola esplicita |

## Roadmap

### 1. Riconciliazione Piano Runtime

**Problema:** 28 turni completati hanno risposta assistant consegnata ma ultimo
piano persistito non e' riconciliato. Questo puo' far sembrare attivo o
incompleto un lavoro gia' concluso.

**Owner canonico:** `runtime_plan_projection`, `turn_events`,
`runtime_plans`, presenter kernel.

**File probabili:**

- `scripts/audit_homun_state.py`
- `scripts/test_audit_homun_state.py`
- `crates/desktop-gateway/src/gateway_plan_reconciliation.rs`
- `crates/desktop-gateway/src/gateway_main_tests.rs`
- `crates/task-runtime/src/store.rs`
- `docs/STATO.md`

**Approccio:**

1. leggere un campione dei 28 casi dal DB reale, senza ripararlo;
2. separare stati storici innocui da stati ancora generabili;
3. aggiungere test rosso per la classe trovata;
4. correggere l'owner canonico o la regola audit, non la UI;
5. rieseguire audit reale e gate mirati.

**Stato 2026-09-02:** il reconciler futuro chiude risposte brevi verificate con
source e blocca failure terminali browser/DNS; l'audit ora guarda anche
`runtime_plans` corrente e non solo marker storici del transcript. L'API
integrity repair espone inoltre
`settle_completed_delivered_open_runtime_plans`, che chiude in modo controllato
solo i piani ancora `open` quando il task chat piu' recente del thread e'
`completed`, l'ultimo `plan_update` e' incompleto e un `done`/`delta` successivo
ha consegnato risposta assistant. La repair non fallisce il task e non muta il
testo della chat.

**Verifica minima:**

```bash
python3 -m unittest scripts.test_audit_homun_state -v
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway reconcile_final_plan -- --nocapture
cargo test -p local-first-task-runtime runtime_integrity_repair_settles_completed_delivered_open_runtime_plan -- --nocapture
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway integrity_repair_apply_settles_completed_delivered_open_runtime_plan_without_exposing_paths -- --nocapture
python3 scripts/audit_homun_state.py --max-findings-per-code 3 --max-timeline-events 20
```

**Gate prima di merge/release:**

```bash
python3 scripts/pre_release_gate.py
```

### 2. Attribuzione Modello E Auto/Unavailable

**Problema:** 23 run storiche non spiegano completamente `role`, `model` o
`provider`. Il comportamento moderno sembra coperto da `agent_runs` e
`agent_run_events.prompt_snapshot`, ma i residui vanno classificati.

**Owner canonico:** `gateway_model_routing`, `agent_runs`,
`agent_run_events.prompt_snapshot`, routing decision log.

**Done:** ogni nuova run ha attribuzione spiegabile; i residui storici non
nascondono regressioni moderne.

**Verifica minima:**

```bash
python3 -m unittest scripts.test_audit_homun_state -v
cargo test -p local-first-task-runtime runtime_integrity_audit -- --nocapture
python3 scripts/audit_homun_state.py --max-findings-per-code 0
```

### 3. Memoria E Provenance Legacy

**Problema:** 100 memorie legacy non hanno evidence link. Non vanno mutate solo
per abbassare il conteggio: e' un tema privacy/provenance.

**Owner canonico:** `local-first-memory`, `MemoryFacade`,
`memory_evidence`, Vault quando sensibile.

**Done:** memoria moderna senza evidence e' errore/warning reale; memoria
legacy e' migrata, archiviata o marcata con politica esplicita.

**Verifica minima:**

```bash
python3 -m unittest scripts.test_audit_homun_state -v
python3 scripts/audit_homun_state.py --max-findings-per-code 0
```

### 4. Scenario Lab Ripetibile

**Problema:** bug emergenti compaiono solo in chat reali lunghe con modello,
browser, memoria, skill, MCP e automation combinati.

**Owner canonico:** `scripts/production_smoke.py` e scenari in
`docs/testing/usage-scenarios.md`.

**Done:** baseline e extended producono evidenza strutturata: `thread_id`,
`turn_id`, `run_id`, terminal status, testo redatto, audit prima/dopo.

**Verifica minima:**

```bash
python3 scripts/production_smoke.py --list
python3 scripts/production_smoke.py --profile baseline --gateway-base http://127.0.0.1:18765
python3 scripts/production_smoke.py --profile extended --gateway-base http://127.0.0.1:18765
```

### 5. Task Lunghi E Budget Azioni

**Problema:** per avvicinarsi a Codex/Manus/OpenCode, Homun deve rendere
espliciti budget azioni, resume, pause, crash recovery, ownership e stato
visibile di lavori che possono durare ore o giorni.

**Owner canonico:** `docs/architecture/action-budget-contract.md`,
task runtime, broker, execution wakes, UI task state.

**Done:** un task lungo puo' essere interrotto, ripreso e spiegato senza perdere
obiettivo, piano, budget, run attribution o richieste HITL.

**Verifica minima:**

```bash
python3 scripts/kernel_regression_gate.py
python3 scripts/smoke_kernel_projection.py
```

## Release Gate

Una release pubblica richiede evidenze separate:

1. `main` con CI verde;
2. `python3 scripts/pre_release_gate.py` locale verde;
3. artifact costruito dal tag, non da working tree incerto;
4. firma/notarization/checksum verificati;
5. smoke su app installata con profilo controllato;
6. stato pubblicazione verificato su GitHub Releases.
