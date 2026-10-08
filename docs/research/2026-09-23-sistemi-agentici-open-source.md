# Sistemi agentici open source: riferimenti per Homun

> Aggiornamento di indirizzo del 23 settembre: Fabio ha chiarito che vuole un motore Homun proprio, derivato dalla logica di un riferimento consolidato. Le ipotesi sotto di incorporare un runtime/SDK esterno sono superate; il confronto resta utile per scegliere e riprodurre il comportamento di riferimento. Vedi la [prova pratica](2026-09-23-prova-hermes-openhands.md).

Ricerca del 23 settembre 2026. Fonti ufficiali, benchmark pubblicato e ispezione statica di prompt e documentazione. Nessuno dei prodotti è stato installato o eseguito in questa ricerca. I comportamenti descritti sono documentati o prescritti dai prompt, non risultati di prove nostre.

## Giudizio

Non emerge una prova sufficiente per dichiarare un vincitore universale o un consenso del mercato. La shortlist proposta per Homun è **Hermes, Agent Zero e OpenHands SDK**: rispettivamente riferimento generalista, confronto di esperienza/prodotto e candidato tecnico da incorporare. È una valutazione per il nostro obiettivo, non una classifica certificata.

OpenClaw merita il confronto per canali, sessioni e contesto; Goose per estensioni e distribuzione desktop; DeerFlow per lavoro lungo, documenti e delega. Non è necessario adottarli tutti né sommare i loro stack.

## Cosa dicono le misure

