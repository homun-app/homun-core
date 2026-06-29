# Sottosistema Browser

> Stato: **2026-06-27 — reverse-engineered dal codice, punto fermo.** Documenta il
> comportamento reale OGGI, non il design desiderato. Ogni riferimento è `file:line`
> verificato sul sorgente del repo `app`. Quando il codice e questa nota divergono,
> vince il codice (e questa nota va corretta).

---

## Cosa fa

Il sottosistema browser è la capacità "navigare il web reale" dell'agente. Permette al
modello di **aprire pagine**, **leggerle come testo accessibile con riferimenti
cliccabili** e **agire** (click, scrittura, selezione, hold) un micro-passo alla volta,
in un loop osserva→agisci. Serve i casi tipo "cerca un treno/volo", "leggi questa
pagina", "compila questa ricerca" senza che il modello debba conoscere il DOM.

Due metà:

- **Sidecar TypeScript** (`runtimes/browser-automation/`): processo Node che parla
  JSON-line su stdio e pilota Chromium via Playwright. Espone metodi atomici
  (`browser.open`, `browser.navigate`, `browser.snapshot`, `browser.act`, …). È il solo
  che tocca il browser.
- **Gateway Rust** (`crates/desktop-gateway/src/main.rs`): espone al modello i tool
  granulari `browser_navigate` / `browser_snapshot` / `browser_act` / `browser_tabs` /
  `browser_screenshot` / `browser_dialog`, gestisce il loop a round, l'igiene di
  contesto, il **gate di sicurezza** e il **lock globale** sul singolo browser.

---

## Come funziona OGGI

Flusso di un turno con browsing (lato gateway, `main.rs`):

1. Quando il modello chiama un tool browser, il gateway, se non c'è ancora una sessione,
   avvia il sidecar con `spawn_browser_sidecar_for_chat` (`main.rs:35427`) /
   `spawn_browser_sidecar_for_task` (`main.rs:35400`). Il loop gira fino a
   `MAX_TOOL_ROUNDS_BROWSER = 32` round (`main.rs:14840`, ciclo a `main.rs:19165`).
2. Ogni round inizia con **igiene di contesto** `prune_browser_history`
   (`main.rs:24983`): tiene solo l'ULTIMO risultato-snapshot del browser e l'ULTIMA
   immagine, stubba i precedenti (`PRUNED_SNAPSHOT_STUB`, `main.rs:24804`), per non far
   esplodere la context window a 32 round.
3. Ogni chiamata al sidecar passa per `chat_browser_call` (`main.rs:25051`), sempre
   sotto il **`browse_web_lock`** globale (`main.rs:24797`): un solo turno pilota il
   browser per volta.
4. **`browser_navigate`** (`main.rs:19844`): la prima volta su un tab fa `browser.open`,
   poi `browser.navigate`; subito dopo fa una `browser.snapshot` con i parametri canonici
   `browser_chat_snapshot_params` (`main.rs:25086`) e restituisce al modello il testo via
   `browser_snapshot_text` (`main.rs:25103`).
5. **`browser_act`** (`main.rs:20004`): costruisce l'azione coercendo l'errore comune del
   modello (un ref tipo `e83` passato come `target`, che è un id di TAB → re-routing in
   `ref`, `main.rs:20018`), passa per il **gate** `browser_safety::high_risk_reason` /
   `is_committing_action` (`browser_safety.rs:69`, `:49`), esegue `browser.act` e
   restituisce lo snapshot aggiornato. C'è anche no-progress detection (snapshot identico
   → nudge, `main.rs:20105`) e `browser_act_error_hint` (`main.rs:14985`) che insegna la
   chiamata corretta.

Lato sidecar (`session_manager.ts`), una `snapshot` (`:216`) fa:
`waitForLoadState("networkidle", 2500ms)` → `dismissCommonOverlays` → `createSnapshot`,
e ripopola la mappa `refs`. Una `act` (`:249`) fa prima `dismissCommonOverlays`, poi
esegue l'azione e (per le azioni mutanti) ri-snapshotta.

