# Stato del motore e fonte dei dati nella chat, non nei banner — 2026-10-12

## Decisione di prodotto

Tutto ciò che viveva nel banner operativo
(`ConversationWorkspaceEngineNotices` → `ConversationEngineBanner`) passa nel
thread della conversazione; banner rimosso. Il piè di pagina della ricerca è
già stato svuotato dalla PR #438 (questo branch ne è figlio).

## Dove vivono gli avvisi (slot che non toccano i messaggi)

Gli avvisi sono **derivati dallo stato del client e disegnati nel thread**:
non sono messaggi della conversazione, non entrano mai nell'elenco messaggi
del runtime (`useExternalStoreRuntime` riceve solo `useChatStream`), non sono
inviati al motore né al modello.

| Slot | Posizione | Contenuto |
| --- | --- | --- |
| `composer` | `.cw-composer`, prima di `StudioChatInput` (in `EngineAgentChat`) | avvisi globali (motore irraggiungibile, `gateError`, `error`) + esito breve «Connessione ripristinata.» |
| `thread-top` | `.cw-history`, primo elemento (in `EngineAgentChat` e `ConversationWorkspaceChatStage`) | «Fonte: simulazione — nessun dato reale è collegato.» (solo simulazione) |
| `thread-end` | `.cw-history`, dopo `<AgentChat/>` | followup della conversazione aperta |

I followup non possono agganciarsi al turno (`commandId`): la trascrizione del
motore (`engine-transcript-client`) non espone alcun legame messaggio↔comando,
quindi vale il fallback previsto: fondo del thread. La barra laterale segnala
le conversazioni con followup con un punto discreto (`cw-sb-dot`) che eredita
il titolo onesto («Risposta non completata: apri la conversazione»).

## Il modello: `lib/chat-status-notices.ts`

Modulo puro, testato: `chatStatusNotices(state)` produce l'elenco
(`{id, scope, kind, severity, testo, azioni, conversationId?, commandId?}`),
`chatStatusLayout(notices, openConversationId)` li colloca negli slot.
Sano in modalità motore → elenco vuoto. Gli errori tipizzati passano da
`HomunErrorNotice` (stesso `homunErrorFromHttp` del banner per i followup).
I componenti (`ChatStatusNotice`, `ChatStatusNotices`) disegnano soltanto.

Invarianti rispettate: un avviso per condizione (id stabile, si aggiorna sul
posto); alla risoluzione esito breve di 6s poi scompare senza tracce
(`useTransientResolved`); `role="status"` per gli stati, `role="alert"` per
gli errori bloccanti; «Fonte: simulazione» dichiarata sempre e sola in chat,
mai etichette di fonte in modalità motore.

A motore irraggiungibile il campo di scrittura si disabilita con il motivo
esposto nell'avviso subito sopra: il testo già scritto resta nel composer e
non si perde più (prima l'invio svuotava il campo con un annuncio generico).

## Verifica nel browser (motore reale, HOMUN_DATA_DIR temporaneo)

Motore `engine/.venv/bin/python -m homun serve --dev-insecure` con
`HOMUN_DATA_DIR=$(mktemp -d)`; web `npm run dev` (127.0.0.1:4183).
Conversazioni reali; il fallimento della risposta è stato prodotto con una
connessione modello del motore non raggiungibile (`broken_provider`,
creata via API `POST /v1/models/connections`): run fallito con
`provider_unavailable`, retry programmato, poi esaurito dopo 3 tentativi.

| # | Scenario | Esito | Screenshot |
| --- | --- | --- | --- |
| 01 | motore sano, nessuna conversazione | zero avvisi, nessun banner | `assets/2026-10-12-status-in-chat/01-…png` |
| 02 | motore fermo, schermata iniziale | avviso `role="alert"` sopra il composer, Riprova/Apri modelli, composer disabilitato, **bozza conservata** | `02-…png` |
| 03 | riavvio motore + «Riprova la connessione» | «Connessione ripristinata.» | `03-…png` |
| 04 | dopo 6s | esito scomparso, thread pulito, composer riabilitato, bozza ancora lì | `04-…png` |
| 05 | motore fermo con conversazione aperta | avviso sopra il campo di scrittura (l'inventario si svuota: comportamento pre-esistente, l'avviso resta dove si scrive) | `05-…png` |
| 06 | risposta interrotta | «Risposta interrotta; un nuovo tentativo è programmato.» solo nel thread della SUA conversazione + punto laterale | `06-…png` |
| 07 | retry esaurito | stesso avviso aggiornato sul posto: «non completata dopo 3 tentativi», `data-error-code="provider_unavailable"`, punto laterale rosso | `07-…png` |
| 08 | due conversazioni con followup | ciascuna mostra solo il suo; pallini laterali distinti | `08-…png` |
| 09 | ricerca ⌘K a motore fermo | nessun `<footer>`; «Nessun risultato. I materiali non sono raggiungibili in questo momento.» + motivo tipizzato (stato locale della ricerca) | `09-…png` |
| 10 | modalità simulazione | «Fonte: simulazione» primo elemento del thread, `role="status"` | `10-…png` |
| 11 | simulazione con conversazione aperta | la fonte resta in cima sopra i messaggi | `11-…png` |
| 12 | **prima**: `origin/main` a motore fermo | il banner sopra l'area di lavoro (worktree su main, porta 4184) | `12-…png` |

Confronto prima/dopo: `12-…png` (banner su main) contro `02-…png` (avviso
nel punto in cui si legge e si scrive).

## Test

`tests/chat-status-notices.test.ts` (nuovo, rosso prima dell'implementazione:
`ERR_MODULE_NOT_FOUND` su `lib/chat-status-notices.ts`) — matrice del modulo
puro, collocazione per conversazione aperta, ruoli a11y, slot reali e
integrazione con `EngineAgentChat` (composer disabilitato con motivo, followup
solo della conversazione aperta) e `ConversationWorkspaceChatStage` (fonte in
cima in simulazione, nulla in modalità motore).
`tests/engine-operational-notices.test.ts` riscritto: il banner non esiste
più, lo stage passa gli stati agli slot e mai ai messaggi.

## Ratchet architetturale

`ConversationWorkspace.tsx` 1354 → 1350 righe (budget abbassato in
`tools/architecture-baseline.json`): gli avvisi attraversano
`EngineChatStage`/prop `dataSource`, non lo shell.
`npm run check`, `npm run architecture:check` verdi; lint senza errori nuovi
sui file toccati.
