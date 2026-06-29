# Sottosistema Vault

> Stato: 2026-06-29. MVP foundation implementata a livello Rust/frontend con
> persistenza metadata-only delle proposte Vault. Spec di riferimento:
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
  `VAULT_PROPOSE`, con azioni salva/scarta.
- `crates/desktop-gateway/src/main.rs`: endpoint
  `/api/vault/proposals/accept` e `/api/vault/proposals/dismiss`.

## Modello dati

Categorie:

- `payments`: carta senza CVV/CV2, billing profile, circuito, scadenza, ultime 4.
- `identity`: documenti, codice fiscale, dati anagrafici.
- `health`: allergie e informazioni sanitarie.
- `vehicles`: targhe, veicoli, assicurazioni.
- `credentials`: credenziali e token.
- `private_notes`: dati sensibili generici.

`VaultRecord` conserva metadati non sensibili e un `SecretRef`. Il materiale segreto
resta nello store segreti esistente (`local-first-secrets`) o nel backend sicuro
futuro. `VaultRecord::new` rifiuta CVV/CV2 nei metadati.

`vault_local_pin` conserva solo `LocalPinVerifier` (`algorithm`, `iterations`,
`salt_hex`, `digest_hex`). Il PIN non e' reversibile e non viene mai serializzato in
chiaro; il gateway espone solo status/setup/verify dietro il bearer locale.

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
`SecretRef` opaco. `Non salvare` chiama `/api/vault/proposals/dismiss`; oggi e'
solo ack locale, senza audit persistente.

## PIN locale

Endpoint gateway:

- `GET /api/vault/pin/status` -> `{ configured }`;
- `POST /api/vault/pin/setup` con `{ pin }` -> crea/sostituisce il verifier;
- `POST /api/vault/pin/verify` con `{ pin }` -> `{ ok }`.

Il PIN e' pensato come gate locale per CVV one-shot e approvazioni pagamento. Non
sostituisce il TOTP futuro dell'app.

## Pagamenti

`PaymentApprovalSnapshot` cattura merchant, dominio, importo, valuta, prodotto,
metodo di pagamento e fingerprint checkout. `validate_payment_approval` invalida
l'approval se uno di questi campi cambia.

Il browser safety gate resta conservativo:

- `high_risk_reason` blocca acquisti/login/prenotazioni come prima.
- `high_risk_reason_with_payment_approval` puo' sbloccare solo controlli finali di
  pagamento se l'azione porta un `payment_approval_id` che combacia con quello
  approvato.

Login, script arbitrari e azioni high-risk non-payment restano bloccati.

## Non implementato ancora

- Keychain/secret-store completo del valore sensibile associato al `SecretRef`.
- Sezione UI Vault completa.
- Dialog UI locale PIN + CVV one-shot.
- Payment Approval Card completa con screenshot/fingerprint.
- Telegram routing per riepilogo pagamento.
- E2E su checkout controllato.

## Regola di confine

Il modello non riceve dump del Vault. Quando servira' un valore, usera' tool
minimizzati (`vault_search`, `vault_get_field`, `vault_fill_browser_field`) con scopo,
dominio, audit e policy. Per i form, la direzione preferita e' compilare direttamente
il browser senza far transitare il valore sensibile nel testo del modello.