```mermaid
flowchart TD
    M[Modello chiama tool browser] --> GW[Gateway main.rs loop max 32 round]
    GW --> PR[prune_browser_history igiene contesto]
    PR --> LK[browse_web_lock mutex globale]
    LK --> CB[chat_browser_call su sidecar]

    CB --> NAV{Quale tool}
    NAV -->|browser_navigate| OPEN[open prima volta poi navigate]
    NAV -->|browser_act| GATE[gate sicurezza high_risk e committing]
    NAV -->|browser_snapshot| SNAPONLY[snapshot read only]

    OPEN --> SC[Sidecar session_manager]
    GATE -->|consentito| SC
    GATE -->|bloccato| STOP[errore confermare con utente]
    SNAPONLY --> SC

    SC --> GOTO[page goto navigate]
    GOTO --> DIS[dismissCommonOverlays consent OneTrust]
    DIS --> IDLE[waitForLoadState networkidle bounded]
    IDLE --> SNAP[createSnapshot aria con ref]
    SNAP --> REFS[mappa refs aria-ref locator]
    REFS --> OUT[snapshot testo piu refs torna al modello]
    OUT --> GW
```

---

## Perché è così

- **Profilo ephemeral di default** (`profiles.ts:41-69`, `assistantUserDataDir`): ogni
  run parte da una dir per-processo sotto la temp OS, fingerprint pulito. È una scelta
  **anti-bot**: un profilo riusato che un vendor (Cloudflare/DataDome) sfida UNA volta
  tiene per sempre il cookie/fingerprint "bot", trasformando un captcha una-tantum in un
  blocco permanente — il fallimento osservato su ricerche anonime pesanti (voli, treni).
  La persistenza è **opt-in** (`BROWSER_AUTOMATION_PERSIST_PROFILE=1`) e ha senso solo per
  flussi **autenticati**, dove sembrare un utente loggato che ritorna aiuta davvero.
- **Snapshot content-preserving** (`browser_chat_snapshot_params`, `main.rs:25075`): la
  vecchia snapshot `mode:"efficient" + interactive:true` filtrava l'albero aria ai soli
  ruoli cliccabili e buttava via tabelle/righe/celle/testo — così una tabella Wikipedia
  tornava come navbar+cookie-button e il modello non vedeva mai i dati, ripiegando su curl
  con cifre stale/inventate. Oggi si tiene `compact:true` ma NON `interactive`, così la
  snapshot conserva il CONTENUTO **e** i ref interattivi: il modello può sia LEGGERE sia
  CLICCARE. `max_chars` ampio (20k) per non tagliare una tabella a metà.
- **Stealth minimale** (`session_manager.ts:659`, `applyStealthInit`): si nasconde solo
  il segnale più alto, `navigator.webdriver`, via `addInitScript` nel main world; sul path
  managed si droppano `--enable-automation` e `AutomationControlled` e si allineano
  locale/timezone all'host (`:577-589`). Volutamente minimale: patchright è stato revertato
  perché il suo isolated-context rompeva snapshot e form-fill.
- **Lock globale = un solo browser** (`browse_web_lock`, `main.rs:24797`): c'è una sola
  istanza Chromium condivisa (warm context con cookie/consenso), quindi va serializzato
  l'accesso per non avere due turni che si pestano i tab/lo stato.
- **Discovery-first per ricerche aperte** (`browser_open_research_discovery_instruction`):
  quando l'utente chiede news o ricerca web corrente senza nominare un sito/URL, il loop
  deve partire da una pagina di search/discovery (risultati o news discovery), leggere più
  candidati recenti e solo dopo scegliere le fonti. Saltare direttamente a una singola
  testata è ammesso solo se l'utente l'ha nominata o se il contesto la impone.

