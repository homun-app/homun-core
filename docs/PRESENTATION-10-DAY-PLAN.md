# Homun — Piano presentazione 10 giorni

> Data: 2026-04-29
> Obiettivo: arrivare a una demo credibile per presentare Homun come agente operativo per aziende piccole, team tecnici e single developer.

---

## 1. Obiettivo di prodotto

Homun non deve presentarsi come una chat AI generica. Deve presentarsi come un **agent operativo personale/aziendale** che riceve un obiettivo, usa strumenti reali, mantiene memoria e produce un risultato verificabile.

Il riferimento competitivo e narrativo e' Manus, ma con una visione diversa:

- Manus punta su agente generalista, cloud, browser operator, wide research, slides, mail/slack e team plan.
- Homun deve puntare su **controllo locale/self-hosted**, canali reali, memoria proprietaria, profili/utenti, strumenti MCP e automazioni.
- Target iniziale consigliato: **single developer, founder tecnico, piccola azienda con workflow ripetitivi**.

Messaggio sintetico:

> Homun e' un agente operativo self-hosted per trasformare messaggi, dati e strumenti aziendali in azioni verificabili.

---

## 2. Cosa copiare da Manus, cosa no

Fonti osservate:

- Homepage Manus: https://manus.im/
- Browser Operator: https://manus.im/features/manus-browser-operator
- Wide Research: https://manus.im/features/wide-research
- Team/API: https://manus.im/team e https://open.manus.ai/docs

### Pattern da adottare

1. **Task, non chat**
   - Manus comunica "What can I do for you?" e propone azioni come creare slide, siti, app e design.
   - Homun dovrebbe trasformare la chat in "missioni": obiettivo, piano, azioni, risultato, artefatti.

2. **Agente che opera**
   - Browser Operator vende autonomia: pianifica, naviga, clicca, compila form, usa sessioni locali.
   - Homun ha gia' browser/MCP/tools: serve renderlo visibile e dimostrabile.

3. **Ricerca su scala**
   - Wide Research vende parallelismo, contesto fresco per ogni item e report finale.
   - Homun puo' proporre una versione piu' piccola: "company/developer research pack" con browser + knowledge + artifact.

4. **Output finito**
   - Manus enfatizza report, dataset, presentazioni, app, risultati pronti.
   - Homun deve mostrare file, report, checklist, decisioni, follow-up e fonti.

5. **Business/team readiness**
   - Manus ha team plan, SSO, Slack, API.
   - Homun per la demo deve mostrare almeno multiutente/profili, isolamento dati, canali e controllo admin.

### Pattern da non copiare ora

- Billing a crediti.
- Cloud browser su larga scala.
- Marketplace pubblico.
- SSO enterprise completo.
- Multi-agent massivo tipo Wide Research a centinaia di agenti.
- Mobile app come asse principale della demo.

---

## 3. Stato Homun oggi

### Punti forti gia' dimostrabili

- Web UI con chat, memory, knowledge, contacts, profiles, settings.
- Gateway canali: web, Telegram, WhatsApp, email, cron.
- Tool registry: shell, file, web search/fetch, vault, contacts, automation, knowledge, browser/MCP.
- Memoria e brain per user/profilo.
- Knowledge e memory scoping per user/profilo.
- Vault scoped per user/profilo.
- Contacts scoped per user.
- UI scope indicator per utente/profilo.
- Build release pulita e workflow di test manuale gia' in uso.

### Rischi residui

- Audit multiutente non ancora completo su tutte le API.
- Chat conversations, uploads/files e workspace possono ancora avere residui globali.
- UX ancora piu' da pannello admin che da "agent mission control".
- Demo browser/MCP da rendere robusta e prevedibile.
- Presentazione non ancora costruita.
- Mancano script/demo seed per partire sempre da uno stato controllato.

---

## 4. Strategia dei prossimi 10 giorni

La priorita' non e' "rendere tutto perfetto". La priorita' e':

1. Stabilizzare il percorso demo.
2. Implementare una nuova feature piccola ma visibile.
3. Raccontare Homun come prodotto coerente.
4. Preparare backup/fallback se qualcosa live fallisce.

### Feature nuova consigliata: Mission Pack

Una "Missione" e' una vista/struttura leggera sopra la chat:

- titolo missione;
- obiettivo;
- piano;
- step eseguiti;
- strumenti usati;
- output finale;
- artefatti prodotti;
- follow-up consigliati.

