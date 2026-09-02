# System Risk Matrix

Verificato 2026-08-31 sul branch di lavoro corrente.

Questa matrice serve a evitare che chat, memoria, privacy, modelli, tool,
automation e UI vengano verificati solo quando un utente inciampa in una
regressione. Non sostituisce la matrice kernel: la completa con domini di
rischio, invarianti, audit read-only e scenari live ripetibili.

## Regola

Ogni bug va classificato in una classe di rischio. La chiusura richiede almeno:

- owner canonico identificato;
- fixture owner-level o audit deterministico;
- scenario live se il bug dipende da modello, skill/tool, automation, browser,
  memoria o privacy in combinazione;
- evidenza separata per app reale o artifact installato quando il difetto
  dipende dal runtime desktop.

Un test che copre solo l'ultimo sintomo non basta. Deve bloccare la classe di
stati impossibili che ha permesso il bug.

## Domini

| Dominio | Owner canonico | Invarianti principali | Gate deterministico | Scenario live |
| --- | --- | --- | --- | --- |
| Chat/runtime | `turn_events`, `tasks`, `agent_runs`, broker | un terminale sblocca l'outcome; task terminale non lascia run running; HITL risolto produce follow-up o terminale | `scripts/audit_turn_consistency.py`, `scripts/audit_homun_state.py`, `python3 scripts/kernel_regression_gate.py` | `python3 scripts/production_smoke.py --profile baseline --gateway-base http://127.0.0.1:18765` |
| Memoria | `local-first-memory`, `MemoryFacade`, memory briefing/recall owners | ogni memoria live ha provenance; memoria sensibile non resta plaintext; recall rispetta workspace/privacy/sensitivity | `scripts/audit_homun_state.py --memory-db ...` | `production_smoke.py` scenari `S2`, `X3` |
| Privacy/Vault | `gateway_privacy_preflight`, `gateway_text_safety`, `local-first-vault` | input critico non raggiunge modello chat; log/trace non contengono raw; record Vault ha secret material cifrato | `scripts/audit_homun_state.py --vault-db ... --logs-dir ...` | `production_smoke.py` scenari `S3`, `S4`, `X3`; `S3` deve seedare un record Vault reale |
| Modelli/routing | `gateway_model_routing`, provider registry, `agent_runs` attribution | scelta modello spiegabile; run ha role/model/provider; fallback non diventa owner nascosto | `scripts/audit_homun_state.py --routing-decisions ...` | baseline `S1`, `S5`, `S9`; extended `X2`, `X3` |
| Tool/skill/capability | `gateway_tool_execution`, capability routing, execution receipts | side effect tracciato; skill/tool/MCP non cambia lifecycle; approval per write incerta | owner tests + kernel projection fixtures | baseline `S6`, `S8`; `S8` deve usare checkout HTTPS pubblico/configurabile e rifiutare blocchi browser, non prompt simulato; extended `X2`, `X6` |
| Automation | `gateway_automation_routes`, task runtime automation runs | trigger/run separati dalla chat interattiva; dry-run non mutante prima della creazione; automation non eredita stato/liveness del thread sbagliato | automation owner tests incluso `automation_dry_run` + `scripts/audit_homun_state.py` per run appesi | extended `X1`, `X5` |
| Code/subagents | workspace routing, `gateway_tool_execution`, `gateway_subagent_execution`, runtime plan state | `Auto` in workspace progetto usa contesto progetto; subagent produce outcome tracciato; nessun file viene modificato in scenari read-only; result delivery idempotente | owner tests subagent/runtime plan + `scripts/production_smoke.py --scenario X4`; `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway orchestrated_subagent_gathers_on_gemma4 -- --ignored --nocapture` | extended `X4`; `SUB1` live finche' il trigger broker subagent non e' stabile |
| UI projection | `/kernel-projection`, `kernelProjectionPresenter`, runtime view model | UI proietta stato canonico; non decide completion/liveness da marker o testo | `scripts/smoke_kernel_projection.py`, desktop unit tests | app smoke Electron su profilo isolato |
| Release/artifact | CI, packaged artifact QA, signing/notarization | CI verde non prova artifact installato; checksum/install/launch/firma sono evidenze separate | `python3 scripts/pre_release_gate.py` | production smoke su app installata |

## Audit Read-Only

Il comando di sistema iniziale e':

```bash
python3 scripts/audit_homun_state.py
```

Per profili isolati o DB di test:

```bash
python3 scripts/audit_homun_state.py \
  --runtime-db /path/to/homun.sqlite \
  --memory-db /path/to/memory.sqlite \
  --vault-db /path/to/vault.sqlite \
  --logs-dir /path/to/logs \
  --routing-decisions /path/to/routing-decisions.json \
  --max-findings-per-code 20
```

L'audit e' read-only. Riporta codici e owner, non valori sensibili. Il report
mantiene i conteggi completi in `summary` e mostra solo un campione per codice
tramite `--max-findings-per-code`. La prima versione copre:

- task terminale con `agent_runs.running`;
- run `agent_runs.running` senza task attivo corrispondente;
- messaggi assistant `streaming`/`retrying` senza run attivo;
- task `completed` con evento `browser_budget_exceeded`;
- task `waiting_user_approval` senza approval canonica pendente o HITL open;
- HITL risolto senza run successivo;
- run senza role/model/provider;
- memoria live con pattern sensibili plaintext;
- memoria live senza evidence link;
- record Vault senza `vault_secret_material`;
- secret material orfano;
- log diagnostici con pattern sensibili raw;
- routing decision senza stage/candidato/modello spiegabile.

