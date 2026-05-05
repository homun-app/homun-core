# Homun — Script Presentazione 5-7 Minuti

## Apertura

Oggi voglio mostrare Homun, una piattaforma AI pensata per portare agenti, automazioni e app interne dentro i processi aziendali.

Il punto di partenza non e' "fare un'altra chat AI". Le chat AI sono utili, ma spesso restano fuori dal flusso reale del lavoro: rispondono, aiutano a scrivere, sintetizzano, ma non hanno una governance completa, non sono integrate con tutti i canali, non gestiscono permessi, non creano app operative e non orchestrano processi aziendali end-to-end.

Homun nasce per coprire questo spazio: essere un AI Operating System per l'azienda.

## Il problema

In molte aziende l'AI entra in modo frammentato. Da una parte ci sono chatbot generalisti, dall'altra strumenti no-code, automazioni isolate, knowledge base separate, ticketing, email, documenti e sistemi interni.

Il risultato e' che l'AI aiuta singoli task, ma fatica a diventare parte del modo in cui l'azienda lavora. Mancano identita', profili, permessi, audit, sicurezza, integrazione con i canali e capacita' di eseguire azioni reali dentro processi controllati.

## La visione

La mia visione e' che la prossima fase dell'AI aziendale non sara' solo conversazionale. Sara' operativa.

Un agente AI dovra' capire la richiesta, sapere chi la sta facendo, quali dati puo' vedere, quali strumenti puo' usare, quali approvazioni servono, quale workflow deve seguire e dove comunicare il risultato.

Homun e' costruito intorno a questa idea: portare l'AI dentro i flussi aziendali, non lasciarla fuori come assistente generico.

## Cos'e' Homun

Homun e' una piattaforma self-hostable e local-first che combina diversi componenti:

- un runtime per agenti AI;
- gestione di utenti, profili, contatti e perimetri;
- canali come web, Telegram, WhatsApp, Slack, Discord, email, CLI e API;
- memoria e knowledge base;
- tool, skills, plugin e integrazioni MCP;
- automazioni e workflow;
- una App Factory per generare applicazioni interne;
- sicurezza, vault, approval gates e audit.

Quindi non e' solo un'interfaccia: e' un control plane AI che collega persone, dati, strumenti e processi.

## Come funziona

Il flusso e' semplice.

Un utente arriva da un canale: dashboard, chat, email o API. Homun identifica utente, profilo e perimetro. L'agente interpreta la richiesta, recupera solo il contesto autorizzato, valuta strumenti disponibili, skills, knowledge base e integrazioni MCP, poi esegue l'azione corretta.

Questa azione puo' essere una risposta, una ricerca, un aggiornamento dati, l'avvio di un workflow, una notifica su un canale, una chiamata a un sistema esterno o la creazione di un'app interna.

La differenza e' che ogni passaggio resta dentro un modello di governance: permessi, trust boundaries, audit, vault, sandbox e approvazioni.

## Sicurezza

La parte di sicurezza e' centrale perche' senza governance l'AI in azienda non scala.

Homun gestisce utenti e profili, token API con scope, pairing dei canali, trusted devices, vault cifrato, 2FA, CSRF, rate limit, sandbox, approval gates e audit log.

Inoltre distingue contenuti trusted, authenticated e untrusted. Per esempio webhook, risultati di tool, pagine browser e messaggi da sorgenti non pienamente fidate vengono etichettati e trattati con difese specifiche contro prompt injection e data exfiltration.

Il principio e' che l'agente non deve essere libero di fare tutto: deve operare dentro confini espliciti.

## Automazioni e workflow

Homun non serve solo a rispondere a domande.

Puo' eseguire processi nel tempo: automazioni pianificate, heartbeat, workflow multi-step, approvazioni, retry, notifiche e resume-on-boot.

Questo permette di passare da "chiedo all'AI una risposta" a "l'AI segue un processo": raccoglie informazioni, applica regole, chiede approvazione se serve, aggiorna dati, invia notifiche e produce report.

## App Factory

Una delle parti piu' importanti e' la App Factory.

L'idea e' che un utente possa descrivere un'app interna in linguaggio naturale. Homun non genera codice arbitrario: prima analizza il dominio, individua utenti, entita', dati, workflow, permessi e viste. Se una scelta e' ambigua e impatta la struttura dell'app, fa una domanda.

Poi genera un blueprint validato e compone un'app funzionante usando componenti predefiniti: UI, storage, ruoli, viste e azioni.

Un esempio puo' essere un'app ferie e permessi, un sistema di ticket interni, prenotazione sale, onboarding clienti o richieste acquisto.

Questa e' una differenza importante: Homun non automatizza solo task, ma puo' creare strumenti operativi per gestire processi.

## Estendibilita'

Homun e' progettato per essere personalizzabile e verticalizzabile.

Le capacita' possono essere estese con skills, plugin, server MCP e connection recipes. Questo permette di collegare servizi come GitHub, Google Workspace, Notion, Slack, Jira, Linear, GitLab, Stripe e molti altri.

La piattaforma resta stabile, ma quello che sa fare cambia in base al contesto: HR, operations, legal, finance, customer support, manufacturing o consulenza.

## Chiusura

In sintesi, Homun e' un tentativo concreto di portare l'AI dal livello conversazionale al livello operativo.

Non sostituisce solo una chat: collega canali, dati, workflow, automazioni, app e sicurezza.

La parte importante e' che oggi non siamo davanti solo a un'idea: esiste gia' una base di prodotto con dashboard, canali, profili, sicurezza, automazioni, MCP, App Factory, mobile e osservabilita'.

Da qui la demo serve a mostrare proprio questo: non una slide sull'AI, ma un sistema che puo' iniziare a gestire processi reali.
