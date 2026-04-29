# Homun — Piano presentazione 10 giorni

> Data: 2026-04-29
> Obiettivo: arrivare a una demo credibile di Homun come piattaforma che genera strumenti interni aziendali tramite agenti, skills, MCP, workflow e componenti predefiniti.

---

## 1. Direzione prodotto

Homun non deve essere raccontato come una chat AI. Deve essere raccontato come una **piattaforma agentica per costruire e usare strumenti operativi interni**.

Il riferimento competitivo e narrativo resta Manus, ma Homun deve differenziarsi in modo netto:

- Manus comunica "AI che agisce" con browser, wide research, slides, app e integrazioni.
- Homun deve comunicare "AI che costruisce strumenti interni e poi li usa": app, workflow, automazioni, memoria, canali, MCP, skills e dati aziendali.
- Il target iniziale piu' forte e' il **single developer / founder tecnico / piccola azienda**: persone che hanno bisogno di tool interni ma non possono permettersi settimane di sviluppo per ogni processo.

One-liner:

> Homun trasforma una richiesta aziendale in un tool interno funzionante, con dati, interfaccia, workflow, automazioni e agente operativo.

### Stato implementazione al 2026-04-29

La prima v0 della Tool/App Factory e' stata implementata come demo tecnica:

- blueprint schema e validatore;
- storage isolato per singola app con SQLite dedicato;
- control plane in `homun.db`;
- API interne per app, record e azioni;
- strumenti agente per creare app, creare/query record e lanciare workflow action;
- UI `/apps` e `/apps/{slug}`;
- skill `app-factory`;
- blueprint e runbook demo ferie/permessi.

Restano da trattare come rischi demo:

- generazione live LLM non deterministica: usare il blueprint pre-seed come fallback;
- smoke test manuale da ripetere sul binario release prima della presentazione;
- polish UI sufficiente per demo, non ancora builder completo;
- notification e automation da blueprint sono narrativa/roadmap, non P0 operativo;
- ruoli granulari multiutente restano post-demo, mentre la v0 usa ownership e scope utente/profilo.

---

## 2. Killer feature: Tool/App Factory

La killer feature proposta e' la **Tool/App Factory**.

Flusso ideale:

1. L'utente descrive un processo aziendale in linguaggio naturale.
2. Homun produce un blueprint strutturato.
3. Il runtime compone componenti predefiniti.
4. Homun crea database, viste, form, workflow e permessi.
5. L'utente riceve un link interno all'app.
6. L'agente puo' usare quell'app via chat/canali/automazioni.

Esempio:

```text
Mi serve un'applicazione interna per gestire ferie e permessi dei dipendenti.
I dipendenti devono inviare richieste, il responsabile deve approvare o rifiutare,
e voglio vedere un calendario/registro delle assenze.
```

Risultato atteso:

- app interna `Ferie e Permessi`;
- schema dati per dipendenti, richieste, stati, note;
- form richiesta ferie;
- tabella richieste con filtri;
- vista approvazione;
- workflow approva/rifiuta;
- notifiche opzionali;
- link interno tipo `/apps/ferie-permessi`;
- interazione agentica: "quante ferie ha richiesto Mario questo mese?"

---

## 3. Principio architetturale: blueprint sempre, codice libero solo dopo

Il blueprint non deve essere una scorciatoia da demo. Deve essere la base stabile del prodotto.

### Regola

Homun non genera applicazioni interne scrivendo codice arbitrario a ogni richiesta. Homun genera un **blueprint dichiarativo** che il sistema interpreta usando componenti approvati.

Questo approccio permette:

- sicurezza migliore;
- UI coerente;
- permessi controllabili;
- migrazioni prevedibili;
- test piu' semplici;
- estensione graduale verso app sempre piu' complesse.

### Componenti blueprint v0

Per la prima versione servono pochi mattoni, ma solidi:

- `App`: nome, slug, descrizione, icona.
- `Entity`: tabella/dataset.
- `Field`: stringa, testo, numero, data, enum, relazione, boolean.
- `View`: lista, dettaglio, form.
- `Action`: crea, aggiorna, approva, rifiuta, archivia.
- `Workflow`: stati e transizioni.
- `Role`: owner, admin, requester, approver.
- `Notification`: evento + canale.
- `Automation`: trigger manuale, schedulato o su cambio stato.
- `AgentCommand`: query/azioni che l'agente puo' fare sull'app.

### Componenti futuri

La stessa struttura potra' crescere con:

