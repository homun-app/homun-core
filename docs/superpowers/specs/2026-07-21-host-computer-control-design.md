# Host Computer Control — Design

Data: 2026-07-21. Stato: **direzione approvata in conversazione; spec in revisione utente**.

## Contesto

Il Local Computer attuale di Homun e' un computer contenuto: Chromium, shell e tool girano
in Docker, il browser viene pilotato via CDP e la UI mostra il desktop del container tramite
noVNC. Questo ambiente e' intenzionalmente isolato dal Mac dell'utente e non puo' leggere o
controllare Finder, Xcode, Note o altre applicazioni della sessione grafica host.

Il nuovo sottosistema aggiunge il controllo delle applicazioni macOS reali senza sostituire il
contained computer. Homun conserva due superfici con scopi diversi:

- **Contained Computer**: browser e shell isolati, adatti a codice e contenuti non fidati.
- **Host Computer**: applicazioni reali dell'utente, accessibili solo attraverso permessi,
  grant per-app, policy e audit del Rust Core.

Il riferimento funzionale e' il pattern Computer Use osserva-agisci-osserva: stato della
finestra composto da Accessibility tree e screenshot, azioni atomiche semantic-first,
coordinate solo come fallback, snapshot rigenerato dopo ogni mutazione. L'implementazione
Homun sara' indipendente e usera' soltanto API pubbliche del sistema operativo. Non incorpora
binari, codice, asset o implementazioni proprietarie di terzi.

## Decisione

Costruiamo una parita' funzionale completa macOS con un helper nativo Swift, firmato e
notarizzato, che gira nella sessione utente. Il gateway Rust sull'host e' l'unico chiamante
dell'helper. Il modello vede un tool manager di alto livello, `use_computer(goal, app?)`, e
le azioni granulari sono disponibili soltanto in un sub-turno ricorsivo isolato, secondo lo
stesso pattern gia' adottato da `browse(goal)`.

Il sidecar nativo esegue primitive; non possiede autonomia, policy, approval, memoria o
orchestrazione. Queste responsabilita' restano nel Rust Core.

## Obiettivi

1. Leggere e controllare applicazioni macOS reali mediante Accessibility, ScreenCaptureKit e
   input sintetico di sistema.
2. Offrire un contratto completo: discovery app e finestre, snapshot, click, testo, selezione,
   tasti, scroll, drag, azioni secondarie e gestione del focus.
3. Preferire target semantici derivati dallo snapshot; usare coordinate solo quando
   Accessibility non basta.
4. Tenere separati Host Computer e Contained Computer, lasciando al manager la scelta della
   superficie corretta.
5. Applicare grant per-app, approval action-time, privacy, redazione e audit prima di ogni
   effetto.
6. Consentire all'utente di interrompere o prendere il controllo immediatamente.
7. Conservare un protocollo e un crate Rust portabili, cosi' che Windows UI Automation e Linux
   AT-SPI possano diventare backend futuri senza cambiare il contratto agentico.

## Non obiettivi

- Eseguire il controllo del Mac dall'interno del container Docker.
- Rimuovere o indebolire il contained computer e il suo sandbox.
- Dare al modello accesso diretto alle API macOS, al socket dell'helper o ai permessi TCC.
- Copiare o distribuire componenti proprietari di terzi.
- Automatizzare loginwindow, schermata bloccata, prompt di autorizzazione macOS, password
  manager o inserimento di nuove credenziali.
- Consegnare Windows e Linux nello stesso incremento; il primo verticale e' macOS.
- Registrare video continuo del desktop o mantenere una cronologia visuale globale.
- Rendere AppleScript o `osascript` il backend principale. Eventuali adapter specifici per app
  saranno capability dichiarate e separate, non scorciatoie invisibili.

## Alternative considerate

### Sostituire Docker con il desktop host

Scartata. Perderebbe isolamento, riproducibilita', shell controllata e il confine gia'
validato del contained computer. Browser e codice non fidati finirebbero nella sessione utente.

### Far pilotare il Mac direttamente dal container

Scartata. Il container non appartiene alla sessione grafica macOS e non riceve i grant TCC.
Qualsiasi bridge utile richiederebbe comunque un processo host; esporlo direttamente a Docker
allargherebbe inutilmente la superficie di attacco.

### Backend ibrido host + contained computer

Scelta. Il gateway host governa entrambi. Docker resta il luogo per browser/shell isolati;
l'helper nativo e' il confine minimo per le applicazioni reali.

