# Condivisione e Connessioni

## Panoramica

Il dominio Condivisione e Connessioni gestisce due aspetti complementari di Homun: (1) la **condivisione di risorse** (skill, server MCP, tool, namespace di conoscenza) con contatti specifici attraverso un modello di permessi espliciti, e (2) l'**onboarding semplificato di servizi esterni** tramite Connection Recipes, un layer di astrazione sopra l'infrastruttura MCP che trasforma la configurazione tecnica in un flusso guidato "connetti un servizio". A questi si aggiunge il sistema di **namespace** per l'isolamento delle risorse RAG e memoria.

## Funzionalita

---

### 1. Condivisione Risorse

#### Comportamento Atteso

**Prospettiva utente:** l'owner di un profilo puo condividere risorse (skill, server MCP, tool, namespace di conoscenza) con contatti specifici. La condivisione e l'**unico modo** per un contatto di accedere a risorse al di fuori del proprio perimetro base. L'interfaccia e un picker modale riutilizzabile (`SharingPicker`) che mostra la lista contatti con checkbox, permessi per-contatto, e — per i server MCP — selezione granulare di tool o risorse specifiche.

**Input:**
- `resource_type`: uno tra `"skill"`, `"mcp"`, `"tool"`, `"knowledge_namespace"`
- `resource_id`: identificativo della risorsa (nome skill, nome server MCP, nome tool, namespace)
- `owner_profile_id`: profilo proprietario
- `contact_id`: contatto destinatario
- `permission`: livello di accesso (`"read"`, `"write"`, `"admin"`)
- `scope_json`: filtro opzionale per sotto-risorse (es. `{"allowed_tools":["notion_search"]}` o `{"allowed_resources":["notion://page/abc"]}`)

**Output:**
- `SharedResource`: definizione della risorsa condivisa (id, tipo, resource_id, owner, descrizione, data creazione)
- `SharedResourceAccess`: grant di accesso per-contatto (id, resource_id, contact_id, permesso, scope_json, data creazione)
- `ContactSharedAccess`: vista computata a runtime di tutto cio che un contatto puo accedere, suddivisa in:
  - `skills`: `Vec<(nome, permesso)>`
  - `mcp_servers`: `Vec<(nome, permesso, scope_json)>`
  - `tools`: `Vec<nome>`
  - `namespaces`: `Vec<nome>`

**Stati possibili:**
- **Privato**: nessun grant di accesso — la risorsa e accessibile solo all'owner
- **Condiviso con N contatti**: uno o piu grant attivi, ognuno con permesso e scope specifici
- **Revocato**: grant rimosso tramite DELETE, il contatto perde immediatamente l'accesso

**Edge case e limiti:**
- La creazione di una risorsa condivisa usa `ON CONFLICT ... DO UPDATE`: se la stessa combinazione `(resource_type, resource_id, owner_profile_id)` esiste gia, viene aggiornata la descrizione (upsert)
- Il grant di accesso usa `ON CONFLICT ... DO UPDATE` su `(shared_resource_id, contact_id)`: un secondo grant allo stesso contatto sovrascrive permesso e scope
- La cancellazione di una `shared_resource` effettua cascade su tutti i grant associati (`ON DELETE CASCADE`)
- La cancellazione di un contatto effettua cascade su tutti i suoi grant (`ON DELETE CASCADE`)
- Lo `scope_json` e un campo JSON libero con chiavi convenzionali: `allowed_tools` per tool MCP, `allowed_resources` per risorse MCP. Il backend non valida la struttura del JSON
- Il frontend (`SharingPicker`) al primo click su un contatto abilita tutti i tool/risorse per default; l'utente puo poi restringere
- I tipi di risorsa non riconosciuti dal resolver (`resolve_contact_access`) vengono silenziosamente ignorati (match con `_ => {}`)

#### Dettagli Tecnici

