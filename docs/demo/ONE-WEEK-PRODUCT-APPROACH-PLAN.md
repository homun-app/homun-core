# Homun One-Week Product Approach Plan

Data: 2026-05-02
Aggiornato: 2026-05-04
Orizzonte: 7 giorni
Obiettivo: avvicinare la percezione prodotto a un workspace operativo agentico, senza rifare il sistema.

## Sintesi

Homun ha gia' una profondita' tecnica superiore a quanto comunica l'interfaccia: chat agente, automazioni, workflow, skill, MCP, profili/brain, canali e App Factory. Il problema principale non e' aggiungere altre feature, ma rendere visibile il modello prodotto:

> Homun trasforma richieste in compiti, automazioni e app operative.

La settimana deve concentrarsi su interventi mirati che aumentano chiarezza, fiducia e demo readiness.

## Stato Attuale

### Completato / Validato

- Home chat task-first: validata visivamente.
- `Tools > Create Automation`: ora attiva la modalita' contestuale per attivita' programmate.
- `Strumenti collegati`: resta accanto a `Tools` come accesso compatto alle capacita' disponibili.
- Shortcut principali sotto il composer: ridotti ai soli ingressi generali (`Crea app`, `Ricerca`, `Briefing`, `Altro`) per evitare affollamento.
- Modalita' automazione: quando selezionata, mostra placeholder dedicato, CTA per calendario/nuova pianificazione e suggerimenti coerenti solo con la pianificazione.

### Implicazione

Il punto 1 della roadmap non richiede altre modifiche UI. Va solo mantenuto stabile, verificato dopo build/restart e usato come base narrativa per il resto della demo.

## Osservazioni Da Playwright

Schermate acquisite durante l'analisi:

- `homun-chat-home.png`
- `homun-automations-overview.png`
- `homun-automation-builder.png`
- `homun-workflows.png`
- `homun-apps-overview.png`
- `homun-skills.png`
- `homun-mcp.png`
- `homun-agents.png`
- `homun-settings-providers.png`
- `homun-settings-channels.png`
- `homun-settings-browser.png`
- `homun-settings-health.png`

### Chat

La chat e' ora l'ingresso operativo principale. La home e' stata portata verso un modello task-first: il prompt resta centrale, i comandi rapidi sono discreti e `Tools` governa le modalita' operative piu' specifiche.

Rischio residuo demo: dopo la risposta dell'agente, alcune azioni successive sono ancora poco guidate. In particolare, dopo una creazione app o automazione servono CTA chiare come "apri", "modifica con chat", "crea automazione collegata" o "salva come demo".

### Automations

La sezione Automations ha una base molto forte:

- template;
- prompt in linguaggio naturale;
- builder visuale;
- palette con trigger, tool, skill, MCP, agent, transform, condition, parallel, loop, approval, 2FA e deliver.

Questa e' una feature da piattaforma, ma e' nascosta dietro una voce laterale tecnica.

Rischio demo: la potenza si capisce solo se qualcuno entra nel builder.

### Workflows

Workflows mostra metriche, storico esecuzioni, stati e restart/delete. E' utile per controllo operativo, ma viene percepito come log tecnico, non come "processi aziendali eseguiti".

Rischio demo: sembra monitor interno, non valore business.

### Apps