[WildClawBench, tabella 3](https://arxiv.org/html/2605.10912v1) confronta OpenClaw, Claude Code, Codex e Hermes mantenendo lo stesso modello nei confronti. Gli autori riportano Hermes primo per tre dei quattro modelli confrontati e differenze fino a 18 punti al cambiare del sistema di esecuzione. Il benchmark comprende 60 attività in sei categorie.

È evidenza favorevole a Hermes, non una vittoria contro tutti i candidati: Agent Zero, Goose, DeerFlow e OpenHands SDK non sono in quel confronto. Versioni, strumenti, tempo disponibile e modello incidono sul risultato; le versioni della ricerca non sono necessariamente le attuali. La tabella principale dei modelli sotto OpenClaw non è una classifica dei sistemi agentici. Non abbiamo replicato gli esperimenti.

Le stelle GitHub sono un segnale di attenzione, non utenti attivi, qualità o affidabilità. Per questo non decidono la scelta. Analogamente un benchmark di coding o controllo del desktop non basta a giudicare il lavoro aziendale completo.

## Confronto operativo

| Sistema | Comportamento documentato | Cosa studiare per Homun | Limite della conclusione |
| --- | --- | --- | --- |
| [Hermes](https://github.com/NousResearch/hermes-agent) | Chat generalista, strumenti, memoria e skill; il ciclo alterna azioni e risultati fino alla risposta. | Ciclo operativo, prompt per modello, recupero e persistenza delle chiamate. | Buon riferimento iniziale; integrazione e resa con i nostri modelli ancora da provare. |
| [OpenClaw](https://docs.openclaw.ai/concepts/agent-loop) | Gestisce messaggio, sessione, contesto, esecuzione, streaming e persistenza; espone esiti e ricevute di consegna. | Continuità fra canali, sessioni e lavoro promesso; gestione del contesto. | Prodotto articolato: il costo di incorporarlo non si deduce dalla popolarità. |
| [Agent Zero](https://github.com/agent0ai/agent-zero) | Ambiente operativo con progetti, file, memoria, strumenti e delega gerarchica; prompt modificabili. | Esperienza di lavoro, profili e passaggio dal generalista agli specialisti. | Delega tecnica non equivale automaticamente a squadra aziendale con responsabilità umane. |
| [Goose](https://github.com/aaif-goose/goose) | Agente desktop/CLI estendibile, con istruzioni e strumenti delle estensioni disponibili nel contesto. | Integrazioni, caricamento capacità e distribuzioni personalizzate. | Le capacità dipendono dalle estensioni e dal modello configurati. |
| [DeerFlow](https://github.com/bytedance/deer-flow) | Lavoro lungo con sandbox, file, memoria, skill caricate al bisogno e sottoagenti. | Consegna di documenti e ricerca; criteri per delegare e verificare. | Non assumere che più sottoagenti migliorino sempre costo e risultato. |
| [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk) | Motore con conversazioni, azioni, osservazioni, strumenti e contesto; SDK e server separati dalle superfici applicative. | Riuso del motore dietro la UX di Homun; eventi e conferme. | Origine e prompt fortemente orientati al software: adattamento al lavoro aziendale da misurare. |

## Come i prompt indirizzano il comportamento

**Hermes.** L'[ispezione precedente](2026-09-23-hermes-codice-prima-di-reinventare.md) mostra composizione del prompt, istruzioni condizionali per modello/strumento, cronologia delle chiamate e persistenza prima dell'esecuzione. Le indicazioni operative chiedono di recuperare i fatti disponibili, agire quando la richiesta è chiara e verificare il risultato. Copiare solo il testo perderebbe la parte di runtime che rende quelle indicazioni eseguibili.

**OpenClaw.** Il [system prompt documentato](https://docs.openclaw.ai/concepts/system-prompt) viene composto con strumenti, contesto, capacità e istruzioni per provider. Spinge a eseguire richieste concrete, recuperare da risultati deboli e chiudere il lavoro promesso con un esito. Le skill sono caricate al bisogno; i sottoagenti ricevono un contesto ridotto. Il modello riceve informazioni sulle capacità effettivamente disponibili.

**Agent Zero.** Il prompt di problem solving prescrive: definire un successo osservabile, consultare memoria/skill, scomporre quando serve, confrontare i risultati con le aspettative, cambiare approccio in caso di errore e verificare prima di concludere. La memoria deve conservare informazioni riutilizzabili, non ogni dettaglio della singola esecuzione. Questo è riutilizzabile come criterio; il profilo principale contiene anche indicazioni di autonomia molto permissive, da non trasferire indiscriminatamente in Homun.

**Goose.** Il [prompt base](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/prompts/system.md) è breve: buona parte delle capacità deriva da strumenti e istruzioni delle estensioni. Il repository documenta anche [distribuzioni personalizzate](https://github.com/aaif-goose/goose/blob/main/CUSTOM_DISTROS.md). È una strada concreta da valutare qualora interessi riusare un prodotto desktop, distinta dall'incorporare una libreria.

**DeerFlow.** Nel prompt del lead agent la delega è condizionata a specializzazione, isolamento del contesto o parallelismo utile. Attività dipendenti o con stato condiviso non vanno distribuite indiscriminatamente. Il coordinatore deve controllare le affermazioni importanti: la ricevuta di una delega prova che è avvenuta, non che il contenuto sia corretto. Le skill possono evolvere, ma il prompt richiede conferma prima di crearne una nuova.

**OpenHands SDK.** L'[architettura ufficiale](https://docs.openhands.dev/sdk/arch/agent) separa ciclo dell'agente, conversazione, eventi e strumenti. Le azioni possono attendere conferma prima di produrre osservazioni. I prompt statici letti includono esplorazione, verifica e recupero, ma anche convenzioni specifiche per codice e Git: vanno selezionate, non importate come policy aziendale.

## Scelta proposta e prossima prova

Priorità: confrontare **Hermes e OpenHands SDK come alternative tecniche**, usando **Agent Zero come confronto di prodotto**. Tenere OpenClaw, Goose e DeerFlow come riferimenti mirati; allargare la prova se i primi candidati falliscono requisiti concreti.

Prima di scegliere il motore eseguire lo stesso protocollo:

1. Richiesta diretta: leggere materiali, cercare un fatto esterno e consegnare un documento senza creare un bot.
2. Richiesta incompleta: chiedere solo l'informazione realmente mancante, poi continuare.
3. Correzione durante il lavoro: incorporarla senza perdere obiettivo e fatti acquisiti.
4. Delega: assegnare un'indagine delimitata e verificare il risultato prima di usarlo.
5. Collaborazione umana: attendere un contributo, incorporarlo e mantenere responsabilità e provenienza.
6. Arresto/ripresa ed errore strumento: recuperare senza duplicare un effetto esterno.

Fissare versioni, modello, istruzioni utente, dati e budget comparabili; dichiarare le capacità non disponibili invece di mascherarle con adattatori diversi. Ripetere i casi per evitare conclusioni da una sola esecuzione. Misurare risultato corretto, domande superflue, fatti persi, verificabilità dell'artefatto, effetti duplicati, costo e tempo. Separare comportamento nativo e adattamenti necessari per Homun. Aggiungere un modello locale come prova distinta, senza confondere limite del modello e limite del motore.

La nostra differenza da validare resta l'organizzazione del lavoro fra persone e AI: contesto aziendale condiviso con accessi corretti, responsabilità, contributi, revisione e continuità. La presenza di profili o sottoagenti è già comune e da sola non costituisce quel vantaggio.

## Snapshot riproducibili

I riferimenti sotto fissano il codice ispezionato. Le pagine di documentazione online possono cambiare. Le licenze del motore non determinano quelle dei modelli, delle estensioni o dei servizi collegati; open source non significa automaticamente esecuzione interamente locale.

- [openclaw/openclaw: sorgente](https://github.com/openclaw/openclaw/blob/238347227b08df23859c3e366bf2cfbb1aa42d3a/docs/concepts/agent-loop.md), commit `238347227b08df23859c3e366bf2cfbb1aa42d3a`; licenza principale MIT.
- [agent0ai/agent-zero: sorgente](https://github.com/agent0ai/agent-zero/blob/b1cbd1f960a1a5c4482b324dcff4742aa67b7a51/prompts/agent.system.main.solving.md), commit `b1cbd1f960a1a5c4482b324dcff4742aa67b7a51`; licenza principale MIT.
- [aaif-goose/goose: sorgente](https://github.com/aaif-goose/goose/blob/e678c3b64a1dfd3c262a6a2019f158d33d5dcab0/README.md), commit `e678c3b64a1dfd3c262a6a2019f158d33d5dcab0`; licenza principale Apache-2.0.
- [bytedance/deer-flow: sorgente](https://github.com/bytedance/deer-flow/blob/fc26204debe2808fa1b4064f8fddfea6db2c71f8/backend/packages/harness/deerflow/agents/lead_agent/prompt.py), commit `fc26204debe2808fa1b4064f8fddfea6db2c71f8`; licenza principale MIT.
- [OpenHands/software-agent-sdk: sorgente](https://github.com/OpenHands/software-agent-sdk/blob/5b36cacccc2bbe6f8fbce9e1d3ff4b0a3dcddadb/openhands-sdk/openhands/sdk/context/prompts/sections/static.py), commit `5b36cacccc2bbe6f8fbce9e1d3ff4b0a3dcddadb`; licenza principale MIT.
- Hermes: snapshot e riferimenti nel [documento dedicato](2026-09-23-hermes-codice-prima-di-reinventare.md).
