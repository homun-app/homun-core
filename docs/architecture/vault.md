# Sottosistema Vault

> Stato: 2026-06-30. MVP foundation implementata a livello Rust/frontend con
> persistenza metadata-only delle proposte Vault e runtime locale di approval
> pagamento PIN+CVV one-shot. Spec di riferimento:
> `docs/superpowers/specs/2026-06-29-vault-purchase-approval-design.md`.

## Cosa fa

Il Vault e' l'area separata per dati sensibili personali: carte, documenti,
codice fiscale, informazioni sanitarie, targhe, credenziali e note private.
Non e' memoria: la memoria puo' contenere solo testo redatto o riferimenti
(`vault_ref`), mentre i valori sensibili passano da tool/policy dedicati.

## Stato implementato

- `crates/vault`: crate `local-first-vault`.
- `sensitive.rs`: classifier/redactor deterministico MVP.
- `types.rs` + `store.rs`: record/metadati separati da `SecretRef`, store in-memory
  e SQLite metadata-only; lo stesso DB conserva il verifier del PIN locale.
- `pin.rs`: verifier PIN locale con salt e hash iterato, serializzabile senza PIN
  in chiaro.
- `payment.rs`: policy di confronto per `PaymentApprovalSnapshot`.
- `crates/desktop-gateway/src/privacy_guard.rs`: Privacy Guard pre-turn, con
  classificazione model-first locale e sidecar pending per non salvare il raw nel transcript.
- `crates/memory/src/redaction.rs`: usa il classifier Vault prima di salvare/esporre
  memoria normale.
- `crates/desktop-gateway/src/browser_safety.rs`: variante approval-aware per il
  click finale di pagamento.
- `apps/desktop/src/components/ChatView.tsx`: parsing/rendering del marker
  `VAULT_PROPOSE`, con azioni salva/scarta, del marker `VAULT_REVEAL`, con unlock
  PIN locale in-chat, e del marker `PAYMENT_APPROVAL`.
- `apps/desktop/src/components/SettingsView.tsx`: sezione Settings separata `Vault`
  per status/setup/verifica del PIN locale e inserimento manuale di dati sensibili
  senza passare dalla chat; la tab `Dati sensibili` e' lista-first, mostra i record
  metadata-only salvati e apre l'inserimento manuale in una modale themed `Add`.
  I record salvati consentono modifica label/categoria o eliminazione.
- `crates/desktop-gateway/src/main.rs`: endpoint
  `/api/vault/records` (`GET`), `/api/vault/records/{id}` (`PATCH`, `DELETE`),
  `/api/vault/records/{id}/reveal` (`POST` con PIN),
  `/api/vault/proposals/accept`, `/api/vault/proposals/dismiss`,
  `/api/vault/pin/status|setup|verify`, fallback Vault redatto dentro
  `recall_memory` e
  `/api/vault/payment-approvals/approve`.

## Modello dati

Categorie:

- `payments`: carta senza CVV/CV2, billing profile, circuito, scadenza, ultime 4.
- `identity`: documenti, codice fiscale, dati anagrafici.
- `health`: allergie e informazioni sanitarie.
- `vehicles`: targhe, veicoli, assicurazioni.
- `credentials`: credenziali e token.
- `private_notes`: dati sensibili generici.

`VaultRecord` conserva metadati non sensibili e un `SecretRef`. Il materiale segreto
non entra nei metadati: quando il gateway riceve un valore sensibile esplicito lo
scrive in `vault_secret_material`, cifrato con una master key locale del Vault.
`VaultRecord::new` rifiuta CVV/CV2 nei metadati.

La lista UI/API dei record usa solo un summary redatto (`id`, `category`, `label`,
`redacted_preview`). Non espone `SecretRef` e non legge il materiale cifrato. La
modifica metadata-only consente cambiare `category` e `label`, preservando
`SecretRef`, `redacted_preview` e l'eventuale materiale cifrato. Se l'utente vuole
correggere il valore cifrato, la UI richiede il PIN locale e chiama il reveal
dedicato: solo dopo unlock il valore entra nello stato renderer e puo' essere
riscritto cifrato con lo stesso PIN. La cancellazione del record elimina sia
`vault_records` sia l'eventuale riga `vault_secret_material` associata, per non
lasciare secret orfani.