**Moduli/file coinvolti:**
- `src/sharing/mod.rs` — tipi di dominio: `SharedResource`, `SharedResourceAccess`, `ContactSharedAccess`
- `src/sharing/db.rs` — operazioni CRUD: `create_resource()`, `list_resources_by_profile()`, `list_all_resources()`, `delete_resource()`, `grant_access()`, `list_access_for_resource()`, `revoke_access()`, `resolve_contact_access()`
- `src/web/api/sharing.rs` — 7 endpoint REST
- `static/js/sharing-picker.js` — componente modale riutilizzabile `window.SharingPicker`

**Flusso dati:**

1. **Creazione risorsa condivisa:** UI chiama `POST /api/v1/sharing/resources` con tipo, id risorsa e profilo owner. Il backend esegue `INSERT ... ON CONFLICT DO UPDATE` nella tabella `shared_resources` e restituisce l'ID.
2. **Concessione accesso:** UI chiama `POST /api/v1/sharing/resources/{id}/access` con `contact_id`, `permission` e `scope_json`. Il backend esegue upsert nella tabella `shared_resource_access`.
3. **Risoluzione accesso runtime:** quando il sistema deve determinare cosa puo fare un contatto, chiama `resolve_contact_access(pool, contact_id)`. La funzione esegue un `JOIN` tra `shared_resource_access` e `shared_resources`, raggruppa per tipo di risorsa, e restituisce un `ContactSharedAccess`.
4. **Revoca:** UI chiama `DELETE /api/v1/sharing/resources/{id}/access/{contact_id}`. Il backend elimina il record dalla tabella `shared_resource_access`.
5. **SharingPicker (frontend):** il modale carica contatti via `/api/v1/contacts`, grant esistenti via `/api/v1/sharing/resources`, e tool/risorse MCP via `McpLoader.discoverTools()` / `McpLoader.discoverResources()`. Al salvataggio, crea la risorsa se necessario, poi esegue upsert dei grant e DELETE dei grant rimossi.

**Tabelle DB utilizzate:**
- `shared_resources` (migrazione 043): `id`, `resource_type`, `resource_id`, `owner_profile_id` (FK → `profiles`), `description`, `created_at`. Vincolo UNIQUE su `(resource_type, resource_id, owner_profile_id)`. Indici su `resource_type` e `owner_profile_id`.
- `shared_resource_access` (migrazione 043): `id`, `shared_resource_id` (FK → `shared_resources`, CASCADE), `contact_id` (FK → `contacts`, CASCADE), `permission` (default `'read'`), `scope_json` (default `'{}'`), `created_at`. Vincolo UNIQUE su `(shared_resource_id, contact_id)`. Indici su `contact_id` e `shared_resource_id`.

**Endpoint API:**

