# Browser Form Draft V1

## Problema

Il task browser per richieste tipo "prenotare un treno" apriva le fonti e
salvava snapshot/screenshot, ma si fermava prima della compilazione. Dal punto
di vista utente sembrava un browser reale bloccato: vedeva i siti aperti, ma
nessuna azione sui form.

## Decisione

Introdurre un primo livello di compilazione e ricerca sicura:

- `browser.act` compila i campi con `kind: "fill_form"`;
- dopo la compilazione puo' premere solo controlli di ricerca risultati
  esplicitamente sicuri (`Cerca`, `Mostra risultati`, equivalenti);
- non vengono premuti login, acquisto, pagamento, prenotazione finale o invio
  dati sensibili;
- l'approvazione iniziale autorizza lettura, compilazione form e ricerca
  risultati;
- submit mutativi, login, pagamento e scelte finali restano fuori da questo
  slice e richiedono approval granulare successiva.

## Implementazione

- Il sidecar browser espone nei ref anche placeholder/id/data-testid/title, ma
  continua a preferire il testo visibile per bottoni e link.
- Il gateway estrae una bozza treno conservativa:
  - partenza;
  - arrivo;
  - data se espressa;
  - ora se espressa.
- Per Trenitalia/Italo prova a mappare i campi riconoscibili e li compila in
  batch, registrando successi parziali e blocchi.
- Se trova un controllo di ricerca sicuro lo preme, legge lo snapshot
  risultante e tenta di estrarre righe opzione con orari/tratte.
- Il Computer locale riceve checkpoint:
  - `browser_form_draft_started`;
  - `browser_form_draft_completed`;
  - `browser_form_draft_blocked`.
- La risposta finale distingue:
  - fonte letta;
  - form compilato in bozza;
  - ricerca risultati avviata e opzioni lette quando disponibili;
  - form non compilabile per campi non esposti;
  - prossimo step proattivo: chiedere quale opzione prenotare.

## Limiti

- I calendari/orari custom esposti come bottoni non vengono ancora manipolati:
  richiedono click controllati e policy di approval granulare.
- Alcuni siti possono richiedere selezione da autocomplete dopo il fill o
  calendari custom; questo sara' lo step successivo con azione `press/click`
  non mutativa e conferma UI.
- Italo puo' fallire con errori HTTP2 o anti-automation; in quel caso il task
  deve riportarlo senza inventare risultati.

## Verifica

- `cargo test -p local-first-desktop-gateway`
- `npm --prefix runtimes/browser-automation test`
- `npm --prefix runtimes/browser-automation run typecheck`
- `npm --prefix apps/desktop run typecheck`
- `npm --prefix apps/desktop run test:ui-contract`
- `npm --prefix apps/desktop run build`
- `git diff --check`
- Smoke tecnico live:
  - Trenitalia espone `partenza` e `arrivo` come textbox;
  - `browser.act fill` riesce a compilare almeno la bozza partenza/arrivo;
  - Italo in headless ha restituito `ERR_HTTP2_PROTOCOL_ERROR`, quindi resta
    gestito come fonte non raggiungibile in quella sessione.