## Architettura

```text
Electron renderer
  -> Desktop gateway HTTP/WS (host)
      -> engine::run_turn (manager)
          -> use_computer(goal, app?)
              -> recursive host-computer sub-turn
                  -> HostComputerOnlyCapabilityExecutor
                      -> HostComputerService (Rust)
                          -> authenticated local IPC
                              -> Homun Computer Service.app (Swift/macOS)
                                  -> AXUIElement
                                  -> ScreenCaptureKit
                                  -> CGEvent
                                  -> NSWorkspace
      -> LocalComputerSessionManager
          -> HostApps surface events, previews, approvals, takeover and audit

Contained Computer remains separate:
  -> browser sidecar -> CDP -> Chromium in Docker
  -> sandbox shell and noVNC
```

Il manager non riceve i tool granulari. `goal` descrive l'esito richiesto; `app` e' un
identificatore opzionale (bundle identifier, nome o path). Se `app` manca, il sub-turno puo'
usare soltanto `computer_list_apps` per risolvere il target prima di chiedere il grant. La call
`use_computer` crea un contesto figlio con:

- obiettivo concreto;
- app target o criterio di risoluzione;
- grant e policy effettivi;
- budget di round e tempo;
- toolset host-only;
- stream interno drenato, salvo eventi di attivita' sicuri;
- risultato finale compatto e provenance-rich restituito al manager.

Questo evita che snapshot voluminosi, tentativi intermedi e indici di elementi contaminino la
conversazione principale. Il sub-turno usa il loop canonico di Homun, non introduce un secondo
motore di autonomia.

## Componenti

### `runtimes/host-computer/macos/`

Applicazione helper Swift con `LSUIElement=true`, senza icona nel Dock.

Responsabilita':

- risolvere applicazioni per bundle identifier, nome o path;
- elencare app e finestre accessibili;
- avviare o attivare un'app tramite API di workspace;
- acquisire la finestra target tramite ScreenCaptureKit;
- leggere e normalizzare l'albero AX della finestra;
- mantenere la mappa effimera `snapshot_id + element_index -> AXUIElement`;
- eseguire azioni AX quando disponibili;
- usare CGEvent per coordinate, drag, scroll e fallback tastiera;
- osservare cambio focus, distruzione finestra, lock screen e input fisico;
- restituire errori tipizzati e mai decidere se un'azione e' consentita.

Moduli previsti:

```text
HomunComputerService/
  AppLifecycle.swift
  IPCServer.swift
  Protocol.swift
  PermissionController.swift
  ApplicationResolver.swift
  WindowResolver.swift
  AccessibilitySnapshot.swift
  AccessibilityNormalizer.swift
  ElementRegistry.swift
  ScreenshotCapture.swift
  ActionExecutor.swift
  PhysicalInputMonitor.swift
  LockStateMonitor.swift
  Errors.swift
```

### `crates/host-computer/`

Crate Rust indipendente dal gateway.

Responsabilita':

- contratti request/response condivisi;
- client IPC e handshake di versione;
- supervisione e health dell'helper;
- risoluzione di timeout, reconnect e restart bounded;
- validazione di snapshot generation e coordinate;
- policy per-app e per-azione;
- redazione dell'osservazione prima dell'ingresso nel contesto modello;
- artifact refs per screenshot;
- mapping degli errori nativi a errori stabili Homun.

Moduli previsti:

```text
src/
  lib.rs
  types.rs
  client.rs
  transport.rs
  supervisor.rs
  policy.rs
  approvals.rs
  observation.rs
  redaction.rs
  artifacts.rs
  errors.rs
```

### Desktop gateway

Il gateway aggiunge:

- schema manager `use_computer(goal, app?)`;
- `GatewayHostComputerExecutor`, proprietario del sub-turno ricorsivo;
- `HostComputerOnlyCapabilityExecutor`, che rifiuta ogni tool non host anche se il modello lo
  inventa;
- lifecycle dell'helper coordinato con Electron e shutdown del gateway;
- emissione di eventi `computer.live` gia' redatti;
- integrazione con approval center, execution journal e Local Computer Session.

Non viene aggiunto un nuovo loop. I tool granulari entrano nel registry dallo stesso sorgente
dei loro schemi runtime e sono visibili solo nel sub-turno host.

### Local Computer Session

