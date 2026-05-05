# Homun — Enterprise Pitch Deck

## 1. Homun

**AI Operating System per processi aziendali**

Homun e' una piattaforma per portare agenti AI, automazioni, app interne, canali, integrazioni e governance dentro i flussi operativi dell'azienda.

**Messaggio chiave**

Non un'altra chat AI, ma un livello operativo che collega persone, dati, strumenti e processi.

**Visual**

Screenshot dashboard o collage: chat, automazioni, app interne, canali.

---

## 2. Il problema

L'AI in azienda oggi entra spesso in modo frammentato:

- chatbot separati dai processi;
- automazioni isolate;
- knowledge base non governate;
- workflow e strumenti scollegati;
- sicurezza e permessi difficili da controllare;
- poca integrazione con i canali dove le persone lavorano davvero.

**Messaggio chiave**

L'AI aiuta singoli task, ma raramente diventa parte del sistema operativo aziendale.

**Visual**

Diagramma con blocchi separati: chat, documenti, ticket, email, automazioni, CRM/ERP.

---

## 3. La visione

La prossima fase dell'AI aziendale non sara' solo conversazionale.

Sara' un layer operativo capace di:

- capire richieste e contesto;
- accedere solo ai dati autorizzati;
- usare strumenti e integrazioni;
- eseguire workflow;
- generare app interne;
- automatizzare processi;
- mantenere controllo, audit e sicurezza.

**Messaggio chiave**

Homun porta l'AI dentro i flussi, non fuori dai flussi.

**Visual**

Freccia: richiesta business -> agente -> strumenti/dati -> workflow/app/report.

---

## 4. Cos'e' Homun

Homun e' una piattaforma AI enterprise self-hostable/local-first che combina:

- agent runtime;
- utenti e profili;
- canali di comunicazione;
- memoria e knowledge base;
- strumenti e automazioni;
- workflow con approvazioni;
- App Factory;
- skills, plugin e integrazioni MCP;
- dashboard web e API.

**Messaggio chiave**

Homun e' un control plane AI per processi aziendali.

**Visual**

Schema a livelli: interfacce, governance, agenti, strumenti, dati, processi.

---

## 5. Come funziona

Flusso operativo:

1. Un utente interagisce da dashboard, canale o API.
2. Homun riconosce identita', profilo, perimetro e permessi.
3. L'agente interpreta richiesta, contesto e vincoli.
4. Usa knowledge, memoria, tool, skills e integrazioni MCP autorizzate.
5. Esegue azioni, workflow, automazioni o app interne.
6. Il sistema mantiene audit, policy e controlli.

**Messaggio chiave**

Ogni azione AI passa da identita', contesto e governance.

**Visual**

Pipeline: canale -> identita/profilo -> agente -> permessi -> tool/knowledge/MCP -> output.

---

## 6. Canali e accesso

Homun puo' essere usato dove le persone gia' lavorano:

- Web dashboard;
- Telegram;
- WhatsApp;
- Slack;
- Discord;
- Email;
- CLI;
- API compatibile OpenAI.

**Messaggio chiave**

L'azienda non deve spostare tutto in una nuova interfaccia: Homun si innesta nei canali esistenti.

**Visual**

Icone canali intorno al core Homun.

---

## 7. Sicurezza e governance

Homun nasce con una logica enterprise:

- utenti, profili e perimetri;
- pairing dei canali;
- trusted devices;
- token API con scope;
- vault cifrato AES-256-GCM;
- 2FA;
- CSRF e rate limiting;
- sandbox per esecuzione strumenti;
- approval gates;
- audit log;
- trust boundaries;
- labeling dei contenuti non fidati;
- protezione da prompt injection.

**Messaggio chiave**

L'agente non e' libero di fare tutto: opera dentro confini espliciti.

**Visual**

Tre livelli: trusted, authenticated, untrusted.

---

## 8. Automazioni e workflow

Homun non si limita a rispondere: puo' eseguire processi nel tempo.

Capacita' gia' previste o implementate:

- cron e automazioni pianificate;
- heartbeat e follow-up;
- workflow multi-step;
- approval gates;
- retry e resume-on-boot;
- notifiche su canali;
- automazioni visuali;
- trigger su eventi.

**Messaggio chiave**

L'AI diventa un motore operativo, non solo un'interfaccia conversazionale.

**Visual**

Workflow: richiesta -> controllo -> approvazione -> azione -> notifica -> report.

---

## 9. App Factory

La App Factory permette di trasformare una richiesta business in un'app interna.

Esempio:

> "Crea un'app per gestire ferie e permessi, con richieste dei dipendenti, approvazione del responsabile e storico."

Homun puo':

- analizzare dominio, utenti, dati e workflow;
- fare domande quando una scelta impatta la struttura;
- generare un blueprint validato;
- creare UI, storage, ruoli e azioni;
- rendere l'app usabile sia da web sia dall'agente.

**Messaggio chiave**

Le app interne diventano componibili, governate e generate a partire dai processi.

**Visual**

Prompt -> planning -> blueprint -> app funzionante.

---

## 10. Skills, plugin e MCP

Homun e' estendibile senza riscrivere il core.

Può aggiungere capacita' tramite:

- skills operative;
- plugin;
- server MCP;
- connection recipes;
- integrazioni OAuth/API key;
- tool condivisi con permessi granulari.

Esempi di servizi integrabili:

GitHub, Google Workspace, Notion, Slack, Jira, Linear, GitLab, Stripe, Reddit, Spotify, Todoist, Home Assistant.

**Messaggio chiave**

La piattaforma resta stabile; le capacita' cambiano in base al settore, al cliente e al processo.

**Visual**

Core Homun + marketplace/connector layer.

---

## 11. Verticalizzazione

Homun puo' essere adattato a settori e funzioni diverse:

- HR: ferie, onboarding, policy, richieste interne;
- Operations: ticket, procedure, monitoraggio, report;
- Finance: approvazioni, rendicontazione, controlli;
- Legal: documenti, scadenze, knowledge riservata;
- Customer support: knowledge, routing, follow-up;
- Manufacturing: procedure, checklist, anomalie, manutenzione;
- Consulenza: workspace cliente, deliverable, analisi.

**Messaggio chiave**

La verticalizzazione avviene componendo app, workflow, dati, skills e integrazioni.

**Visual**

Stesso core centrale, verticali intorno.

---

## 12. Stato attuale e roadmap

Homun oggi dispone gia' di fondamenta concrete:

- dashboard web;
- utenti, profili e contatti;
- canali multipli;
- agent runtime;
- memoria e knowledge base;
- strumenti;
- automazioni e workflow;
- MCP e connection recipes;
- sicurezza e vault;
- App Factory;
- mobile app;
- osservabilita'.

Prossima evoluzione:

- maggiori integrazioni enterprise;
- verticali di settore;
- analisi operative e KPI;
- orchestrazione multi-agent;
- App Factory piu' avanzata;
- governance e audit sempre piu' granulari.

**Messaggio chiave**

Homun non e' solo una demo: e' una base di prodotto gia' costruita, pronta per essere validata su casi d'uso reali.

**Visual**

Stato attuale -> demo -> roadmap.