---

## Contratto

### Tool esposti al modello (gateway)

| Tool | Input | Output | Note |
|------|-------|--------|------|
| `browser_navigate` (`main.rs:14900`) | `url` (req), `target` (tab), `new_tab` | "Page opened (url). Snapshot:\n…" | apre/naviga + auto-snapshot |
| `browser_snapshot` (`main.rs:14929`) | `target` | "Page snapshot:\n…" | read-only, ri-legge la pagina |
| `browser_act` (`main.rs:14949`) | `kind` (req: click/type/fill/select/select_option/press/press_key/hover/hold/scroll/scrollIntoView/wait), `ref`, `text`, `value`, `values`, `submit`, `key`, `durationMs`, `target` | snapshot aggiornato | un micro-passo per volta |
| `browser_screenshot` (`main.rs:14999`) | `full_page`, `marks`, `target` | immagine (+ legenda set-of-marks se `marks`) | solo se la text-snapshot non basta |
| `browser_tabs` (`main.rs:15018`) | — | lista tab (id, url, titolo) | read-only |
| `browser_dialog` (`main.rs:15029`) | `accept`, `prompt_text` | dialog gestito | risponde a alert/confirm/prompt nativi |

### Metodi del sidecar (stdio JSON-line)

`browser.health|profiles|start|stop|tabs|open|focus|close_tab|navigate|snapshot|`
`screenshot|act|arm_file_chooser|respond_dialog|wait_download|console|pdf`
(`contracts.ts:1`, dispatch `server.ts:34`). Request `{id, method, params}` →
response `{id, ok:true, result}` o `{id, ok:false, error:{code, message, retryable, manual_action_required}}` (`contracts.ts:20-43`).

### Forma dello snapshot

`BrowserSnapshot` (`snapshot.ts:10`): `{ targetId, url, snapshot (testo), refs[], refLocators, refsMode: "aria"|"locator", snapshotFormat: "ai"|"legacy", stats:{lines,chars,refs} }`.

- **`snapshot`** = testo accessibile (albero aria in modalità AI) con righe tipo
  `- button "Cerca" [ref=e7]`. Costruito da `createAiSnapshot` (`snapshot.ts:143`) via
  `page.ariaSnapshot({mode:"ai"})`, opzionalmente ridotto da
  `buildRoleSnapshotFromAiSnapshot` (`snapshot.ts:225`) secondo `INTERACTIVE_ROLES`
  (`snapshot.ts:39`) / `STRUCTURAL_ROLES` (`snapshot.ts:59`).
- **`refs`** = elenco `{ref, role, name}` degli elementi indirizzabili; ogni ref mappa a
  un `Locator` (`page.locator("aria-ref=eN")`). Il modello agisce passando `ref`. Ref
  stale → take a fresh snapshot (`BROWSER_STALE_REF`, `actions.ts:595`).
- Fallback `createLegacySnapshot` (`snapshot.ts:321`) quando l'aria-snapshot AI fallisce:
  title + body text + elementi da `INTERACTIVE_SELECTOR`, `refsMode:"locator"`.

### Env (sidecar)

- `BROWSER_AUTOMATION_PERSIST_PROFILE=1` → profilo persistente STABILE (default:
  ephemeral per-processo). `profiles.ts:54`.
- `BROWSER_AUTOMATION_ISOLATED_CONTEXT=1` → contesto isolato per worker paralleli (su CDP
  crea un `newContext` proprio; forza comunque dir per-processo). `profiles.ts:55`,
  `session_manager.ts:628`.
- `BROWSER_AUTOMATION_USER_CDP_ENDPOINT` → attacca via `connectOverCDP` al browser reale
  del contained-computer (ADR 0010) invece di lanciare un Chromium host
  (`session_manager.ts:615-635`). Wiring lato gateway: `browser_sidecar_env_with_headless`
  (`main.rs:42948`), endpoint da `contained_computer_cdp_endpoint` (`main.rs:42455`).