`SurfaceKind` aggiunge `HostApps`. La sessione distingue esplicitamente:

```text
Browser       contained browser / CDP
Shell         contained sandbox
Files         artifacts e file autorizzati
HostApps      applicazioni reali del sistema operativo
Logs          proiezione operativa redatta
```

Eventi aggiuntivi:

```text
host_computer_permission_required
host_computer_permission_resolved
host_app_grant_required
host_app_grant_resolved
host_app_started
host_window_activated
host_snapshot_captured
host_action_started
host_action_completed
host_action_failed
host_user_input_detected
host_takeover_started
host_takeover_completed
host_session_suspended
```

## Protocollo IPC

Il transport macOS usa un Unix domain socket nella directory applicativa Homun con permessi
`0600`. Ogni avvio genera un segreto casuale a 256 bit passato all'helper tramite un file
effimero protetto o un canale ereditato, non tramite argomenti di processo. L'helper verifica
UID del peer, token di sessione, protocol version e scadenza della richiesta.

Il framing e' JSON-RPC 2.0 length-prefixed, con limite massimo per frame. Screenshot e altri
payload binari non viaggiano base64 nel JSON: vengono scritti in una directory artifact privata
e il protocollo restituisce un riferimento locale scoped alla sessione.

Envelope comune:

```json
{
  "jsonrpc": "2.0",
  "id": 41,
  "method": "state.get",
  "params": {
    "session_id": "cs_123",
    "app": { "bundle_id": "com.apple.Notes" },
    "full_tree": false
  },
  "meta": {
    "protocol_version": 1,
    "turn_id": "turn_123",
    "deadline_unix_ms": 1784650000000
  }
}
```

Ogni metodo e' serializzato per sessione; sessioni diverse possono leggere in parallelo, ma
solo una sessione puo' inviare input sintetico alla volta. Il gateway possiede il lock globale
delle azioni host per evitare focus race tra task.

Metodi iniziali:

```text
service.ping
service.version
permissions.status
permissions.present
apps.list
app.launch
windows.list
window.activate
session.start
session.stop
state.get
action.perform
```

`permissions.present` mostra soltanto la UI informativa Homun e apre, su scelta esplicita
dell'utente, la destinazione corretta in System Settings. L'agente non clicca o accetta i propri
permessi.

## Contratto dello stato applicazione

`state.get` restituisce:

```text
session_id
snapshot_id
captured_at
app { bundle_id, display_name, pid, path }
window { id, title_redacted, frame_points, scale_factor, focused }
tree { mode: full|diff, base_snapshot_id?, text, truncated, node_count }
elements[] { index, role, label, value_redacted?, frame_points?, actions[], enabled, focused }
screenshot_ref?
loading_state
warnings[]
```

Lo snapshot usa una generazione immutabile. Ogni azione semantica deve includere
`snapshot_id` e `element_index`; l'helper rifiuta generazioni vecchie con
`STALE_SNAPSHOT`. Gli oggetti `AXUIElement` non vengono persistiti, serializzati o riutilizzati
tra riavvii.

L'albero e' bounded per profondita', numero nodi e caratteri. La normalizzazione privilegia:

1. finestra e foglio modale attivi;
2. elemento focalizzato e suoi antenati;
3. controlli interattivi visibili;
4. testo associato ai controlli;
5. struttura necessaria a disambiguare elementi omonimi.

Il default restituisce un diff rispetto all'ultimo snapshot consegnato nella stessa sessione.
Il gateway puo' richiedere un full snapshot dopo perdita di contesto, restart o errore di base.

## Tool granulari del sub-turno

```text
computer_list_apps
computer_list_windows
computer_get_app_state
computer_launch_app
computer_activate_window
computer_click
computer_drag
computer_scroll
computer_set_value
computer_select_text
computer_type_text
computer_press_key
computer_perform_secondary_action
computer_get_screenshot
computer_done
```

Regole:

- `computer_get_app_state` e' obbligatorio prima della prima azione del turno.
- Dopo ogni azione si acquisisce uno stato fresco prima di decidere il passo successivo.
- Click, set value, text selection e secondary action preferiscono `element_index`.
- Coordinate sono window-relative e legate allo `snapshot_id`; non sono coordinate globali.
- `type_text` e `press_key` richiedono app e finestra attive verificate immediatamente prima.
- Azioni batch non sono esposte: ogni call produce un solo effetto osservabile.
- `computer_done` richiede una sintesi dell'esito e riferimenti agli snapshot finali usati come
  verifica.

