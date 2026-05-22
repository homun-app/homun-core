# Work Memory

Questo file e' la memoria operativa del lavoro svolto nel repository. Va aggiornato durante lo sviluppo per conservare non solo cosa e' stato fatto, ma anche perche'.

## 2026-05-22

### Bootstrap progetto

- Inizializzato il repository Git.
- Creato ambiente locale `.venv-mlx` con `uv`.
- Aggiunti `pyproject.toml`, `.python-version`, `.gitignore` e `uv.lock`.

Perche': il progetto deve essere riproducibile localmente e non dipendere dalla venv storica usata negli esperimenti iniziali.

### Runtime locale Gemma 4

- Creato `runtimes/mlx-gemma4/server.py`.
- Il server carica una sola volta `mlx-community/gemma-4-e4b-it-4bit`.
- Esposti endpoint locali: `/health`, `/generate`, `/generate_json`, `/tool_call`, `/analyze_image`, `/benchmark`, `/shutdown`.
- Aggiunte metriche per richiesta: token, token/s, memoria peak, tempo.
- Aggiunta validazione JSON e repair attempt locale.

Perche': `PROJECT.md` stabilisce che Gemma 4 deve essere un sidecar Python/MLX persistente, non una CLI lanciata a ogni prompt e non un servizio cloud.

### Benchmark parity

- Portati nel server i 7 casi validati della suite storica Gemma 4.
- Aggiunto `scripts/gemma4_benchmark.py` per produrre `reports/gemma4_eval.jsonl`.
- `make benchmark` esegue la suite reale con MLX.

Perche': la Fase 1 deve conservare il comportamento gia' validato: JSON rigido, routine inference, memory extraction, tool calling, patch codice e vision/OCR.

### Subagenti

- Aggiornato `PROJECT.md` con `Subagent Manager`, Fase 1.5 e workflow MVP.
- Aggiunti contratti JSON condivisi per `SubagentTask`, `SubagentResult`, `SubagentReview`.
- Creato crate Rust `crates/subagents`.
- Aggiunti tipi base, registry agenti iniziali e validazione permessi deny-by-default.
- Aggiunti tipi per risultato, audit, review, risk level e findings.

Perche': il runtime LLM non deve diventare l'agente. Il coordinamento, i permessi, la memoria accessibile, l'audit e la cancellazione dei task devono vivere nel Rust Core.

### Stato verificato

- `make test`: Python e Rust passano.
- `make benchmark`: suite Gemma reale 7/7 passata.

## Prossimo blocco

### ExecutionGraph subagenti

- Implementato `ExecutionGraph` in `crates/subagents`.
- Aggiunti `TaskNode` e `TaskState`.
- Il grafo calcola i task pronti quando tutte le dipendenze sono `succeeded`.
- Il grafo marca come bloccati i task pendenti con dipendenze `failed` o `cancelled`.
- Il grafo rifiuta dipendenze mancanti al momento dell'inserimento.

Perche': il Subagent Manager deve poter orchestrare workflow sequenziali/paralleli in modo auditabile, prima di introdurre esecuzione async o chiamate reali al runtime.

## Prossimo blocco

### Runtime client Rust

- Aggiunto `RuntimeClient` nel crate subagenti.
- Modellate `GenerateJsonRequest` e `GenerateJsonResponse`.
- La risposta conserva le metriche del runtime Python/MLX tramite `TokenMetrics`.
- Il client costruisce endpoint locali stabili e chiama `/generate_json`.

Perche': il Subagent Manager deve usare il runtime Gemma come primitiva locale HTTP. Il client e' tenuto separato dall'`ExecutionGraph` per non accoppiare scheduling, permessi e trasporto.

## Prossimo blocco

- Creare un primo `SubagentRunner` che prende un `SubagentTask`, valida permessi, chiama `RuntimeClient.generate_json` e produce `SubagentResult`.
- Mantenere il runner sincrono e minimale finche' non serve async/cancel reale.
