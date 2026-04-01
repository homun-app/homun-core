# 03 — Memoria e Conoscenza

> Dominio: Agent Memory + RAG Knowledge Base
> Ultima revisione: 2026-03-30

---

## Feature 1 — Memoria Short-Term (Sessione)

### Comportamento Atteso
- L'agente ricorda tutti i messaggi scambiati nella sessione corrente.
- Ogni sessione è identificata da una chiave univoca (`session_key`, es. `cli:default`, `telegram:123456`).
- I messaggi vengono caricati dal DB all'avvio e tenuti in memoria durante la conversazione.
- L'utente vede risposte coerenti con il contesto della sessione senza dover ripetere informazioni.
- Input: messaggi utente/assistente con ruolo, contenuto e lista tool usati.
- Output: storico navigabile, usato come contesto per ogni nuova richiesta LLM.
- Stato vuoto: nessun messaggio precedente, la sessione parte da zero.
- Stato errore: fallimento scrittura DB (messaggio comunque restituito, log di warning).
- Limite: la finestra attiva è configurabile (`memory_window`, default 20 messaggi); oltre soglia scatta la consolidazione.

### Dettagli Tecnici
- Moduli: `src/storage/db.rs`
- Tabella SQLite: `session_messages` — campi: `session_key`, `role`, `content`, `tools_used`, `timestamp`
- Operazioni principali:
  - `insert_message(session_key, role, content, tools_used)`
  - `load_messages(session_key, limit)` — LIFO, ultime N righe
  - `count_messages(session_key)` — trigger per consolidazione
  - `delete_old_messages(session_key, keep_count)` — compaction post-consolidazione
  - `load_old_messages(session_key, keep_count)` — recupero chunk da consolidare
- Flusso dati: ogni turno di chat → `insert_message` → `count_messages` → se `count > memory_window` → `MemoryConsolidator::consolidate()`

### Dipendenze
- Da cosa dipende: `storage::Database` (SQLite via sqlx), configurazione `memory_window`
- Cosa dipende da questa feature: consolidazione long-term, contesto LLM, compaction sessione

---

## Feature 2 — Memoria Long-Term (Consolidazione LLM)

### Comportamento Atteso
- Quando il numero di messaggi supera `memory_window`, l'agente consolida automaticamente la conversazione in background (task non bloccante).
- Il processo produce: una voce storica in `HISTORY.md` + file giornaliero, aggiornamento di `MEMORY.md` (fatti persistenti), salvataggio istruzioni comportamentali in `INSTRUCTIONS.md`, segreti rilevati nel vault cifrato.
- L'utente non percepisce interruzioni; nelle sessioni successive i fatti appresi sono già disponibili nel contesto.
- Input: messaggi da processare (da `last_consolidated` a `total - keep_count`).
- Output: `ConsolidationResult` con `history_entry`, `memory_updated`, `new_chunks` (per indicizzazione HNSW), `pruned_chunk_ids`.
- Stato vuoto: se `process_start >= process_end` → nessuna elaborazione, result vuoto.
- Stato errore: chiamata LLM fallita → propagazione errore con log; vault non disponibile → warning e skip segreti.
- Edge case: valori vault già esistenti vengono deduplicati; istruzioni già presenti saltate; contenuto redatto prima della scrittura su file (`redact_vault_values`).

### Dettagli Tecnici
- Moduli: `src/agent/memory.rs` (`MemoryConsolidator`), `src/storage/db.rs`
- Strutture chiave:
  - `ConsolidationResult` — output consolidazione
  - `ConsolidationResponseV2` — risposta LLM (JSON): `history_entry`, `memory_update`, `instructions[]`, `vault_entries[]`
  - `ScoredInstruction` — istruzione con punteggio importanza 1-5
  - `VaultEntry` — coppia chiave/valore da cifrare
- File prodotti (in `{data_dir}/brain/` o `{data_dir}/brain/profiles/{slug}/`):
  - `MEMORY.md` — fatti persistenti sull'utente
  - `HISTORY.md` — log eventi conversazione
  - `INSTRUCTIONS.md` — regole comportamentali dell'agente
  - `{data_dir}/memory/YYYY-MM-DD.md` — file giornaliero (o `memory/profiles/{slug}/YYYY-MM-DD.md`)