## Strategia di azione

Ordine di preferenza:

1. `AXUIElementPerformAction` per press, pick, show menu, increment e azioni dichiarate.
2. `AXUIElementSetAttributeValue` per controlli editabili realmente settable.
3. selezione testuale tramite range/accessibility marker supportati dall'app.
4. CGEvent mirato alla finestra per click, drag, scroll e tastiera.

Il fallback visuale non scatta silenziosamente dopo un errore semantico ambiguo. Il risultato
spiega il fallimento al modello, che deve acquisire un nuovo snapshot e scegliere se usare le
coordinate. Questo evita doppi click o effetti duplicati.

## Permessi e grant

### Permessi macOS

L'helper richiede:

- Accessibility per leggere e controllare altre applicazioni;
- Screen Recording per screenshot di app e finestre.

I permessi appartengono al bundle firmato dell'helper, non a Electron, Docker o al modello.
L'onboarding mostra stato, motivazione e istruzioni. Dopo ogni cambio TCC, il sistema verifica
live la capacita' effettiva; non considera sufficiente il solo click dell'utente in Settings.

### Grant Homun per applicazione

Prima del primo accesso a un'app, Rust risolve il target canonico e applica una decisione:

```text
allowed       grant valido
ask           consenso sessione o persistente
denied        bloccato da policy utente/organizzazione
forbidden     app o superficie non automatizzabile per sicurezza
```

Il grant e' legato a bundle identifier, signing identity quando disponibile, path canonico,
utente e workspace. Se path o firma cambiano, il grant persistente viene invalidato.

La card di consenso mostra nome, icona, bundle identifier, livello di rischio e capacita'
richieste. Le opzioni sono `Consenti questa volta`, `Consenti per questa sessione`, `Consenti
sempre` quando la policy lo permette, oppure `Nega`.

## Policy delle azioni

Rust classifica ogni azione prima dell'IPC usando app target, ruolo AX, label, testo che verra'
inserito, stato della sessione e intento utente. Il contenuto letto dall'app e' dato di terzi e
non vale mai come autorizzazione.

Classi minime:

```text
read                 snapshot, lista app/finestre, screenshot consentito
local_edit           modifica locale recuperabile e gia' richiesta
external_effect      invio, pubblicazione, upload, prenotazione, submit
destructive          cancellazione o modifica non recuperabile
sensitive_transfer   inserimento o invio di dati sensibili
security             permessi, credenziali, rete/VPN, chiavi e accesso persistente
financial            acquisti, trasferimenti e operazioni finanziarie
```

Read non richiede conferma dopo il grant app. Le altre classi seguono l'Approval Center e
richiedono conferma immediatamente prima dell'effetto quando la richiesta utente non costituisce
una pre-approvazione valida. Credential change e operazioni finanziarie ad alto impatto passano
sempre al takeover umano.

Hard deny iniziale:

- loginwindow e lock screen;
- finestre di autorizzazione macOS e prompt TCC;
- Keychain Access e password manager;
- campi `AXSecureTextField` e contenuto mascherato;
- UI che modifica i permessi di Homun o del suo helper;
- automazione invisibile di applicazioni senza finestra verificabile.

Terminali e shell host sono leggibili dopo grant, ma l'inserimento testo e le scorciatoie che
eseguono comandi sono bloccati: l'esecuzione comandi resta nel contained computer e nel tool
sandbox governato. Questa scelta evita che la UI automation diventi un bypass della command
policy.

## Privacy e gestione degli snapshot

Il raw Accessibility tree e il frame originale restano locali. Prima di entrare nel contesto del
modello, l'osservazione passa da `ComputerObservationPolicy`:

- valori di secure field sempre rimossi;
- email, token, chiavi, path sensibili e query string redatti secondo le policy esistenti;
- testo limitato alla finestra e al task in corso;
- contenuto non necessario escluso;
- screenshot consegnato al modello soltanto quando Accessibility e' insufficiente e il provider
  vision scelto e' autorizzato a riceverlo;
- ogni invio a un provider non locale e' registrato con provenance e categoria dati;
- UI e journal ricevono soltanto proiezioni redatte e artifact refs.

Gli screenshot hanno retention bounded, quota per sessione e cleanup su scadenza. Non diventano
memoria personale, allegati della chat o dati di training locali implicitamente. Una promozione a
artifact persistente richiede un'azione esplicita.

