# Final Roadmap

Questa roadmap traduce `docs/architecture/system-map.md` in un percorso di
sviluppo ordinato fino all'obiettivo finale: un assistente personale local-first
che capisce richieste naturali, usa strumenti in modo governato, esegue task
anche lunghi, mostra il Local Computer e apprende abitudini in modo controllato.

Ogni fase deve chiudersi con test, documentazione aggiornata e una demo locale
verificabile. Una fase non e' chiusa se funziona solo tramite mock o se bypassa
Task Runtime, Resource Governor, Approval Gate o privacy policy.

> **Stato 2026-06-05.** Questa roadmap per fasi e' in larga parte realizzata.
> Le fasi 0.5-4 (chat foundation, executor governato, UI task/approval, Local
> Computer, browser end-to-end) sono operative; le fasi 5-9 (Brain, capability/
> MCP/connettori, subagenti, memoria, persistenza) sono avanzate o di base
> completa. Tre cambi importanti NON previsti nel piano originale e ora in
> esercizio: **(1) capable-first** — provider registry + ruoli orchestrator/
> browser/memory verso modelli SOTA (cloud), con MLX/Gemma come fallback locale
> piccolo: ogni riferimento a "Gemma" qui sotto va letto come "modello attivo
> del ruolo"; **(2) canali** WhatsApp/Telegram con inbound-come-agente e
> **contatti**/identity resolution; **(3) riscrittura browser stile OpenClaw** —
> tool granulari guidati dal modello principale, che affianca il planner legacy
> ancora vivo per i task durevoli (debito da chiudere). Le **priorita' correnti**
> vivono in `docs/roadmap.md`; le fasi qui sotto restano valide come spec di
> dettaglio, ma i loro "Stato" sono in parte storici.

## Principi Guida

- Finire un blocco per volta prima di passare al successivo.
- Ogni feature operativa passa da Durable Task Runtime.
- Ogni task dichiara risorse e passa dal Resource Governor.
- La UI mostra read model e stato, non decide tool o policy.
- Il Brain comprende, pianifica e seleziona capability; non esegue bypassando
  il runtime.
- Browser, shell, MCP, connettori, skill e subagenti condividono code,
  checkpoint, approval e risorse.
- L'auto-apprendimento arriva dopo eventi reali affidabili.
- La chat experience e' fondazione di prodotto: non e' polish finale. Markdown,
  codice, allegati, azioni messaggio, streaming e activity progressive
  disclosure devono essere solidi prima di cablare altri tool complessi.
- Lo streaming chat non dipende da IPC desktop: passa dal Desktop HTTP Gateway
  Rust locale, loopback-only, con token bearer + CORS allowlist. Questo e' fatto
  e in esercizio (`crates/desktop-gateway`): prompt building con context
  compression, stream/cancel, thread/messaggi persistenti, e i read model
  operativi (task, memoria, capability, Local Computer).
- Capable-first: il modello attivo per ruolo (orchestrator/browser/memory) e'
  scelto dal provider registry (cloud SOTA per default sui ruoli che lo
  richiedono); MLX/Gemma locale resta come fallback per modelli piccoli. Niente
  vincoli di prompt/contesto pensati per il modello piccolo sui modelli capaci.
- Ogni fase aggiorna `docs/work-memory.md`; se cambia architettura o ordine,
  aggiorna anche `docs/architecture/system-map.md` e questo file.

## Roadmap Sintetica

```mermaid
flowchart TD
  F0["Fase 0: Mappa e contratti"] --> F0_5["Fase 0.5: Chat Experience Foundation + HTTP Gateway"]
  F0_5 --> F1["Fase 1: Executor task pianificati"]
  F1 --> F2["Fase 2: UI task e approval reali"]
  F2 --> F3["Fase 3: Local Computer live"]
  F3 --> F4["Fase 4: Browser automation end-to-end"]
  F4 --> F5["Fase 5: Brain tool orchestration"]
  F5 --> F6["Fase 6: Capability, MCP e connettori"]
  F6 --> F7["Fase 7: Subagenti operativi"]
  F7 --> F8["Fase 8: Memoria nel ciclo Brain"]
  F8 --> F9["Fase 9: Persistenza e recovery desktop"]
  F9 --> F10["Fase 10: Auto-apprendimento"]
  F10 --> F11["Fase 11: UI polish e controllo utente"]
  F11 --> F12["Fase 12: Hardening e packaging"]
```