| Metodo | Percorso | Descrizione | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/v1/sharing/resources` | Lista tutte le risorse condivise | read |
| `POST` | `/api/v1/sharing/resources` | Crea/aggiorna risorsa condivisa | write |
| `GET` | `/api/v1/sharing/resources/{id}` | Lista grant di accesso per una risorsa | read |
| `DELETE` | `/api/v1/sharing/resources/{id}` | Elimina risorsa (cascade su grant) | write |
| `POST` | `/api/v1/sharing/resources/{id}/access` | Concede accesso a un contatto | write |
| `DELETE` | `/api/v1/sharing/resources/{id}/access/{contact_id}` | Revoca accesso di un contatto | write |
| `GET` | `/api/v1/sharing/contacts/{contact_id}` | Vista computata di tutti gli accessi di un contatto | read |

#### Dipendenze

**Da cosa dipende:**
- Modulo `contacts` — i grant referenziano `contacts.id`
- Modulo `profiles` — le risorse appartengono a un `profiles.id`
- `web/auth.rs` — le operazioni di scrittura richiedono `require_write()`
- `McpLoader` (frontend) — per scoprire tool e risorse MCP da rendere selezionabili nel picker

**Cosa dipende da questa feature:**
- `contacts/perimeter.rs` — il perimetro di accesso di un contatto include le risorse condivise esplicitamente
- `agent/cognition/` — la cognition utilizza `ContactSharedAccess` per determinare quali tool rendere disponibili a un contatto
- `connections.js` — il bottone "Access" nella gestione istanze apre `SharingPicker` per condividere server MCP con contatti

---

### 2. Connessioni Esterne

#### Comportamento Atteso

**Prospettiva utente:** la pagina Connections presenta un catalogo di servizi esterni (GitHub, Notion, Slack, Jira, ecc.) come card visive. L'utente clicca "Connect", compila i campi richiesti (API key, token OAuth, ecc.), e il sistema configura automaticamente il server MCP sottostante, salva i segreti nel vault, e testa la connessione. Supporta multi-account (es. due istanze Gmail: `gmail-work` e `gmail-personal`).

**Input:**
- Selezione di una recipe dal catalogo (17 bundled + user-defined in `~/.homun/recipes/`)
- Valori dei campi definiti dalla recipe (API key, token, client_id, ecc.)
- Nome istanza opzionale (default: id della recipe)
- Flag `skip_test` per saltare il test di connessione

**Output:**
- `ConnectResult`: esito dell'operazione con `ok`, `message`, `connected`, `tool_count`, `stored_vault_keys`, `success` (copy di successo dalla recipe)
- Configurazione MCP persistita in `config.toml`
- Segreti salvati nel vault (`AES-256-GCM`)
- Hot-reload dei tool MCP nel registry dell'agente (senza restart)

**Stati possibili:**
- **Not Connected**: nessuna istanza configurata per la recipe
- **Connected**: una o piu istanze attive con tool count
- **Error**: connessione configurata ma test fallito
- **Multi-instance**: piu istanze della stessa recipe (es. `github` e `github-work`)

**Edge case e limiti:**
- Le recipe bundled sono compilate nel binario via `include_str!`; le recipe utente in `~/.homun/recipes/*.toml` possono sovrascrivere quelle bundled (stesso `id`)
- Il match tra recipe e istanze configurate avviene per `McpServerConfig::recipe_id` (esplicito) o per nome server = id recipe (legacy)
- I vault key sono namespace per istanza: `mcp.{instance_name}.{field_id}` (es. `mcp.github-work.personal_access_token`)
- Il test di connessione esegue solo `initialize + list_tools` senza sandbox (la sandbox si applica a runtime sui tool call)
- L'auto-generazione del nome istanza per multi-account segue il pattern `{recipe_id}-{n}` (es. `gmail-2`, `gmail-3`)
- Le recipe deprecate mostrano un badge "Deprecated" nel catalogo
- Tre modalita di autenticazione: `api_key` (campi manuali), `oauth` (flusso Google OAuth standard), `mcp_oauth` (OAuth 2.1 con PKCE e Dynamic Client Registration, usato da Notion)
- Il flusso OAuth usa popup + `postMessage` per il callback; il flusso MCP OAuth salva `code_verifier` e `client_id` in closure JS

#### Dettagli Tecnici

**Moduli/file coinvolti:**
- `src/connections/mod.rs` — tipi: `ConnectionRecipe`, `RecipeField`, `RecipeMcpConfig`, `SuccessCopy`, `ConnectionStatus`, `ConnectionInstance`, `ConnectionCatalogItem`
- `src/connections/recipes.rs` — caricamento recipe: `load_all_recipes()`, `find_recipe()`, `recipe_instances()`, `recipe_connection_status()`, `recipe_to_preset()`
- `src/connections/connect.rs` — orchestratore connessione: `connect_recipe()`
- `src/web/api/connections.rs` — 7 endpoint REST
- `static/js/connections.js` — UI catalogo, dialog di connessione, gestione istanze, flussi OAuth
- `recipes/*.toml` — 17 file TOML bundled (brave-search, github, gitlab, google-maps, google-workspace, home-assistant, jira, linear, notion, reddit, sentry, slack, spotify, stripe, todoist, twitter, wordpress)
- `src/mcp_setup.rs` — `apply_mcp_preset_setup()`, `test_mcp_server_connection()` (infrastruttura MCP sottostante)

**Flusso dati:**

1. **Caricamento catalogo:** `GET /api/v1/connections/catalog` chiama `load_all_recipes()` che parsa le recipe bundled + utente. Per ogni recipe, `recipe_connection_status()` incrocia con `config.mcp.servers` per determinare lo stato, e `recipe_instances()` trova tutte le istanze associate.
2. **Connessione:** `POST /api/v1/connections/recipes/{id}/connect` riceve i valori dei campi. `connect_recipe()` esegue:
   - Mappa `field.id` → `field.env_key` (es. `personal_access_token` → `GITHUB_PERSONAL_ACCESS_TOKEN`)
   - Converte recipe → `McpServerPreset` via `recipe_to_preset()` (vault key namespace per istanza)
   - Chiama `apply_mcp_preset_setup()` che salva segreti nel vault e scrive la config MCP
   - Tagga il server con `recipe_id` per il discovery multi-istanza
   - Opzionalmente testa la connessione via `test_mcp_server_connection()`
   - Se il test ha successo, salva `discovered_tool_count` nella config
3. **Hot-reload:** dopo connessione riuscita, un task `tokio::spawn` chiama `McpManager::connect_single()` per registrare i nuovi tool nel `tool_registry` senza restart del gateway.
4. **Test:** `POST /api/v1/connections/{name}/test` avvia temporaneamente il server MCP, esegue `initialize + list_tools`, e restituisce il report.
5. **Capabilities:** `GET /api/v1/connections/{name}/capabilities` avvia il server MCP temporaneamente, lista i tool con nome e descrizione, poi lo spegne.
6. **Disconnessione:** `DELETE /api/v1/connections/{name}` rimuove il server dalla config e persiste.

**Tabelle DB utilizzate:**
- Nessuna tabella dedicata. Le connessioni sono persistite nella configurazione TOML (`config.mcp.servers`) e i segreti nel vault (`~/.homun/secrets.enc`).

**Endpoint API:**

| Metodo | Percorso | Descrizione |
|--------|----------|-------------|
| `GET` | `/api/v1/connections/catalog` | Catalogo completo recipe + status |
| `GET` | `/api/v1/connections/recipes/{id}` | Dettaglio singola recipe + status |
| `POST` | `/api/v1/connections/recipes/{id}/connect` | Connetti servizio (store + config + test) |
| `POST` | `/api/v1/connections/{name}/test` | Re-test connessione esistente |
| `GET` | `/api/v1/connections/{name}/capabilities` | Lista tool esposti dal server MCP |
| `DELETE` | `/api/v1/connections/{name}` | Disconnetti istanza |
| `GET` | `/api/v1/connections` | Lista tutti i servizi connessi |

#### Dipendenze

**Da cosa dipende:**
- `src/mcp_setup.rs` — infrastruttura MCP: `apply_mcp_preset_setup()`, `test_mcp_server_connection()`
- `src/skills/mcp_registry.rs` — tipo `McpServerPreset`, `McpEnvVar`
- `src/config/schema.rs` — `McpServerConfig` (con campo `recipe_id`, `discovered_tool_count`)
- `src/storage/secrets.rs` — vault per i segreti (API key, token)
- `src/tools/mcp.rs` — `McpManager::connect_single()` per hot-reload
- `src/web/api/mcp/` — endpoint OAuth (`/api/v1/mcp/oauth/{provider}/start`, `/exchange`, `/callback`)

**Cosa dipende da questa feature:**
- L'agente utilizza i server MCP configurati tramite le connessioni per eseguire tool call
- `SharingPicker` puo condividere istanze di connessione con contatti via il bottone "Access"
- La pagina MCP (`mcp.js`) mostra i server configurati dalle connessioni

---

### 3. Namespace

#### Comportamento Atteso

**Prospettiva utente:** ogni documento RAG e chunk di memoria appartiene a un namespace che ne controlla la visibilita. Per default tutto e `_private` (solo l'owner). L'utente puo assegnare namespace alle risorse e poi condividere namespace specifici con contatti tramite il sistema di sharing (tipo `"knowledge_namespace"`).

**Input:**
- Colonna `namespace` nelle tabelle `rag_sources` e `memory_chunks` (default: `'_private'`)

**Output:**
- Isolamento a livello di query: le ricerche RAG e memoria filtrano per namespace accessibili al contatto

**Stati possibili:**
- `_private`: solo l'owner puo vedere (default conservativo)
- `_public`: tutti i contatti possono vedere (riservato)
- `_profile:{slug}`: scoping per profilo (riservato)
- Namespace custom (es. `famiglia`, `lavoro`): condivisibili esplicitamente con contatti

**Edge case e limiti:**
- La migrazione 042 aggiunge la colonna `namespace` con `DEFAULT '_private'` — tutti i dati preesistenti diventano privati (deny by default)
- I namespace riservati (`_private`, `_public`, `_profile:{slug}`) hanno semantica speciale e non dovrebbero essere usati come namespace custom
- La condivisione di un namespace con un contatto avviene creando una `shared_resource` di tipo `"knowledge_namespace"` con `resource_id` uguale al nome del namespace, poi concedendo accesso al contatto
- Il backfill dei dati esistenti e intenzionalmente conservativo: nessun dato preesistente viene esposto automaticamente

#### Dettagli Tecnici

**Moduli/file coinvolti:**
- `migrations/042_namespaces.sql` — aggiunge colonna `namespace` a `rag_sources` e `memory_chunks`
- `src/sharing/db.rs` — `resolve_contact_access()` include i namespace nella vista `ContactSharedAccess.namespaces`
- `src/rag/engine.rs` — il motore di ricerca RAG filtra per namespace accessibili
- `src/agent/memory_search.rs` — la ricerca memoria filtra per namespace

**Flusso dati:**

1. **Ingestione:** quando un documento viene aggiunto al RAG o un chunk di memoria viene creato, viene assegnato un namespace (default `_private`).
2. **Condivisione namespace:** l'owner crea una `shared_resource` con `resource_type = "knowledge_namespace"` e `resource_id = "{nome_namespace}"`, poi concede accesso ai contatti desiderati.
3. **Query runtime:** quando un contatto interroga il sistema, `resolve_contact_access()` restituisce i namespace accessibili in `ContactSharedAccess.namespaces`. Il motore RAG e la ricerca memoria filtrano i risultati in base a questi namespace piu i namespace base del perimetro del contatto.

**Tabelle DB utilizzate:**
- `rag_sources` — colonna `namespace TEXT NOT NULL DEFAULT '_private'`, indice `idx_rag_sources_namespace`
- `memory_chunks` — colonna `namespace TEXT NOT NULL DEFAULT '_private'`, indice `idx_memory_chunks_namespace`
- `shared_resources` + `shared_resource_access` — per i grant di tipo `"knowledge_namespace"`

**Endpoint API:**
- Nessun endpoint dedicato ai namespace. La gestione avviene tramite gli endpoint di sharing (`/api/v1/sharing/resources`) con `resource_type = "knowledge_namespace"`.

#### Dipendenze

**Da cosa dipende:**
- Modulo `sharing` — per la condivisione dei namespace con contatti
- `contacts/perimeter.rs` — il perimetro base definisce i namespace accessibili per default

**Cosa dipende da questa feature:**
- `src/rag/engine.rs` — filtra i risultati per namespace
- `src/agent/memory_search.rs` — filtra la memoria per namespace
- `src/agent/cognition/discovery.rs` — la cognition considera i namespace accessibili durante il discovery RAG