- `BROWSER_AUTOMATION_HEADLESS` (default headless), `_ALLOW_PRIVATE_NETWORK`,
  `_PROFILE_ROOT`, `_ARTIFACT_ROOT`, `_UPLOAD_ROOTS`, `BROWSER_EXECUTABLE_PATH`
  (`server.ts:13`, `profiles.ts:97`).

### Garanzie / errori tipizzati

- **Navigazione governata**: `assertNavigationAllowed` (`navigation_guard.ts:12`) blocca
  protocolli non http(s) e (default) la rete privata → `BROWSER_NAVIGATION_BLOCKED` /
  `BROWSER_PRIVATE_NETWORK_BLOCKED`.
- **Gate di sicurezza** (`browser_safety.rs`): `evaluate` (JS arbitrario) e azioni
  committing (click/submit/Enter) su controlli con label di acquisto/login/prenotazione
  (`HIGH_RISK_LABEL_PATTERNS`, EN+IT) sono rifiutate per tutti. In turni read-only da
  canale ogni commit è rifiutato, TRANNE per l'owner.
- Errori tipizzati `BrowserAutomationError` (`contracts.ts:65`): es. `BROWSER_STALE_REF`,
  `BROWSER_ACTION_TIMEOUT`, `BROWSER_DIALOG_BLOCKED`, `BROWSER_TAB_NOT_FOUND`,
  `BROWSER_EXECUTABLE_NOT_FOUND`, `BROWSER_FORM_FILL_FAILED`, con flag
  `retryable` / `manual_action_required`.
- **Autocomplete owned dall'harness**: `kind:"type"` gestisce da solo la selezione del
  suggerimento (combobox, typeahead, keyboard-only) — il modello non deve saperlo
  (`actions.ts:806`, `confirmAutocomplete`). `hold` per le challenge "tieni premuto"
  (`actions.ts:336`).