## Takeover, input fisico e lock screen

Un event tap passivo distingue, per quanto consentito dal sistema, eventi fisici dagli eventi
sintetici prodotti dall'helper. Quando arriva input fisico durante una sessione attiva:

1. l'helper interrompe la coda di azioni;
2. il gateway marca la sessione `WaitingUser`;
3. la UI mostra `Hai il controllo`;
4. nessuna azione riparte finche' l'utente non seleziona `Restituisci controllo a Homun`.

Un comando globale nella card Computer permette `Pausa` e `Interrompi`. Il lock dello schermo,
lo sleep, il cambio utente o la perdita della sessione grafica sospendono sempre l'automazione e
invalidano snapshot e focus. Homun non tenta sblocco automatico e non conserva credenziali per
farlo.

## Errori e recovery

Errori stabili:

```text
PERMISSION_REQUIRED
PERMISSION_PENDING
APP_NOT_FOUND
APP_FORBIDDEN
APP_GRANT_REQUIRED
WINDOW_NOT_FOUND
WINDOW_NOT_ACTIVE
STALE_SNAPSHOT
ELEMENT_NOT_FOUND
ACTION_UNSUPPORTED
ACTION_REJECTED
AX_TIMEOUT
SCREENSHOT_FAILED
USER_TOOK_CONTROL
SCREEN_LOCKED
HELPER_UNAVAILABLE
PROTOCOL_MISMATCH
DEADLINE_EXCEEDED
```

Ogni errore dichiara `retryable`, `fresh_snapshot_required`, `approval_required` e
`manual_action_required`.

Recovery:

- stale element o window change: full snapshot, nessun replay automatico dell'azione;
- AX timeout: un retry di lettura, poi takeover o errore;
- helper crash: un restart bounded, invalidazione di tutte le sessioni e full snapshot;
- screenshot failure con AX valido: continua semantic-only con warning;
- AX insufficiente con screenshot valido: fallback visuale consentito dalla policy;
- perdita focus prima di type/key: riattiva e riverifica, senza digitare finche' il target non
  coincide;
- risultato ambiguo: osserva e verifica, non ripete automaticamente un'azione mutante.

## Lifecycle, packaging e aggiornamenti

`Homun Computer Service.app` e' una nested app firmata con lo stesso Team ID di Homun, inclusa
nelle risorse del pacchetto Electron e validata durante `package:prepare`. Il bundle helper ha
versione propria e protocol version esplicita.

Requisiti:

- hardened runtime;
- firma e notarizzazione dell'helper e di ogni componente annidato;
- `LSUIElement=true`;
- nessun listener di rete;
- socket e artifact root nel container applicativo Homun;
- aggiornamento atomico insieme alla release desktop;
- verifica code signature e hash prima del launch;
- incompatibilita' di protocollo fail-closed con messaggio di aggiornamento;
- uninstall e factory reset rimuovono socket, cache snapshot, grant Homun e artifact effimeri;
  i record TCC del sistema sono spiegati all'utente ma non manipolati direttamente.

Electron avvia il gateway come oggi. Il gateway chiede a LaunchServices di avviare l'helper solo
quando serve o durante il controllo permessi; l'helper termina dopo idle timeout quando non ci
sono sessioni. Un crash dell'helper non abbatte gateway o UI.

## UX

Settings -> Local Computer distingue due righe:

- `Computer contenuto`: Docker, browser, shell, stato e risorse.
- `Applicazioni del Mac`: helper, Accessibility, Screen Recording, grant app e stato.

La card Computer del thread mantiene una sola superficie ma mostra il badge attivo `Contenuto` o
`Mac`. La vista espansa aggiunge il tab `Applicazioni`, con:

- app e finestra correnti;
- ultimo screenshot redatto;
- azione in corso;
- grant e livello di rischio;
- `Pausa`, `Interrompi`, `Prendi controllo`;
- indicazione visibile quando il modello sta osservando o quando uno screenshot puo' essere
  inviato a un provider non locale.

Non vengono aggiunti contenitori UI annidati: la vista usa la superficie piatta gia' adottata dal
Computer panel e separatori funzionali.

## Strategia di test

### Contratti e Rust