Apps mostra le app generate e i dettagli tecnici (`sqlite_per_app`, numero entita'). La feature e' forte, ma la pagina non spiega bene che l'app ha database isolato, utenti, CRUD, calendario, ruoli e link esterno.

Rischio demo: App Factory sembra una lista di oggetti, non una killer feature.

### Extensions: Skill, MCP, Agents

Extensions contiene una parte fondamentale del prodotto:

- Skills installate e catalogo skill;
- sandbox di esecuzione skill;
- MCP Servers con catalogo servizi, stati di connessione e numero tool;
- Agents con routing, classifier e agenti specializzati.

Questa area e' oggi corretta tecnicamente, ma comunica "configurazione". In ottica demo dovrebbe comunicare "capacita' disponibili".

Rischio demo: Homun ha skill, MCP e agenti, ma l'utente li scopre solo se sa dove cercare.

### Settings: Control Plane

Settings e' molto piu' ricco di una semplice pagina impostazioni:

- account, utenti web locali, gateway instances, channel identities, API keys e trusted devices;
- provider e model routing;
- canali Telegram, WhatsApp, Email, Web UI e canali futuri;
- browser/MCP Playwright con stato, modalita' headless, stealth e modelli;
- vault, approvals, file access, shell, sandbox, database, logs, request analysis, usage;
- System Health con modello attivo, uptime, canali, dati, memoria e knowledge.

Questo e' un vero control plane operativo. Va tenuto come area avanzata, ma alcuni segnali devono uscire in superficie.

Rischio demo: le capacita' enterprise ci sono, ma sembrano nascoste in una modalita' amministrativa.

## Direzione Prodotto

Homun deve presentarsi come:

> Operating layer agentico per piccoli team e single developer: capisce il lavoro, usa strumenti collegati, automatizza processi e crea mini-app aziendali.

Tre modalita' centrali:

1. **Lavora per me**
   Ricerca, browser, documenti, analisi, sintesi, azioni agentiche.

2. **Automatizza per me**
   Processi ricorrenti con trigger, skill, MCP, agent, approvazione, 2FA e canali.

3. **Costruisci per me**
   App interne con database isolato, utenti, CRUD, viste, workflow e bridge Homun.

Queste modalita' devono essere sostenute da una quarta superficie trasversale:

4. **Capacita' collegate**
   Skill, MCP, browser, canali, provider, agenti, vault, approvazioni e sandbox.

## Piano Di Intervento

### P0: Task Launcher In Chat — COMPLETATO

Obiettivo: rendere la home/chat meno generica e piu' task-first.

Stato:

- Shortcut principali presenti e puliti:
  - Crea app;
  - Ricerca;
  - Briefing;
  - Altro.
- `Tools` mantiene le azioni operative:
  - Create Skill;
  - Create Automation;
  - Create Workflow;
  - Browse Web;
  - MCP Servers.
- `Create Automation` non inserisce piu' solo testo: attiva una modalita' contestuale equivalente ad "Attivita programmata".
- `Strumenti collegati` mostra le capacita' connesse senza trasformarsi in una fascia sempre visibile.
- La modalita' automazione nasconde i suggerimenti generici e mostra solo suggerimenti di pianificazione.

Risultato:

- la chat non sembra piu' generica;
- l'utente ha ingressi semplici senza rumore;
- l'automazione e' accessibile dal posto giusto, cioe' `Tools`;
- la UX resta coerente con il confronto Manus, ma piu' orientata al lavoro aziendale.

Non riaprire ora:

- altri redesign della home chat;
- nuove card o shortcut nella home;
- ulteriori duplicazioni di "Attivita programmata" fuori da `Tools > Create Automation`.

### P0: Capability Strip / Readiness Nella Home — COMPLETATO COME MENU COMPATTO

Obiettivo: far vedere subito che Homun ha strumenti collegati e non e' solo una chat.

Stato:

- La fascia sempre visibile e' stata evitata per non affollare l'interfaccia.
- Le capacita' sono accessibili da `Strumenti collegati`, accanto a `Tools`.
- Il menu mostra 5 segnali:
  - Model ready;
  - Browser ready;
  - Channels active;
  - Skills available;
  - MCP tools connected.
- Ogni stato rimanda alla pagina o sezione corretta:
  - provider/settings;
  - browser settings;
  - channels;
  - skills;
  - MCP.

Risultato:

- le capacita' sono visibili su richiesta;
- la home resta piu' pulita;
- la demo puo' mostrare in un click che Homun usa modello, browser, canali, skill e MCP.

Perche' ora:

- e' gia' implementato come accesso leggero;
- rende visibili skill, MCP, gateway e browser senza trasformare la home in dashboard;
- aumenta la percezione di piattaforma senza sacrificare il prompt.

Non riaprire ora:

- rifare Settings;
- creare un marketplace completo;
- implementare health monitoring nuovo;
- rimettere una capability strip sempre visibile sotto il composer.

### P0: Automation Hero + Template Story

Obiettivo: far capire subito che le automazioni sono potenti.

Interventi:

- Nella pagina Automations aggiungere una fascia introduttiva sopra la lista:
  - titolo: "Automatizza processi con tool, skill, MCP e approvazioni"
  - sottotitolo: "Descrivi un processo ricorrente, Homun lo trasforma in workflow eseguibile."
  - CTA: "Describe automation"
- Migliorare le card template del builder:
  - Daily Email Digest
  - Web Monitor
  - Daily Standup
  - News Briefing
  - Security Check
  - File Organizer
- Aggiungere 3 prompt demo pronti:
  - "Ogni mattina controlla le email importanti, riassumi e invia su Telegram."
  - "Ogni giorno controlla un sito e avvisami se cambia."
  - "Ogni venerdi prepara un briefing e chiedi approvazione prima di inviarlo."

Perche' ora:

- Automation e' probabilmente piu' matura di quanto sembri;
- serve solo renderla vendibile.

Non fare ora:

- nuovo engine automation;
- nuovo canvas;
- nuovo sistema nodi.

### P0: App Factory Demo Hardening

Obiettivo: rendere "Crea app interna" una demo affidabile.

Interventi:

- Mantenere 3 prompt ufficiali:
  - prenotazione sale;
  - ticket interni;
  - ferie/permessi.
- Ogni prompt deve passare da `plan_internal_app`.
- Quando il planner restituisce `recommended_blueprint`, il modello deve usarlo senza riscriverlo.
- La pagina Apps deve mostrare badge business, non solo tecnici:
  - Database isolato
  - Utenti app-local
  - CRUD completo
  - Ruoli
  - Link pubblico
- In dettaglio app, mettere in alto:
  - "Open app"
  - "Manage users"
  - "Edit with chat"
  - "Delete"

Perche' ora:

- e' la demo differenziante;
- abbiamo appena reso CRUD e planning piu' credibili.

Non fare ora:

- generazione app generica perfetta;
- UI builder visuale per app;
- template app complessi.

### P1: Projects / Outputs Light

Obiettivo: dare l'idea che Homun produce risultati persistenti, non solo risposte chat.

Interventi:

- Senza creare un nuovo modello dati, rinominare o presentare meglio le sezioni:
  - Apps = Generated Apps
  - Automations = Process Automations
  - Workflows = Runs / Execution History
  - Brain = Memory & Knowledge
  - Extensions = Skills & Tools
- Aggiungere nella sidebar o nella chat una sezione "Recent outputs":
  - ultime app;
  - ultime automazioni;
  - ultimi workflow completati.

Perche' ora:

- aiuta il confronto con Manus, che ragiona per progetti/compiti;
- e' possibile farlo come UI aggregata leggera.

Non fare ora:

- progetto/tenant model completo;
- migrazione dati;
- permessi progetto.

### P1: Skills & Tools Come Catalogo Di Capacita'

Obiettivo: trasformare Extensions da area tecnica a catalogo comprensibile.

Interventi:

- Rinominare visivamente Extensions in "Skills & Tools" o "Capabilities".
- Nella pagina principale mostrare 4 gruppi:
  - Skills: competenze operative installate;
  - MCP Servers: servizi esterni collegabili;
  - Agents: operatori specializzati;
  - Browser: navigazione e azione su web.
- Per ogni card, mostrare:
  - stato;
  - numero tool/capacita';
  - dove viene usata: Chat, Automation, App Factory.
- Evidenziare `app-factory` come skill demo-critical.

Perche' ora:

- non richiede cambiare engine;
- rende chiaro il vantaggio su automazioni e app;
- aiuta a spiegare l'approccio generale simile a Manus, ma piu' aziendale.

Non fare ora:

- nuovo protocollo skill;
- nuovo sistema permessi MCP;
- installazione guidata complessa.

### P1: Gateway & Channels Come Asset Di Prodotto

Obiettivo: portare i canali fuori dalla sola configurazione.

Interventi:

- In Dashboard/Home o Automation mostrare un blocco "Delivery channels":
  - Web;
  - Telegram;
  - WhatsApp;
  - Email;
  - futuri Slack/Discord.
- Mostrare stato chiaro:
  - Active;
  - Needs attention;
  - Disabled.
- Collegare le automazioni al delivery:
  - "send to Telegram";
  - "send by Email";
  - "ask approval on Web".

Perche' ora:

- Homun ha un vantaggio forte sui canali;
- nelle demo aziendali il valore e' "fa arrivare il lavoro dove serve".

Non fare ora:

- riparare tutti i canali live se non servono alla demo;
- promettere canali non maturi.

### P1: Readiness Checklist Pre-Demo

Obiettivo: evitare che in presentazione emergano warning evitabili.

Checklist:

- modello attivo e funzionante;
- provider principale stabile;
- browser MCP attivo;
- almeno una skill demo-critical caricata (`app-factory`);
- MCP catalog visibile;
- Web UI healthy;
- Telegram healthy se usato in demo;
- WhatsApp o Email: o funzionanti, o nascosti dal percorso demo;
- App Factory con app sale e ticket pronte;
- una automazione gia' salvata e una run completata.

Perche' ora:

- System Health esiste gia';
- basta usarlo come checklist operativa prima della demo.

### P1: Demo Runbook

Obiettivo: ridurre rischio live.

Interventi:

- Creare una pagina o documento `docs/demo/presentation-runbook.md` con:
  - script narrativo;
  - prompt ufficiali;
  - fallback gia' creati;
  - checklist pre-demo;
  - cosa non mostrare live.
- Preparare fallback:
  - 1 automazione gia' funzionante;
  - 1 app sale gia' pronta;
  - 1 app ticket gia' pronta;
  - 1 workflow run con stato completed.

Perche' ora:

- con una settimana, la demo deve essere guidata;
- non bisogna improvvisare prompt troppo larghi.

### P2: Iteration Budget UX

Obiettivo: evitare che il sistema sembri rotto quando si ferma.

Interventi:

- Quando finisce il budget, mostrare un messaggio piu' operativo:
  - cosa e' stato fatto;
  - cosa manca;
  - bottone/prompt "Continua da qui";
  - se ci sono errori schema ripetuti, suggerire replanning.
- Per App Factory, dopo 2 errori blueprint simili, forzare planner/tool atomico.

Perche' non P0:

- importante, ma meno visibile se usiamo prompt demo controllati.

## Sequenza Dei 7 Giorni

### Giorno 1 — Fatto / Da bloccare

- Bloccare modifiche App Factory gia' fatte con build e commit.
- Home chat task-first completata e validata:
  - `Tools > Create Automation` apre la modalita' attivita' programmata;
  - `Strumenti collegati` resta un menu compatto;
  - shortcut generici sotto il composer restano puliti.
- Smoke test app sale end-to-end:
  - create app;
  - create users;
  - login employee;
  - create booking;
  - login admin;
  - edit/delete room o booking.

### Giorno 2 — Prossimo focus

- Non riaprire la home chat salvo bug.
- Rendere piu' vendibile Automation:
  - pagina Automations piu' chiara;
  - template story;
  - prompt demo controllati;
  - collegamento esplicito a skill, MCP, browser e canali.
- Preparare almeno una automazione demo gia' funzionante.

### Giorno 3

- App Factory demo hardening:
  - prompt ufficiali sale/ticket/ferie;
  - planner obbligatorio;
  - evitare errori blueprint da prompt troppo specifici;
  - CRUD sempre completo nelle app demo.
- Bloccare app ticket e prenotazione sale come fallback.

### Giorno 4

- Apps page polish:
  - badge business;
  - CTA chiare;
  - dettagli app meno tecnici.
- Skills & Tools / Capabilities polish:
  - rinominare/categorizzare Extensions;
  - rendere visibili MCP, skill, agents e browser come capacita'.

### Giorno 5

- Gateway/Channels readiness:
  - stati chiari;
  - nascondere o non usare in demo cio' che e' `Needs attention`;
  - collegare delivery channels al racconto Automation.
- Demo runbook.
- Fallback app/automation/workflow gia' pronti.

### Giorno 6

- Test demo completo registrato:
  - Chat task dalla home validata;
  - Automation;
  - App Factory.
- Correggere solo blocker.

### Giorno 7

- Build release.
- Pulizia finale UI/testi.
- Prova presentazione a tempo.

## Cosa Dire In Presentazione

Messaggio principale:

> Homun non e' un chatbot. E' un operating layer agentico: capisce compiti, usa strumenti collegati, automatizza processi e crea app interne.

Messaggio di differenziazione:

> Manus mostra un agente generalista. Homun punta al lavoro aziendale: canali, skill, MCP, automazioni, approvazioni, memoria, profili e app interne isolate.

Demo in tre atti:

1. **Task**
   "Preparami un briefing."

2. **Automation**
   "Fallo ogni mattina e mandamelo su Telegram."

3. **App**
   "Crea un'app per prenotare sale riunioni."

Prima dei tre atti, mostrare in 20 secondi il menu `Strumenti collegati`:

- modello attivo;
- browser disponibile;
- canali disponibili;
- skill e MCP disponibili.

## Cosa Non Dire

- Non competere con Manus su "facciamo tutto".
- Non vendere MCP come parola tecnica.
- Non mostrare troppe impostazioni.
- Non improvvisare app complesse fuori dai prompt preparati.
- Non presentare Automations come feature nascosta: va raccontata come pilastro.
- Non aprire Settings come prima cosa: usare Settings solo per dimostrare controllo quando serve.

## Definition Of Done

La settimana e' riuscita se:

- dalla chat si capiscono subito i lavori possibili;
- Automation comunica potenza senza entrare nel codice;
- Apps comunica valore business, non solo metadata;
- Skills, MCP, gateway, browser e provider sono visibili come capacita';
- System Health diventa una checklist pre-demo;
- App Factory crea una demo affidabile con sale/ticket;
- la presentazione ha una storia chiara in 10-15 minuti;
- esistono fallback pronti per ogni passaggio live.