- **`kind:"fill"` accetta DUE forme** (`resolveFillFields`, `actions.ts`): la canonica
  `fields:[{ref,value}]` (multi-campo, usata da `fill_form`/batch) **e** la forma PIATTA
  del micro-tool chat `{ref, text|value}`. Lo schema `browser_act` esposto al modello è
  piatto (una micro-azione per volta), quindi `kind:"fill"` dal chat-loop arriva senza
  `fields`: prima della coercizione il `for…of action.fields` falliva silenziosamente
  (`action.fields` undefined → `BROWSER_ACTION_FAILED`), così **fill non funzionava** dalla
  chat mentre `type` sì. Ora le due forme convergono in un solo path (caposaldo #5); manca
  ancora `ref`+nessun valore → `BROWSER_INVALID_REQUEST` esplicito (non più TypeError opaco).
- **Resilienza tab**: `resolvePage` (`session_manager.ts:537`) ri-materializza un tab
  morto al suo ultimo URL invece di fallire a metà loop; fallback headless→visibile su
  errori di rete tipici (`gotoWithHeadlessFallback`, `:496`; `isHeadlessNavigationFailure`,
  `:833`).

---

## Divergenze / debolezze

Problemi reali individuati nel codice attuale:

1. **Lock globale → niente browsing parallelo.** `browse_web_lock` (`main.rs:24797`)
   serializza tutto su un'unica istanza Chromium condivisa. Più turni/canali che vogliono
   navigare insieme si bloccano a vicenda. Il sidecar ha già il concetto di
   isolated-context per worker paralleli (`session_manager.ts:628`), ma il path chat lo
   serializza comunque.
2. **Consent auto-dismiss solo OneTrust (+ generici IT/EN).** `dismissCommonOverlays`
   (`session_manager.ts:786`) conosce gli handler `#onetrust-*` e una manciata di bottoni
   per testo ("Rifiuta tutto", "Accept all", …). NON copre **Sourcepoint**, **Didomi**,
   **Quantcast/TCF** né i consent dentro **iframe** (selettori solo sul frame top). Su quei
   CMP il banner resta e occupa il viewport.
3. **SPA che falliscono lo snapshot.** Lo snapshot AI dipende da `page.ariaSnapshot` su un
   albero aria stabilizzato; il settle è **bounded** (`networkidle` 2.5s,
   `session_manager.ts:234`). Una SPA che non va mai idle, idrata dopo il cap, o monta i
   risultati in shadow DOM/canvas può tornare uno snapshot vuoto/scheletro. Fallback:
   `createLegacySnapshot` (testo + selettori CSS), oppure lo screenshot set-of-marks.
4. **Profilo ephemeral = consent-wall ogni pagina.** Il rovescio del default anti-bot:
   nessun cookie persiste tra run, quindi ogni sessione anonima rivede il consent-wall e
   le scelte geo/lingua. Mitigato solo dal warm shared context **quando** si è su CDP
   contained-computer (cookie condivisi tra tab della stessa sessione, `main.rs:42971`);
   sul path host ephemeral si riparte puliti ogni volta.
5. **`evaluate` non disponibile lato chat.** Il gate rifiuta `evaluate`
   (`browser_safety.rs:71`), quindi non c'è via di estrazione dati via JS: tutto deve
   passare dal testo dello snapshot o da click/scroll. Limita pagine in cui il dato è
   raggiungibile solo via script.
6. **Due sorgenti per "i tool browser" (convergenti, F1.d).** Restano: (a)
   gli **schemi di chat** (`browser_*_tool_schema()` in `main.rs`, la superficie reale che il
   modello chiama, cablati in `base_tools`); (b) il **seed del registry**
   (`browser_registry_cached_tools`) che deriva gli stessi sei tool dagli schemi (a) — è
   ciò che il **planner** dell'orchestratore indicizza, quindi il browser è visibile al piano
   coi nomi giusti. F1.d ha reso (a)≡(b); resta da far sorgentare (a) dal registry (lavoro di
   F3). Il **terzo** sorgente storico — il provider tipato `BrowserCapabilityProvider`,
   dot-named a livello di metodo sidecar (`browser.navigate`), **mai istanziato** — è stato
   **cancellato** (sessione 2026-06-28, F1.d cleanup): era un gemello dormiente in violazione del
   caposaldo #5. L'esecutore durable reale (`execute_capability_browser_task` →
   `execute_persistent_browser_capability`, `main.rs`) pilota il sidecar condiviso
   **direttamente** via `BrowserAutomationClient`/`BrowserMethod`, mappando il tool con
   `browser_method_for_capability_tool` (`main.rs:~35473`, gemello vivo di quello che era
   `method_for_tool` nel provider): non serviva né serve un `CapabilityProvider` tipato per il
   worker path. NB: l'**enum** `CapabilityProviderKind::Browser` resta (lo usano registry,
   orchestratore e resource-bridge per la classe risorsa `BrowserSession`); è solo la **struct**
   provider a essere stata rimossa.
7. **CDP-wedge invisibile a `browser_cdp_ok` (2026-06-29).** Un container `homun-cc` long-lived può
   andare in *wedge*: `/json/version` (HTTP) risponde ancora, ma `connectOverCDP` (ws handshake) si
   impianta su targets stantii → ogni sidecar nuovo va in `Timeout 30000ms exceeded`. `browser_cdp_ok`
   (`main.rs:43383`) sonda SOLO l'HTTP, quindi `ensure_browser_cdp_healthy` lo manca → **gap di entrambi i
   motori**. Mitigazione (path condiviso `call_shared_browser_sidecar`): `browser_response_indicates_cdp_wedge`
   riconosce la firma e `recycle_container()` una volta per finestra (`browser_recycle_throttle_ok`, 90s) →
   `SidecarLost` → respawn fresco. Resta debole: la firma è testuale (EN Playwright) e il recycle è un
   `docker rm -f` (disruptivo se un altro turno sta usando il browser). Fix migliore a regime: un probe
   ws-level (non solo HTTP) in `browser_cdp_ok`.