## Fase 0 - Mappa, Focus E Contratti Base

Stato: completata come base, da mantenere aggiornata.

Obiettivo:

- avere una fonte di verita' su scopo, componenti, confini e ordine;
- evitare lavoro dispersivo su UI, Brain, browser o learning fuori sequenza.

Deliverable:

- `docs/architecture/system-map.md`;
- `docs/architecture/final-roadmap.md`;
- `docs/work-memory.md` aggiornato dopo ogni blocco;
- regola esplicita: ogni fase deve dichiarare quale parte della system map
  chiude.

Gate di chiusura:

- documenti committati;
- nessun placeholder;
- roadmap coerente con `PROJECT.md`.

## Fase 0.5 - Chat Experience Foundation

Stato: in corso. Primo slice implementato con `RichMessage` per Markdown, GFM,
codice, tabelle e Mermaid. Dopo test reali, Tauri/WKWebView e' stato rimosso
dalla shell desktop: lo stesso frontend in Electron/Chromium streamma in modo
fluido. Il Desktop HTTP Gateway Rust autonomo esiste in `crates/desktop-gateway`
e ora possiede prompt building, stream/cancel, runtime health/warmup/shutdown,
autostart via ProcessManager e thread/messaggi persistenti. Restano composer
avanzato, allegati completi, action bar, suggestion, benchmark UI, packaging
gateway/runtime e diagnostica.

Obiettivo:

- rendere la chat abbastanza solida da testare davvero ogni funzione successiva;
- evitare che tool, browser, subagenti o memoria sembrino confusi per limiti
  della superficie conversazionale;
- adottare i pattern assistant-ui utili senza importare la CLI shadcn/Tailwind
  come dipendenza architetturale.

Componenti:

- `apps/desktop/src/components/ChatView.tsx`
- `apps/desktop/src/components/RichMessage.tsx`
- `apps/desktop/src/components` nuovi componenti dedicati per Composer,
  MessageActions, Attachments e Suggestions
- `apps/desktop/src/lib/coreBridge.ts`
- nuovo client `apps/desktop/src/lib/chatApi.ts`
- `apps/desktop/electron`
- nuovo crate/processo Rust gateway locale, probabilmente basato su `axum`/`tokio`

Deliverable:

- renderer messaggi ricco:
  - Markdown;
  - GitHub Flavored Markdown;
  - tabelle;
  - codice inline;
  - code block con copia;
  - Mermaid;
  - link sicuri;
  - HTML sanitizzato.
- renderer streaming-aware:
  - Mermaid renderizzato solo a blocco/messaggio completo;
  - code block incompleti leggibili durante lo stream;
  - scroll stabile durante risposte lunghe.
- Desktop Chat HTTP Gateway:
  - bind solo su `127.0.0.1`;
  - token locale per sessione app;
  - CORS ristretto alle origini localhost/Electron della app;
  - `GET /api/health`;
  - thread e messaggi via HTTP;
  - `POST /messages/stream` con NDJSON/SSE;
  - cancel per `request_id`;
  - metriche del modello attivo preservate;
  - nessun raw payload in read model UI.
- composer avanzato:
  - send;
  - cancel streaming;
  - focus e shortcut;
  - `canSend` separato da `isDisabled`;
  - allegati;
  - drag and drop;
  - quote/reply.
- attachments:
  - pending attachments nel composer;
  - attachment read-only nei messaggi;
  - immagini, documenti, file generici e artifact locali.
- message actions:
  - copia risposta;
  - rigenera;
  - continua;
  - salva in memoria;
  - crea task o automazione;
  - feedback utile/non utile.
