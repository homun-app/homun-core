# Visione originale e distanza dal prodotto attuale

23 settembre 2026. Analisi statica del sorgente `f17546b2`, successivo al
consolidamento. Nessuna nuova prova con utenti, browser, provider o servizi
esterni. Le evidenze descrivono collegamenti nel codice, non qualità operativa
certificata. Le proposte seguenti non sono un piano di implementazione approvato.

## Direzione già decisa

La [visione originale](../VISIONE-PRODOTTO.md) identifica piccole aziende senza
reparto IT, collaboratori agnostici rispetto al settore, un coordinatore
facoltativo e lavoro con persone, clienti e fornitori. La
[specifica prodotto](../specifications/01-prodotto-e-dati.md) parte dalla
conversazione: una domanda può restare una domanda. Il
[confronto del 19 settembre](2026-09-19-hermes-homun-comparison.md) colloca già
le capacità di un agente generalista dentro il lavoro aziendale.

Fabio ha ribadito due ingressi allo stesso prodotto:

1. **Usa subito Homun:** chiedi, fornisci materiali, fai eseguire operazioni;
   creare un collaboratore specializzato è facoltativo.
2. **Costruisci la tua squadra:** racconti l'azienda o il gruppo desiderato;
   Homun propone collaboratori, individua profili riutilizzabili dove disponibili,
   aiuta a configurarli e a lavorare con colleghi reali.

La squadra è il posizionamento iniziale. Le capacità generaliste sono la base
che deve renderlo utile anche prima dell'onboarding. Il confronto listini è una
fixture tecnica riuscita; non definisce il mercato né giustifica da solo un
agente specializzato. Non abbiamo ancora validato domanda di mercato, disponibilità
a pagare o un segmento più preciso tramite interviste/piloti.

## Cosa c'è e cosa manca

I riferimenti di codice sono relativi al repository; le righe indicate valgono
per il commit analizzato.

| Aspettativa | Evidenza attuale | Conseguenza per l'utente |
| --- | --- | --- |
| Iniziare senza configurare un bot | L'ingresso motore promette un collaboratore o un nuovo profilo (`ConversationWorkspaceWelcome.tsx`, 32–49). L'intake eseguibile richiede uno dei due (`models/intake.py`, 178 e seguenti). | La specializzazione diventa un prerequisito anche quando serve soltanto completare una richiesta. |
| Domanda semplice | Il classificatore distingue domanda e lavoro, ma `createIntakeConversation` crea prima conversazione **e Work** (`engine-intake-creation.ts`, 16–24). | La UI evita il brief obbligatorio, ma la persistenza resta accoppiata al lavoro. Questo non prova da solo che ogni bozza sia visibile in Compiti. |
| Agire e adattarsi ai risultati | `ChatMessage` ha solo system/user/assistant; `CompletionResult` è testuale (`models/types.py`, 15 e 71). `ModelPort.complete` non riceve strumenti (`models/port.py`, 61). | Manca il ciclo modello → strumento → osservazione → nuova decisione. Un prompt migliore non basta. |
| Compiti non previsti a priori | Il registro contiene compare_csv, read_material, synthesize e general; general è preparazione (`domain/capabilities.py`, 71 e 138). | L'esecuzione è limitata a percorsi espliciti. Agnosticità del settore non equivale ancora a generalità operativa. |
| Operazioni in più passi | Le chain eseguono una lista approvata di letture/confronti (`application/tool_chains.py`, 25; `runtime/workflows/tool_chain.py`, 47). | Esistono sequenze persistenti, ma non rivalutazione del piano sulla base dei risultati. |
| Strumenti esterni disponibili all'agente | MCP filtra nomi senza conservare descrizioni e inputSchema nella discovery (`application/mcp_client.py`, 113); approvazione ed esecuzione sono inline (`application/external_tools.py`, 88). | Collegare un server non lo rende automaticamente utilizzabile dal ragionamento; va anche unificata la gestione degli esiti incerti. |
| Onboarding aziendale | L'app monta direttamente ConversationWorkspace (`apps/web/src/main.tsx`); l'ingresso motore raccoglie la richiesta e le impostazioni dello spazio espongono campi generici. Nel percorso esaminato non emerge un'intervista aziendale persistente che proponga una squadra. | L'utente deve tradurre da sé azienda, bisogni e responsabilità in configurazioni. |
| Squadra con coordinatore | Team e coordinator_id persistono. I riferimenti backend al coordinatore sono modello, CRUD e validazione; l'editor sceglie AgentProfile attivi (`EngineWorkspaceTeams.tsx`, 21 e 191). | La composizione esiste; il coordinatore non pianifica e delega attraverso quel ruolo. |
| Colleghi reali | Le persone non hanno registro (`domain/commands/membership.py`, 10); inviti dichiarati demo; la sessione locale vincola un singolo attore (`routes/session_auth.py`, 29). | Un identificativo di collega non equivale a un accesso personale e a un canale per contribuire. |
| Metodo e continuità | Memorie approvate entrano nel contesto (`application/conversation_context.py`, 136); procedure selezionate e revisioni entrano nella sintesi (`application/synthesis_execution.py`, 200). Le routine registrano schedule DBOS (`application/routines.py`, 77). | Queste basi sono reali. Va completato e provato il passaggio da correzione individuale a metodo condiviso dalla squadra. |

