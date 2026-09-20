# Motore Python

Stato e verifiche complessive: [stato corrente](../docs/STATO.md). Il motore include ora intake supervisionato e confronto CSV reale; i rapporti delle singole tranche restano prove datate.

**Runtime adottato (D-RUN-01):** Pydantic AI + DBOS.
**Dominio F1+F2:** comandi versionati persistiti su **SQLite (WAL)**; HTTP locale.

La cifratura a riposo **non** è ancora attiva (D-CRYPTO-01). Non trattare il file
SQLite come archivio sicuro per dati sensibili di produzione.

## Sessione locale e recovery

La CLI richiede `HOMUN_SESSION_TOKEN` per la sessione desktop. Il comando
`npm run engine:dev` abilita esplicitamente `--dev-insecure` sul loopback per il
browser locale. Il processo desktop gestisce token e porta; non copiare il token
nei file di configurazione. Un secondo proprietario della stessa directory è rifiutato.

Il recovery avviato nel lifecycle ripulisce originali gestiti senza riferimenti e
riprende follow-up di messaggi con claim scaduta. Tre tentativi massimi, backoff,
fencing e controllo permessi; stato di errore visibile dopo refresh. Dettagli e
limiti nella [consegna recovery](../docs/research/2026-09-19-recovery-desktop-delivery.md).

## Backup completo v2 (offline)

`npm run engine:backup -- --full` richiede motore fermo e include workspace,
originali referenziati, DBOS e ricevute. Verifica e restore riconoscono il formato
automaticamente; destinazione completamente vuota. Credenziali, configurazione
provider e indici ricostruibili sono esclusi. Dopo restore riconfigurare i provider.
Non è un archivio cifrato o autenticato. La prova di recupero riprende un lavoro in
attesa dopo restore in una directory diversa senza duplicare la ricevuta.

## Backup del solo workspace v1 (F2.5)

Snapshot consistente del database dominio + `manifest.json` (hash SHA-256).
Il ripristino scrive **solo** in una directory di destinazione vuota.

```bash
# Crea backup sotto <data-dir>/backups/<timestamp>/
npm run engine:backup

# Verifica checksum
engine/.venv/bin/python -m homun backup verify ~/Library/Application\ Support/Homun2/engine/backups/<id>

# Ripristina in directory pulita (poi avvia con HOMUN_DATA_DIR)
engine/.venv/bin/python -m homun backup restore <backup-dir> --to /tmp/homun-restore
HOMUN_DATA_DIR=/tmp/homun-restore npm run engine:dev
```

Anche via HTTP (create/list; restore resta CLI):

- `POST /v1/workspaces/ws_local/backups`
- `GET /v1/workspaces/ws_local/backups`

## Dipendenze riproducibili

`requirements.lock` congela runtime, test e strumenti di build, con hash delle
distribuzioni. Il primo lock conserva tutte le 113 versioni già installate nel
virtualenv verificato; aggiunge soltanto dipendenze di build e piattaforme diverse.
Il profilo verificato usa **Python 3.13.12** e il compilatore del lock **uv 0.10.0**.
La risoluzione universale include marker per altri sistemi; la loro presenza non
costituisce una prova di esecuzione su quelle piattaforme. L'extra `memory` non è
incluso: richiede un profilo separato prima di una distribuzione che lo abilita.

Per un ambiente nuovo, dalla radice del repository:

```bash
npm run engine:install
```

Il comando crea `.venv` e sincronizza esattamente il lock: in un ambiente già
esistente può rimuovere pacchetti aggiunti manualmente. La CI usa lo stesso lock
con `pip install --only-binary=:all: --require-hashes`, poi installa il progetto locale con
`--no-deps --no-build-isolation` e verifica `pip check`. `requirements-build.in`
include anche `editables`, richiesto dinamicamente da Hatchling per la build
editable. Le dipendenze esterne devono avere un wheel compatibile: la CI rifiuta
un fallback a compilazioni sorgente con dipendenze di build non congelate.

Per rigenerare conservando le versioni già congelate:

```bash
uv pip compile engine/pyproject.toml engine/requirements-build.in \
  --extra dev --universal --python-version 3.13 \
  --constraint engine/requirements.lock --generate-hashes \
  --output-file engine/requirements.lock --no-config
```

