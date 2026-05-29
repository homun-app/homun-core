# Roadmap Operativa

## Active Goal

Rendere la chat Electron realmente usabile e local-first: streaming fluido,
contesto conversazionale corretto, prompt budget nel core Rust e nessuna
dipendenza da Tauri o API cloud.

## Current Phase

Desktop HTTP Gateway Rust.

Slice completati: `crates/desktop-gateway` espone prompt build,
stream/cancel, runtime health/warmup/shutdown e read model persistente di
thread/messaggi su SQLite locale. Il gateway usa
`local-first-context-compression` per redigere/comprimere il contesto recente,
proxy stream NDJSON verso Gemma, token bearer locale e CORS allowlist. Il
gateway espone anche i read model non-chat principali: task queue, task detail,
approval gate, local computer session, memory dashboard e capability snapshot.
Il primo percorso operativo reale dalla chat e' collegato: un prompt operativo
crea un task persistente, richiede approval, apre una sessione Computer locale
associata e sincronizza lo stato dopo approve/reject. Esiste anche un primo
executor read-only: consuma task approvati, aggiorna checkpoint/sessione
Computer/timeline e pubblica il risultato in chat. Per ora esegue browser
open/snapshot/screenshot preview via sidecar locale, shell `date` read-only e
calcoli semplici.
La UI
Settings mostra ora diagnostica runtime copiabile con stato, PID, porta,
memoria, CPU, duplicati e log runtime redatti quando Gemma e' gestito dal
gateway. Electron ora possiede il lifecycle del gateway anche in dev:
preload isolato per URL/token, autostart gateway, fallback packaged a
`resources/bin/local-first-desktop-gateway` o `LOCAL_FIRST_DESKTOP_GATEWAY_BIN`
e spegnimento del gateway gestito su quit. Il supervisor locale ora conserva
log processo redatti su disco con retention e il gateway supporta una venv
Python/MLX configurabile per build packaged. Esiste anche un layout risorse
production-like generato da `npm run package:prepare`, con gateway release,
runtime MLX e `.venv-mlx`, verificato con smoke Electron senza Vite.
L'executor usa ora lease locali, recupero lease scaduti e reservation/release
risorse tramite `ResourceGovernor`. Il browser read-only raccoglie piu' fonti
per i task treno, registra errori per singola fonte senza far fallire tutto il
task e produce una preview PNG consultabile dal Computer locale. Il gateway
avvia anche un worker background che controlla la coda ogni secondo ed esegue
task approvati senza intervento manuale della UI; `/api/tasks/executor` espone
lo stato sintetico del worker. Durante l'esecuzione il gateway scrive ora
checkpoint/eventi intermedi per avvio task, runtime browser, singole fonti e
sintesi finale. La risposta finale dei task browser e' ora separata dai dati
tecnici: la chat mostra risultato/fonti/limiti/prossimo passo, mentre snapshot,
errori tecnici e screenshot restano nel Computer locale e nel checkpoint. La UI
mantiene visibile la card Computer quando una sessione ha timeline o artifact,
anche dopo il completamento. Il browser gestito dal gateway e' visibile di
default sul desktop, con override `LOCAL_FIRST_BROWSER_HEADLESS=1` per smoke e
test. Per i task treno esiste anche un primo livello di compilazione sicura:
il gateway estrae partenza/arrivo/data/ora, prova a compilare in bozza i campi
riconoscibili con `browser.act fill_form` batch, registra checkpoint dedicati e
non preme mai Cerca/Continua, submit, login o pagamento senza ulteriore
conferma. Questo slice prende da Homun solo i pattern browser funzionanti
essenziali: tool browser stateful, azioni alte, snapshot dopo azione e
separazione tra compilazione bozza e azioni mutative.
E' iniziata anche la policy URL persistente ispirata a Homun: le approval
browser possono essere temporanee o salvate localmente per i domini del task,
con scelta `auto`, `visible` o `headless` per la sessione browser. Il percorso
chat ora e' operational-first: i prompt che richiedono azioni locali non
passano prima dalla risposta Gemma generica, ma creano direttamente task,
approval e Computer locale; la risposta finale deve arrivare dall'executor con
dati raccolti. Per i task treno il gateway compila i form riconoscibili, prova
a premere solo controlli di ricerca risultati sicuri e poi chiede
proattivamente quale opzione prenotare, fermandosi prima di login, scelta
finale, dati sensibili, acquisto o pagamento. Dopo l'analisi di Homun, i task
browser hanno iniziato a usare un `OperationalPlan` persistente: step, vincoli,
gate e success criteria vengono salvati nel task/checkpoint. Il caso treno non
viene piu' marcato completato se non sono state estratte opzioni reali e
leggibili; resta bloccato con motivazione esplicita invece di fingere una
ricerca conclusa. L'analisi dettagliata di OpenClaw conferma che il prossimo
salto non e' aggiungere altre euristiche sito-specifiche, ma portare nel
sidecar e nel gateway il loop `snapshot -> act -> snapshot -> verify`, con
snapshot Playwright AI/aria refs, target id stabile e policy post-azione.
Il primo slice OpenClaw/Homun e' ora nel sidecar e nel crate browser:
snapshot AI/aria refs, fixture autocomplete + date picker e
`BrowserLoopRunner` testato. Il gateway ora usa anche un
`RuntimeBrowserLoopPlanner` Gemma per i task treno quando
`LOCAL_FIRST_BROWSER_LOOP_CONTROLLER` non e' disattivato. Resta da validare il
loop su siti reali con Gemma avviato e correggere il prompt/controller sugli
artifact prodotti. Il primo test live e' ora passato su TrovaTreno: il gateway
ha prodotto opzioni reali Napoli-Milano per il 10 giugno verso le 9 senza
acquisto/login, usando URL parametrizzato, snapshot reale e completion solo
dopo opzioni verificate.
La prova diretta tramite il nostro sistema su Trenitalia e ItaloTreno ha
chiarito il limite successivo: il routing per fonte esplicita e' corretto e i
task sono browser task, ma il loop generico non gestisce ancora in modo
affidabile cookie, autocomplete, data/ora e submit sui form complessi degli
operatori. Dopo il confronto con OpenClaw, la decisione e' esplicita:
OpenClaw diventa il riferimento principale per il browser runtime. Il primo
porting del contratto e' gia' presente: snapshot AI con aria refs, `urls=true`,
`fill_form` nel planner, ref validation, no-progress guard e checkpoint live per
iterazione. Il piano attivo e' `docs/plans/2026-05-28-openclaw-browser-parity.md`.