---

## Caposaldo servito

- **Caposaldo 3 — Local-first + privacy-by-design** (`docs/CAPISALDI.md`): il browser gira
  locale; navigazione governata (`navigation_guard.ts`) e gate di sicurezza
  (`browser_safety.rs`) sono guardrail fail-closed sulle azioni rischiose.
- **Caposaldo 2 / 11 — orchestrazione dell'harness, no keyword.** L'autocomplete, la
  selezione suggerimenti, la coercion ref/target e i nudge no-progress vivono nel
  CODICE (harness), non nel modello: il browsing deve funzionare anche su modelli deboli.
- **Caposaldo 9 — workspace agentico operativo.** Il loop osserva→agisci con evidenza
  (snapshot, screenshot, browser-step) è una superficie di computer activity verificabile.
- **Caposaldo 5 — un solo motore / niente duplicati.** Il browser ha UN solo esecutore
  (l'esecutore durable sul sidecar condiviso) e UNA sola superficie verso il planner (il seed
  del registry). Il provider tipato dormiente `BrowserCapabilityProvider` è stato cancellato
  (F1.d cleanup) per non lasciare un secondo path di esecuzione mai cablato — stesso ritiro già
  fatto per `SkillCapabilityProvider` (F1.b) e `ComposioCapabilityProvider` (F1.c).
- **ADR 0010 — contained computer**: l'attach via CDP (`connectOverCDP`,
  `BROWSER_AUTOMATION_USER_CDP_ENDPOINT`) è il modo in cui il browser reale del contained
  computer diventa il backend del sidecar. Riferimento esterno: `openclaw` (la snapshot
  segue il contratto OpenClaw, `snapshot.ts:37`).

---

## File chiave

Sidecar TypeScript (`runtimes/browser-automation/src/`):
- `server.ts` — dispatch stdio JSON-line dei metodi `browser.*`.
- `contracts.ts` — `BrowserMethod`, request/response, `BrowserAutomationError`.
- `browser/session_manager.ts` — `BrowserSessionManager`: `snapshot`/`act`/`resolvePage`,
  `dismissCommonOverlays`, `applyStealthInit`, `launchPersistentContext` /
  `connectOverCDP`, fallback headless→visibile.
- `browser/snapshot.ts` — `createSnapshot` / `createAiSnapshot` /
  `buildRoleSnapshotFromAiSnapshot` / `createLegacySnapshot`, `INTERACTIVE_ROLES` /
  `STRUCTURAL_ROLES`.
- `browser/actions.ts` — `executeAction` (tutte le `kind`), `confirmAutocomplete`,
  `requireRef`, errori normalizzati.
- `browser/profiles.ts` — `assistantUserDataDir` (ephemeral di default / persist opt-in),
  `discoverChromiumExecutable`.
- `browser/navigation_guard.ts` — `assertNavigationAllowed`, blocco rete privata.

Gateway Rust (`crates/desktop-gateway/src/`):
- `main.rs` — tool schema (`browser_*_tool_schema`, ~`:14900`), loop e handler
  (`:19165`, `:19844`/`:19966`/`:20004`), `browse_web_lock` (`:24797`),
  `prune_browser_history` (`:24983`), `chat_browser_call` (`:25051`),
  `browser_chat_snapshot_params` (`:25086`), `browser_snapshot_text` (`:25103`),
  `browser_act_error_hint` (`:14985`), spawn sidecar (`:35400`/`:35427`),
  env builder (`:42948`).
- `browser_safety.rs` — `high_risk_reason`, `is_committing_action`,
  `snapshot_label_for_ref`, `HIGH_RISK_LABEL_PATTERNS`.