Il loop chat non vede il Vault come tool separato o connettore. Quando il modello
chiama `recall_memory` e la memoria normale non produce righe pertinenti, il gateway
prova internamente un fallback sui soli metadati redatti del Vault (`id`,
`category`, `label`, `redacted_preview`). Serve a evitare che il modello risponda
"non lo so" quando un record e' gia' nel Vault, senza esporre materiale segreto. Se
trova una corrispondenza, il modello deve dire che il dato e' salvato nel Vault e che
serve unlock locale con PIN per rivelarlo o editarlo; non deve inferire ne' inventare
il valore dal metadata. Se l'utente ha chiesto di vedere il valore, il risultato di
`recall_memory` include anche un marker `VAULT_REVEAL` da copiare nella risposta: la
UI mostra una card che chiede il PIN e chiama `/api/vault/records/{id}/reveal`. Il
valore rivelato resta nello stato locale della card e non viene riscritto nel
transcript.

`vault_local_pin` conserva solo `LocalPinVerifier` (`algorithm`, `iterations`,
`salt_hex`, `digest_hex`). Il PIN non e' reversibile e non viene mai serializzato in
chiaro; il gateway espone solo status/setup/verify dietro il bearer locale.

`vault_local_keyring` conserva la master key del Vault cifrata con una chiave derivata
dal PIN locale. Primo setup PIN crea la master key; cambio PIN autorizzato la
re-cifra sotto il nuovo PIN. Un reset/sostituzione non autorizzato del verifier non
puo' sbloccare il materiale gia' cifrato. I profili legacy con PIN gia' presente ma
senza keyring creano la master key al primo salvataggio Vault con PIN valido oppure
al primo cambio PIN verificato.

## Classificazione e redaction

La chat usa un **Privacy Guard pre-turn** prima del loop agentico principale:

1. prova una classificazione modellistica sul ruolo `privacy_guard`, ma solo se
   risolve su endpoint locale/loopback e modello non `:cloud`;
2. valida l'output del modello accettando solo `secret_value` che sono sottostringhe
   esatte del prompt utente;
3. se trova dati sensibili, chiude il turno senza chiamare il modello chat: il
   messaggio utente committato e' redatto e l'assistant contiene solo card
   `VAULT_PROPOSE`;
4. il raw secret vive in un sidecar volatile `pending_id`: il salvataggio chat
   conferma il record metadata-only senza PIN; il sidecar viene materializzato e
   cifrato solo al primo reveal/edit con PIN locale.

Il classifier deterministico resta fallback/safety net e copre:

- carte Luhn-valid da 13-19 cifre;
- CVV/CVC/CV2 come dato one-shot;
- codice fiscale italiano;
- targa italiana;
- note sanitarie con keyword sanitarie;
- credenziali/token/password.

Il confine memoria chiama `classify_sensitive_text` dentro `redact_text`: se trova dati
critici, la memoria vede solo placeholder `VAULT:*`.

## Marker chat

Il backend espone un formatter per:

```text
‹‹VAULT_PROPOSE››{"category":"payments","label":"Carta personale","redacted_preview":"[VAULT:payments:card:last4=1111]"}‹‹/VAULT_PROPOSE››
```

Il frontend lo nasconde dalla prosa e mostra una card. Le card create dal Privacy
Guard includono `pending_id`, ma non chiedono PIN al salvataggio: il raw non passa
dal transcript e `Save to Vault` crea subito un record metadata-only. Il PIN serve
quando l'utente vuole vedere o correggere il valore: il reveal recupera il sidecar
volatile, lo cifra in `vault_secret_material` e poi lo consuma. `Save to Vault` chiama
`/api/vault/proposals/accept` e persiste un `VaultRecord` in `~/.homun/vault.sqlite`
con label, categoria, preview redatta, `thread_id`/`message_id` opzionali e un
`SecretRef` opaco. Se la richiesta porta anche `secret_value`, deve portare un `pin`:
il gateway sblocca la master key e salva il valore in `vault_secret_material`
cifrato. Le card chat attuali non trasportano raw secret nel transcript, quindi
salvano metadati redatti + `pending_id`. Per valori manuali, Settings > Vault usa lo stesso
endpoint con `secret_value` e PIN locale: il valore entra nel gateway cifrato e non
nel transcript della chat. `Non salvare`
chiama `/api/vault/proposals/dismiss`; oggi e' solo ack locale, senza audit
persistente.

Nel live stream il gateway emette anche l'evento tipizzato `vault_propose` prima
del delta marker legacy. Il marker resta per vecchie chat e persistenza, non come
unico contratto del renderer.

Per record gia' salvati, la chat puo' ricevere:

```text
‹‹VAULT_REVEAL››{"record_id":"vault_...","category":"identity","label":"Codice Fiscale","redacted_preview":"[VAULT:identity:fiscal_code]"}‹‹/VAULT_REVEAL››
```

Il frontend nasconde il marker dalla prosa e mostra una card con campo PIN locale.
La chiamata di reveal usa l'endpoint PIN-gated e mostra il valore solo nel componente
corrente; il transcript conserva il marker/metadata redatto, non il valore.
Nel live stream lo stesso payload arriva anche come `vault_reveal` tipizzato.

