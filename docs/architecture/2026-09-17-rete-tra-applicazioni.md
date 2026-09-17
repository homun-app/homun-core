# Rete tra applicazioni Homun

17 settembre 2026. Proposta conseguente alla domanda di Fabio: «possiamo creare un sistema di comunicazione senza un server centrale ma le varie applicazioni parlano tra di loro».

## Direzione

Sì: installazioni autonome, ciascuna con identità e motore, possono collegarsi e collaborare. Il requisito è non dipendere da un backend centrale Homun per possedere dati e svolgere il lavoro. Non implica automaticamente assenza di qualunque infrastruttura di rete, replica completa, funzionamento offline concorrente o alta disponibilità.

**Proposta iniziale: rete di nodi, con un'autorità per spazio e delega esplicita ai peer.** Nessun server centrale del fornitore obbligatorio. Un'app può essere host di uno spazio e client di un altro. Un host aziendale sempre acceso è opzionale e può eseguire lo stesso motore senza interfaccia.

Questa è una proposta, non una decisione già approvata da Fabio. Non chiamarla sistema completamente paritario: per ciascuno spazio la prima versione ha un nodo coordinatore.

## Esempio concreto

- Il Mac di Fabio ospita lo spazio aziendale e il piano «Nuovo catalogo».
- Il computer di Giulia si associa attraverso un invito, vede solo i lavori e file consentiti e può dare il proprio contributo.
- Un Mac con un modello locale può offrire la capacità «traduzione». Fabio delega a quel nodo un passo con input e budget definiti.
- Il nodo traduttore riceve solo i materiali necessari e restituisce artifact, ricevuta e consumo. Non riceve le chiavi degli altri connettori.
- Il nodo che ospita lo spazio registra il risultato e prosegue il piano. Approvazioni e modifiche concorrenti sono validate lì.
- Se un peer è offline, il contributo rimane da consegnare. Se l'host dello spazio è offline, i client possono consultare copie autorizzate già ricevute e preparare bozze locali; non dichiarano completate modifiche che l'host non ha accettato.
- Se tutti i nodi sono spenti, non possono avvenire automazioni. Se serve continuità, l'azienda lascia acceso un nodo o sceglie un host proprio.

## Tre livelli distinti

| Livello | Cosa abilita | Cosa non risolve |
|---|---|---|
| Collegamento tra app | Chat, consultazione, contributi e file tra dispositivi autorizzati | Non decide chi può modificare/eseguire |
| Delega di esecuzione | Un nodo esegue un passo per un altro | Non replica automaticamente identità, memoria, credenziali o permessi |
| Replica e failover | Continuare quando il nodo proprietario non è disponibile | Richiede consenso, conflitti, revoche e protezione da doppie azioni |

Costruire in quest'ordine. Non utilizzare merge di documenti per decidere chi può inviare un'email o spendere budget.

## Rete locale e Internet

Sulla rete locale: scoperta facoltativa, invito e collegamento autenticato. Scoprire un dispositivo non lo rende fidato.

Tra reti diverse: provare collegamento diretto, con infrastruttura di rendezvous/relay quando NAT e firewall lo richiedono. Un relay inoltra traffico cifrato, non è il database aziendale né il coordinatore del lavoro. Può comunque osservare metadati di connessione; non promettere assenza assoluta di metadati. Deve essere configurabile o ospitabile dall'azienda se il requisito lo richiede.

Tre modalità da provare: LAN diretta; Internet diretta; Internet tramite relay. Senza relay/configurazione di rete non possiamo promettere connessione universale. Se il requisito è «zero infrastruttura esterna», limitare inizialmente a LAN o rete privata configurata dall'azienda.

Candidati da valutare con uno spike, non da adottare entrambi: iroh oppure libp2p; alternativa iniziale più ridotta HTTPS autenticato su rete privata. Il trasporto deve restare un adattatore: non imporre un cambio del motore Python per incorporare una libreria. Valutare un processo di rete separato se i binding non soddisfano packaging e manutenzione.