Percorsi abbreviati nella tabella: i file Python sono sotto
`engine/src/homun/`; i componenti sotto `apps/web/src/components/builder/`;
i moduli client sotto `apps/web/src/lib/`.

## Patrimonio da conservare

Dominio persistente, comandi versionati, autorizzazioni, materiali, artifact,
revisione, budget, outbox e DBOS costituiscono una base utile. I contributi umani
sono già comandi di dominio con destinatario, risposta e risoluzione della fase
(`domain/commands/execution.py`, 95–205). I profili possono essere creati e
assegnati con conferma; le procedure approvate vengono effettivamente usate.

Non serve ricostruire questi pezzi. Serve collegarli a un esecutore capace di
scegliere strumenti e a identità/canali che rendano reale la squadra. Il semplice
numero di test superati nel consolidamento non dimostra nessuno di questi due
risultati di prodotto.

## Proposta di esperienza da discutere

**Homun è l'interlocutore iniziale e può svolgere direttamente il lavoro.**
Chiede soltanto ciò che manca per procedere. Propone un collaboratore stabile
quando responsabilità, frequenza, metodo o delega ne rendono utile la creazione.
L'identità dell'esecutore resta distinta dalla persona che autorizza e verifica.

**L'onboarding aziendale è un percorso conversazionale facoltativo e riprendibile.**
Raccoglie contesto, persone, responsabilità, strumenti e difficoltà quotidiane;
restituisce una proposta concreta di squadra e un primo lavoro utile. Un profilo
pronto deve dichiarare strumenti necessari, accessi mancanti e attività realmente
supportate. L'installazione di un nome/ruolo non deve essere presentata come una
competenza già operativa.

**Il lavoro passa fra persone e bot mantenendo il contesto.** Una richiesta a un
collega deve arrivare al destinatario; la sua risposta deve far proseguire il
lavoro. Il coordinatore propone ed esegue deleghe nel perimetro concordato,
rende visibili attese e problemi e raccoglie il risultato.

Le autorizzazioni vanno legate ad azioni e ambiti: non occorre trasformare ogni
richiesta in un mestiere previsto dal catalogo, né ripetere conferme per letture
già autorizzate. I dettagli di configurazione compaiono quando servono a una
scelta reale. Questi principi riprendono AG-03/AG-06 della
[specifica agenti](../specifications/02-agenti-esecuzioni-memoria.md).

## Priorità proposte

1. **Disegnare insieme i due ingressi e il lavoro condiviso.** Definire quando
   una conversazione diventa lavoro, quando conviene un collaboratore stabile,
   chi autorizza e come un collega partecipa. Questo evita che il motore imponga
   di nuovo alla UX un catalogo di attività.
2. **Costruire una prima esperienza completa su quel disegno:** esecuzione diretta
   senza bot preconfigurato, ciclo adattivo con strumenti e osservazioni persistiti,
   proposta di squadra dal contesto aziendale e passaggio reale a una persona.
   Lavorare in incrementi verificabili, mantenendo questo risultato comune.
3. **Estendere riutilizzo e continuità:** profili pronti verificabili, procedure
   derivate da correzioni, ricorrenze entro autorizzazioni esplicite e più squadre.

Per il motore raccomando di estendere ModelPort, catalogo strumenti ed esecuzione
durabile esistenti. Continuare ad aggiungere soltanto capability verticali riduce
il lavoro iniziale ma mantiene il limite strutturale. Adottare un runtime esterno
è un'alternativa da valutare con uno spike separato: va chiarito chi possiede stato,
autorizzazioni, effetti e ripresa prima di scegliere. Il confronto con Hermes
rimane un riferimento di capacità e utilizzo; non sostituisce il disegno di Homun.

## Prove che renderebbero credibile la direzione

- Un nuovo utente completa richieste diverse senza scegliere o creare un bot.
  Il modello usa uno strumento, ne osserva l'esito e modifica il passo successivo;
  gli strumenti mancanti sono dichiarati. Includere un compito non scritto nei
  prompt di esempio, compatibile con gli strumenti disponibili.
- Un titolare racconta la propria organizzazione, corregge la proposta di squadra
  e capisce cosa sarà operativo e cosa richiede un collegamento.
- Due persone con identità distinte e un agente completano un lavoro: richiesta,
  notifica/accesso, contributo, prosecuzione e consegna sono osservabili.
- Una correzione diventa una procedura proposta e approvata; un lavoro successivo
  la usa nel giusto ambito, con fonti e revisione riconoscibili.
- Dopo un'interruzione si riprende senza duplicare effetti né perdere attese.
  Il risultato resta distinto da una consegna accettata dalla persona.

Misurare tempo al primo risultato utile, configurazioni richieste, conferme
ridondanti, interventi necessari per sbloccare il lavoro e comprensione di chi
sta aspettando chi. Per la squadra aggiungere tempo risparmiato nei passaggi e
qualità del lavoro consegnato. Sono criteri proposti, non risultati misurati.
