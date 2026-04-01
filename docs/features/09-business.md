# Business Autopilot

## Panoramica

Il modulo Business Autopilot consente a Homun di gestire attivita commerciali in modo autonomo o semi-autonomo. L'utente puo lanciare un business, definire prodotti e strategie, registrare vendite e spese, e delegare all'agente la revisione periodica tramite il ciclo OODA (Observe-Orient-Decide-Act). Tre livelli di autonomia (Semi, Budget, Full) controllano il grado di indipendenza decisionale dell'agente.

Il dominio e composto da 6 tabelle SQLite, un engine Rust per la logica di business, un tool LLM con 13 azioni, 10 endpoint REST e una pagina Web UI dedicata.

## Funzionalita

---

### 1. Business Entity

#### Comportamento Atteso

- L'utente crea un business specificando nome, descrizione opzionale, livello di autonomia, budget opzionale con valuta, intervallo OODA e canale di consegna notifiche.
- Ogni business ha un ID UUID troncato a 8 caratteri.
- Stati possibili: `planning` (default), `active`, `paused`, `closed`.
- Un business nasce in stato `active` quando creato tramite il tool LLM (`launch`). Quando creato via API REST, lo stato iniziale e anch'esso `active`.
- Un business chiuso (`closed`) e terminale: non puo essere riaperto ne messo in pausa.
- Il campo `context_json` permette di allegare contesto arbitrario in formato JSON.
- Campi opzionali `profile_id` e `user_id` per scoping multi-utente/multi-profilo (aggiunti in migrazione 037).
- Il campo `deliver_to` specifica il target di consegna notifiche in formato `channel:chat_id`.
- Il campo `created_by` registra chi ha creato il business in formato `channel:chat_id`.

#### Dettagli Tecnici

- **Moduli**: `src/business/mod.rs` (tipi), `src/business/db.rs` (CRUD), `src/business/engine.rs` (logica).
- **Struct**: `Business` con 18 campi, `BusinessStatus` enum (4 varianti), `BusinessAutonomy` enum (3 varianti).
- **Tabella DB**: `businesses` (migrazione `015_business.sql`). Indice su `status`.
- **Flusso dati**:
  - Creazione: `BusinessEngine::launch()` genera UUID, assembla la struct, chiama `Database::insert_business()`.
  - Cambio stato: `Database::update_business_status()` aggiorna status, `updated_at`, e `closed_at` (solo per stato terminale).
  - Lista: `Database::list_businesses(status, profile_id)` supporta filtro opzionale per status e profilo.
- **Endpoint API**:
  - `POST /api/v1/business` — crea un nuovo business (richiede auth write).
  - `GET /api/v1/business` — lista business con query param `?status=` e `?profile=` opzionali. Filtro profilo a livello SQL.
  - `GET /api/v1/business/{id}` — dettaglio singolo business con revenue summary.
- **Edge case**: chiusura di un business gia chiuso e permessa (idempotente). Pausa di un business chiuso restituisce errore.

#### Dipendenze

- Dipende da: `storage::Database`, migrazione `015_business.sql`, migrazione `037_user_profile_scoping.sql`.
- Dipendenti: tutte le altre feature business (strategie, prodotti, transazioni, ordini, insight) sono legate a un business via FK con `ON DELETE CASCADE`.

---

### 2. OODA Loop

#### Comportamento Atteso

- Ogni business ha un ciclo OODA periodico che l'agente esegue come automazione ricorrente.
- Il ciclo segue 5 fasi: Observe (stato corrente), Orient (performance finanziaria), Decide (analisi strategia), Act (pivot/ricerca se necessario), Report (invio report al proprietario).
- L'intervallo OODA e configurabile (default: `every:86400` = ogni 24 ore).
- Il prompt OODA viene generato dal engine e include: nome business, ID, livello di autonomia, informazioni budget (totale/speso/rimanente), e regole comportamentali basate sull'autonomia.
- L'automazione OODA viene collegata al business tramite `ooda_automation_id`.
- Se il business e in pausa, le review OODA si fermano.

#### Dettagli Tecnici

- **Moduli**: `src/business/engine.rs` (`build_ooda_prompt()`, `set_ooda_automation()`).
- **Flusso dati**:
  1. `launch()` crea il business e restituisce l'`ooda_prompt` nel risultato.
  2. L'agente crea un'automazione esterna usando il prompt OODA generato.
  3. `set_ooda_automation()` collega l'automazione al business (aggiorna `ooda_automation_id`).
  4. L'automazione invoca periodicamente le azioni `status`, `revenue`, `review`, e opzionalmente `pivot`/`research` del tool `business`.