## PIN locale

Endpoint gateway:

- `GET /api/vault/pin/status` -> `{ configured }`;
- `POST /api/vault/pin/setup` con `{ pin }` -> crea il primo verifier;
- `POST /api/vault/pin/setup` con `{ current_pin, pin }` -> sostituisce il verifier solo se il PIN
  corrente e' valido;
- `POST /api/vault/pin/verify` con `{ pin }` -> `{ ok }`.

Il PIN e' pensato come gate locale per CVV one-shot e approvazioni pagamento e come
wrapping key della master key locale del Vault. Non sostituisce il TOTP futuro
dell'app.

La UI espone setup/verifica PIN e lista/edit/delete manuale nella sezione Settings
`Vault`, separata da `Memory`. Il layout segue il pattern tabs dei Connectors:
`Dati sensibili` e `PIN locale`. `Dati sensibili` privilegia la lista; il valore raw
si inserisce solo nella modale `Add`, che svuota valore e PIN alla chiusura o dopo il
salvataggio. L'edit inline mostra solo metadati finche' l'utente non inserisce il PIN
e sblocca esplicitamente il valore.

## Pagamenti

`PaymentApprovalSnapshot` cattura merchant, dominio, importo, valuta, prodotto,
metodo di pagamento e fingerprint checkout. `validate_payment_approval` invalida
l'approval se uno di questi campi cambia.

Il loop non puo' cliccare il pagamento finale in autonomia. Quando arriva al
checkout emette:

```text
‹‹PAYMENT_APPROVAL››{"snapshot":{"approval_id":"pay_...","merchant":"...","domain":"...","amount_minor":5900,"currency":"EUR","product_summary":"...","payment_method_label":"Visa 1111","checkout_fingerprint":"..."}}‹‹/PAYMENT_APPROVAL››
```

La UI nasconde il marker e mostra una Payment Approval Card con riepilogo
merchant/importo/prodotto/metodo. L'utente inserisce PIN locale e CVV/CV2
one-shot; il bridge chiama `/api/vault/payment-approvals/approve` passando
`thread_id`/`message_id` quando disponibili. Il gateway:

- verifica il PIN locale;
- valida il CVV/CV2 come 3-4 cifre;
- registra in memoria volatile un grant con TTL 300s;
- riscrive il messaggio sorgente rimuovendo la card e lasciando solo
  `payment_approval_id` nel transcript, senza PIN o CVV.

Per riempire un campo CVV dopo l'approval, il modello non riceve il valore:
chiama `browser_act` con `payment_approval_id` e `vault_secret:"cvv_one_shot"`.
Il gateway sostituisce localmente il secret nel payload browser e lo consuma:
un secondo uso dello stesso CVV fallisce e richiede una nuova approval.

Il flusso e' coperto da un checkout controllato di gateway: messaggio assistant
con `PAYMENT_APPROVAL`, store chat in-memory, PIN configurato, approval, rewrite
transcript, blocco/sblocco del final-click e consumo one-shot del CVV. Questo
test resta sotto `local-first-desktop-gateway` perche' il confine critico e'
gateway/safety/store; il sidecar browser esegue solo azioni atomiche.

Il browser safety gate resta conservativo:

- `high_risk_reason` blocca acquisti/login/prenotazioni come prima.
- `high_risk_reason_with_payment_approval` puo' sbloccare solo controlli finali di
  pagamento se l'azione porta un `payment_approval_id` che combacia con quello
  approvato.

Nel live stream il payload arriva anche come `payment_approval` tipizzato prima
del delta marker legacy, così la card può migrare al renderer strutturato senza
dipendere da regex sul testo.

Login, script arbitrari e azioni high-risk non-payment restano bloccati.

## Non implementato ancora

- Payment Approval Card completa con screenshot/fingerprint.
- Telegram routing per riepilogo pagamento.
- Tool minimizzati PIN-gated per rivelare/riempire record Vault nel browser.
- Smoke live Electron su checkout fixture/browser reale.

## Regola di confine

Il modello non riceve dump del Vault e non vede il Vault come MCP/tool autonomo. Il
fallback interno di `recall_memory` espone solo metadati redatti per sapere che un
record esiste. Il canale Telegram configurato per le autorizzazioni puo' ricevere
riepiloghi e prompt di approvazione, ma non valori segreti grezzi; il reveal del
valore resta PIN-gated in app o in un futuro flusso dedicato e approvato. Quando
servira' il valore in un task agentico, usera' tool minimizzati PIN-gated
(`vault_get_field`, `vault_fill_browser_field`) con scopo, dominio, audit e policy.
Per i form, la direzione preferita e' compilare direttamente il browser senza far
transitare il valore sensibile nel testo del modello.