- suggestions contestuali:
  - approfondisci;
  - apri browser;
  - salva preferenza;
  - crea automazione;
  - mostra dettagli.
- activity rendering:
  - tool calls e Local Computer come progressive disclosure;
  - risultato finale sempre piu' evidente della timeline;
  - nessun raw payload.

Test minimi:

- build TypeScript;
- test UI contract per:
  - renderer Markdown;
  - code block;
  - Mermaid;
  - composer sticky;
  - cancel streaming;
  - chat HTTP client;
  - attachments;
  - message actions;
  - assenza raw payload in activity/tool details.
- verifica browser desktop e viewport stretta:
  - nessun overlap;
  - composer sempre utilizzabile;
  - scroll-to-bottom funziona;
  - risposta lunga resta leggibile.
- benchmark rendering chat:
  - scrollback da 1.000 messaggi con DOM montato limitato;
  - p95 frame time streaming sotto soglia;
  - commit finale Markdown misurato;
  - confronto browser preview ed Electron reale.
- test Rust gateway:
  - health locale;
  - auth token richiesto;
  - CORS/bind loopback;
  - stream produce `accepted`, `delta`, `done` o `error`;
  - cancel interrompe richiesta pendente.

Gate di chiusura:

- demo locale con una chat che contiene testo lungo, lista, tabella, codice,
  Mermaid, link, allegato/artifact e activity collassata;
- l'utente puo' leggere la risposta, copiare codice, aprire dettagli e
  continuare senza aprire log o terminale;
- la chat resta collegata al gateway/core come external-store pattern: React
  renderizza e invia comandi, ma non decide tool, policy o routing.
- la chat non usa IPC desktop per streaming o payload grandi; usa browser
  networking verso il gateway locale.

## Fase 1 - Prompt Plan Executor V1

Stato: primo slice read-only governato implementato. Restano da collegare
browser/shell live come executor reali nelle fasi 3-4.

Obiettivo:

- trasformare i task `prompt_plan.*` creati dal Brain in esecuzione governata;
- usare Task Runtime, Resource Governor, Approval Gate e checkpoint prima di
  qualunque azione reale.

Componenti:

- nuovo gateway desktop Rust per executor prompt plan;
- `crates/task-runtime`
- `crates/browser-automation`
- `crates/local-computer-session`

Deliverable:

- comando o loop locale per eseguire il prossimo task pianificato;
- selezione del prossimo task via scheduler;
- reservation risorse prima dell'esecuzione;
- stato `waiting_resource` quando browser, shell o LLM sono saturi;
- blocco automatico degli step con approval richiesta;
- checkpoint redatti per step iniziato, completato, bloccato o fallito;
- eventi Local Computer Session per step start/completion/block.

Test minimi:

- un prompt treno crea task e il primo step read-only viene eseguito;
- se `browser_session` e' gia' occupata, il task resta `waiting_resource`;
- uno step con `requires_user_approval=true` non viene eseguito;
- checkpoint e timeline non contengono raw prompt;
- release risorse dopo completion/failure.

Gate di chiusura:

- `cargo test --workspace` o test mirati del gateway/crate executor;
- test specifici executor;
- demo locale: prompt complesso -> piano -> task -> esecuzione step read-only
  -> timeline aggiornata.

## Fase 2 - UI Tasks, Queue, Risorse E Approval Reali

Stato: completata come base operativa. La UI legge `task_queue_snapshot`, mostra
task, approval e resource usage reali, carica `task_detail` redatto e invia
approve/reject all'Approval Gate del Core.

Obiettivo:

- rendere visibile il runtime operativo, non solo la chat;
- permettere di capire cosa e' in coda, cosa gira, cosa e' bloccato e perche'.

Componenti:

- `apps/desktop/src/components/TasksView.tsx`
- `apps/desktop/src/lib/coreBridge.ts`
- DTO/read model esposti dal gateway desktop Rust

Deliverable:

- TasksView collegata a `task_queue_snapshot`;
- task detail collegato a `task_detail`;
- pannello approval reale;
- visualizzazione resource usage per classe;
- stati chiari: queued, running, waiting_resource, waiting_user_approval,
  completed, failed;
- nessun raw payload nel detail.

Test minimi:

- UI contract su stati task e approval;
- typecheck/build frontend;
- test Rust sui DTO read model;
- verifica browser desktop/mobile senza overlap.

Gate di chiusura:

- l'utente puo' vedere task reali creati dal prompt planner;
- l'utente puo' distinguere blocco risorsa da blocco approval;
- la UI non mostra payload non redatti.

## Fase 3 - Local Computer Live

Stato: avviata. Il smoke locale registra shell output reale e produce anche un
artifact screenshot browser dal sidecar Playwright, esposto come preview
redatta nella sessione Local Computer. La UI puo' caricare la preview artifact
tramite gateway locale e mostrarla come thumbnail/pannello Browser senza
esporre path raw. I controlli base pausa/riprendi/takeover sono cablati al Core
e persistiti nel read model.

Obiettivo:

- rendere il Local Computer il centro di fiducia: vedere browser, shell, file e
  log di cio' che il sistema sta facendo.

Componenti:

- `crates/local-computer-session`
- `apps/desktop/src/components/ChatView.tsx`
- eventuali componenti separati per computer panel, timeline e artifact;
- gateway desktop Rust per snapshot e artifact preview

Deliverable:

- preview browser reale o screenshot aggiornabile;
- comando locale per leggere preview artifact redatti come data URL UI-safe;
- output shell redatto;
- artifact list reale;
- timeline compatta nella chat e detail completo on demand;
- takeover/pause UI cablati almeno come stati controllati;
- refresh affidabile senza layout jump.

Test minimi:

- smoke test shell produce transcript redatto;
- smoke test browser produce artifact/preview;
- snapshot UI verifica pannello desktop e mobile;
- nessun evento vecchio appare in thread nuovi.

Gate di chiusura:

- prompt operativo mostra nel Computer cosa sta succedendo;
- browser/shell/artifact/log sono coerenti con lo stesso task/thread.

## Fase 4 - Browser Automation End-To-End

Stato: in corso. Gli step `prompt_plan.*` con `surface=browser` usano il
sidecar browser locale, aprono una pagina sicura, producono screenshot artifact
e aggiornano Task Runtime + Local Computer. Il smoke browser copre anche form
fill draft su fixture locale senza submit. Il `BrowserTaskExecutor` applica una
policy preventiva: fill/draft resta consentito, click/close/type con submit
richiedono approval prima di arrivare al sidecar. Dopo un checkpoint approvato
per `browser.manual_action`, l'executor puo' riprendere l'azione. Esiste una
demo/test locale con fixture form, sidecar Playwright, blocco click, approval e
resume reale. La UI Tasks/Approval Center mostra i blocker browser in forma
leggibile e redatta. Restano da chiudere recovery su errori browser e
orchestrazione Brain -> task browser reale. Il planner puo' produrre una
`target_url` sicura per step browser: solo start page/homepage senza query o
fragment, cosi' il prompt raw non viene trasformato in URL esterne. Gli step
browser atomici con `target_url` vengono ora enqueueati come task
`browser_automation` reali, usando il tool registry browser e il browser task
executor. Il primo task browser atomico esegue ora `browser.open` e, nella
stessa sessione sidecar, produce anche `browser.snapshot` e
`browser.screenshot` redatti per alimentare la Local Computer card. Esiste
anche un batch runner controllato che puo' avanzare piu' step pronti del piano
senza bypassare approval o risorse. Le preview prodotte dai task browser sono
ora renderizzabili nella UI attraverso un comando locale che restituisce solo
data URL per artifact di sessione.

Obiettivo:

- usare il browser per ricerche, compilazione form e operazioni web controllate;
- fermarsi prima di login, submit mutativi, acquisti e pagamenti.

Componenti:

- `crates/browser-automation`
- sidecar browser;
- Prompt Plan Executor;
- Local Computer Session;
- Approval Gate.

Deliverable:

- task browser read-only reali;
- form fill draft senza submit rischioso;
- manual blockers tipizzati;
- policy mutative preventiva nel task executor;
- resume dopo approval browser manuale;
- test locale form mutativo simulato con Playwright sidecar;
- blocker browser leggibili nella UI;
- `target_url` sicura per step browser del Brain planner;
- mapping Brain planner -> task `browser_automation`;
- readback browser atomico con snapshot e screenshot;
- preview browser visibile nel Local Computer UI;
- screenshot e transcript redatti;
- policy per domini e azioni sensibili;
- fallback e recovery su errore browser.

Test minimi:

- navigazione read-only su sito di test locale;
- compilazione form locale senza submit;
- blocco su azione mutativa senza approval;
- resource governor limita sessioni browser concorrenti;
- artifact redatti visibili in UI.

Gate di chiusura:

- demo: richiesta di ricerca o prenotazione simulata -> browser agisce ->
  risultati redatti -> approval prima di azioni rischiose.

## Fase 5 - Orchestrator Brain Completo

Stato: in corso. Il Brain produce gia' piani strutturati, il Capability
Registry espone tool sintetici e la UI puo' eseguire un batch limitato di step
pronti tramite Task Runtime. Restano da chiudere DAG completo, selezione
capability multi-provider, MCP/connettori e subagenti.

Obiettivo:

- superare il planner prompt-level e avere un Brain che sceglie tool,
  capability, MCP, skill e subagenti in modo spiegabile e governato.

Componenti:

- crate orchestrator, se separato;
- Capability Registry;
- Memory Layer;
- Task Runtime;
- Prompt submission gateway.

Deliverable:

- tool registry compatto con title/description/resource/sensitivity;
- lazy loading del dettaglio tool;
- piano validato con step, dipendenze, risorse, risk e approval;
- immediate execution solo per azioni read/draft brevi e sicure;
- batch runner controllato per step pronti, con stop su idle, risorsa,
  approval o errore;
- tutto il resto accodato;
- audit Brain persistente e UI-safe.

Test minimi:

- prompt in italiano e inglese selezionano tool coerenti;
- richiesta multi-step genera DAG;
- batch su richiesta treno completa step read-only e si ferma prima
  dell'approval;
- tool rischioso richiede approval;
- tool non abilitato genera richiesta configurazione;
- token budget: il Brain non riceve l'intero registry completo.

Gate di chiusura:

- il composer non risponde piu' "planner prossimo layer";
- richieste complesse diventano piani/tool/task osservabili.

## Fase 6 - Capability, MCP, Connettori E Skill

Obiettivo:

- rendere disponibili integrazioni reali senza costruire tutto a mano;
- mantenere separazione tra provider, policy, segreti e runtime.

Componenti:

- `crates/capabilities`
- MCP stdio/http adapters;
- managed provider adapter opzionale;
- secrets/keychain;
- Connections/Settings UI.

Deliverable:

- pagina connettori reale;
- enable/disable provider;
- grants e privacy domains;
- segreti non esposti nei read model;
- tool cache e resource hints;
- supporto MCP per provider locali;
- valutazione managed providers come Composio/Pipedream/Zapier solo sotto
  policy esplicita.

Test minimi:

- provider locale espone tool card;
- tool MCP viene accodato come task;
- provider disabilitato non viene selezionato;
- segreti assenti da JSON UI;
- connector_api limitato dal Resource Governor.

Gate di chiusura:

- Brain puo' selezionare un tool MCP/connettore abilitato e accodarlo.

## Fase 7 - Subagenti Operativi

Obiettivo:

- usare agenti specializzati per task complessi senza duplicare runtime,
  memoria o policy.

Componenti:

- `crates/subagents`
- Task Runtime;
- Capability Registry;
- Brain.

Deliverable:

- agent definitions data-driven;
- `when_to_use`, scope tool, limiti runtime e memoria accessibile;
- workflow subagente come task durevole;
- checkpoint e recovery;
- UI mostra subagenti coinvolti in modo comprensibile.

Test minimi:

- Brain delega a subagente coerente;
- subagente dichiara `llm_inference`;
- fallimento retryable torna in coda;
- memoria accessibile limitata al task;
- audit non espone prompt raw.

Gate di chiusura:

- una richiesta complessa puo' generare step capability e step subagente con
  dipendenze persistite.

## Fase 8 - Memoria Nel Ciclo Operativo

Obiettivo:

- usare la memoria per contesto, personalizzazione e continuita' senza
  esfiltrare dati.

Componenti:

- `crates/memory`
- MemoryUiReadModel;
- Brain memory context adapter;
- Graphify adapter;
- wiki/notes adapter.

Deliverable:

- memory retrieval filtrata per privacy domain e sensitivity;
- riferimenti memoria allegati ai piani Brain;
- memory dashboard reale;
- link tra memoria strutturata, grafo e wiki;
- azioni CRUD e antiesfiltrazione complete esposte al core/UI.

Test minimi:

- broad query senza permesso viene negata;
- memoria sensibile non entra in prompt oltre soglia;
- Brain riceve solo snippet/reference redatti;
- UI mostra contatori e riferimenti senza raw payload.

Gate di chiusura:

- richieste contestuali usano memoria reale con audit consultabile.

## Fase 9 - Persistenza, Resume E Task Di Giorni

Stato: avviata. Il desktop ora apre store persistenti locali sotto
`.local-first/desktop-state/` per task runtime, memoria, process registry,
capability registry, Local Computer e chat thread. I test restano su store
in-memory isolati. Il bootstrap rilascia risorse stale e riporta in coda task
`running`/`waiting_resource` non-chat dopo restart, con checkpoint redatto.
La UI traduce i task recuperati in messaggi leggibili e le approval pending
sono verificate come persistenti e ancora azionabili dopo restart. Restano da
chiudere resume task running più avanzato e policy di compattazione/retention.

Obiettivo:

- rendere affidabili task lunghi, multipli e riprendibili dopo riavvio.

Componenti:

- TaskStore SQLite persistente;
- LocalComputerSessionStore persistente;
- ChatThreadStore persistente;
- Process Manager;
- app lifecycle Electron + gateway.

Deliverable:

- thread persistenti;
- task e checkpoint persistenti;
- sessioni computer persistenti o ricostruibili;
- seed locale idempotente, senza reset a ogni avvio;
- resume di task pending/running;
- lease/recovery all'avvio con rilascio risorse stale;
- recovery e approval post-restart visibili nei read model/UI;
- limiti globali/per workspace/per utente applicati dopo restart.

Test minimi:

- creare task, riavviare app, ritrovare coda;
- creare chat, riavviare app, ritrovare thread e sessione computer;
- running stale rilascia risorse, registra checkpoint redatto e torna queued;
- approval pending sopravvive al riavvio;
- thread nuovo non eredita eventi vecchi.

Gate di chiusura:

- un task di lunga durata puo' essere sospeso e ripreso senza perdere audit.

## Fase 10 - Auto-Apprendimento

Obiettivo:

- imparare abitudini e proporre automatismi dopo che eventi reali, memoria e
  policy sono affidabili.

Componenti:

- event ingestion dal Local Computer;
- Memory Layer;
- Learning read model;
- Automation proposals;
- Approval Gate.

Deliverable:

- raccolta eventi redatti e classificati;
- pattern detection locale;
- proposte di automatismi spiegabili;
- conferma, modifica, rifiuto e revoca;
- separazione tra insight, memoria confermata e automazione attiva.

Test minimi:

- eventi sensibili vengono esclusi o redatti;
- pattern con bassa confidenza resta candidate;
- automazione non viene attivata senza conferma;
- utente puo' cancellare insight e dati correlati.

Gate di chiusura:

- UI Apprendimento mostra cosa ha imparato, prove redatte e automatismi
  consigliati, senza agire da sola.