- **Prompt generato**: il prompt istruisce l'LLM a usare le azioni del tool `business` in sequenza e ad applicare le regole di autonomia.
- **Tabella DB**: campo `ooda_automation_id` e `ooda_interval` in `businesses`.

#### Dipendenze

- Dipende da: Business Entity, sistema automazioni (`scheduler/automations.rs`), tool `business`.
- Dipendenti: nessuna dipendenza diretta.

---

### 3. Livelli di Autonomia

#### Comportamento Atteso

- **Semi** (`semi`): l'agente propone azioni significative all'utente prima di eseguirle. Strategie create rimangono in stato `proposed`. Prodotti creati restano in stato `draft` con messaggio esplicito di presentare all'utente per approvazione.
- **Budget** (`budget`): l'agente opera liberamente entro il budget allocato. Le spese che eccedono il budget rimanente vengono bloccate. Strategie vengono auto-approvate e attivate immediatamente.
- **Full** (`full`): l'agente opera in totale autonomia. Strategie vengono auto-approvate. Nessun vincolo di budget.
- Il livello di autonomia e impostato alla creazione del business e influenza il comportamento di `strategize`, `create_product`, e `pivot`.
- Default: `semi` (sia nel tool che nell'API REST).

#### Dettagli Tecnici

- **Moduli**: `src/business/mod.rs` (enum `BusinessAutonomy`), `src/tools/business.rs` (logica condizionale nei handler).
- **Enum**: `BusinessAutonomy` con varianti `Semi`, `Budget`, `Full`.
- **Logica condizionale**:
  - `handle_strategize()`: se `Semi`, la strategia resta `proposed` con messaggio per l'utente. Se `Budget`/`Full`, auto-transizione a `active`.
  - `handle_create_product()`: se `Semi`, messaggio di approvazione. Il prodotto resta `draft` in ogni caso.
  - `handle_pivot()`: stessa logica di `strategize` per la nuova strategia.
  - Il prompt OODA include le regole di autonomia nel testo generato.
- **Tabella DB**: campo `autonomy_level` in `businesses` (TEXT, valori: `semi`, `budget`, `full`).

#### Dipendenze

- Dipende da: Business Entity.
- Dipendenti: Budget Enforcement, OODA Loop, Business Tool (azioni `strategize`, `create_product`, `pivot`).

---

### 4. Budget Enforcement

#### Comportamento Atteso

- Un business puo avere un budget totale opzionale (`budget_total`) in una valuta specificata.
- Se `budget_total` e `None`, il budget e considerato illimitato e ogni spesa e permessa.
- Ogni spesa registrata (`record_expense`) viene verificata contro il budget rimanente (`budget_total - budget_spent`).
- Se la spesa eccede il budget rimanente, l'operazione fallisce con errore che indica importo richiesto e rimanente.
- Dopo ogni spesa, `budget_spent` viene ricalcolato come somma di tutte le transazioni di tipo `expense` per quel business.
- Il revenue summary include `budget_total` e `budget_remaining` per visibilita.

#### Dettagli Tecnici

- **Moduli**: `src/business/engine.rs` (`check_budget()`, `record_expense()`), `src/business/db.rs` (`update_budget_spent()`).
- **Flusso dati**:
  1. `record_expense()` chiama `check_budget()` prima di inserire la transazione.
  2. `check_budget()` carica il business e confronta `amount` con `budget_total - budget_spent`.
  3. Se il check passa, la transazione viene inserita e `update_budget_spent()` ricalcola il totale speso con `SUM(amount)` su tutte le transazioni `expense`.
- **Tabella DB**: campi `budget_total`, `budget_spent`, `budget_currency` in `businesses`.
- **Edge case**: se il business non ha budget (`budget_total IS NULL`), `check_budget()` ritorna sempre `true`. Il ricalcolo di `budget_spent` avviene con query aggregata (non incrementale) per garantire consistenza.

#### Dipendenze

- Dipende da: Business Entity, Transazioni.
- Dipendenti: Livelli di Autonomia (il livello `budget` si basa su questo meccanismo), OODA Loop (il prompt mostra lo stato del budget).

---

### 5. Transazioni

#### Comportamento Atteso

- Tre tipi di transazione: `income` (vendita/ricavo), `expense` (spesa), `refund` (rimborso).
- Ogni transazione ha: importo, valuta, descrizione opzionale, categoria opzionale, sorgente opzionale, importo tasse opzionale, aliquota tasse opzionale.
- Le transazioni possono essere collegate a un prodotto (`product_id`) e/o a un ordine (`order_id`).
- Una vendita (`record_sale`) crea una transazione `income` e aggiorna i contatori del prodotto collegato (unita vendute e ricavo totale).
- Una spesa (`record_expense`) crea una transazione `expense` con verifica budget.
- I refund sono registrabili direttamente in DB ma non hanno un handler dedicato nel tool LLM.
- Le transazioni sono ordinate per `recorded_at DESC`.

#### Dettagli Tecnici

- **Moduli**: `src/business/mod.rs` (struct `Transaction`, enum `TxType`), `src/business/engine.rs` (`record_sale()`, `record_expense()`), `src/business/db.rs` (`insert_transaction()`, `list_transactions()`).
- **Struct**: `Transaction` con 13 campi.
- **Enum**: `TxType` con varianti `Income`, `Expense`, `Refund`.
- **Tabella DB**: `transactions` (migrazione `015_business.sql`). Indici su `business_id` e `tx_type`.
- **Flusso `record_sale()`**:
  1. Genera UUID, crea transazione di tipo `income`.
  2. Inserisce in DB.
  3. Se `product_id` presente, chiama `update_product_sales()` per incrementare `units_sold` e `revenue_total`.
- **Flusso `record_expense()`**:
  1. Verifica budget con `check_budget()`.
  2. Se passa, genera UUID, crea transazione di tipo `expense`.
  3. Inserisce in DB.
  4. Chiama `update_budget_spent()` per ricalcolare il totale speso.
- **Endpoint API**: `GET /api/v1/business/{id}/transactions` — lista transazioni per business.
- **Edge case**: `record_sale()` non verifica il budget (le vendite non consumano budget). I campi `tax_amount` e `tax_rate` sono opzionali e non vengono validati (nessun calcolo automatico).

#### Dipendenze

- Dipende da: Business Entity, Prodotti (per `record_sale` con `product_id`).
- Dipendenti: Budget Enforcement (`update_budget_spent`), Revenue Tracking (aggregazione per summary).

---

### 6. Ordini

#### Comportamento Atteso

- Un ordine rappresenta l'acquisto di un prodotto da parte di un cliente.
- Ciclo di vita: `pending` -> `paid` -> `fulfilled` -> `refunded`/`cancelled`.
- Ogni ordine contiene: riferimento al prodotto, dati cliente (email, nome, paese), importo, tasse, valuta, provider di pagamento, riferimento pagamento, riferimento fattura, note.
- Gli ordini possono essere creati e gestiti via DB ma non hanno azioni dedicate nel tool LLM attuale.
- Il campo `completed_at` viene impostato automaticamente quando lo stato diventa `paid` o `fulfilled`.

#### Dettagli Tecnici

- **Moduli**: `src/business/mod.rs` (struct `Order`, enum `OrderStatus`), `src/business/db.rs` (`insert_order()`, `list_orders()`, `update_order_status()`).
- **Struct**: `Order` con 16 campi.
- **Enum**: `OrderStatus` con 5 varianti: `Pending`, `Paid`, `Fulfilled`, `Refunded`, `Cancelled`.
- **Tabella DB**: `orders` (migrazione `015_business.sql`). Indice su `business_id`. FK verso `businesses(id)` con `ON DELETE CASCADE`.
- **Flusso cambio stato**: `update_order_status()` imposta `completed_at` quando lo stato e `Paid` o `Fulfilled`, usando `COALESCE` per non sovrascrivere un timestamp gia presente.
- **Endpoint API**: `GET /api/v1/business/{id}/orders` non e attualmente registrato tra le route REST (solo il CRUD DB e disponibile).
- **Edge case**: nessuna validazione sulle transizioni di stato (es. si puo passare da `cancelled` a `paid`). Il campo `customer_country` e rilevante per il calcolo fiscale ma non viene usato automaticamente.
- **Limitazione**: il tool LLM non espone azioni per creare/gestire ordini. L'integrazione ordini e predisposta a livello DB/tipi ma non ancora esposta.

#### Dipendenze

- Dipende da: Business Entity, Prodotti (FK `product_id`).
- Dipendenti: Transazioni (campo `order_id` nelle transazioni collega ordini e pagamenti).

---

### 7. Strategie e Prodotti

#### Comportamento Atteso — Strategie

- Una strategia rappresenta un'ipotesi di business con un approccio proposto.
- Stati: `proposed` -> `approved` -> `active` -> `pivoted`/`abandoned`.
- In modalita Semi, le strategie nascono come `proposed` e richiedono approvazione utente.
- In modalita Budget/Full, le strategie vengono auto-approvate e attivate.
- Il pivot marca la vecchia strategia come `pivoted` e crea una nuova strategia.
- Ogni strategia ha campi opzionali `metrics` e `results` (JSON) per tracciare metriche e risultati.

#### Comportamento Atteso — Prodotti

- Un prodotto ha un tipo (`digital`, `physical`, `service`, `subscription`), prezzo, valuta e stato.
- Stati: `draft` -> `active` -> `discontinued`.
- I prodotti nascono sempre come `draft`.
- I contatori `units_sold` e `revenue_total` vengono aggiornati automaticamente quando si registra una vendita collegata al prodotto.
- Il campo `metadata` (JSON) permette dati aggiuntivi arbitrari.

#### Dettagli Tecnici

- **Moduli strategie**: `src/business/mod.rs` (struct `Strategy`, enum `StrategyStatus`), `src/business/db.rs` (`insert_strategy()`, `list_strategies()`, `update_strategy_status()`), `src/business/engine.rs` (`add_strategy()`), `src/tools/business.rs` (`handle_strategize()`, `handle_pivot()`).
- **Moduli prodotti**: `src/business/mod.rs` (struct `Product`, enum `ProductStatus`), `src/business/db.rs` (`insert_product()`, `list_products()`, `update_product_sales()`), `src/business/engine.rs` (`create_product()`), `src/tools/business.rs` (`handle_create_product()`).
- **Tabelle DB**: `business_strategies` (indice su `business_id`), `products` (indice su `business_id`). Entrambe con FK `ON DELETE CASCADE`.
- **Campo `approved_at`**: impostato automaticamente quando lo stato diventa `approved` (via `COALESCE` per non sovrascrivere).
- **Endpoint API**:
  - `GET /api/v1/business/{id}/strategies` — lista strategie.
  - `GET /api/v1/business/{id}/products` — lista prodotti.
- **Edge case**: non esiste un endpoint REST per creare strategie/prodotti direttamente (solo via tool LLM). Non esiste un'azione tool per cambiare lo stato di un prodotto da `draft` ad `active`.

#### Dipendenze

- Dipende da: Business Entity, Livelli di Autonomia (per auto-approvazione).
- Dipendenti: Transazioni (vendite collegate a prodotti), OODA Loop (le strategie sono parte del report di status).

---

### 8. Revenue Tracking

#### Comportamento Atteso

- Il revenue summary fornisce una fotografia finanziaria del business: ricavi totali, spese totali, rimborsi totali, profitto netto, tasse raccolte, budget totale e budget rimanente.
- Il profitto e calcolato come: `income - expenses - refunds`.
- Le tasse raccolte sono la somma di `tax_amount` sulle transazioni di tipo `income`.
- Il report di stato (`status_report`) include revenue, strategie e prodotti in formato testuale leggibile.
- L'azione `review` del tool combina il report di stato con revenue summary, conteggio strategie e insight recenti.

#### Dettagli Tecnici

- **Moduli**: `src/business/mod.rs` (struct `RevenueSummary`), `src/business/db.rs` (`revenue_summary()`), `src/business/engine.rs` (`get_revenue_summary()`, `status_report()`).
- **Struct**: `RevenueSummary` con 7 campi: `income`, `expenses`, `refunds`, `profit`, `tax_collected`, `budget_total`, `budget_remaining`.
- **Flusso `revenue_summary()`**:
  1. Query aggregate separate per income, expenses, refunds, tax_collected (4 query).
  2. Caricamento business per ottenere budget info.
  3. Calcolo `profit = income - expenses - refunds`.
  4. Calcolo `budget_remaining = budget_total - budget_spent`.
- **Flusso `status_report()`**: assembla un report Markdown con nome, ID, status, autonomia, budget, revenue, lista strategie e lista prodotti.
- **Endpoint API**: `GET /api/v1/business/{id}/revenue` — restituisce il `RevenueSummary` come JSON.
- **Web UI**: la pagina business mostra revenue, expenses e profit nel pannello dettaglio.
- **Limitazione**: non c'e filtraggio temporale (es. revenue dell'ultimo mese). Le query aggregano tutte le transazioni storiche.