- Tabelle DB: `memory_chunks` (nuovi chunk) + `sessions` (aggiornamento `last_consolidated`)
- Prompt LLM: temperature 0.3, max_tokens 4096, priority `Low` (non blocca altre richieste)
- Budget chunks: `prune_memory_chunks_to_budget(keep_count)` — elimina chunk meno rilevanti per score `importance * recency`

### Dipendenze
- Da cosa dipende: `Provider` (LLM), `MemoryBackend`, `storage::global_secrets()` (vault), configurazione `memory_window`, `MemorySearcher` (per indicizzazione nuovi chunk HNSW)
- Cosa dipende da questa feature: hybrid search memoria (i nuovi chunk entrano nell'indice HNSW), contesto system prompt (MEMORY.md + INSTRUCTIONS.md)

---

## Feature 3 — Tool `remember` (Aggiornamento USER.md)

### Comportamento Atteso
- L'utente può chiedere all'agente di ricordare informazioni personali: preferenze, contatti, dettagli anagrafici.
- Il tool scrive in modo idempotente nel file `USER.md` usando il formato "Semantic Markdown" (sezioni `## NomeSezione` con coppie `- chiave: valore`).
- Se la sezione esiste → aggiorna o aggiunge la chiave. Se non esiste → crea la sezione. Se il file non esiste → lo crea con struttura completa (tutte le sezioni default).
- Per segreti/password, il valore usa il formato `vault://nome_chiave`.
- Supporto site-specific memory: se fornito `site` (dominio), salva in `sites/{domain}.md` invece di `USER.md`.
- Input: `key` (1-64 chars), `value`, `category` (default: "Identity"), `site` (opzionale).
- Output: conferma testuale con chiave, valore e sezione.
- Edge case: chiave vuota o > 64 chars → errore. Chiave normalizzata (spazi → underscore, lowercase). Timestamp `Last updated` aggiornato ad ogni scrittura.
- Sezioni default: Identity, Family, Preferences, Contacts, Context.

### Dettagli Tecnici
- Moduli: `src/tools/remember.rs` (`RememberTool`)
- File prodotti:
  - `{brain_dir}/USER.md` — profilo utente globale
  - `{brain_dir}/sites/{domain}.md` — memoria sito-specifica (formato `SiteMemory` con YAML frontmatter)
- `brain_dir`: `ctx.profile_brain_dir` se disponibile, altrimenti `{data_dir}/brain/`
- Funzioni interne pure (testabili):
  - `update_user_content(content, category, key, value)` — dispatcher
  - `create_new_user_file(category, key, value)` — prima scrittura
  - `update_section(content, section_header, key, value)` — aggiornamento sezione esistente
  - `add_new_section(content, category, key, value)` — aggiunge nuova sezione
  - `update_timestamp(content, timestamp)` — aggiorna `Last updated`
- Nessuna tabella DB: operazione puramente su filesystem.
- Endpoint API: nessuno diretto; esposto tramite tool registry dell'agente.

### Dipendenze
- Da cosa dipende: `Config::data_dir()`, `ToolContext::profile_brain_dir`, modulo `browser::site_memory`
- Cosa dipende da questa feature: system prompt dell'agente (USER.md incluso nel contesto), navigazione browser (site memory)

---

## Feature 4 — Hybrid Search Memoria (Vector HNSW + FTS5 + RRF)

### Comportamento Atteso
- Ricerca nei chunk di memoria a lungo termine usando sia similarità vettoriale che keyword matching.
- Restituisce i risultati più rilevanti considerando: similarità semantica, corrispondenza testuale, età del contenuto (decay esponenziale), importanza del chunk.
- Supporta scoping per: `contact_id` (chunk globali + specifici del contatto), `agent_id`, `profile_ids` (lista profili visibili), `allowed_namespaces`.
- **Owner-scoped enforcement**: i chunk con `namespace = "_private"` sono invisibili ai contatti — solo il proprietario li vede. Questo è un filtro **strutturale** (SQL), non prompt-based.
- Fallback automatico a solo vector search se FTS5 fallisce (query con caratteri speciali).
- Input: `query` (testo libero), `top_k`, filtri scope opzionali.
- Output: `Vec<SearchResult>` con `chunk: MemoryChunkRow` e `score: f64`, ordinati per score decrescente.
- Edge case: query con caratteri FTS5 speciali (parentesi, virgolette, due punti) → sanificata da `sanitize_fts5_query`; date non valide → nessun decay applicato.

### Dettagli Tecnici
- Moduli: `src/agent/memory_search.rs` (`MemorySearcher`), `src/agent/memory_db.rs`, `src/agent/embeddings.rs`
- Algoritmo (pipeline a 5 stadi):
  1. **Vector search** (USearch/HNSW): `engine.search(query, 20)` → top 20 per cosine similarity
  2. **FTS5 search**: `db.fts5_search(sanitized_query, 20)` → top 20 per BM25 ranking
  3. **RRF merge**: `rrf_merge(vector, fts, top_k)` con `k=60` (formula: `sum(1/(60 + rank))`)
  4. **Temporal decay**: `score * 0.5^(age_days / 30)` — half-life 30 giorni
  5. **Importance weighting**: `score * (importance / 3.0)` — neutro a 3, max 1.67x a 5
- Tabelle DB: `memory_chunks` (caricamento full row), `memory_fts` (FTS5 virtual table su `memory_chunks`)
- Costanti: `CANDIDATES_PER_SOURCE=20`, `RRF_K=60.0`, `DEFAULT_HALF_LIFE_DAYS=30.0`
- Reindex completo: `reindex_all()` — ricarica tutti i chunk e ricostruisce indice HNSW

### Dipendenze
- Da cosa dipende: `EmbeddingEngine` (per vettorizzare la query), `Database` (FTS5 + chunk loading), indice HNSW su disco
- Cosa dipende da questa feature: contesto LLM (i chunk trovati sono iniettati nel prompt), tool knowledge search

---

## Feature 4b — Memory Visibility e Namespace Isolation

### Comportamento Atteso

- Ogni chunk di memoria ha un campo `namespace` che determina la visibilità:
  - `_private` (default): visibile solo al proprietario. I contatti non lo vedono.
  - `_public`: visibile al proprietario e a tutti i contatti del profilo.
  - Custom (es. `acme`, `contact_7`): visibile solo a chi ha quel namespace nel perimeter.
- **Auto-assegnazione**: quando un chunk viene creato con `contact_id`, il namespace è automaticamente `_public`. Senza contact, il default è `_private`.
- **Difesa strutturale**: il filtro `_private` è applicato a livello SQL nel memory search — non è un prompt instruction, è un hard block.
- La cognition discovery propaga gli `allowed_namespaces` dal contact perimeter al memory search.

### Dettagli Tecnici

- **Filtro nel search** (`memory_search.rs`): dopo il contact scoping, se `contact_id.is_some()` e `chunk.namespace == "_private"` → chunk escluso. Applicato in entrambi i path (merged_ids e vector_only fallback).
- **Auto-namespace** (`memory_db.rs`): `insert_memory_chunk()` calcola il namespace internamente:
  ```rust
  let namespace = if contact_id.is_some() { "_public" } else { "_private" };
  ```
- **Cognition** (`cognition/discovery.rs`): `search_memory()` accetta `allowed_namespaces: Option<&[String]>` e lo passa a `search_scoped_full()`. Il TODO rimosso.
- **Engine** (`cognition/engine.rs`): passa `params.allowed_namespaces.as_deref()` nel match `"search_memory"`.

### Dipendenze

- Da cosa dipende: contact perimeter (source dei namespace consentiti), MemorySearcher
- Cosa dipende: hybrid search, cognition discovery

---

## Feature 4c — Visibility Audit Wizard

### Comportamento Atteso

- L'owner può vedere e reclassificare i chunk di memoria privati tramite la Web UI (pagina `/memory`, sezione "Visibility Audit").
- **Dashboard**: conteggio chunk privati del proprietario, chunk pubblici, chunk per contatto.
- **Preview**: lista dei primi 20 chunk privati con heading, data, anteprima (120 char) e contenuto completo espandibile al click.
- **Azioni**: per ogni chunk, bottone "Share" per rendere visibile ai contatti (`_public`). Bulk "Mark all private" per confermare tutti come `_private`.
- Tutto filtrato per profilo attivo (query param `?profile=slug`).

### Dettagli Tecnici

- **API**:
  - `GET /v1/memory/audit?profile=slug` → `AuditResponse { private_owner_chunks, public_chunks, contact_scoped_chunks, unscoped_samples[] }`
  - `POST /v1/memory/audit/classify` → `{ chunk_ids: [i64], namespace: "_public"|"_private" }` — reclassifica chunk specifici
  - `POST /v1/memory/audit/classify-all` → `{ namespace: "_public"|"_private", profile?: "slug" }` — reclassifica tutti i chunk privati del profilo
- **DB** (`memory_db.rs`):
  - `audit_namespace_counts(profile_id)` → 3 count (private, public, contact_scoped)
  - `audit_private_samples(limit, profile_id)` → chunk per preview
  - `reclassify_chunks(chunk_ids, namespace)` → UPDATE per ID
  - `reclassify_all_private(namespace, profile_id)` → UPDATE bulk
- **Frontend** (`memory.js`): sezione con badge count, lista expand/collapse, bottoni Share e Mark All Private. Ricarica su cambio profilo.

### Dipendenze

- Da cosa dipende: Database (memory_chunks), profili (resolve_profile_filter)
- Cosa dipende: isolamento contatti (i chunk _public diventano visibili dopo reclassifica)

---

## Feature 5 — Embedding Providers (OpenAI + FastEmbed locale)

### Comportamento Atteso
- Converte testo in vettori float per indicizzazione e ricerca semantica.
- Provider selezionabile via config (`memory.embedding_provider`): `ollama` (default), `openai`, `mistral`, o qualsiasi endpoint OpenAI-compatibile.
- Cache LRU da 512 entries: testi già processati non vengono ri-embeddati.
- I vettori sono persistiti nell'indice HNSW su disco (sopravvivono ai riavvii).
- Input: `Vec<String>` di testi da embeddare.
- Output: `Vec<Vec<f32>>` — un vettore per testo, dimensione configurabile (default 384).
- Stato errore: chiamata API fallisce → propagazione errore con context.
- Edge case: dimensioni vettore devono corrispondere tra provider e indice HNSW; cambio modello richiede reindex completo.

### Dettagli Tecnici
- Moduli: `src/agent/embeddings.rs` (`EmbeddingEngine`, `EmbeddingProvider`)
- Trait `EmbeddingProvider`: metodi `embed(&[String])`, `dimensions()`, `name()`, `model_name()`
- Implementazioni:
  - `ApiEmbeddingProvider`: qualsiasi endpoint `/v1/embeddings` (OpenAI, Ollama, Mistral, HuggingFace TEI). Corpo richiesta: `{model, input, dimensions}`
  - Provider fastembed locale: inferenza on-device senza API key (feature-gated)
- Risoluzione API key: `embedding_api_key` → chiave provider LLM corrispondente → stringa vuota
- Indice HNSW: libreria `usearch`, metrica cosine, `ScalarKind` configurabile, file `.usearch` in `{data_dir}/`
- Cache: `LruCache<String, Vec<f32>>` con capacità 512 entry
- Operazioni indice: `index_chunk(id, text)` — embed + inserimento; `search(query, k)` — embed query + nearest neighbors; `save()` / `load()` — persistenza disco
- Reset provider: `reset_with_provider(new_provider)` + `reindex_all()` su tutti i chunk

### Dipendenze
- Da cosa dipende: config `memory.embedding_provider`, `memory.embedding_dimensions`, `memory.embedding_api_key`; per provider API: rete e API key valida
- Cosa dipende da questa feature: `MemorySearcher` (memoria), `RagEngine` (RAG knowledge base), reindex dopo cambio modello

---

## Feature 6 — RAG Knowledge Base (Ingestione Documenti)

### Comportamento Atteso
- L'utente può indicizzare file locali (testo, codice, documenti) per renderli ricercabili dall'agente.
- Oltre 30 formati supportati: md, txt, log, rs, py, js, ts, go, java, c, cpp, h, toml, yaml, json, html, csv, ini, cfg, env, sh, sql, xml, pdf, docx, xlsx, odt e altri.
- Deduplicazione automatica via SHA-256: file già indicizzati non vengono rielaborati.
- Il nome del file viene preposto all'heading di ogni chunk per migliorare la ricerca FTS5 per filename.
- Testo embeddato = `"{filename}\n{chunk.content}"` per arricchire il contesto vettoriale.
- Input: path file o directory, `source_channel`, `profile_id`, `user_id`, `namespace` (default `_private`).
- Output: `Option<i64>` — source_id se indicizzato, `None` se già presente.
- Stato vuoto: file senza contenuto estratto → status `indexed`, 0 chunks.
- Stato errore: formato non supportato → errore immediato; errore parsing → status `error` con messaggio.
- Edge case: ingestione directory con `recursive` flag; indice HNSW salvato su disco dopo ogni ingestione.

### Dettagli Tecnici
- Moduli: `src/rag/engine.rs` (`RagEngine`), `src/rag/db.rs`, `src/rag/chunker.rs`
- Tabelle DB:
  - `rag_sources`: `file_path`, `file_name`, `file_hash`, `doc_type`, `file_size`, `chunk_count`, `status`, `error_message`, `source_channel`, `profile_id`, `user_id`, `namespace`
  - `rag_chunks`: `source_id`, `chunk_index`, `heading`, `content`, `token_count`, `is_sensitive`, `profile_id`, `user_id`
  - `rag_fts` — FTS5 virtual table su `rag_chunks`
- Flusso ingestione singolo file:
  1. `is_supported(path)` → verifica estensione
  2. Lettura file + calcolo `hex_sha256`
  3. `find_rag_source_by_hash` → se trovato, return `None` (dedup)
  4. `insert_rag_source` → crea record in `rag_sources`
  5. `chunk_file(path, opts)` → lista `DocChunk`
  6. Per ogni chunk: `is_sensitive_filename || is_sensitive(content)` → flag; `insert_rag_chunk`; `engine.index_chunk(chunk_id, embed_text)`
  7. `engine.save()` → persiste HNSW
  8. `update_rag_source_status(id, "indexed", None, count)`

### Dipendenze
- Da cosa dipende: `EmbeddingEngine` (vettorizzazione chunk), `RagStore` (DB), `chunker` (estrazione chunk), `sensitive` (classificazione)
- Cosa dipende da questa feature: hybrid search RAG, directory watcher, tool knowledge (ingest/list/remove)

---

## Feature 7 — Hybrid Search RAG (HNSW + FTS5)

### Comportamento Atteso
- Ricerca nei chunk indicizzati della knowledge base con approccio ibrido (vettoriale + keyword).
- Restituisce i chunk più rilevanti con source attribution (nome file).
- Supporta scoping per `profile_id` e `allowed_namespaces`: i chunk con namespace non autorizzato sono esclusi; chunk `is_sensitive=true` restituiti con placeholder `[REDACTED — usa reveal per accedere]`.
- Input: `query` (testo), `top_k`, `profile_id`, `allowed_namespaces`.
- Output: `Vec<RagSearchResult>` con `chunk`, `score`, `source_file`.
- Fallback: se FTS5 fallisce → solo risultati vettoriali.

### Dettagli Tecnici
- Moduli: `src/rag/engine.rs` (`RagEngine::search`)
- Algoritmo identico alla memoria (Feature 4):
  1. Vector search HNSW → 20 candidati
  2. FTS5 BM25 → 20 candidati
  3. RRF merge (`k=60`)
  4. Filtraggio scope (profile, namespace)
  5. Redaction chunk sensibili
- Tabelle DB: `rag_chunks` (full row load), `rag_fts` (FTS5 virtual table)
- Costanti: `CANDIDATES_PER_SOURCE=20`, `RRF_K=60.0` (stesse della memoria)
- Source attribution: join con `rag_sources` per recuperare `file_name`

### Dipendenze
- Da cosa dipende: `EmbeddingEngine` (embed query), `RagStore` (DB), indice HNSW RAG su disco, `sensitive` (classificazione per redaction)
- Cosa dipende da questa feature: tool knowledge (`search` action), contesto LLM (chunk iniettati nel prompt)

---

## Feature 8 — Chunking (Strategie di Segmentazione)

### Comportamento Atteso
- Divide documenti in chunk di dimensione controllata per l'indicizzazione semantica.
- Strategie diverse per tipo di documento: testo libero → token sliding window; markdown → split per heading (`##`, `###`); codice → split per funzione/blocco; PDF/DOCX/XLSX → estrazione testo + sliding window.
- Overlap configurabile tra chunk contigui per preservare contesto ai bordi.
- Input: `Path` al file, `ChunkOptions { max_tokens: 512, overlap_tokens: 50 }`.
- Output: `Vec<DocChunk>` con `index`, `heading`, `content`, `token_count`.
- Edge case: file vuoto → lista vuota; formato non supportato → errore; chunk vuoti filtrati.

### Dettagli Tecnici
- Moduli: `src/rag/chunker.rs`
- Strutture: `DocChunk { index, heading, content, token_count }`, `ChunkOptions { max_tokens, overlap_tokens }`
- Funzioni principali:
  - `detect_doc_type(path)` → stringa tipo: `"markdown"`, `"text"`, `"code"`, `"config"`, `"html"`, `"pdf"`, `"docx"`, `"spreadsheet"`
  - `is_supported(path)` → check estensione contro `SUPPORTED_EXTENSIONS`
  - `chunk_file(path, opts)` → dispatcher per tipo
- Estensioni supportate (37 tipi): md, markdown, txt, log, rs, py, js, ts, go, java, c, cpp, h, hpp, toml, yaml, yml, json, html, htm, css, sh, bash, zsh, sql, xml, csv, ini, cfg, conf, env, dockerfile, makefile, pdf, docx, xlsx, xls, xlsm, odt
- Parser binari (feature-gated): PDF (pdfium/lopdf), DOCX/ODT (docx-rs), XLSX/XLS (calamine)
- Tokenizzazione approssimata: word-based count (non sub-word) per performance

### Dipendenze
- Da cosa dipende: filesystem (lettura file), feature flags Cargo per parser binari
- Cosa dipende da questa feature: `RagEngine::ingest_file` (usa chunk_file), `RagEngine::ingest_directory`

---

## Feature 9 — Sensitive Data Classification (Vault-Gating)

### Comportamento Atteso
- Ogni chunk RAG viene analizzato prima dell'indicizzazione per rilevare dati sensibili.
- Se rilevato: il chunk viene marcato `is_sensitive=true` nel DB; in fase di ricerca il contenuto viene sostituito con `[REDACTED — usa reveal per accedere]`; l'azione `reveal` richiede 2FA se abilitato.
- Classificazione anche per nome file: file con nomi come `password.txt`, `.pem`, `secrets.yaml` sono automaticamente sensibili.
- Rilevamento prompt injection (SEC-11): documenti con direttive malevole (ignore previous instructions, role hijacking, exfiltration commands, ecc.) vengono segnalati/bloccati.
- Input: testo chunk o nome file.
- Output: `bool` (is_sensitive) o `Vec<InjectionMatch>` con nome pattern.
- Edge case: falsi positivi su IBAN/carte → accettati come trade-off sicurezza.

### Dettagli Tecnici
- Moduli: `src/rag/sensitive.rs`
- Funzioni esposte:
  - `is_sensitive(text: &str) -> bool` — match regex su SENSITIVE_PATTERNS
  - `is_sensitive_filename(name: &str) -> bool` — match regex su SENSITIVE_NAME_PATTERNS
  - `scan_for_injection(text: &str) -> Vec<(match, pattern_name)>` — rilevamento prompt injection
- Pattern sensibili rilevati (regex compilate lazy con `LazyLock`):
  - API keys generiche: `api_key:`, `access_token:`, `bearer:`
  - Token specifici: `sk-...` (OpenAI), `sk-ant-...` (Anthropic), `ghp_` (GitHub), `glpat-` (GitLab), `AKIA...` (AWS), `xoxb-` (Slack)
  - Password: `password=`, `passwd=`
  - Chiavi private PEM: `-----BEGIN ... PRIVATE KEY-----`
  - JWT: `eyJ...eyJ...`
  - Connection string con credenziali: `postgres://user:pass@`
  - IBAN (pattern EU), numeri carta di credito 16 cifre
- Pattern injection (SEC-11): agent-directive, ignore-previous, role-hijack, new-instructions, exfiltration-command, hide-from-user, prompt-leak

### Dipendenze
- Da cosa dipende: libreria `regex`, `LazyLock` (std)
- Cosa dipende da questa feature: `RagEngine::ingest_file` (classifica ogni chunk), `RagEngine::search` (redaction output), tool knowledge (`reveal` action)

---

## Feature 10 — Directory Watcher (Auto-Ingest)

### Comportamento Atteso
- Monitora directory configurate e indicizza automaticamente i file aggiunti o modificati.
- Due sorgenti di configurazione:
  1. **DB watches** (`knowledge_watches` table) — con namespace, profile_id, contact_ids associati.
  2. **Legacy dirs** (`config.knowledge.watch_dirs`) — compatibilità retroattiva, nessuno scoping.
- Hot-reload: dopo operazioni CRUD sulle watch via API, il watcher si riconfigura senza riavvio (canale `WatchUpdate::Reload`).
- Solo file con estensione supportata vengono processati (filtro `is_supported`).
- Input: eventi filesystem (creazione/modifica file).
- Output: file indicizzati nella RAG knowledge base.
- Edge case: file già indicizzati (stesso hash) → skip; directory non esistente → log di warning; errore ingestione → log, continua con file successivi.

### Dettagli Tecnici
- Moduli: `src/rag/watcher.rs` (`RagWatcher`), `src/rag/db.rs` (`KnowledgeWatch`)
- Strutture:
  - `RagWatcher { engine, db, legacy_dirs, update_rx }`
  - `WatchContext { path, recursive, profile_id, namespace }` — contesto per ogni watch
  - `WatchUpdate::Reload` — segnale hot-reload via `mpsc::channel`
  - `KnowledgeWatch` — row DB con `path`, `recursive`, `enabled`, `profile_id`, `namespace`, `contact_ids` (JSON array)
- Libreria filesystem: `notify` (cross-platform, `RecommendedWatcher`)
- Modalità ricorsiva: `RecursiveMode::Recursive` o `RecursiveMode::NonRecursive` per watch
- Tabella DB: `knowledge_watches` — CRUD gestito da `src/web/api/knowledge/watches.rs`
- Task: avviato come background task con `spawn_watched` (gestione graceful shutdown via `stop_rx`)
- Metodo `load_contexts()`: carica watch abilitate da DB + legacy dirs ad ogni Reload

### Dipendenze
- Da cosa dipende: `RagEngine` (ingestione file), `Database` (load knowledge_watches), `notify` crate, canale `WatchUpdate` dall'API
- Cosa dipende da questa feature: knowledge base (alimentata automaticamente), API watches CRUD (`src/web/api/knowledge/watches.rs`)

---

## Feature 11 — Tool `knowledge` (Search/Ingest/List/Delete/Reveal)

### Comportamento Atteso
- Interfaccia unificata per interagire con la RAG knowledge base dall'interno della conversazione.
- Azioni disponibili:
  - `search`: ricerca semantica + keyword nei documenti indicizzati. Restituisce testo completo dei chunk (non solo nomi file). Unico modo per leggere contenuto di file caricati dall'utente.
  - `ingest`: indicizza un file o directory. Supporta flag `recursive` per directory.
  - `list`: elenca tutti i documenti indicizzati con ID sorgente, nome file, tipo, numero chunk, stato.
  - `remove`: elimina una sorgente per ID (cascata su chunk e vettori HNSW).
  - `reveal`: accede al testo di un chunk sensibile/redatto. Richiede 2FA (TOTP o session token) se la feature `vault-2fa` è abilitata.
- Input JSON: `{ action, query?, path?, source_id?, chunk_id?, code?, session_id?, recursive? }`
- Output: testo formattato per l'agente (chunk trovati con score, lista sorgenti, conferma ingestione).
- Edge case: `search` senza risultati → messaggio esplicito; `ingest` file non supportato → errore con estensione; `reveal` senza 2FA valido → errore 403; chunk_id non trovato → errore.

### Dettagli Tecnici
- Moduli: `src/tools/knowledge.rs` (`KnowledgeTool`)
- Implementa trait `Tool` con `name()="knowledge"`, `description()`, `parameters()` (JSON Schema), `execute(args, ctx)`
- Routing interno per `action`:
  - `"search"` → `engine.search(query, 5, profile_id, allowed_namespaces)`
  - `"ingest"` → `engine.ingest_file(path, ...)` o `engine.ingest_directory(path, recursive, ...)`
  - `"list"` → `store.list_rag_sources(profile_id, ...)`
  - `"remove"` → `store.delete_rag_source(source_id)` + rimozione vettori HNSW
  - `"reveal"` → verifica 2FA → `store.load_rag_chunk(chunk_id)` → testo in chiaro
- 2FA (feature `vault-2fa`): `is_2fa_enabled()` → se true → `verify_session(session_id)` oppure `verify_totp(code)` → accesso
- Context: `ToolContext { profile_id, allowed_namespaces, ... }` — scoping automatico per multi-tenant

### Dipendenze
- Da cosa dipende: `RagEngine` (search, ingest, remove), `TwoFactorStorage` + `TotpManager` (reveal con 2FA), `ToolContext` (scoping)
- Cosa dipende da questa feature: conversazione agente (tool chiamato dal loop LLM), frontend (tool result blocks)

---

## Feature 12 — MCP Cloud Sources (Integrazione Sorgenti Cloud)

### Comportamento Atteso
- Sincronizza risorse esposte da server MCP (Google Drive, Notion, Confluence, ecc.) nella knowledge base RAG locale.
- Il processo scarica le risorse come testo, le salva in una directory di staging, e le indicizza tramite `RagEngine`.
- Deduplicazione per hash: risorse non cambiate vengono saltate (`unchanged`); risorse modificate vengono re-indicizzate (`updated`); nuove risorse vengono indicizzate (`new_files`).
- Input: `McpPeer` (connessione al server MCP), `server_name` (per directory staging).
- Output: `SyncReport { new_files, updated, unchanged, errors }`.
- Edge case: server senza risorse → report vuoto; risorsa con contenuto vuoto → skip; errore lettura singola risorsa → log e continua; directory staging creata se non esiste.

### Dettagli Tecnici
- Moduli: `src/rag/cloud.rs` (`CloudSync`), `src/tools/mcp.rs` (`McpPeer`)
- Strutture:
  - `CloudSync { engine: Arc<Mutex<RagEngine>>, sync_dir: PathBuf }`
  - `SyncReport { new_files, updated, unchanged, errors }` — impl `Display`
- Protocollo MCP (libreria `rmcp`):
  - `peer.list_resources()` → lista `ResourceContents` (URI, nome, mime_type)
  - `peer.read_resource(uri)` → contenuto testuale
- Flusso sync per singola risorsa:
  1. `safe_filename(name, uri)` → nome file sicuro per filesystem
  2. Scrittura in `{sync_dir}/{server_name}/{filename}`
  3. Confronto hash SHA-256 con file esistente → skip se uguale
  4. `engine.lock().await.ingest_file(file_path, ...)` → indicizzazione RAG
- `extract_text_content(ResourceContents)` → estrae testo da risposta MCP (text o blob base64)
- Nessuna tabella DB propria: delega completamente a `RagEngine` e `rag_sources`/`rag_chunks`

### Dipendenze
- Da cosa dipende: `McpPeer` (connessione MCP attiva), `RagEngine` (ingestione), filesystem (staging dir), libreria `rmcp`, `sha2` (dedup hash)
- Cosa dipende da questa feature: knowledge base RAG (alimentata da sorgenti cloud), tool knowledge (i documenti cloud sono ricercabili con `search`)

---

## Tabelle DB — Riepilogo

| Tabella | Modulo | Scopo |
|---|---|---|
| `session_messages` | storage/db.rs | Messaggi sessione corrente (short-term) |
| `sessions` | storage/db.rs | Metadata sessione + puntatore `last_consolidated` |
| `memory_chunks` | agent/memory_db.rs | Chunk long-term (fatti, storia, istruzioni) |
| `memory_fts` | agent/memory_db.rs | FTS5 virtual table su memory_chunks |
| `rag_sources` | rag/db.rs | Sorgenti documenti RAG (file indicizzati) |
| `rag_chunks` | rag/db.rs | Chunk estratti dai documenti RAG |
| `rag_fts` | rag/db.rs | FTS5 virtual table su rag_chunks |
| `knowledge_watches` | rag/db.rs | Configurazione directory monitorate |

## File Su Disco — Riepilogo

| File | Percorso | Scopo |
|---|---|---|
| `USER.md` | `{brain_dir}/USER.md` | Profilo utente (tool remember) |
| `MEMORY.md` | `{brain_dir}/MEMORY.md` | Fatti long-term consolidati |
| `HISTORY.md` | `{brain_dir}/HISTORY.md` | Log eventi conversazione |
| `INSTRUCTIONS.md` | `{brain_dir}/INSTRUCTIONS.md` | Regole comportamentali agente |
| `YYYY-MM-DD.md` | `{memory_dir}/` o `{memory_dir}/profiles/{slug}/` | File giornaliero consolidazione |
| `sites/{domain}.md` | `{brain_dir}/sites/` | Memoria sito-specifica |
| `*.usearch` | `{data_dir}/` | Indice HNSW memoria + RAG |