- dashboard e grafici;
- calendari;
- kanban;
- allegati;
- firme/approvazioni avanzate;
- import/export CSV;
- connessioni MCP;
- sync con Google Workspace, Notion, GitHub, Slack, email;
- template verticali.

---

## 4. Cosa Homun ha gia' e va valorizzato

Homun oggi ha piu' superficie prodotto di una semplice web chat:

- skills;
- MCP e tool discovery;
- browser tool;
- automazioni;
- workflow;
- memoria e knowledge;
- vault;
- profili e multiutente;
- contatti;
- gateway web/Telegram/WhatsApp/email;
- app mobile/parziale gia' collegata al sistema;
- UI web admin;
- file/artifact flow;
- cron/scheduler;
- sandbox e controlli di sicurezza.

La Tool/App Factory deve usare questi pezzi, non sostituirli.

Esempio: un'app ferie non e' solo CRUD. Puo' usare:

- workflow per approvazioni;
- automation per reminder;
- email/Telegram per notifiche;
- memory per preferenze aziendali;
- MCP per calendario;
- skills per generare template;
- knowledge per policy aziendale;
- vault per credenziali integrazioni.

---

## 5. Rapporto con Manus

Fonti osservate:

- Homepage Manus: https://manus.im/
- Browser Operator: https://manus.im/features/manus-browser-operator
- Wide Research: https://manus.im/features/wide-research
- Team/API: https://manus.im/team e https://open.manus.ai/docs

### Cosa adottare

1. **AI che agisce**
   - Homun deve mostrare piani, tool usati, stati e risultati, non solo risposte.

2. **Output finito**
   - Ogni demo deve terminare con qualcosa di usabile: app interna, report, workflow, link, artifact.

3. **Business readiness**
   - Utenti, profili, permessi, canali e audit devono essere visibili.

4. **Composizione rapida**
   - Manus vende creazione di slide/siti/app. Homun deve vendere creazione di tool interni.

### Cosa evitare ora

- Promettere generazione universale di qualsiasi software.
- Far scrivere codice libero senza guardrail.
- Puntare su cloud browser massivo.
- Inseguire SSO/team enterprise prima della demo.
- Creare un builder visuale drag-and-drop: il builder deve essere invisibile e agentico.

---

## 6. Demo principale

### Titolo demo

**Da prompt ad applicazione interna: gestione ferie e permessi**

### Script demo

1. Login come Fabio/admin.
2. Mostrare scope utente/profilo.
3. Aprire chat.
4. Prompt:

```text
Crea un'app interna per gestire ferie e permessi.
I dipendenti devono poter inviare richieste indicando tipo, date e note.
Un responsabile deve approvare o rifiutare.
Voglio una lista delle richieste, un dettaglio, stati chiari e una notifica quando una richiesta viene approvata.
```

5. Homun genera un blueprint.
6. Homun mostra un riepilogo: entita', viste, workflow, ruoli.
7. Homun crea l'app.
8. Appare link interno: `Apri Ferie e Permessi`.
9. Aprire l'app:
   - form richiesta;
   - lista richieste;
   - dettaglio;
   - azioni approva/rifiuta.
10. Creare una richiesta demo.
11. Approvare la richiesta.
12. Mostrare che Homun puo' interrogare l'app:

```text
Quante richieste ferie sono state approvate questa settimana?
```

13. Switch a user2 o profilo diverso per mostrare isolamento/scope se serve.

### Perche' funziona come demo

- E' concreta.
- Parla a ogni azienda.
- Mostra generazione di valore, non solo conversazione.
- Usa componenti interni controllati.
- Apre una roadmap ampia senza promettere magia incontrollata.

---

## 7. Demo secondaria

### "L'agente usa il tool appena creato"

Dopo la creazione dell'app ferie:

1. Inviare un messaggio via chat o canale:

```text
Segna una richiesta ferie per Mario Rossi dal 10 al 12 maggio e lasciala in attesa di approvazione.
```

2. Homun usa l'app generata.
3. La richiesta compare nella UI.
4. Il responsabile approva.
5. Homun conferma e registra l'evento.

Questo dimostra il punto chiave: Homun non solo genera strumenti, li puo' anche usare.

---

## 8. Demo fallback

Se la generazione live e' instabile, usare un blueprint pre-seed gia' pronto:

1. Mostrare il prompt.
2. Mostrare il blueprint generato/caricato.
3. Aprire l'app gia' creata.
4. Creare/approvare una richiesta.
5. Far interrogare l'app dall'agente.

Fallback accettabile:

- non fingere che sia tutto generato live se non lo e';
- spiegare che il runtime blueprint e' il pezzo core;
- mostrare che il modello puo' produrre/modificare blueprint.

---

## 9. Roadmap operativa 10 giorni

### Giorno 1 — Specifica Tool/App Factory v0

Obiettivo: fissare schema blueprint e limiti della v0.

Stato: completato.

Interventi:

- Definire JSON/YAML blueprint v0.
- Definire componenti supportati.
- Definire cosa non e' supportato.
- Definire app demo ferie/permessi come blueprint di riferimento.
- Decidere storage: tabelle generiche vs tabelle dedicate.

Definition of Done:

- Documento tecnico blueprint v0.
- Esempio completo ferie/permessi.

### Giorno 2 — Runtime blueprint minimo

Obiettivo: renderizzare una app da blueprint.

Stato: completato per table/form/detail generici e storage record per-app.

Interventi:

- Registry app interne.
- Loader blueprint.
- Route interna `/apps/{slug}`.
- Renderer liste/form/dettaglio.
- Storage record generico.

Definition of Done:

- Una app statica da blueprint si apre e salva record.

### Giorno 3 — Workflow e azioni

Obiettivo: supportare stati e transizioni.

Stato: completato per transizioni locali `approved/rejected` e audit/eventi.

Interventi:

- Stato record.
- Azioni approva/rifiuta.
- Validazioni minime.
- Audit eventi.

Definition of Done:

- La richiesta ferie passa da `pending` a `approved/rejected`.

### Giorno 4 — Generazione blueprint via agente

Obiettivo: passare da prompt a blueprint controllato.

Stato: completato come skill `app-factory` + tool `create_internal_app`; la preview esplicita e' migliorabile.

Interventi:

- Skill/prompt specializzato `app-factory`.
- Validatore schema.
- Preview blueprint prima della creazione.
- Salvataggio app.

Definition of Done:

- Il prompt ferie produce un blueprint valido o una proposta modificabile.

### Giorno 5 — AgentCommand e interrogazione app

Obiettivo: Homun deve usare l'app generata.

Stato: completato per tool runtime `create_app_record`, `query_app_records`, `run_app_action`.

Interventi:

- Tool per leggere/scrivere record app.
- Query semplici sui record.
- Prompt guidance: usare app generata quando pertinente.

Definition of Done:

- "Quante richieste approvate?" restituisce risposta corretta.
- "Crea richiesta per Mario" crea record nell'app.

### Giorno 6 — UI polish demo

Obiettivo: rendere la demo presentabile.

Stato: implementato a livello demo; resta da fare verifica visiva finale su release gateway.

Interventi:

- Empty state app.
- Form e tabella coerenti con UI Homun.
- Link app dalla chat.
- Card "App created".
- Messaggi di errore chiari.

Definition of Done:

- Screenshot dell'app ferie presentabile.

### Giorno 7 — Seed demo e runbook

Obiettivo: demo ripetibile.

Stato: completato con [runbook demo](demo/app-factory-runbook.md) e [blueprint pre-seed](demo/blueprints/ferie-permessi.json).

Interventi:

- Seed utenti/profili.
- Seed app ferie.
- Seed dipendenti/richieste.
- Prompt live e fallback.
- Script demo 5-7 minuti.

Definition of Done:

- Demo eseguibile da stato pulito.

### Giorno 8 — Presentazione

Obiettivo: costruire deck e narrativa.

Struttura deck:

1. Problema: ogni azienda ha processi interni non coperti da software standard.
2. Soluzione: descrivi il processo, Homun crea il tool.
3. Architettura: agent + blueprint + componenti + skills/MCP/workflow.
4. Demo ferie/permessi.
5. Differenza da Manus e dai no-code builder.
6. Roadmap.
7. Ask.

Definition of Done:

- Deck draft.
- Script parlato.

### Giorno 9 — Hardening e freeze feature

Obiettivo: solo bugfix demo.

Interventi:

- Smoke test app factory.
- Smoke test multiutente.
- Smoke test build release.
- Fix solo blocker.

Definition of Done:

- Build release finale.
- Stato git pulito.

### Giorno 10 — Prova finale

Obiettivo: delivery.

Checklist:

- Demo ripetuta almeno 3 volte.
- Deck esportato.
- Prompt salvati.
- Backup blueprint pronto.
- Screenshot/video breve opzionale.
- Piano B documentato.

---

## 10. Backlog prioritizzato

### P0 — Necessario per presentazione

