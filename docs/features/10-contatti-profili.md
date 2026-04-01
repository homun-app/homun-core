# Feature 10 — Contatti e Profili

> Documento di specifica funzionale per il dominio **Contatti e Profili** del progetto Homun.
> Versione: 2026-03-30

---

## 1. Gestione Contatti (CRUD, identità multi-canale)

### Comportamento Atteso
- L'utente può creare, leggere, aggiornare ed eliminare contatti nella rubrica personale dell'agente.
- Ogni contatto ha un nome, un nickname opzionale, una bio, note, data di compleanno/onomastico, canale preferito, modalità di risposta, tono di voce, tag e URL avatar.
- Ogni contatto può avere zero o più **identità** su canali diversi (Telegram, WhatsApp, email, ecc.). Un'identità è la coppia `(channel, identifier)` che identifica il contatto su quel canale.
- I contatti possono essere cercati per nome, nickname o bio tramite query full-text (LIKE).
- **Input:** dati del contatto (nome obbligatorio, altri campi facoltativi); identità come coppie `(channel, identifier, label?)`.
- **Output:** oggetto `Contact` serializzato in JSON; lista ordinata per nome (case-insensitive).
- **Stati:** lista vuota se nessun contatto è presente; errore DB se la query fallisce; successo con lista o oggetto singolo.
- **Edge case:** nome duplicato è permesso (non c'è vincolo di unicità sul nome). La cancellazione di un contatto elimina a cascata identità, relazioni ed eventi associati.

### Dettagli Tecnici
- **Moduli:** `src/contacts/mod.rs`, `src/contacts/db.rs`
- **Tipi principali:** `Contact`, `ContactIdentity`, `ContactUpdate`
- **Flusso dati:**
  1. API REST riceve la richiesta HTTP.
  2. Handler chiama metodi su `Database` (es. `insert_contact`, `update_contact`, `delete_contact`).
  3. Il DB SQLite aggiorna la tabella `contacts` e/o `contact_identities`.
  4. La risposta viene serializzata come JSON e restituita al client.
- **Tabelle DB:** `contacts`, `contact_identities`
- **Endpoint API:**
  - `GET /v1/contacts?q=<query>` — lista contatti con ricerca opzionale
  - `POST /v1/contacts` — crea contatto
  - `GET /v1/contacts/{id}` — leggi contatto
  - `PUT /v1/contacts/{id}` — aggiorna contatto (campi parziali)
  - `DELETE /v1/contacts/{id}` — elimina contatto
  - `GET /v1/contacts/{id}/identities` — lista identità
  - `POST /v1/contacts/{id}/identities` — aggiungi identità
  - `DELETE /v1/contacts/identities/{id}` — rimuovi identità

### Dipendenze
- **Da cosa dipende:** `storage::Database` (SQLite via sqlx), sistema di autenticazione (`require_write`).
- **Cosa dipende da questa feature:** contact context injection, contact perimeter, identity resolution, gateway overrides, contact auto-association.

---

## 2. Contact Context Injection (tone_of_voice, history nel system prompt)

### Comportamento Atteso
- Quando l'agente riceve un messaggio da un mittente noto (presente nella rubrica), viene costruito automaticamente un blocco di testo strutturato che descrive il contatto e viene iniettato nel system prompt della conversazione.
- Il blocco include: nome, nickname, bio, relazioni sociali, canale preferito, modalità di risposta, tono di voce richiesto, eventi/ricorrenze, tag e note.
- Se il mittente non è noto, viene iniettato invece un hint che informa l'agente che il mittente è sconosciuto e suggerisce di creare/associare un contatto durante la conversazione.
- **Input:** `channel` e `sender_id` del mittente.
- **Output:** stringa di testo multi-linea da inserire nel system prompt, oppure `None` se non trovato.
- **Edge case:** relazioni con contatti eliminati vengono gestite con fallback al solo ID numerico. Campi vuoti vengono omessi per non appesantire il prompt.

### Dettagli Tecnici
- **Moduli:** `src/contacts/context.rs`
- **Funzioni principali:**
  - `build_contact_context(db, channel, sender_id)` — lookup per identità + costruzione blocco
  - `build_contact_context_from(db, contact)` — costruzione blocco da contatto già risolto
  - `build_unknown_sender_context(channel, sender_id)` — genera hint per mittente sconosciuto
- **Flusso dati:**
  1. Il loop dell'agente chiama `build_contact_context` prima di comporre il system prompt.
  2. `find_contact_by_identity` esegue una JOIN `contacts ⋈ contact_identities`.
  3. Se trovato: carica relazioni (`list_contact_relationships`) e eventi (`list_contact_events`), costruisce il testo.
  4. Il testo viene concatenato al system prompt della sessione.
- **Tabelle DB:** `contacts`, `contact_identities`, `contact_relationships`, `contact_events`
- **Endpoint API:** nessuno (logica interna all'agent loop).

### Dipendenze
- **Da cosa dipende:** `contacts::db` (lookup identità, relazioni, eventi), struttura `Contact`.
- **Cosa dipende da questa feature:** agent loop / session builder (deve chiamare queste funzioni prima di ogni turno); `tone_of_voice` influenza il comportamento linguistico dell'agente.

---

## 3. Contact Perimeter (restrizioni conoscenza, namespacing)

### Comportamento Atteso
- Ogni contatto ha un **perimetro di accesso** che definisce cosa l'agente può condividere/fare quando risponde a quel contatto.
- Il perimetro controlla: namespace di conoscenza accessibili, scope della memoria, tool consentiti/negati, visibilità di altri contatti e del calendario.
- Se non esiste una riga esplicita in DB, vengono applicati dei **safe defaults**: namespace `["_public", "contact_{id}"]`, memoria `contact_only`, tool vault negato, contatti e calendario non visibili.
- La creazione di un nuovo contatto genera automaticamente una riga perimetro con i default sicuri.
- **Input:** `contact_id` + parametri perimetro (namespaces JSON, memory_scope, tools_allowed JSON, tools_denied JSON, flags booleani).
- **Output:** oggetto `ContactPerimeter`; in assenza di riga DB viene restituito il default calcolato runtime.
- **Edge case:** namespace duplicati vengono ignorati (operazione idempotente). La cancellazione esplicita del perimetro ripristina i safe defaults.

### Dettagli Tecnici
- **Moduli:** `src/contacts/perimeter.rs`
- **Tipi principali:** `ContactPerimeter`
- **Funzioni principali:**
  - `load_perimeter(pool, contact_id)` — carica o restituisce default
  - `upsert_perimeter(...)` — inserimento/aggiornamento con `ON CONFLICT`
  - `create_perimeter_for_contact(pool, contact_id)` — chiamata alla creazione contatto
  - `add_namespace_to_perimeter` / `remove_namespace_from_perimeter` — gestione granulare namespace
  - `delete_perimeter(pool, contact_id)` — ripristina safe defaults
  - `contact_namespace(contact_id)` → `"contact_{id}"` — genera namespace privato auto
- **Flusso dati:**
  1. Alla creazione di un contatto, `create_perimeter_for_contact` viene chiamato in automatico.
  2. Prima di ogni risposta, il loop carica il perimetro tramite `load_perimeter`.
  3. I namespace consentiti vengono usati per filtrare la ricerca RAG/knowledge base.
  4. I tool negati vengono esclusi dall'elenco tool disponibili per quella sessione.
- **Tabelle DB:** `contact_perimeters`
- **Endpoint API:**
  - `GET /v1/contacts/{id}/perimeter`
  - `PUT /v1/contacts/{id}/perimeter`
  - `DELETE /v1/contacts/{id}/perimeter`

### Dipendenze
- **Da cosa dipende:** `contacts::db` (contact_id), SQLite pool.
- **Cosa dipende da questa feature:** RAG / knowledge search (filtraggio namespace), tool dispatcher (filtraggio tool consentiti/negati), agent loop (caricamento perimetro per sessione).

---

## 4. Identity Resolution (stesso contatto su canali diversi)

### Comportamento Atteso
- L'agente può risolvere descrizioni in linguaggio naturale come "la mamma di Felicia" o "Marco Rossi" a un contatto specifico nella rubrica, anche traversando il grafo delle relazioni.
- **Fast path:** ricerca diretta per nome/nickname senza chiamata LLM. Se il match è esattamente uno, viene restituito con confidence 1.0.
- **Slow path:** se la descrizione contiene keyword relazionali (es. "madre", "papà", "collega", "di", "della") o ci sono match multipli, viene invocato un LLM one-shot con il grafo completo dei contatti e relazioni come contesto.
- **Input:** stringa descrizione in linguaggio naturale.
- **Output:** `ResolveResult { contact, confidence, resolution_path }` oppure `None`.
- **Edge case:** confidence < 0.5 viene scartata. Grafo vuoto restituisce `None`. La lista di keyword copre italiano e inglese.

### Dettagli Tecnici
- **Moduli:** `src/contacts/resolver.rs`
- **Tipi principali:** `ResolveResult`
- **Funzioni principali:**
  - `resolve_contact(db, config, description)` — entry point principale
  - `has_relationship_keywords(query)` — rilevazione fast/slow path
- **Flusso dati:**
  1. Verifica presenza keyword relazionali.
  2. Fast path: `db.list_contacts(Some(description))` → match diretto.
  3. Slow path: carica tutti i contatti + relazioni, costruisce testo di contesto, chiama `llm_one_shot` con temperature=0.1, max_tokens=256, timeout=15s.
  4. Il JSON restituito dall'LLM viene parsato: estrae `contact_id`, `confidence`, `path`.
  5. Se confidence >= 0.5 e contact_id valido, restituisce il contatto trovato.
- **Tabelle DB:** `contacts`, `contact_identities`, `contact_relationships` (letti in bulk)
- **Endpoint API:** nessuno diretto (usato internamente da tool e agent loop).

### Dipendenze
- **Da cosa dipende:** `contacts::db`, `config::Config` (per credenziali LLM), `provider::one_shot::llm_one_shot`.
- **Cosa dipende da questa feature:** tool `contacts` (quando l'agente deve identificare un contatto da testo libero), workflow di risposta assistita.

---

## 5. Profili Utente/Agente (CRUD, profilo default vs. named profiles)

### Comportamento Atteso
- Un **profilo** definisce l'identità operativa dell'agente: nome, ruolo, linguaggio, personalità, capacità e visibilità cross-profilo.
- Esiste sempre esattamente un **profilo default** (`is_default = 1`) che non può essere eliminato.
- Profili aggiuntivi (es. "acme-corp", "personal") possono essere creati, modificati ed eliminati.
- La cancellazione di un profilo non-default elimina in cascata tutti i dati associati (memoria, RAG, contatti, sessioni, automazioni, workflow, business, email pending).
- I profili sono caricati in un `ProfileRegistry` in memoria all'avvio e ricaricati a caldo senza restart.
- **Input:** slug (identificatore URL-safe), display_name, avatar_emoji, color (hex), profile_json (JSON strutturato), user_id opzionale.
- **Output:** oggetto `Profile`; lista ordinata default-first poi per slug.
- **Edge case:** tentativo di cancellare il profilo default restituisce errore. Slug duplicato genera errore DB (UNIQUE constraint). Il `profile_json` può essere `{}` per profili minimali.

### Dettagli Tecnici
- **Moduli:** `src/profiles/mod.rs`, `src/profiles/db.rs`
- **Tipi principali:** `Profile`, `ProfileJson`, `ProfileIdentity`, `ProfileLinguistics`, `ProfilePersonality`, `ProfileCapabilities`, `ProfileVisibility`, `ProfileRegistry`
- **Struttura `profile_json`:** JSON con sezioni `identity`, `linguistics` (language, formality, style, forbidden_words, catchphrases), `personality` (traits, tone, humor), `capabilities` (tools_emphasis, domains), `visibility` (readable_from).
- **`build_profile_context(profile)`:** genera testo summary del profilo per iniezione nel system prompt.
- **`resolve_visible_profile_ids(profile, pool)`:** risolve i profili visibili tramite `visibility.readable_from` per filtrare memoria e RAG.
- **`ProfileRegistry`:** cache `Arc<RwLock<HashMap<slug, Profile>>>` con metodi `get_default()`, `get_by_slug()`, `get_by_id()`, `list()`, `reload()`.
- **Tabelle DB:** `profiles`
- **Endpoint API:** gestiti da `src/web/api/` (pagina `/profiles`).

### Dipendenze
- **Da cosa dipende:** `storage::Database`, filesystem (per directory brain).
- **Cosa dipende da questa feature:** profile-scoped brain directory, contact profile assignment (`contacts.profile_id`), gateway default profile, agent loop (selezione profilo attivo), memoria/RAG (filtraggio per `profile_id`).

---

## 6. Profile-Scoped Brain Directory (USER.md per profilo)

### Comportamento Atteso
- Ogni profilo ha una directory dedicata nel filesystem per i file "brain" (SOUL.md, USER.md, INSTRUCTIONS.md).
- Il percorso è `{data_dir}/brain/profiles/{slug}/`.
- Alla creazione di un profilo o al reload del registry, la directory viene creata automaticamente se non esiste.
- **Migrazione legacy:** i file brain globali (`{data_dir}/brain/SOUL.md`, `USER.md`, `INSTRUCTIONS.md`) vengono copiati nella directory del profilo default se non sono già presenti lì. I file originali rimangono come fallback.
- **Input:** nessuno diretto — avviene automaticamente al caricamento del `ProfileRegistry`.
- **Output:** directory creata su filesystem.
- **Edge case:** se il profilo default non esiste nel registry, la migrazione viene saltata. La copia è idempotente (non sovrascrive se il file target già esiste).

### Dettagli Tecnici
- **Moduli:** `src/profiles/mod.rs` (metodi `ensure_brain_dirs`, `migrate_legacy_brain_files` su `ProfileRegistry`)
- **Funzione chiave:** `Profile::brain_dir(data_dir)` → `PathBuf` → `data_dir/brain/profiles/{slug}`
- **Flusso dati:**
  1. `ProfileRegistry::load()` carica i profili da DB.
  2. `ensure_brain_dirs()` itera tutti i profili, crea le directory mancanti.
  3. `migrate_legacy_brain_files()` copia SOUL.md, USER.md, INSTRUCTIONS.md nella dir del profilo default se non presenti.
- **Tabelle DB:** nessuna (operazione filesystem pura).
- **Endpoint API:** nessuno.

### Dipendenze
- **Da cosa dipende:** `ProfileRegistry` (deve esistere il profilo), filesystem con permessi di scrittura su `data_dir`.
- **Cosa dipende da questa feature:** agent loop (legge USER.md / INSTRUCTIONS.md dalla directory del profilo attivo per costruire il system prompt), tool brain_read/brain_write.

---

## 7. Gateways (gateway service, routing messaggi in uscita verso contatti)

### Comportamento Atteso
- Un **gateway** è un'istanza configurata di un tipo di canale (es. bot Telegram "personale", account WhatsApp "lavoro").
- Sono supportati più gateway dello stesso tipo (es. due bot Telegram distinti).
- Ogni gateway ha: nome, tipo canale, stato abilitato/disabilitato, configurazione JSON specifica del canale (`config_json`), profilo default, agente default, modalità di risposta.
- Il `config_json` contiene campi comportamentali comuni: `persona`, `tone_of_voice`, `allow_from` (lista ID autorizzati), `pairing_required`, `notify_channel`, `notify_chat_id`.
- I gateway sono caricati in un `GatewayRegistry` in memoria all'avvio.
- **Input:** dati gateway (nome, channel_type, config_json, default_profile, default_agent, response_mode).
- **Output:** oggetto `Gateway` o `GatewayBehavior`; lista ordinata per channel_type poi nome.
- **Edge case:** gateway disabilitato (`enabled = 0`) non viene incluso nelle liste "enabled". La deserializzazione di `config_json` con campi mancanti usa valori di default.

### Dettagli Tecnici
- **Moduli:** `src/gateways/mod.rs`, `src/gateways/db.rs`
- **Tipi principali:** `Gateway`, `GatewayBehavior`, `GatewayRegistry`
- **Trait `ChannelBehavior`:** implementato da `GatewayBehavior`, espone `persona()`, `tone_of_voice()`, `response_mode()`, `notify_channel()`, `notify_chat_id()`, `allow_from()`, `pairing_required()`, `default_agent()`, `default_profile()`.
- **`GatewayRegistry`:** cache `Arc<RwLock<Vec<Gateway>>>` con metodi `by_id()`, `by_channel_type()`, `enabled()`, `list()`, `reload()`.
- **Funzioni DB:** `insert_gateway`, `load_gateway_by_id`, `load_all_gateways`, `load_enabled_gateways`, `load_gateways_by_type`, `update_gateway`, `delete_gateway`, `count_gateways`.
- **Tabelle DB:** `gateways`
- **Endpoint API:** gestiti da `src/web/api/` (pagina `/channels`).

### Dipendenze
- **Da cosa dipende:** `storage::Database`, `config::ChannelBehavior` (trait).
- **Cosa dipende da questa feature:** channel handlers (Telegram, WhatsApp, ecc.) che usano il registry per trovare il gateway attivo; contact gateway overrides; routing messaggi in uscita; `allow_from` per filtraggio mittenti.

---

## 8. Contact Gateway Overrides (override configurazione canale per singolo contatto)

### Comportamento Atteso
- Per ogni contatto è possibile definire, gateway per gateway, quale **profilo** usare quando il contatto interagisce tramite quel gateway specifico.
- Questo permette di rispondere con un profilo aziendale "acme-corp" a un contatto business su WhatsApp, e con il profilo "personal" allo stesso contatto su Telegram.
- L'override è una coppia `(contact_id, gateway_id)` → `profile_id`.
- Se non esiste un override, viene usato il profilo assegnato al contatto (`contact.profile_id`) o quello di default del gateway (`gateway.default_profile`).
- **Input:** `contact_id`, `gateway_id`, `profile_id`.
- **Output:** lista di `ContactGatewayOverride` per un contatto; singolo `profile_id` per lookup.
- **Edge case:** upsert idempotente (`ON CONFLICT` aggiorna il profile_id). La cancellazione dell'override ripristina il comportamento default del gateway.

### Dettagli Tecnici
- **Moduli:** `src/gateways/db.rs` (funzioni `upsert_gateway_override`, `load_overrides_for_contact`, `get_override_profile_id`, `delete_gateway_override`)
- **Tipi principali:** `ContactGatewayOverride { id, contact_id, gateway_id, profile_id, created_at }`
- **Flusso dati:**
  1. All'arrivo di un messaggio, il loop identifica il gateway sorgente e il contatto.
  2. `get_override_profile_id(pool, contact_id, gateway_id)` cerca l'override specifico.
  3. Se trovato, carica il profilo corrispondente dal `ProfileRegistry`.
  4. Altrimenti, usa `contact.profile_id` o `gateway.default_profile`.
- **Tabelle DB:** `contact_gateway_overrides` (chiave unica su `(contact_id, gateway_id)`)
- **Endpoint API:**
  - `GET /v1/contacts/{id}/gateway-overrides`
  - `POST /v1/contacts/{id}/gateway-overrides`
  - `DELETE /v1/contacts/{id}/gateway-overrides/{gateway_id}`

### Dipendenze
- **Da cosa dipende:** `contacts` (contact_id valido), `gateways` (gateway_id valido), `profiles` (profile_id valido).
- **Cosa dipende da questa feature:** agent loop / session builder (selezione profilo attivo per la conversazione).

---

## 9. Contact Auto-Association (associazione automatica mittente sconosciuto)

### Comportamento Atteso
- Quando l'agente riceve un messaggio da un mittente non presente nella rubrica, il sistema non blocca la risposta ma inietta un hint nel system prompt che informa l'agente della situazione.
- L'hint include: canale, sender_id, e istruzioni per usare il tool `contacts` per creare un nuovo contatto o associare l'identità a un contatto esistente se l'identità del mittente viene scoperta durante la conversazione.
- Il processo di associazione è quindi **guidato dall'agente** tramite tool call, non automatico a livello di sistema.
- Il sistema mantiene anche una lista di mittenti noti per canale (`contact_identifiers_for_channel`) usata per costruire la lista `allow_from` dei gateway dinamicamente.
- **Input:** `channel`, `sender_id`.
- **Output:** stringa hint per il system prompt (se mittente sconosciuto); lista di identificatori noti per canale (per allow_from).
- **Edge case (WhatsApp):** l'identificatore può avere il suffisso `@s.whatsapp.net`; vengono indicizzate entrambe le forme (con e senza suffisso, con e senza `+`).

### Dettagli Tecnici
- **Moduli:** `src/contacts/context.rs` (funzione `build_unknown_sender_context`), `src/contacts/db.rs` (funzione `contact_identifiers_for_channel`)
- **Funzioni principali:**
  - `build_unknown_sender_context(channel, sender_id)` — genera il testo hint
  - `contact_identifiers_for_channel(channel)` — lista tutti gli identificatori noti per un canale, con normalizzazione WhatsApp
- **Flusso dati:**
  1. Agent loop chiama `build_contact_context(db, channel, sender_id)`.
  2. Se il risultato è `None` (mittente sconosciuto), chiama `build_unknown_sender_context`.
  3. L'hint viene iniettato nel system prompt.
  4. L'agente, durante la conversazione, può usare il tool `contacts` per creare/associare il contatto.
  5. All'avvio del gateway, `contact_identifiers_for_channel` popola `allow_from` con tutti gli identificatori noti.
- **Tabelle DB:** `contacts`, `contact_identities`
- **Endpoint API:** nessuno diretto.

### Dipendenze
- **Da cosa dipende:** `contacts::db` (lookup identità, lista identifiers per canale), `contacts::context` (builder hint).
- **Cosa dipende da questa feature:** agent loop (branching known/unknown sender), gateway channel handlers (costruzione `allow_from` dinamico da rubrica), tool `contacts` (creazione/associazione guidata dall'agente).
