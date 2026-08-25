# Chat Lifecycle And Rendering Contracts

Verificato 2026-08-25 contro `main` aggiornato a #395.

Questa pagina descrive solo contratti gia' presenti nel codice. Se un nuovo
fix modifica chat, turni, steering, reasoning o browser/activity overlay, deve
aggiornare uno degli owner qui sotto e il relativo test.

## Owner

| Contratto | Owner codice | Test/gate |
| --- | --- | --- |
| Classificazione durable del turno | `crates/task-runtime/src/turn_lifecycle.rs` | `cargo test -p local-first-task-runtime turn_lifecycle` |
| Query del turno attivo chat | `crates/task-runtime/src/broker.rs`, `crates/task-runtime/src/store.rs` | `cargo test -p local-first-task-runtime active_chat_turn` |
| Cleanup steering terminale | `crates/task-runtime/src/store.rs::close_unsettled_turn_steering`, `crates/desktop-gateway/src/main.rs::finalize_turn_steering` | `cargo test -p local-first-task-runtime finalization_fence_blocks_every_unapplied_steering_state`; `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway steering` |
| Lifecycle UI del turno | `apps/desktop/src/lib/chat-runtime/kernelProjectionPresenter.ts` via `runtimeViewModel.turnUiState` | `cd apps/desktop && node --test src/lib/chat-runtime/kernelProjectionPresenter.test.mjs src/lib/chat-runtime/runtimeLifecycleRetirement.test.mjs` |
| Modalita' composer | `apps/desktop/src/lib/chat-runtime/kernelProjectionPresenter.ts` via `runtimeViewModel.composerMode`; `apps/desktop/src/lib/chat-runtime/submissionRouting.ts` consuma il valore del presenter | `cd apps/desktop && node --test src/lib/chat-runtime/kernelProjectionPresenter.test.mjs src/lib/chat-runtime/submissionRouting.test.mjs` |
| Steering visibile in chat | `apps/desktop/src/lib/chat-runtime/steering.ts`, `apps/desktop/src/lib/chatSteeringState.ts` | `cd apps/desktop && npm run test:cursor-grammar` |
| Testo assistente visibile | `apps/desktop/src/lib/chat-rendering/visibleContent.ts` e compat `apps/desktop/src/lib/chatVisibleContent.ts` | `cd apps/desktop && npm run test:cursor-grammar` |
| Layout messaggi/chat overlay | `apps/desktop/src/styles/chat.css`, `apps/desktop/src/styles/workspace-island.css` | `cd apps/desktop && npm run test:ui-contract`; `npm run build` |

## Turn Lifecycle

`crates/task-runtime/src/turn_lifecycle.rs` e' il vocabolario canonico per
classificare lo stato durable di un turno.

- Terminale: `completed`, `failed`, `cancelled`, `expired`.
- Waiting user: `waiting_user_approval`; e' un turno attivo ma non lavoro modello.
- Parked: `parked`; e' attivo e bloccato da una causa esplicita.
- Internal finalizing: `finalizing`; e' uno stato SQL-only, non e' un
  `TaskStatus` pubblico e non deve apparire come lavoro attivo in UI.
- Active work: ogni altro stato non terminale e non speciale.

La costante `ACTIVE_CHAT_TURN_EXCLUDED_SQL_STATUSES` deve restare allineata al
classifier: `finalizing` e gli stati terminali non possono bloccare una nuova
enqueue come turno attivo.

## Steering

Un turno terminale non deve lasciare azioni utente pendenti che blocchino il
thread successivo.

`TaskStore::close_unsettled_turn_steering` cancella solo le righe dello stesso
`user_id`, `workspace_id`, `thread_id` e `active_turn_id` negli stati:
`pending`, `held`, `claimed`, `interpreted`, `applied`.

Non deve toccare:

- steering gia' `completed`, `cancelled` o `promoted`;
- steering di altri turni;
- steering di altri workspace o utenti.

Il gateway chiama questo cleanup durante `finalize_turn_steering`, dopo la fence
di finalizzazione. Le righe cambiate vengono ricaricate e pubblicate come
`cancelled`; le righe non cambiate non generano eventi sintetici.

Nel renderer, le righe stale in stato `pending`, `held`, `claimed`,
`interpreted` o `applied` sono visibili solo quando appartengono al turno attivo
corrente. Un turno `waiting_user_approval` puo' restare legittimamente bloccato
su `Waiting for you`, ma non deve mostrare `Applying` o altre card provenienti
da un `active_turn_id` precedente.

## Renderer

`ChatView.tsx` non deve possedere la macchina stati. Deve assemblare input da
proiezioni durable, stream locale, HITL, steering e messaggi persistiti, poi
delegare a funzioni pure:

- `projectKernelThreadView` decide `turnUiState.hasActiveTurn`,
  `workInProgress`, `turnAwaitingUser`, `canStop`, `terminalTurnAtRest` e
  `status`, e produce il `runtimeViewModel` consumato dagli hook UI.
- `ChatView` non riceve piu' `projectedActiveTurn` o `projectedTurnStatus` come
  contratti separati da `useChatActivityProjection`/browser activity lifecycle:
  active turn e status arrivano da `runtimeViewModel.activeTurn` e
  `runtimeViewModel.turnUiState.status`.
- `projectKernelThreadView` espone anche `runtimeViewModel.composerMode`: il
  fallback pre-projection resta nel presenter e `routeComposerSubmission`
  consuma solo quel valore normalizzato, senza ricostruire localmente lifecycle o
  stato projection.
- `deriveChatSteeringState` decide cosa resta visibile come pending/stale.

Regola: se una nuova condizione cambia "thinking", stop button, composer o
steering, prima si aggiunge una fixture nel presenter/runtime view model, poi si
cabla la UI.

## Visible Content

Il testo finale dell'assistente passa da un'unica pipeline di visible content.
Reasoning, marker di attivita', blocchi piano, tool-call prose e frammenti
malformati non devono diventare testo risposta.

I punti da preservare:

- streaming e messaggio persistito usano lo stesso filtro;
- `<think>` non chiuso durante lo streaming resta nascosto;
- marker interni come `REASONING`, `ACTIVITY`, piano e tool-call prose sono
  rimossi;
- il reasoning puo' esistere in superfici esplicite di activity/diagnostica, ma
  non nella risposta principale.

## Layout UI

I messaggi utente inviati sono testo allineato a destra, senza bubble frame:
`apps/desktop/src/styles/chat.css::.chat-message-user-band`.

L'editor inline del messaggio vive nello stesso CSS della chat, non nel CSS
legacy globale, e mantiene una geometria multilinea usabile:
`.message-edit textarea` ha `min-width: min(420px, 100%)` e `min-height: 96px`.

L'isola workspace e il dock live computer/browser non si sovrappongono:
quando `.active-task-layout` ha `data-workspace-island-open="true"`, il dock
`.chat-computer-runtime` e' nascosto. L'accesso al browser resta owner
dell'isola workspace/rail, non del dock flottante.

Il footer del composer separa tre concetti:

- il bottone modello mostra il prossimo override selezionato oppure il modello
  runtime attivo;
- la provenienza del modello che ha prodotto una risposta resta message-scoped
  e non viene falsificata dal next-turn override;
- `Runtime & Context` nel footer e' un trigger icon-only, con testo solo in
  `aria-label`/tooltip.

Il panel runtime mostra prima una visualizzazione di context usage: percentuale,
token usati/window, barra e legenda contributi. I dettagli tecnici restano sotto.