## Fase 11 - UI Finale E Qualita' Esperienza

Obiettivo:

- completare la qualita' visiva e di controllo dell'intera app dopo che la Chat
  Experience Foundation ha gia' reso stabile la superficie conversazionale;
- arrivare a una UI premium, chiara e operativa ispirata alla pulizia Manus,
  con settings/controlli solidi in stile Codex.

Componenti:

- Desktop UI React;
- Tasks/Approvals;
- Connections;
- Settings;
- Local Computer;
- Learning.

Deliverable:

- rifinitura chat centrale gia' fondata nella Fase 0.5;
- sidebar/thread minimal;
- top menu contestuali;
- Local Computer espandibile;
- settings ampie e leggibili;
- connettori curati;
- responsive desktop/mobile;
- tema light completo e token pronti per dark mode.

Test minimi:

- screenshot desktop e mobile;
- nessun overlap;
- composer sempre utilizzabile;
- sidebar collapsabile;
- settings senza tagli;
- palette non monocromatica e non troppo densa.

Gate di chiusura:

- l'app si puo' usare per un workflow reale senza aprire terminale o log grezzi.

## Fase 12 - Production Hardening E Packaging

Obiettivo:

- rendere il sistema distribuibile, robusto e verificabile.

Componenti:

- Electron packaging;
- process manager;
- secrets/keychain;
- migrations;
- test e2e;
- observability locale;
- export/delete data.

Deliverable:

- packaging macOS prima, poi Windows/Linux;
- migrations versionate;
- backup/recovery;
- export/delete globale dati utente;
- limiti output/log;
- crash recovery;
- suite e2e sui workflow principali;
- security/privacy review locale.

Test minimi:

- installazione pulita;
- upgrade schema;
- cancellazione dati;
- task recovery;
- inferenza/provider health (Ollama/OpenAI-compat/Anthropic);
- browser sidecar health;
- workflow e2e: prompt -> piano -> task -> tool -> Local Computer -> output.

Gate di chiusura:

- build installabile e testabile da utente reale con dati locali, senza API
  cloud implicite.

## Milestone Di Prodotto

### Milestone A - Test Reale Locale Governato

Include fasi 1-3.

Risultato:

- prompt complesso crea piano;
- task viene eseguito passando da risorse e approval;
- UI mostra stato reale e Local Computer coerente.

### Milestone B - Browser Reale Utile

Include fase 4.

Risultato:

- l'assistente puo' cercare, navigare e preparare form senza azioni rischiose;
- l'utente vede screenshot, transcript e blocchi approval.

### Milestone C - Tool Orchestration Reale

Include fasi 5-7.

Risultato:

- Brain sceglie capability, MCP, skill e subagenti;
- task multi-step e multi-tool sono accodati e osservabili.

### Milestone D - Assistente Personale Contestuale

Include fasi 8-10.

Risultato:

- memoria e apprendimento rendono l'assistente personale, ma sempre
  controllabile e revocabile.

### Milestone E - Prodotto Installabile

Include fasi 11-12.

Risultato:

- UI completa, pacchetto installabile, recovery, sicurezza e test e2e.

## Prossima Azione

La Fase 1 (Prompt Plan Executor) e le fasi 2-4 sono realizzate. Le priorita'
correnti sono in `docs/roadmap.md` -> sezione "Next Action", in sintesi:

1. ~~ruolo browser su modello vision~~ FATTO (2026-06-05: ruolo browser =
   `minimax-m3:cloud`, vision) -> la priorita' #1 effettiva e' ora la voce 2;
2. portare i task durevoli `browser_task` sul motore browser granular e ritirare
   il planner legacy (chiude il debito del doppio motore);
3. affidabilita' browser su siti reali (extractor tabellari, cookie preflight,
   stale-ref recovery, wait predicates);
4. Fase 12 — packaging/notarization macOS (distribuzione);
5. Fase 10 — auto-apprendimento (gated: solo dopo eventi reali affidabili).