- round-trip di tutti gli envelope IPC e compatibilita' versionata;
- framing parziale, frame sovradimensionato, timeout e peer non autorizzato;
- grant per-app sessione/persistente, invalidazione su path/firma e deny organizzativo;
- policy action class, prompt injection da testo AX e conferme action-time;
- stale snapshot e coordinate legate alla generazione;
- redazione di secure field, email, token, path, URL e screenshot metadata;
- recovery dopo helper crash senza replay dell'ultima mutazione;
- isolamento del sub-turno: nessun tool non host e nessun raw snapshot al manager;
- journal start/completed/failed e Local Computer read model UI-safe.

### Helper macOS

Una fixture app firmata espone controlli AppKit/SwiftUI deterministici: button, checkbox, menu,
table, outline, text field, secure field, editor multilinea, sheet, dialog, scroll view e due
finestre.

Test automatici:

- enumerazione tree e azioni;
- indici deterministici dentro uno snapshot;
- invalidazione dopo cambio UI;
- AX press/set/select e fallback CGEvent;
- mapping coordinate con Retina, finestre spostate e display multipli;
- full tree e diff equivalenti;
- screenshot della sola finestra target;
- focus race, finestra chiusa e app non responsive;
- input fisico che sospende la sessione;
- lock/sleep che invalida lo stato.

### Integrazione reale

Matrice minima su una macchina macOS pulita:

- onboarding senza permessi, solo Accessibility, solo Screen Recording, entrambi;
- Finder: navigazione e selezione non distruttiva;
- Note: creazione e modifica di una nota di test recuperabile;
- Xcode: apertura progetto, build e lettura esito senza usare Terminal host;
- Safari o Chrome: lettura e interazione, mantenendo `browse` come scelta preferita per il web;
- app Electron e SwiftUI con Accessibility incompleta;
- due monitor, scaling Retina e finestra parzialmente fuori schermo;
- takeover con mouse e trackpad reali, non soltanto scorciatoie simulate;
- riavvio helper, riavvio gateway, reload UI e update applicativo.

### Gate di sicurezza

- tentativo di leggere un secure field;
- tentativo di pilotare Keychain/password manager;
- tentativo di cambiare i permessi di Homun;
- testo malevolo visibile nell'app che chiede di ignorare policy;
- submit esterno senza approval;
- digitazione in Terminal host;
- cambio focus tra verifica e type;
- screenshot non autorizzato verso provider cloud.

## Rollout

1. **Foundation nascosta**: helper, IPC, permission status e fixture app; nessun tool al modello.
2. **Read-only dogfood**: list app/window, snapshot e screenshot su allowlist interna.
3. **Azioni semantiche**: click, set value, select, scroll e focus sulla fixture e su Note.
4. **Sub-turno agentico**: `use_computer` con tool host-only, journal e Local Computer events.
5. **Approval e takeover**: grant per-app, action policy, input fisico e lock handling.
6. **Beta esplicita macOS**: opt-in Settings, app matrix e telemetria locale degli errori.
7. **Disponibilita' generale**: solo dopo firma/notarizzazione, upgrade/factory-reset, live matrix e
   audit privacy completi.

Ogni fase e' disattivabile senza cambiare il contained computer. Il feature flag governa la
registrazione della capability, non crea rami alternativi dentro il loop canonico.

## Criteri di accettazione

La prima release generale e' completa quando:

1. Docker continua a servire browser e shell senza regressioni.
2. L'helper host controlla app reali attraverso API pubbliche e non espone porte di rete.
3. Il manager vede un solo `use_computer`; i tool granulari restano confinati al sub-turno.
4. Ogni azione usa app, finestra e snapshot generation verificati.
5. Semantic action precede sempre il fallback a coordinate.
6. Grant per-app, approval e hard deny sono applicati nel Rust Core prima dell'IPC.
7. Secure field, permessi, password manager, lock screen e Terminal host non sono bypassabili.
8. Input fisico e lock screen sospendono l'automazione senza azioni residue.
9. Raw tree e screenshot non raggiungono UI, journal, memoria o provider non autorizzati.
10. Helper crash, focus race e stale snapshot non causano replay di mutazioni.
11. Firma, notarizzazione, update, uninstall e factory reset sono verificati su build reale.
12. La matrice Finder/Note/Xcode/browser e i gate di sicurezza passano nell'app installata.
13. Il pannello mostra chiaramente se Homun opera nel computer contenuto o nelle app del Mac.
14. Codice e documentazione dell'implementazione sono originali e tracciano soltanto API pubbliche
    e contratti Homun come fonti.
