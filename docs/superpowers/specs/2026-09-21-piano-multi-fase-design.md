# Piano multi-fase di un lavoro

Stato: **proposta in attesa di validazione** — nessun codice scritto su questo perimetro.

## Problema verificato

Oggi un accordo corrisponde a una capacità singola: `compare_csv`, `read_material`
o preparazione (`general`). Un lavoro reale — raccogliere i listini, confrontarli,
sintetizzare il report per il commerciale — è una sequenza con più collaboratori,
punti di attesa e passaggi visibili. Il motore ha già il comando `plan.propose`
con passi, dipendenze e assegnatari (`engine/src/homun/domain/commands/plans.py`),
più `plan.accept` e `plan.revise` con storico dei passi riusciti, ma l'intake
conversazionale non lo usa: la sequenza vive solo nella testa della persona.

## Direzione raccomandata

**L'accordo resta unico; il piano è la sua decomposizione operativa.** Obiettivo,
risultato e vincoli non si moltiplicano: si confermano una volta (come oggi). Il
piano di fasi viene proposto dopo la conferma dell'accordo, quando il lavoro ha
davvero più fasi; i lavori a capacità singola continuano sul percorso attuale
senza piano esplicito. Nessun nuovo orchestratore: ogni passo eseguibile usa il
registro delle capacità, l'approvazione per effetto e l'esecuzione DBOS esistenti.

### Percorso della persona

1. **Richiesta → accordo** (invariato). La proposta di accordo oggi già dichiara
   attività, risultato atteso, collaboratore e informazioni mancanti.
2. **Proposta del piano** — alla conferma di un accordo multi-fase, Homun presenta
   in chat una scheda «Piano di lavoro»: fasi in ordine, e per ogni fase
   - cosa serve (materiali, informazioni, decisioni),
   - chi la porta avanti (collaboratore con capacità collegata dal registro;
     fasi di raccolta e decisioni assegnate a te),
   - cosa produce e da quale fase dipende.
   La conferma del piano (`plan.accept`) è un gesto esplicito separato dalla
   conferma dell'accordo: approvare il contratto non preautorizza la sequenza.
3. **Fase corrente visibile** — la scheda «Cosa serve ora» (già esistente per
   `general`) diventa la vista della fase attiva: elenco di ciò che manca con
   stato per riga, caricamento contestuale, nessuna caccia ai menu. Il riepilogo
   destro mostra fase corrente e prossimo passo; sidebar e scheda danno lo
   stesso stato (stessa fonte).
4. **Il lavoro propone il passo eseguibile** — quando tutto ciò che la fase
   richiede è presente (la disponibilità dei materiali è già interrogabile per
   attore dal registro), Homun prepara da solo l'azione della fase con la
   capacità collegata e la presenta con la card di approvazione esistente
   (azione, fonti con versione e hash, effetti, limiti). Una persona approva;
   l'esecuzione è il workflow DBOS già provato. Nessuna esecuzione senza
   approvazione, nessun loop agentico libero.
5. **Chiusura di fase** — l'artefatto del passo entra in revisione umana
   (`EngineResultReview`: approva / richiedi correzioni con riapertura, già
   provato). L'approvazione chiude la fase e sblocca la dipendente; il lavoro
   passa alla fase successiva e la scheda torna a mostrare «cosa serve ora» —
   o, se la fase dipendente è già pronta, la proposta del suo passo.
6. **Chiusura del lavoro** — l'ultima fase produce il risultato complessivo;
   la revisione finale (l'attuale «Approva il risultato e concludi») completa
   il lavoro. Nessun invio esterno in nessun passaggio.

### Prima fetta suggerita (verificabile)

**Raccolta → confronto**: accordo confermato con capacità `compare_csv`; la
fase di raccolta elenca i due listini richiesti; quando i materiali idonei
sono registrati nel progetto, il lavoro prepara da solo l'azione di confronto
(fonti rivalidate all'avvio, come già fa il selettore materiali) e la propone
in attesa di approvazione. Riuso integro di policy, digest, fonti immutabili,
DBOS e ricevute. Seconda fetta naturale: la fase di lettura (`read_material`)
in catena, già provata via API come tool chain.

## Cosa non è in questo perimetro

- Nessuna esecuzione multi-passo automatica: ogni effetto resta soggetto alla
  sua approvazione, anche quando le fasi sono già pianificate.
- Nessun secondo orchestratore o loop agentico: il «lavoro propone il passo»
  è una policy strutturale del motore, non un agente che decide.
- Le skill portabili, la delega estesa e il budget per fase restano fuori
  (la busta resta per lavoro, come oggi).

## Decisioni che servono a Fabio

1. **Conferma del piano separata o accorpata?** Raccomando separata (un gesto
   in più solo per i lavori multi-fase), nella stessa card dell'accordo per
   ridurre l'attrito.
2. **Chi compone il piano?** Raccomando ibrido: percorsi noti (confronto,
   lettura, raccolta) da policy deterministica del motore; scomposizione di
   accordi «general» dal modello con validazione engine-side di assegnatari e
   capacità collegate — il modello propone, il backend decide.
3. **Revisione per fase o solo finale?** Raccomando per fase: è il comportamento
   già provato e coerente col principio che approvare un risultato non
   autorizza l'effetto successivo.