Gli aggiornamenti intenzionali richiedono la revisione dei vincoli e del diff del
lock, reinstallazione in un virtualenv nuovo e suite completa. Non aggiornare il
lock dal risultato di una risoluzione non verificata. Il lock e i test Linux non
sostituiscono le prove del pacchetto Mac: vedere i
[gate di distribuzione](../docs/research/2026-09-19-production-release-gates.md).

## Avvio

```bash
npm run engine:install
npm run engine:dev
```

- Health: `http://127.0.0.1:8765/v1/health`
- Capabilities: `domain`, `backup`, `models`, `memory`, `runtime`, `materials` = true
- DB default (macOS): `~/Library/Application Support/Homun2/engine/ws_local.sqlite3`
- DBOS system DB + receipts (F4.1): under `<data-dir>/` (not the F0.2 experiment tree)
- Materials blobs (F4.2): `<data-dir>/materials/{id}/v{n}/original`
- Memories (F3.5a): `GET/POST /v1/workspaces/ws_local/memories` (ledger SQLite). Optional Mem0 dual-write with `HOMUN_MEMORY_BACKEND=mem0` after `uv pip install -e ".[memory]"` (Ollama + Qdrant local — see Memoria section below). Status: `GET /v1/memory/status`.
- Streaming (F3.5): `POST /v1/workspaces/ws_local/commands/stream` (SSE phase/token/result)
- Override: `HOMUN_DATA_DIR=/path npm run engine:dev`
- Secrets modelli: `<data-dir>/secrets/` file plaintext mode 0600 — **non** D-CRYPTO-01
- **Default provider:** Ollama (`http://127.0.0.1:11434/v1`, modello `llama3.2`). Fake solo nei test (`for_tests`).

## Memoria (F3.5a) — MemoryPort + Mem0 locale opzionale

Ledger SQLite = source of truth (`GET/POST /v1/workspaces/ws_local/memories`).

Optional **Mem0 OSS** dual-write for semantic recall (`HOMUN_MEMORY_BACKEND=mem0`):
local **Ollama** (LLM + embedder) + **Qdrant** only — never OpenAI defaults.

```bash
# Extras
cd engine && uv pip install -e ".[memory]"

# Qdrant
docker run -d --name homun-qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant

# Ollama models
ollama pull llama3.2
ollama pull nomic-embed-text

# Engine with Mem0
HOMUN_MEMORY_BACKEND=mem0 npm run engine:dev

# Status
curl -sS http://127.0.0.1:8765/v1/memory/status
```

| Env | Default |
|-----|---------|
| `HOMUN_MEMORY_BACKEND` | `sqlite` |
| `HOMUN_MEM0_OLLAMA_URL` | `http://127.0.0.1:11434` |
| `HOMUN_MEM0_LLM_MODEL` | `llama3.2` |
| `HOMUN_MEM0_EMBED_MODEL` | `nomic-embed-text` |
| `HOMUN_MEM0_EMBED_DIMS` | `768` |
| `HOMUN_MEM0_QDRANT_HOST` | `127.0.0.1` |
| `HOMUN_MEM0_QDRANT_PORT` | `6333` |
| `HOMUN_MEM0_COLLECTION` | `homun_memories` |

Live integration test: `HOMUN_MEM0_LIVE=1 .venv/bin/pytest tests/test_mem0_local_stack.py -m integration`.

## Progetti, grant e materiali (B1–B3)

Organizational `Project` / `Team` on the domain store (SQLite). Membership does
**not** invent AccessGrant. Project reads/writes are deny-by-default (B2);
`project.create` issues an `admin` grant to the creator. Materials (B3+F4.2):
metadata **and** local blob ingest (`POST .../materials/ingest`) with hash +
text extract (TXT/CSV/PDF). Unsupported formats stay downloadable without
claiming they were read. OCR is out of scope.