#### Dipendenze

- Dipende da: Business Entity, Transazioni.
- Dipendenti: OODA Loop (usa revenue per la fase Orient), status report, Web UI (dashboard).

---

### 9. Business Tool (13 azioni)

#### Comportamento Atteso

Il tool `business` espone 13 azioni all'LLM per la gestione autonoma:

| Azione | Parametri Richiesti | Descrizione |
|---|---|---|
| `launch` | `name` | Crea un nuovo business |
| `list` | (nessuno) | Lista tutti i business, con filtro opzionale |
| `status` | `business_id` | Report di stato completo |
| `research` | `business_id`, `topic`, `content` | Registra un insight di mercato |
| `strategize` | `business_id`, `name`, `hypothesis` | Propone/crea una strategia |
| `create_product` | `business_id`, `name` | Crea un prodotto |
| `record_sale` | `business_id`, `amount` | Registra una vendita |
| `record_expense` | `business_id`, `amount` | Registra una spesa (con budget check) |
| `revenue` | `business_id` | Revenue summary finanziario |
| `review` | `business_id` | Review completa (report + revenue + strategie + insight) |
| `pivot` | `business_id`, `hypothesis` | Cambia strategia (marca vecchia come pivoted) |
| `pause` | `business_id` | Mette in pausa il business |
| `close` | `business_id` | Chiude il business permanentemente con summary finale |

