# Sottosistema Vault

> Stato: 2026-06-29. MVP foundation implementata a livello Rust/frontend con
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
- `crates/memory/src/redaction.rs`: usa il classifier Vault prima di salvare/esporre
  memoria normale.
- `crates/desktop-gateway/src/browser_safety.rs`: variante approval-aware per il
  click finale di pagamento.
- `apps/desktop/src/components/ChatView.tsx`: parsing/rendering del marker
  `VAULT_PROPOSE`, con azioni salva/scarta, e del marker `PAYMENT_APPROVAL`.
- `apps/desktop/src/components/SettingsView.tsx`: sezione Settings separata `Vault`
  per status/setup/verifica del PIN locale.
- `crates/desktop-gateway/src/main.rs`: endpoint
  `/api/vault/proposals/accept`, `/api/vault/proposals/dismiss`,
  `/api/vault/pin/status|setup|verify` e
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

`vault_local_pin` conserva solo `LocalPinVerifier` (`algorithm`, `iterations`,
`salt_hex`, `digest_hex`). Il PIN non e' reversibile e non viene mai serializzato in
chiaro; il gateway espone solo status/setup/verify dietro il bearer locale.

`vault_local_keyring` conserva la master key del Vault cifrata con una chiave derivata
dal PIN locale. Primo setup PIN crea la master key; cambio PIN autorizzato la
re-cifra sotto il nuovo PIN. Un reset/sostituzione non autorizzato del verifier non
puo' sbloccare il materiale gia' cifrato. I profili legacy con PIN gia' presente ma
senza keyring creano la master key al primo cambio PIN verificato.

## Classificazione e redaction

Il classifier MVP e' deterministico e copre:

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

Il frontend lo nasconde dalla prosa e mostra una card. `Salva nel Vault` chiama
`/api/vault/proposals/accept` e persiste un `VaultRecord` in `~/.homun/vault.sqlite`
con label, categoria, preview redatta, `thread_id`/`message_id` opzionali e un
`SecretRef` opaco. Se la richiesta porta anche `secret_value`, deve portare un `pin`:
il gateway sblocca la master key e salva il valore in `vault_secret_material`
cifrato. Le card chat attuali non trasportano raw secret nel transcript, quindi
salvano solo metadati redatti finche' non esiste un input UI dedicato. `Non salvare`
chiama `/api/vault/proposals/dismiss`; oggi e' solo ack locale, senza audit
persistente.

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

La UI espone il setup nella sezione Settings `Vault`, separata da `Memory`.

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

Login, script arbitrari e azioni high-risk non-payment restano bloccati.

## Non implementato ancora

- Keychain/secret-store completo del valore sensibile associato al `SecretRef`.
- Sezione UI Vault completa.
- Payment Approval Card completa con screenshot/fingerprint.
- Telegram routing per riepilogo pagamento.
- Smoke live Electron su checkout fixture/browser reale.

## Regola di confine

Il modello non riceve dump del Vault. Quando servira' un valore, usera' tool
minimizzati (`vault_search`, `vault_get_field`, `vault_fill_browser_field`) con scopo,
dominio, audit e policy. Per i form, la direzione preferita e' compilare direttamente
il browser senza far transitare il valore sensibile nel testo del modello.
