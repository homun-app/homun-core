# Handoff — Pulizia codice morto Homun (post-ritiro superficie)

> Run dedicata per cancellare il codice Homun ormai irraggiungibile, DOPO il ritiro
> della superficie (commit `95561dc`/`acf9917`). Scope deciso dall'utente:
> **cancella la superficie morta, TIENI il motore di scheduling.**

## Contesto

Homun è già ritirato come superficie proattiva: push spento (`cancel_homun_checkins`
all'avvio), pulsante nav rimosso, curiosità/onboarding ora emessi come **card** dal
supervisore della proattività. Resta da cancellare il codice diventato irraggiungibile.
Vedi memoria `[[addon-proattivita-cards]]` e `[[homun-apprendista]]`.

## Principio (deciso): cancella la SUPERFICIE, tieni il MOTORE

- **CANCELLA** (morto/irraggiungibile): la spinta curiosità + la superficie proposte automazione.
- **TIENI** (vivo/riusabile): `schedule_proactive_task` + `execute_proactive_prompt_task`
  — eseguono i task ricorrenti pianificati (esistenti nel DB + future "automation-card").
  Si rimuove solo il loro **ramo homun** (`deliver_thread == "homun"`).

## Mappa morto/vivo (call-site tracciati 2026-06-12)

| Simbolo | Stato | Azione |
|---|---|---|
| `mine_curiosities` (main.rs:799) | chiamato solo da `homun_curiosities_mine` + ramo-homun di execute | CANCELLA |
| `mine_automations` (main.rs:896) | chiamato solo da `homun_automations_mine` | CANCELLA (superficie proposta) |
| `execute_proactive_prompt_task` (main.rs:16667) | dispatch task ProactivePrompt (16654) + homun_checkin_now | **TIENI**, togli solo ramo `deliver_thread=="homun"` (16694) |
| `schedule_proactive_task` (main.rs:4676) | da homun_automation_approve (1728) | **TIENI** (motore ricorrenze per le card) |
| `find_or_create_homun_thread` (chat_store:288) | homun_thread/greet/execute-homun-branch | CANCELLA (dopo aver tolto i chiamanti) |
| `cancel_homun_checkins` + `task_delivers_to_homun` | chiamati allo startup (migrazione) | **TIENI** (spazza stragglers da vecchie versioni) |

## Da cancellare — BACKEND (`crates/desktop-gateway/src/main.rs`)

Endpoint + route (righe ~452-467) e relativi handler:
- `/api/homun/proactive` → `homun_proactive_status`, `homun_proactive_set`
- `/api/homun/checkin-now` → `homun_checkin_now`, `homun_checkin_is_active`
- `/api/homun/curiosities` (+ `/dismiss`) → `homun_curiosities_list`, `homun_curiosities_mine`, `homun_curiosity_dismiss`
- `/api/homun/automations` (+ `/approve`, `/reject`) → `homun_automations_list`, `homun_automations_mine`, `homun_automation_approve`, `homun_automation_reject`
- `/api/homun/greet` → `homun_greet`
- `homun_thread` endpoint (main.rs:764) + la sua route
- Funzioni di supporto: `mine_curiosities`, `mine_automations`, `seed_homun_asked_questions` (+ chiamata startup ~422), `HOMUN_CHECKIN_GOAL`
- In `execute_proactive_prompt_task`: rimuovi il ramo `deliver_thread == Some("homun")` (16694) e la `find_or_create_homun_thread`; resta il ramo "scheduled".
- `homun_idle_threshold_secs` / `seconds_since_user_activity` / `note_user_activity`: **TIENI** — li usa il trigger auto-review della proattività.

## Da cancellare — chat_store (`crates/desktop-gateway/src/chat_store.rs`)

- Tabella `curiosities` (migrate block) + metodi: `insert_curiosity`, `all_curiosity_texts`,
  `list_curiosities`/pending, `dismiss_curiosity`, conteggi. (Audit: `grep -n curiosit chat_store.rs`.)
- `find_or_create_homun_thread` (288) dopo aver tolto i chiamanti.
- NB: `set_flag("homun_asked_seed_v1")` sparisce con seed_homun_asked_questions.

## Da cancellare — FRONTEND

- `ChatView.tsx` (~48 ref): `HomunProactiveToggle`, pulsante "Chiedimi qualcosa ora",
  pannello "Cose che vorrei chiederti" (curiosità), pannello proposte automazione
  ("Posso occuparmene io"), persona `is_homun`. **Attenzione**: è il componente chat
  principale (~6k righe) → cancellare a strati, `npx tsc --noEmit` dopo ogni strato.
- `coreBridge.ts` (~41 ref): `homunThread`, `homunGreet`, `setHomunProactive`,
  `homunProactiveStatus`, `homunCheckinNow`, curiosities list/mine/dismiss,
  automations list/mine/approve/reject + le rispettive `chatApi` (chatApi.ts ~3 ref).
- `styles.css` (~22 ref): classi `.homun-*` orfane. `accent.ts` (1), `MemoryView.tsx` (1),
  `AutomationsView.tsx` (2): audit — potrebbero essere riferimenti legittimi residui.
- `mockData.ts` (1): audit.

## Ordine di esecuzione (a strati, build-check tra ognuno)

1. **Frontend coreBridge/chatApi**: rimuovi i metodi homun morti → `npx tsc --noEmit`
   (rivelerà ogni chiamante residuo in ChatView).
2. **ChatView**: rimuovi la UI homun guidata dagli errori tsc dello step 1 → `tsc` verde.
3. **styles.css / accent / mockData**: rimuovi le classi/ref orfane.
4. **Backend route + handler endpoint** `/api/homun/*` (curiosità, proactive, checkin, automations, greet, thread) → `cargo build`.
5. **Backend funzioni**: `mine_curiosities`, `mine_automations`, `seed_homun_asked_questions`, `HOMUN_CHECKIN_GOAL`, ramo-homun di execute_proactive_prompt_task → `cargo build`.
6. **chat_store**: tabella `curiosities` + metodi, `find_or_create_homun_thread` → `cargo build` + `cargo test`.
7. **Verifica**: restart, health 200, `/api/suggestions` 200, dashboard Proattività funziona, AutomationsView (Automation, NON automation_candidates) intatta, una review manuale `review-now` funziona.

## Rischi / cautele

- **execute_proactive_prompt_task vivo**: NON cancellarlo. Solo il ramo homun. Verifica che il
  ramo "scheduled" resti integro (lo usano i task ricorrenti già nel DB).
- **automation_candidates** (memory crate): `mine_automations` lo scriveva; i metodi store
  restano (riusabili dalle future automation-card). Possibili warning unused nel memory crate —
  lasciali o `#[allow(dead_code)]`, NON cancellare il modello dati.
- **ChatView è grande e centrale**: cancella a strati piccoli, tsc dopo ognuno. È il punto a più alto rischio.
- Il thread `homun` resta come dato (storia); non serve droppare righe.

## Dopo la pulizia — prossimi pezzi proattività

- Onboarding statico (bootstrap modello+chiave), sistema a sé.
- Proposte di automazione come **card** `automazione` (riusando schedule_proactive_task tenuto qui).
- Trigger a evento connettore (Auto-G2 ConnectorPoll → review).