Non serve creare subito un nuovo sistema complesso di workflow. Per la demo basta partire da una implementazione pragmatica:

- migliorare rendering dei task step/tool timeline;
- aggiungere una card finale "Mission completed";
- salvare o mostrare un report finale come artifact;
- aggiungere quick actions da chat vuota per lanciare missioni demo.

Questa feature e' coerente con Manus, ma in Homun diventa piu' business/dev oriented.

---

## 5. Demo consigliata

### Demo principale: "AI Ops assistant per single developer"

Scenario:

> Un founder tecnico deve analizzare un possibile cliente/competitor, produrre un mini-brief operativo, salvarlo in knowledge/memory e preparare un follow-up.

Flusso demo:

1. Login come Fabio.
2. Mostrare topbar con scope `Fabio / Default`.
3. Aprire chat con quick action "Research company".
4. Prompt:

```text
Prepara un brief operativo su un potenziale cliente B2B: cerca informazioni pubbliche, sintetizza cosa fa, identifica 3 opportunita' per vendergli un agente operativo, prepara un messaggio email di primo contatto e salva il brief in knowledge.
```

5. Homun mostra piano e tool timeline.
6. Usa browser/web/search/knowledge/file.
7. Produce:
   - executive summary;
   - opportunita';
   - rischi;
   - messaggio email;
   - artifact markdown scaricabile o visibile.
8. Salvare una nota in memory:

```text
ricorda che per questo cliente vogliamo proporre Homun come agente operativo per founder tecnici
```

9. Switch a user2.
10. Mostrare che user2 non vede memory/contacts/knowledge di Fabio.
11. Tornare a Fabio e mostrare che il brief resta disponibile.

### Demo secondaria: "Canale operativo"

Se Telegram/WhatsApp sono stabili:

1. Mandare un messaggio da Telegram.
2. Homun riconosce il contatto.
3. Risponde usando profilo/memoria.
4. Mostrare che il web admin registra/scope correttamente.

### Demo fallback

Se browser/live web fallisce:

- usare una knowledge source gia' caricata;
- chiedere a Homun di analizzarla;
- generare report e follow-up;
- mostrare memory/profili/isolamento.

---

## 6. Roadmap operativa giorno per giorno

### Giorno 1 — Audit multiutente residuo

Obiettivo: chiudere le aree dove i dati possono ancora essere globali.

Interventi:

- Audit `chat conversations`.
- Audit `uploads/files/workspace`.
- Audit `automations`.
- Audit `sessions/devices/account`.
- Scrivere test minimi per user isolation dove mancano.

Definition of Done:

- Documento breve con API audited.
- Fix dei blocker scoperti.
- Build release passata.

### Giorno 2 — Mission Pack v0

Obiettivo: rendere la chat piu' simile a un task operativo.

Interventi:

- Migliorare empty state con quick actions business/dev.
- Migliorare timeline tool/steps.
- Aggiungere card "Mission completed" quando il task finisce con tool usage.
- Aggiungere follow-up suggestions statiche o derivate dalla risposta.

Definition of Done:

- La chat racconta visivamente "sto lavorando su una missione".
- Nessun cambio architetturale pesante.

### Giorno 3 — Artifact/report flow

Obiettivo: ogni demo deve concludersi con un output tangibile.

Interventi:

- Standardizzare output markdown/report.
- Rendere visibile file generato nella chat.
- Aggiungere eventuale sezione "Artifacts" o riusare file preview.
- Preparare template di report demo.

Definition of Done:

- Il demo produce un file/report apribile.

### Giorno 4 — Demo seed e script

Obiettivo: demo ripetibile.

Interventi:

- Preparare utenti `fabio` e `user2`.
- Preparare profili default.
- Preparare knowledge source controllate.
- Preparare contatti demo.
- Preparare prompt demo e prompt fallback.

Definition of Done:

- Runbook demo eseguibile senza improvvisare.

### Giorno 5 — Stabilizzazione browser/MCP/tools

Obiettivo: evitare fallimenti live.

Interventi:

- Smoke test browser tool.
- Smoke test web search/fetch.
- Smoke test file/artifact.
- Smoke test memory/knowledge/vault.
- Migliorare messaggi d'errore nei punti piu' visibili.

Definition of Done:

- Lista dei rischi live con workaround.

### Giorno 6 — UI polish mirato

Obiettivo: migliorare percezione prodotto senza redesign.

Interventi:

- Chat empty state.
- Tool timeline.
- Completion/follow-up.
- Scope indicators.
- Knowledge/memory visual clarity.

Definition of Done:

- Screenshot demo presentabile.

### Giorno 7 — Presentazione

Obiettivo: creare deck e narrativa.

Struttura deck:

1. Problema: le aziende piccole hanno troppi strumenti e poco tempo operativo.
2. Insight: non serve un'altra chat, serve un agente che agisce.
3. Homun: agente operativo self-hosted con canali, memoria, tool e automazioni.
4. Differenza da Manus: controllo locale, dati proprietari, canali reali, adattabile al team.
5. Demo scenario.
6. Architettura ad alto livello.
7. Roadmap prodotto.
8. Ask: cosa serve per proseguire.

Definition of Done:

- Deck draft pronto.
- Script parlato di 5-7 minuti.

### Giorno 8 — Prova demo integrale

Obiettivo: provare come se fosse il giorno della presentazione.

Interventi:

- Prova con cronometro.
- Annotare tutti gli intoppi.
- Creare piano B per ogni intoppo.
- Bloccare nuove feature non essenziali.

Definition of Done:

- Demo ripetuta almeno 3 volte.

### Giorno 9 — Fix solo blocker

Obiettivo: non introdurre instabilita'.

Regola:

- Solo bug che rompono demo o sicurezza percepita.
- Niente refactor.
- Niente feature nuove.

Definition of Done:

- Release build finale.
- Stato git pulito.

### Giorno 10 — Freeze e delivery

Obiettivo: materiale pronto.

Checklist:

- Build release.
- Database demo controllato.
- Script demo stampato.
- Deck esportato.
- Prompt demo salvati.
- Fallback offline pronto.
- Screenshot/video breve opzionale.

---

## 7. Backlog prioritizzato

### P0 — Necessario per presentazione

- Audit multiutente residuo su chat/uploads/automations.
- Mission Pack v0 in chat.
- Artifact/report finale.
- Demo seed e runbook.
- Deck presentazione.
- Smoke test completo.

### P1 — Molto utile se resta tempo

- Quick actions in home/chat.
- Follow-up suggestions.
- Libreria artefatti minimale.
- Migliore pagina Knowledge per distinguere input knowledge vs output artifacts.
- Script di reset demo.

### P2 — Post presentazione

- SSO/team completo.
- Workspace per organizzazione.
- Permission model enterprise.
- Billing/licensing.
- Parallel research multi-agent vero.
- Browser operator extension dedicata.
- API pubblica stabile.

---

## 8. Posizionamento consigliato

### One-liner

Homun e' un agente operativo self-hosted per aziende piccole e founder tecnici: capisce un obiettivo, usa strumenti reali, mantiene memoria e consegna risultati verificabili.

### Differenziatori

- Self-hosted/local-first.
- Multi-canale: web, Telegram, WhatsApp, email.
- Memoria e knowledge proprietarie.
- Vault e profili per separare contesti.
- MCP/tools per collegarsi agli strumenti aziendali.
- Automazioni e cron.
- Pensato per single developer e piccoli team, non solo enterprise.

### Cosa non promettere ancora

- Autonomia perfetta su qualsiasi sito.
- Multi-agent su larga scala.
- Enterprise SSO completo.
- Zero configurazione.
- Sicurezza enterprise certificata.

---

## 9. Prompt demo

### Prompt demo principale

```text
Agisci come mio agente operativo. Devo valutare un potenziale cliente B2B per Homun.
Cerca informazioni pubbliche sull'azienda, sintetizza cosa fa, identifica 3 opportunita' concrete per proporre un agente operativo, prepara un messaggio email di primo contatto e genera un brief markdown finale.
```

### Prompt demo con knowledge gia' caricata

```text
Usa la knowledge disponibile per preparare un brief operativo: contesto, opportunita', rischi, prossima azione e bozza email. Alla fine produci un report markdown.
```

### Prompt demo isolamento utente

```text
Cosa sai in memory.md e quali documenti knowledge sono disponibili per questo profilo?
```

Atteso:

- Fabio vede dati Fabio.
- user2 non vede dati Fabio.

---

## 10. Decisione operativa proposta

Partire subito da:

1. Audit multiutente residuo.
2. Mission Pack v0.
3. Demo seed/runbook.

Questi tre elementi aumentano la credibilita' piu' di qualsiasi feature profonda aggiunta in modo isolato.