## Identità e permessi

Device identity con chiave propria; identità umana separata. Invito monouso, scadenza, conferma del dispositivo e assegnazione ruolo. Non condividere password o chiavi private dell'host. Ogni richiesta porta attore, nodo, workspace, command_id, versione e autorizzazione verificabile.

Revocare dispositivo e utente separatamente. Nodo revocato non riceve nuovi dati né può completare azioni remote. Una copia già scaricata non può essere cancellata retroattivamente con garanzia: la UX deve dirlo. Accesso offline a dati sensibili è una policy esplicita; per la v1 nessuna nuova azione esterna condivisa offline.

Registrare device, trust grant, capability advertisement, execution assignment e receipt. Le capacità dichiarate dal nodo sono indicative fino alla prova; non equivalgono a consenso per eseguire qualsiasi operazione.

## Protocollo applicativo

1. Pair e handshake: identità, versione protocollo, capacità, spazio consentito.
2. Subscribe: eventi autorizzati da cursor; snapshot al bisogno. Ordinamento per spazio, non orologio globale.
3. Submit: comando deduplicato, expected_version; ACK ricevuto distinto da accepted e completed.
4. Transfer: manifest file, hash, dimensione e autorizzazione; trasferimento riprendibile, validazione all'arrivo. Nessuna copia del database SQLite via rete.
5. Delegate: assignment_id, run/step/revisione, input hash, capacità concessa, scadenza e budget riservato dall'autorità.
6. Execute: il peer acquisisce autorizzazione corrente prima di azioni esterne; persiste intent e ricevuta. In disconnessione si fermano nuove azioni condivise con effetti esterni.
7. Return: risultato e ricevuta con assignment_id; messaggi duplicati non creano risultati o addebiti doppi.
8. Reconcile: dopo timeout, interrogare il tentativo precedente. Non riassegnare ciecamente un invio esterno a un secondo nodo.

Le fencing token proteggono il commit interno; non possono fermare da sole una richiesta già partita verso un servizio che non le comprende. Su effetti incerti serve riconciliazione specifica del connettore.

## Replica successiva

Cache di lettura prima; trasferimento esplicito dell'autorità con vecchio nodo cooperante poi. Perdita del nodo: ripristino controllato da backup, blocco delle esecuzioni incerte finché riconciliate. Niente failover automatico con due potenziali proprietari.

Più avanti: replica selettiva, protocolli di consenso per autorità e budget, gestione split-brain. Un CRDT può essere utile per note e bozze collaborative; non rende sicuri automaticamente approvazioni, accessi o azioni esterne.

## Criteri di accettazione della prima rete

- Due Mac possono associarsi, condividere una conversazione autorizzata e fornire un contributo.
- Un terzo device non invitato non accede neanche conoscendo un ID.
- Connessione e trasferimenti si riprendono senza duplicati dopo distacco rete.
- Un evento ricevuto due volte genera una sola transizione/notifica.
- Host offline mostrato correttamente; azioni non accettate visibili come in attesa di consegna.
- Revoca peer impedisce nuove letture/azioni; copie già ricevute dichiarate come limite.
- Delega interrompibile, con risultato riconciliato dopo timeout e senza doppio invio.
- Test di due reti reali e relay forzato, non soltanto due processi sullo stesso computer.

## Fonti primarie consultate

- [libp2p: hole punching](https://docs.libp2p.io/concepts/hole-punching/): connessione diretta e ruolo dei relay nelle reti con NAT.
- [iroh: public relays](https://docs.iroh.computer/iroh-services/relays/public): relay e metadati osservabili.
- [Automerge: conflicts](https://automerge.org/docs/reference/documents/conflicts/): merge e conflitti nei dati collaborativi; l'esclusione dai comandi con effetti è una scelta architetturale Homun.
