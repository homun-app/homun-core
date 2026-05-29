# Browser Controller Pulito, Ispirato a Homun

## Obiettivo

Recuperare da Homun le parti browser che funzionano, senza portare la sua
complessita' complessiva. Il browser deve diventare una capability coerente e
stateful, non un executor hardcoded nel gateway.

## Scope Primo Slice

- Arricchire il sidecar `runtimes/browser-automation` con primitive piu' alte:
  - `fill_form` batch;
  - `press_key`;
  - `select_option`;
  - `scroll`;
  - snapshot opzionale dopo azioni che cambiano pagina/stato.
- Mantenere compatibilita' con `browser.act` esistente.
- Ridurre l'orchestrazione ref-by-ref nel Desktop Gateway usando un singolo
  `fill_form` per la bozza.
- Aggiornare policy Rust per classificare le nuove azioni.
- Aggiungere test su fixture locale.

## Non Scope

- Non portare l'intero sistema MCP di Homun.
- Non introdurre ancora profili multipli avanzati, site memory completa,
  stealth injection o auto-escalation headless/visible.
- Non autorizzare submit, login, pagamento o click sensibili senza approval
  granulare.

## File

- `runtimes/browser-automation/src/browser/actions.ts`
- `runtimes/browser-automation/src/browser/session_manager.ts`
- `runtimes/browser-automation/tests/browser_fixture.test.ts`
- `runtimes/browser-automation/tests/fixtures/form.html`
- `crates/browser-automation/src/policy.rs`
- `crates/browser-automation/tests/policy.rs`
- `crates/desktop-gateway/src/main.rs`
- `docs/work-memory.md`
- `docs/roadmap.md`

## Verifica

- `npm --prefix runtimes/browser-automation test`
- `npm --prefix runtimes/browser-automation run typecheck`
- `cargo test -p local-first-browser-automation`
- `cargo test -p local-first-desktop-gateway`
- `npm --prefix apps/desktop run test:ui-contract`
- `git diff --check`

## Criteri

- `fill_form` compila piu' campi in una singola chiamata.
- `type` puo' far emergere autocomplete meglio di `fill`.
- `click`/`type` possono restituire snapshot aggiornato quando richiesto.
- La policy continua a bloccare click/submit e consente solo bozze non-submit.

## Stato

Completato primo slice:

- `fill_form` batch restituisce campi riusciti/falliti.
- `snapshot_after` snake_case e `snapshotAfter` camelCase sono entrambi
  supportati.
- Snapshot post-azione esteso a `press_key`, `select_option` e `scroll`.
- Il gateway usa `fill_form` per la bozza treno.
- Restano fuori dal primo slice: scelta autocomplete assistita, click approvato
  granulare, site memory e fixture e2e task completa.

## Estensione URL Approval

Completato anche il primo layer di approval URL:

- store SQLite locale per regole `origin + action`;
- scope `once` e `always`;
- visibility `auto`, `visible`, `headless`;
- UI inline per scegliere ambito e modalita browser;
- gateway capace di saltare l'approval iniziale quando tutti i domini browser
  del task sono gia' coperti da regole persistenti.

Non autorizza ancora click/submit: questi restano approval granulari successive.