- Il tool usa il pattern `OnceCell` per l'inizializzazione lazy del `BusinessEngine`.
- Ogni azione restituisce JSON formattato con `serde_json::to_string_pretty`.
- L'azione `launch` restituisce anche l'`ooda_prompt` per consentire all'agente di creare l'automazione OODA.
- L'azione `close` restituisce il revenue summary finale prima della chiusura.
- Parametri con default: `autonomy` -> `semi`, `currency` -> `EUR`, `product_type` -> `digital`, `insight_type` -> `research`, `category` -> `general`.

#### Dettagli Tecnici

- **Modulo**: `src/tools/business.rs` (671 righe).
- **Struct**: `BusinessTool` con campo `engine: Arc<tokio::sync::OnceCell<Arc<BusinessEngine>>>`.
- **Trait**: implementa `Tool` (name, description, parameters, execute).
- **Schema parametri**: oggetto JSON con 22 proprieta, solo `action` richiesto.
- **Routing**: match su stringa `action` nel metodo `execute()`, delega a 13 metodi `handle_*`.
- **Gestione errori**: parametri mancanti restituiscono `ToolResult::error()` (non panic). Errori di budget restituiscono l'errore formattato come `ToolResult::error`.

#### Dipendenze

- Dipende da: `BusinessEngine`, `ToolContext` (per `channel` e `chat_id`).
- Dipendenti: agent loop (il tool e registrato nel `ToolRegistry`), OODA Loop (usa le azioni del tool).