- Blueprint schema v0. **Completato.**
- Runtime app da blueprint. **Completato per CRUD generico e workflow semplice.**
- App ferie/permessi. **Completato come blueprint pre-seed e demo target.**
- Workflow approve/reject. **Completato.**
- Tool/agent command per leggere e scrivere record app. **Completato.**
- Link interno app dalla chat. **Completato nel risultato dei tool; da verificare nel flusso live.**
- Demo seed/runbook. **Completato.**
- Deck presentazione.

P0 residuo:

- completare deck e script parlato;
- eseguire smoke test manuale su release gateway;
- registrare eventuale video/screenshot fallback;
- congelare feature e correggere solo blocker.

### P1 — Molto utile se resta tempo

- Mission Pack UX in chat.
- Quick actions "Crea tool interno".
- Follow-up suggestions.
- Notifiche via canale su cambio stato.
- Import CSV dipendenti.
- Mini libreria app create.

### P2 — Post presentazione

- Builder visuale opzionale.
- Componenti avanzati: calendario, kanban, grafici, allegati.
- Template marketplace interno.
- Permessi enterprise dettagliati.
- SSO.
- App factory con MCP esterni.
- Versioning/migrazioni blueprint.
- Test generator automatico per blueprint.

---

## 11. Blueprint v0 — esempio ferie/permessi

```json
{
  "app": {
    "slug": "ferie-permessi",
    "name": "Ferie e Permessi",
    "description": "Gestione richieste ferie e permessi dei dipendenti",
    "icon": "calendar"
  },
  "entities": [
    {
      "name": "employee",
      "label": "Dipendente",
      "fields": [
        { "name": "full_name", "type": "string", "label": "Nome completo", "required": true },
        { "name": "email", "type": "string", "label": "Email" },
        { "name": "team", "type": "string", "label": "Team" }
      ]
    },
    {
      "name": "leave_request",
      "label": "Richiesta",
      "fields": [
        { "name": "employee", "type": "relation", "to": "employee", "label": "Dipendente", "required": true },
        { "name": "kind", "type": "enum", "label": "Tipo", "options": ["ferie", "permesso", "malattia"], "required": true },
        { "name": "start_date", "type": "date", "label": "Dal", "required": true },
        { "name": "end_date", "type": "date", "label": "Al", "required": true },
        { "name": "notes", "type": "text", "label": "Note" },
        { "name": "status", "type": "enum", "label": "Stato", "options": ["pending", "approved", "rejected"], "default": "pending" }
      ]
    }
  ],
  "views": [
    { "type": "table", "entity": "leave_request", "name": "Richieste", "columns": ["employee", "kind", "start_date", "end_date", "status"] },
    { "type": "form", "entity": "leave_request", "name": "Nuova richiesta" },
    { "type": "detail", "entity": "leave_request", "name": "Dettaglio richiesta" }
  ],
  "workflows": [
    {
      "entity": "leave_request",
      "states": ["pending", "approved", "rejected"],
      "transitions": [
        { "name": "approve", "from": "pending", "to": "approved", "label": "Approva" },
        { "name": "reject", "from": "pending", "to": "rejected", "label": "Rifiuta" }
      ]
    }
  ],
  "agent_commands": [
    { "intent": "create_leave_request", "entity": "leave_request", "action": "create" },
    { "intent": "count_approved_leave_requests", "entity": "leave_request", "action": "query" }
  ]
}
```

---

## 12. Prompt demo

### Creazione app

```text
Crea un'app interna per gestire ferie e permessi.
I dipendenti devono poter inviare richieste indicando tipo, date e note.
Un responsabile deve approvare o rifiutare.
Voglio una lista delle richieste, un dettaglio, stati chiari e una notifica quando una richiesta viene approvata.
```

### Uso app generata

```text
Crea una richiesta ferie per Mario Rossi dal 10 al 12 maggio, con nota "vacanza famiglia", e lasciala in attesa di approvazione.
```

### Query app generata

```text
Quante richieste ferie sono state approvate questa settimana?
```

### Isolamento utente

```text
Quali app interne e quali richieste ferie sono disponibili per questo profilo?
```

Atteso:

- Fabio vede app e dati Fabio.
- user2 non vede app e dati Fabio.

---

## 13. Decisione operativa proposta

Partire subito da:

1. Specifica tecnica Blueprint v0.
2. Runtime minimo app da blueprint.
3. Demo ferie/permessi.

Mission Pack resta utile, ma diventa supporto UX. La vera feature da presentare e costruire e' la Tool/App Factory basata su blueprint componibili.