La stessa copertura lifecycle read-only e' esposta anche da
`/api/integrity/audit` nella sezione `runtime`, insieme a `memory`, `vault` e
`graphs`, per permettere alla dashboard di mostrare owner/codici canonici.
Non e' ancora cablato nel gate kernel per evitare falsi positivi sul DB reale.
Quando il rumore e' classificato, va aggiunto come step deterministico.

## Scenario Lab

Le fixture non coprono il comportamento emergente dei modelli. Gli scenari live
devono girare su profilo isolato quando possibile, raccogliendo prima e dopo:

- `homun.sqlite`, `memory.sqlite`, `vault.sqlite`;
- `logs/turn-trace.jsonl`, `routing-decisions.json`;
- output di `audit_homun_state.py`;
- thread id, turn id, run id, terminal status e assistant text redatto.

Wrapper profilo pulito:

```bash
python3 scripts/clean_runtime_smoke.py --skip-smoke
python3 scripts/clean_runtime_smoke.py \
  --profile baseline \
  --scenario S1 \
  --seed-config-from ~/.homun \
  --copy-secrets \
  --keep
python3 scripts/clean_runtime_smoke.py \
  --profile all \
  --scenario X5 \
  --scenario X6 \
  --seed-config-from ~/.homun \
  --copy-secrets \
  --keep
```

`clean_runtime_smoke.py` avvia un gateway dedicato con `HOMUN_DATA_DIR`
temporaneo o esplicito, porta libera, token dedicato, smoke e audit finale sullo
stesso profilo. Non copia DB runtime/memoria/vault dal profilo reale. Con
`--seed-config-from` copia solo configurazione selezionata; i secret cifrati sono
copiati solo con `--copy-secrets`, insieme a `secret-key`, per mantenere coerente
lo store cifrato. Ogni run scrive evidenza JSON sotto
`clean-smoke-evidence/`.

Evidenza pulita 2026-09-02:

```bash
python3 scripts/clean_runtime_smoke.py --profile baseline --scenario S2 --scenario S3 --scenario S4 --seed-config-from ~/.homun --copy-secrets --model-headers-timeout-secs 30 --model-first-token-timeout-secs 60 --model-idle-timeout-secs 60
python3 scripts/clean_runtime_smoke.py --profile baseline --scenario S6 --seed-config-from ~/.homun --copy-secrets --model-headers-timeout-secs 30 --model-first-token-timeout-secs 60 --model-idle-timeout-secs 60
python3 scripts/clean_runtime_smoke.py --profile all --scenario X4 --seed-config-from ~/.homun --copy-secrets --model-headers-timeout-secs 30 --model-first-token-timeout-secs 60 --model-idle-timeout-secs 60
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway orchestrated_subagent_gathers_on_gemma4 -- --ignored --nocapture
```

Queste run hanno coperto memoria/privacy/Vault, browser form-fill, routing
codice read-only e subagent, con audit finale zero sui profili isolati per gli
smoke HTTP.

Baseline stabile:

```bash
python3 scripts/production_smoke.py --list
python3 scripts/production_smoke.py --profile baseline --gateway-base http://127.0.0.1:18765
```

Nota 2026-08-28: `S8` resta intenzionalmente un canary rosso finche' il
flusso checkout non produce una `Payment Approval Card` strutturata. Un testo
"simulato" o un `browser_budget_exceeded` non chiudono lo scenario.

Scenari complessi opt-in:

```bash
python3 scripts/production_smoke.py --profile extended --list
python3 scripts/production_smoke.py --profile extended --gateway-base http://127.0.0.1:18765
```

Il profilo `extended` include:

- `X1` automation lifecycle probe;
- `X2` skill/tool selection probe;
- `X3` interazione memoria/privacy/modello;
- `X4` code workspace auto-routing probe;
- `X5` automation API scoped lifecycle;
- `X6` MCP stdio API scoped lifecycle;
- `SUB1` subagent runner probe tramite test live ignorato.

Nota 2026-08-31: le automation espongono anche `POST
/api/automations/dry-run`, che valida request e recurrence senza creare rule o
task e senza restituire prompt/trigger completi. Lo scenario esteso `X5` lo usa
prima di materializzare automation reali.

Esecuzione completa:

```bash
python3 scripts/production_smoke.py --profile all --gateway-base http://127.0.0.1:18765
```

Gli scenari live non sostituiscono le fixture: quando falliscono, il fix deve
aggiungere una fixture o un audit che renda la classe riproducibile senza
dipendere dal modello reale.

## Procedura Per Ogni Nuovo Bug

1. Classificare il dominio primario e i domini secondari.
2. Identificare l'owner canonico che avrebbe dovuto impedire lo stato.
3. Aggiungere una fixture owner-level o una regola in `audit_homun_state.py`.
4. Se il bug dipende da combinazioni reali, aggiungere o aggiornare uno scenario
   live in `production_smoke.py`.
5. Eseguire il gate deterministico piu' piccolo e lo scenario live pertinente.
6. Annotare se l'evidenza e' locale, app reale o artifact installato.
