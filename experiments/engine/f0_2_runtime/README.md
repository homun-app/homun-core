# F0.2 — validazione runtime (Pydantic AI + DBOS)

Spike che ha **confermato l’adozione** di Pydantic AI + DBOS (D-RUN-01).
Non è uno stack temporaneo: da qui si integra nel motore Homun e si migliora.

Scenario verificato:

1. output tipizzato (piano) da un file di prova  
2. attesa contributo umano durable (`DBOS.recv`)  
3. kill del processo e ripresa dallo stato checkpointato  
4. effetto esterno incerto con rifiuto del doppio apply cieco  

Provider LLM: **nessuno** in questo spike (`TestModel` deterministico).

Esito documentato in
[`docs/architecture/decisions/2026-09-17-f0-2-runtime-spike.md`](../../../docs/architecture/decisions/2026-09-17-f0-2-runtime-spike.md).

## Setup

Richiede [`uv`](https://github.com/astral-sh/uv).

```bash
cd experiments/engine/f0_2_runtime
uv venv .venv
uv pip install -e . --python .venv/bin/python
```

## Prove

```bash
chmod +x scripts/*.sh
./scripts/prove_kill_resume.sh
./scripts/prove_uncertain_effect.sh
```

Manuale:

```bash
.venv/bin/python -m f0_2_runtime reset
.venv/bin/python -m f0_2_runtime start --workflow-id demo-1 --wait
# altro terminale, dopo il kill/riavvio del primo processo:
.venv/bin/python -m f0_2_runtime contribute --workflow-id demo-1
```

Dati locali in `.data/` (sqlite DBOS, piano, ricevute). Non sono dati di prodotto.

## Fuori scope di questo spike

- Secondo profilo agente / inserimento passo a caldo  
- MCP dinamico  
- Cifratura checkpoint  
- Packaging Electron / Mac pulito  
- Integrazione con `apps/web` o `engine/` di produzione  

Questi restano gate F0 successivi o criteri di chiusura D-RUN-01.
