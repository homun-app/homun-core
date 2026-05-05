# Homun — AI Operating System per processi aziendali

Homun e' una piattaforma AI enterprise progettata per portare agenti, automazioni, app interne, integrazioni e governance dentro i processi operativi dell'azienda.

L'obiettivo non e' creare un'altra chat AI, ma un layer operativo capace di collegare persone, dati, strumenti, canali e workflow. In molte aziende l'AI viene introdotta in modo frammentato: chatbot separati, knowledge base isolate, automazioni scollegate, strumenti no-code, sistemi interni e canali di comunicazione non integrati. Il risultato e' che l'AI supporta singoli task, ma raramente diventa parte strutturale del modo in cui l'azienda lavora.

Homun affronta questo problema come un control plane AI: ogni richiesta passa attraverso identita', profili, permessi, contesto e policy. L'agente puo' usare knowledge base, memoria, tool, skills, plugin e integrazioni MCP, ma sempre dentro un perimetro governato. L'output puo' essere una risposta, un'azione, un workflow, una notifica, un'automazione o un'app interna generata tramite blueprint.

## Cosa fa

Homun combina in un'unica piattaforma:

- agent runtime per interpretare richieste ed eseguire azioni;
- gestione di utenti, profili, contatti e perimetri;
- canali come dashboard web, Telegram, WhatsApp, Slack, Discord, email, CLI e API;
- memoria e knowledge base per recuperare contesto aziendale;
- automazioni pianificate, heartbeat e workflow multi-step;
- approval gates, retry, notifiche e resume-on-boot;
- vault cifrato, 2FA, sandbox, audit log e controlli di sicurezza;
- skills, plugin e integrazioni MCP verso servizi esterni;
- App Factory per generare app interne da richieste business.

## Sicurezza e governance

La sicurezza e' una parte centrale dell'architettura. Homun supporta utenti e profili, pairing dei canali, trusted devices, token API con scope, vault cifrato AES-256-GCM, 2FA, CSRF, rate limit, sandbox per strumenti, approval gates e audit log.

Il sistema distingue contenuti trusted, authenticated e untrusted. Messaggi da canali, webhook, risultati di tool, pagine browser e contenuti da fonti esterne possono essere etichettati e trattati con controlli specifici contro prompt injection e data exfiltration. L'agente non opera liberamente: usa solo dati, strumenti e integrazioni consentiti dal contesto.

## App Factory

La App Factory e' uno degli elementi piu' distintivi di Homun. Un utente puo' descrivere un'app interna in linguaggio naturale, per esempio un sistema per ferie e permessi, ticket interni, prenotazione sale o richieste acquisto.

Homun analizza dominio, utenti, dati, viste, permessi e workflow. Se una decisione cambia la struttura dell'app, puo' fare una domanda mirata. Poi produce un blueprint validato e compone l'app con componenti predefiniti: UI, storage, ruoli, viste e azioni. Questo evita generazione arbitraria di codice e rende le app interne piu' controllabili.

## Estendibilita' e verticalizzazione

Homun e' pensato per essere personalizzabile senza riscrivere il core. Skills, plugin, server MCP e connection recipes permettono di aggiungere capacita' e integrazioni verso servizi come GitHub, Google Workspace, Notion, Slack, Jira, Linear, GitLab, Stripe, Todoist e altri.

Questo rende la piattaforma verticalizzabile per settori e funzioni diverse: HR, operations, legal, finance, customer support, manufacturing, consulenza e processi specifici di cliente.

## Stato attuale e direzione

Homun dispone gia' di una base concreta: dashboard web, gestione utenti/profili, canali, sicurezza, memoria, knowledge base, automazioni, workflow, MCP, skills, App Factory, mobile app e osservabilita'.

La direzione futura e' far evolvere Homun in un sistema operativo AI per i processi aziendali: piu' integrazioni enterprise, piu' verticali, analisi operative, KPI, orchestrazione multi-agent, app interne generate on demand e governance sempre piu' granulare.

In sintesi, Homun porta l'AI dal livello conversazionale al livello operativo: non solo risposte, ma processi, strumenti, automazioni e app governate.