---

### 10. Configurazione Fiscale

#### Comportamento Atteso

- Ogni business puo avere una configurazione fiscale opzionale (`FiscalConfig`).
- La configurazione include: paese, partita IVA opzionale, regime fiscale, aliquota tasse di default opzionale.
- La configurazione fiscale e persistita come JSON nel campo `fiscal_config_json` della tabella `businesses`.
- Attualmente la configurazione fiscale viene passata al metodo `launch()` ma non viene impostata dal tool LLM (il parametro e sempre `None` nell'handler `handle_launch`).
- Le transazioni supportano `tax_amount` e `tax_rate` come campi opzionali indipendenti dalla configurazione fiscale.
- Il `RevenueSummary` include `tax_collected` come aggregazione delle tasse sulle transazioni income.

#### Dettagli Tecnici

- **Moduli**: `src/business/mod.rs` (struct `FiscalConfig`).
- **Struct**: `FiscalConfig` con 4 campi: `country` (String), `vat_number` (Option), `regime` (String), `default_tax_rate` (Option).
- **Persistenza**: serializzato come JSON nel campo `fiscal_config_json` della tabella `businesses`. Deserializzato in `BusinessRow::into_business()`.
- **Tabella DB**: campo `fiscal_config_json` in `businesses` (TEXT, nullable).
- **Limitazioni attuali**:
  - Il tool LLM non espone parametri per impostare la configurazione fiscale alla creazione del business.
  - Non c'e calcolo automatico delle tasse basato su `default_tax_rate` e paese cliente.
  - Il campo `customer_country` negli ordini non viene usato per determinare l'aliquota IVA applicabile.
  - Nessuna validazione del formato partita IVA.

#### Dipendenze

- Dipende da: Business Entity.
- Dipendenti: Transazioni (campi `tax_amount`/`tax_rate`), Revenue Tracking (`tax_collected`).

---

### 11. Market Insights (Ricerche di Mercato)

#### Comportamento Atteso

- L'agente puo registrare insight di mercato per un business, risultato di ricerche, analisi competitor, trend e opportunita.
- Ogni insight ha: topic, tipo (`research`, `competitor`, `trend`, `opportunity`), contenuto testuale, livello di confidenza opzionale (0.0-1.0), sorgente opzionale.
- Gli insight vengono usati nella fase Orient/Decide del ciclo OODA per informare le decisioni strategiche.
- L'azione `review` include i 5 insight piu recenti nel suo output.

#### Dettagli Tecnici

- **Moduli**: `src/business/mod.rs` (struct `MarketInsight`), `src/business/engine.rs` (`add_insight()`), `src/business/db.rs` (`insert_insight()`, `list_insights()`).
- **Struct**: `MarketInsight` con 8 campi.
- **Tabella DB**: `market_insights` (migrazione `015_business.sql`). Indice su `business_id`. FK con `ON DELETE CASCADE`.
- **Tool**: azione `research` richiede `business_id`, `topic`, `content`.

#### Dipendenze

- Dipende da: Business Entity.
- Dipendenti: OODA Loop (fase Orient/Decide).

---

## Web UI

La pagina Business (`static/js/business.js`, 433 righe) offre:

- **Form di creazione**: nome, descrizione, autonomia (dropdown), budget, valuta, canale di consegna.
- **Lista business**: card con nome, stato (badge colorato), autonomia, budget, data creazione. Card selezionabile per aprire il pannello dettaglio.
- **Pannello dettaglio**: revenue/expenses/profit, info business (stato, autonomia, budget, intervallo OODA), lista strategie, lista prodotti, lista transazioni (ultime 20).
- **Azioni**: pausa, riprendi, chiudi (con conferma). I bottoni pausa/riprendi sono visibili condizionalmente in base allo stato.
- **Statistiche**: contatore business attivi, contatore prodotti, revenue totale, profitto.
- **Delivery targets**: caricati da `/api/v1/automations/targets` per popolare il dropdown canale di consegna.

## Endpoint API

| Metodo | Path | Descrizione | Auth |
|---|---|---|---|
| `GET` | `/api/v1/business` | Lista business (filtro `?status=`) | Read |
| `POST` | `/api/v1/business` | Crea business | Write |
| `GET` | `/api/v1/business/{id}` | Dettaglio + revenue | Read |
| `POST` | `/api/v1/business/{id}/pause` | Pausa business | Read |
| `POST` | `/api/v1/business/{id}/resume` | Riprendi business | Read |
| `POST` | `/api/v1/business/{id}/close` | Chiudi business | Read |
| `GET` | `/api/v1/business/{id}/strategies` | Lista strategie | Read |
| `GET` | `/api/v1/business/{id}/products` | Lista prodotti | Read |
| `GET` | `/api/v1/business/{id}/transactions` | Lista transazioni | Read |
| `GET` | `/api/v1/business/{id}/revenue` | Revenue summary | Read |

**Nota**: solo `POST /api/v1/business` richiede esplicitamente `require_write`. Le azioni pause/resume/close non hanno check `require_write` esplicito nel codice attuale.

## Tabelle Database

Tutte definite in `migrations/015_business.sql`:

| Tabella | Chiave Primaria | FK | Indici |
|---|---|---|---|
| `businesses` | `id` (TEXT) | - | `idx_biz_status` |
| `business_strategies` | `id` (TEXT) | `business_id -> businesses` | `idx_strat_biz` |
| `products` | `id` (TEXT) | `business_id -> businesses` | `idx_prod_biz` |
| `transactions` | `id` (TEXT) | `business_id -> businesses` | `idx_tx_biz`, `idx_tx_type` |
| `orders` | `id` (TEXT) | `business_id -> businesses` | `idx_ord_biz` |
| `market_insights` | `id` (TEXT) | `business_id -> businesses` | `idx_insight_biz` |

Tutte le FK hanno `ON DELETE CASCADE`.

Campi `profile_id` e `user_id` aggiunti alla tabella `businesses` nella migrazione `037_user_profile_scoping.sql`.
