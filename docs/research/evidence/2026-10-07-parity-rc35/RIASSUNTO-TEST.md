# Parity reale Hermes vs Homun — 7 ottobre 2026 (Hermes rc.35-v0.21.5)

Test differenziale black-box: stessi modelli (qwen3.5:4b via Ollama su 127.0.0.1:11434),
stessi prompt/task. Hermes = `.audit-hermes-ref` aggiornato al tag `rc.35-v0.21.5`
(venv ricostruita su Python 3.14; il pyproject pinnano ruamel/jiter per ≥3.14),
`HERMES_HOME=/tmp/hermes-parity-home` (nessuna credenziale utente toccata).
Homun = main @ f74e1eb0, motore su 127.0.0.1:8765. Immagine terminal Homun:
`sha256:294b683cb724…` (Docker attivo).

## Risultati

| # | Capability | Hermes rc.35 | Homun | Note |
|---|---|---|---|---|
| T1 | Core chat loop | PASS ("OK") | PASS (verificato in chat UI, streaming) | entrambi su qwen3.5:4b |
| T2 | Agente crea file | PASS (file su host, contenuto esatto) | PASS (`write_workspace_file`, approvazioni digest, file nel workspace) | Homun: 2 observation (list + write) |
| T3 | Memoria cross-session | **FAIL** (nessuna memoria persistita: dir `memories/` vuota, state.db senza tabella) | idem a settembre (capability opt-in) | **upstream ha rimosso i memory provider bundled** → plugin catalog (supermemory/Honcho): senza plugin non c'è memoria |
| T6 | Terminale | **FAIL con qwen3.5:4b** (il modello non invoca MAI il tool terminale: `tool_calls=0` su tutte le prove in state.db; risponde testo) | PASS (terminal_execute in container pinned, **exit 0**, 2 turni, approvazione job verificata) | limite del modello 4b sul tool-calling di hermes, non del motore |

## Bug trovato e corretto durante il test (Homun)

Il mio fix anti-zombie (commit 304e683d) chiudeva falsamente i run in attesa di
approvazione terminale: **race tra lo snapshot stantio del delivery sweep e lo
stato DBOS fresco**. Sequenza: run `running` nello snapshot → il workflow
propone il terminal job e scrive `waiting_external` (transazione propria) → il
workflow esce SUCCESS → il sweep legge `running` (stantio) + SUCCESS (fresco) →
`agent_run_workflow_finished_unrecorded` su un run legittimo. Cura: rilettura
fresca del run prima di qualunque chiusura fatale; test di regressione dedicato
(`test_sweep_does_not_close_run_waiting_on_approval`).

Nota ambientale: durante la sessione è emersa una anomalia dati — la
conversazione di setup `conv_cnof2y8GTfj8iQ` (creata alle 11:07) non è più nel
DB dopo il riavvio del motore delle 11:44, senza recovery scattato (nessun
report, DB integro, meta.sequence allineato). Da tenere d'occhio: nessun'altra
perdita rilevata (work e run di oggi presenti).

## Changelog upstream (da cosa nasce la 0.21.5)

Gap dal nostro pin: **9.403 commit**. Filoni principali (ultimi 500 commit):
desktop (71), cron (48), gateway (44), dashboard (34), voice/STT (nuovo),
free-tier, kanban, telemetry, i18n layered. Fix rilevanti per le meccaniche
che abbiamo copiato — **gap di porting da valutare**:

1. `b6aae42c3b` — **anti-loop mentre streamma**: `is_runaway_repetition` (≥16k
   char) gira sui canali raw content+reasoning durante lo stream, a ogni
   raddoppio, e chiude il turno. Noi abbiamo gli stall-guard sui finish gates
   ma non un runaway check live sul parziale.
2. `572446308e` — **think inline nel pane ragionamento**: lo scrubber espone
   il testo strippato dai blocchi think come reasoning delta inline (per
   modelli che pensano senza tag nativi). Il nostro split gestisce solo i tag.
3. `167f0ef5fa` — coda del commento persa al confine tool-call (streaming
   interim): da verificare sul nostro path engine-side.
4. `a2a19bcc77` — clean-EOF senza finish_reason distinto dal drop di trasporto.
5. Memoria → **plugin catalog**: anche per noi una direzione (catalogo plugin
   invece di capability inglobate).
6. Voice: turni vocali con reasoning off di default e modello dedicato —
   filone prodotto nuovo, prima che compaiano gap.

## Comandi per riprodurre

- Hermes: `HERMES_HOME=/tmp/hermes-parity-home .venv/bin/hermes -z "<prompt>"`
  (config: provider custom → `http://127.0.0.1:11434/v1`, model qwen3.5:4b)
- Homun T2/T6: `bash tools/parity/t2_homun_agent_file.sh sha256:294b…` /
  `bash tools/parity/t6_homun_terminal.sh` (setup conv/proj in /tmp/parity_*)