```bash
# List projects visible to the actor (requires X-Homun-Actor-Id)
curl -sS http://127.0.0.1:8765/v1/workspaces/ws_local/projects \
  -H 'X-Homun-Actor-Id: person_fabio'

curl -sS http://127.0.0.1:8765/v1/workspaces/ws_local/teams

# Create team
curl -sS -X POST http://127.0.0.1:8765/v1/workspaces/ws_local/commands \
  -H 'Content-Type: application/json' \
  -H 'X-Homun-Actor-Id: person_fabio' \
  -d '{"command_id":"cmd_team_1","type":"team.create","payload":{"name":"Catalogo","member_ids":["person_fabio"],"coordinator_id":"person_fabio"}}'

# Create project (bootstrap admin grant)
curl -sS -X POST http://127.0.0.1:8765/v1/workspaces/ws_local/commands \
  -H 'Content-Type: application/json' \
  -H 'X-Homun-Actor-Id: person_fabio' \
  -d '{"command_id":"cmd_proj_1","type":"project.create","payload":{"name":"Acme 2026","description":"Listini"}}'

# Issue read grant
curl -sS -X POST http://127.0.0.1:8765/v1/workspaces/ws_local/commands \
  -H 'Content-Type: application/json' \
  -H 'X-Homun-Actor-Id: person_fabio' \
  -d '{"command_id":"cmd_grant_1","type":"grant.issue","payload":{"project_id":"proj_…","subject_id":"person_other","capability":"read"}}'

# Materials on a project
curl -sS "http://127.0.0.1:8765/v1/workspaces/ws_local/projects/proj_…/materials" \
  -H 'X-Homun-Actor-Id: person_fabio'

# Ingest a file (F4.2)
curl -sS -X POST "http://127.0.0.1:8765/v1/workspaces/ws_local/projects/proj_…/materials/ingest" \
  -H 'X-Homun-Actor-Id: person_fabio' \
  -F 'file=@./listino.txt;type=text/plain' \
  -F 'relative_path=docs/listino.txt'

# Extracted content / raw blob
curl -sS "http://127.0.0.1:8765/v1/workspaces/ws_local/materials/mat_…/content" \
  -H 'X-Homun-Actor-Id: person_fabio'
curl -sS "http://127.0.0.1:8765/v1/workspaces/ws_local/materials/mat_…/blob" \
  -H 'X-Homun-Actor-Id: person_fabio' -o /tmp/original.bin
```

Settings → **Progetti** (grants + materials ingest/preview when a project is selected).

## Modelli (F3.1–F3.2) — ModelPort

Homun owns **ModelPort** (`homun.models.port`): connections, verify, complete/stream.
Vendor SDKs (including **Pydantic AI**) live only under `homun.models.adapters/`.
Swap an adapter without touching chat UI, agents, or memory.

| Adapter | Kind | Role |
|---------|------|------|
| `FakeModelAdapter` | `fake` | Deterministic, no network |
| `OpenAICompatModelAdapter` | `openai_compatible` | Ollama / any OpenAI-HTTP |
| `adapters/pydantic_ai.py` | helpers | Structured interpret + optional PAI chat |

**Build order:** LLM foundations → agents → memory → projects → product flow.

Provider `fake` (deterministico, nessun network) e `openai_compatible` (HTTP chat completions / Ollama).

Interpretazione messaggi: `POST /v1/models/interpret` e automatica su `conversation.post_message` (Fonte=motore). Output tipizzato; comandi solo proposta (F3.3 applica).

```bash
# Lista collegamenti ModelPort
curl -sS http://127.0.0.1:8765/v1/models/connections

# Lista provider + stato credenziali (legacy alias)
curl -sS http://127.0.0.1:8765/v1/models/providers

# Preset Ollama locale (richiede ollama serve)
curl -sS -X POST http://127.0.0.1:8765/v1/models/providers/openai_compatible/ollama_preset \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.2"}'

# Verifica fake (sempre ok se registry attivo)
curl -sS -X POST http://127.0.0.1:8765/v1/models/providers/fake/verify

# Interpret strutturato (fake in CI)
curl -sS -X POST http://127.0.0.1:8765/v1/models/interpret \
  -H 'Content-Type: application/json' \
  -d '{"text":"Prepare a catalog","roster":[{"id":"person_fabio","display_name":"Fabio","kind":"person"}],"provider_id":"fake"}'

# Chat ModelPort (alias di /complete)
curl -sS -X POST http://127.0.0.1:8765/v1/models/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Ciao"}],"connection_id":"fake"}'

# Completamento fake
curl -sS -X POST http://127.0.0.1:8765/v1/models/complete \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Ciao"}],"provider_id":"fake"}'

# UsageAttempt ledger (F3.5) — interpret tries linked to commands
curl -sS http://127.0.0.1:8765/v1/models/usage-attempts

# Credenziale OpenAI-compatible remota (salva su file locale)
curl -sS -X POST http://127.0.0.1:8765/v1/models/providers/openai_compatible/credentials \
  -H 'Content-Type: application/json' \
  -d '{"api_key":"sk-...","base_url":"https://api.openai.com/v1","default_model":"gpt-4o-mini"}'
```