## Milestones

1. Stabilizzare packaging gateway Electron.
2. Collegare PromptBrain e task planner al percorso chat.
3. Collegare Local Computer, browser/shell e approvals reali.
4. Solo dopo, cablare auto-apprendimento sugli eventi PC reali.

## Blockers

- In dev il token viene generato da `electron-dev.mjs`; il packaging produzione
  deve avere lifecycle equivalente.
- Il gateway avvia il runtime Python/MLX tramite `ProcessManager` quando warmup
  non trova Gemma in ascolto. Resta da scegliere il packager finale
  (`electron-builder` o equivalente) e il formato macOS/notarization.

## Next Action

Rendere i task multi-step e piu' utili:

- separare planning/esecuzione/sintesi finale nel read model del task;
- sostituire i riconoscimenti hardcoded dei task operativi con un planner Brain
  locale che produca piano, tool scelti, criteri di stop e output atteso;
- completare il porting pulito del modello Homun utile: cognition plan-first,
  browser loop continuo, form policy, autocomplete selection, result extractor
  e completion solo dopo success criteria;
- portare dal modello OpenClaw la parte browser essenziale: contratto browser
  unico per il Brain, snapshot AI Playwright con refs `aria-ref`, action loop
  stretto e recovery su stale refs/dialog blocker. Snapshot AI/aria refs e
  runner base sono presenti; il primo cablaggio gateway/Brain e' attivo per i
  task treno. Prossimo step: test live con Gemma e artifact reali;
- completare policy persistenti per approval/regole fisse:
  gestione/eliminazione regole in Settings, audit leggibile e applicazione
  granulare a click/autocomplete/submit;
- introdurre approval granulare per click controllati, selezione autocomplete,
  calendari/orari custom, submit, login, pagamento, download/upload o qualunque
  write;
- portare nel sidecar browser le prossime primitive Homun-style utili ma
  semplificate: selezione autocomplete assistita, click approvato con snapshot,
  memoria leggera dei pattern sito e test e2e con fixture locale;
- rendere il browser loop OpenClaw-like:
  action schema piu' completo, stale-ref recovery, cookie/banner preflight,
  tab hygiene, dialog blocker, wait predicates bounded, extractor strutturati
  per tabelle/listbox e supporto piu' robusto per Trenitalia/Italo oltre al
  fallback TrovaTreno;
- introdurre adapter form per Trenitalia e ItaloTreno:
  accettazione/chiusura cookie prima del fill, mappatura campo per ruolo/nome,
  autocomplete selection deterministica, date/time picker deterministico,
  submit solo su controllo search-safe e no-progress guard su stesso ref/hash;
- salvare come memoria utente solo preferenze stabili emerse dal task
  confermato, con anti-esfiltrazione e privacy domain, cosi' non vengono
  richieste di nuovo informazioni gia' date;
- mantenere il focus UI sulla risposta finale, con Computer locale collassato
  di default quando il task e' completo.