### Adding an adapter

1. Create `engine/src/homun/models/adapters/<name>.py` implementing the ModelPort methods.
2. Import vendor SDKs **only** in that file (guarded by the isolation test).
3. Map a `Connection.kind` in `ModelRegistry.list_connections` / `upsert_connection`.
4. Keep HTTP responses as Homun types (`Connection`, `CompletionResult`) — never leak SDK types.

## Agenti (foundation slice A)

Homun `AgentProfile` is a domain object (not a model, not a chat): name, role, instructions,
`preferred_connection_id` (ModelPort), status (`draft|active|paused|retired`).

Commands: `agent.create`, `agent.update`, `agent.rename`. Reads: `GET .../agents`, `GET .../agents/{id}`.
Interpret roster merges workspace agents with `status in {active, draft}`.

```bash
# List agents
curl -sS http://127.0.0.1:8765/v1/workspaces/ws_local/agents

# Create
curl -sS -X POST http://127.0.0.1:8765/v1/workspaces/ws_local/commands \
  -H 'Content-Type: application/json' \
  -H 'X-Homun-Actor-Id: person_fabio' \
  -d '{"command_id":"cmd_agent_1","type":"agent.create","payload":{"name":"Vera","instructions":"Sii breve","preferred_connection_id":"fake"}}'
```

Bozza piano (F3.3): su `command_proposal` il motore estrae/valida un `PlanDraft` e, se completo e c’è un work collegato, chiama `plan.propose`. Messaggi corti restano `reply`.

## Runtime durable (F4.1)

Homun owns `Run` + EffectReceipt; DBOS owns checkpoint / `recv` / `send`.
`work.start` with durable runtime creates a Run and starts the workflow; contribution
via `work.provide_contribution` is accepted in domain then `DBOS.send`s to the wait.

```bash
# After plan.propose on a work — start durable run
curl -sS -X POST http://127.0.0.1:8765/v1/workspaces/ws_local/commands \
  -H 'Content-Type: application/json' \
  -H 'X-Homun-Actor-Id: person_fabio' \
  -d '{"command_id":"cmd_start_1","type":"work.start","payload":{"work_id":"work_…","expected_version":N}}'

# Current run for a work
curl -sS http://127.0.0.1:8765/v1/workspaces/ws_local/works/work_…/run

# Run by id
curl -sS http://127.0.0.1:8765/v1/workspaces/ws_local/runs/run_…

# Provide contribution (unblocks DBOS.recv)
curl -sS -X POST http://127.0.0.1:8765/v1/workspaces/ws_local/commands \
  -H 'Content-Type: application/json' \
  -H 'X-Homun-Actor-Id: person_fabio' \
  -d '{"command_id":"cmd_contrib_1","type":"work.provide_contribution","payload":{"request_id":"req_…","expected_version":N,"text":"Listino allegato"}}'
```

Tests: `engine/tests/test_f41_durable_runtime.py`, `test_f41_receipts.py`.

Identità della sessione locale: il launcher associa il token a
`HOMUN_SESSION_ACTOR_ID` (profilo desktop attuale: `person_fabio`). Il middleware
inietta l'attore se l'header manca e rifiuta header diversi o duplicati con
`session_actor_mismatch`; il nome non viene accettato come identità dal renderer.
Questo è un profilo locale, non un provider di identità multiutente.

Gli esempi curl senza Bearer in questa pagina valgono per `--dev-insecure`,
esplicitamente limitato al loopback. In tale modalità gli header attore sono:


- `X-Homun-Actor-Id`
- `X-Homun-Actor-Name` (opzionale)

Esempio:

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/workspaces/ws_local/commands \
  -H 'Content-Type: application/json' \
  -H 'X-Homun-Actor-Id: person_fabio' \
  -H 'X-Homun-Actor-Name: Fabio' \
  -d '{"command_id":"cmd_demo_1","type":"conversation.create","payload":{"title":"Ciao"}}'
```

## Test

```bash
npm run engine:test
```

## Contratti

- `contracts/openapi/v1-health.yaml`
- `contracts/openapi/v1-domain.yaml`
- `contracts/schemas/domain-f1.json`
